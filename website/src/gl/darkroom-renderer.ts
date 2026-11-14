import type { CurveChannel, DarkroomParams } from '../types'
import { FRAGMENT_SHADER_GLSL, VERTEX_SHADER_GLSL } from './shaders'

export interface PhotometricStats {
  p05: number
  p50: number
  p95: number
  clipHighPct: number
  clipLowPct: number
  lumaBins: Uint32Array
  rBins: Uint32Array
  gBins: Uint32Array
  bBins: Uint32Array
}

/**
 * Fritsch–Carlson monotonic cubic spline evaluator (256 samples in 0..255),
 * mirroring Chengying's builtin:curve operator so curve edits never overshoot.
 */
export function evaluateMonotonicSpline256(points: Array<[number, number]>): Uint8Array {
  const sorted = [...points]
    .map(([x, y]) => [Math.max(0, Math.min(1, x)), Math.max(0, Math.min(1, y))] as [number, number])
    .sort((a, b) => a[0] - b[0])

  if (sorted.length === 0) {
    const id = new Uint8Array(256)
    for (let i = 0; i < 256; i++) id[i] = i
    return id
  }
  if (sorted[0][0] > 0) sorted.unshift([0, sorted[0][1]])
  if (sorted[sorted.length - 1][0] < 1) sorted.push([1, sorted[sorted.length - 1][1]])

  const pts: Array<[number, number]> = [sorted[0]]
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i][0] - pts[pts.length - 1][0] > 1e-4) {
      pts.push(sorted[i])
    }
  }
  const n = pts.length
  const out = new Uint8Array(256)
  if (n === 1) {
    out.fill(Math.round(pts[0][1] * 255))
    return out
  }

  const dx: number[] = []
  const dy: number[] = []
  const m: number[] = []
  for (let i = 0; i < n - 1; i++) {
    const h = pts[i + 1][0] - pts[i][0]
    const d = pts[i + 1][1] - pts[i][1]
    dx.push(h)
    dy.push(d)
    m.push(d / h)
  }

  const tangents: number[] = [m[0]]
  for (let i = 1; i < n - 1; i++) {
    if (m[i - 1] * m[i] <= 0) {
      tangents.push(0)
    } else {
      const common = dx[i - 1] + dx[i]
      tangents.push((3 * common) / ((common + dx[i]) / m[i - 1] + (common + dx[i - 1]) / m[i]))
    }
  }
  tangents.push(m[n - 2])

  let seg = 0
  for (let i = 0; i < 256; i++) {
    const x = i / 255
    while (seg < n - 2 && x > pts[seg + 1][0]) seg++
    const h = dx[seg]
    const t = Math.max(0, Math.min(1, (x - pts[seg][0]) / h))
    const t2 = t * t
    const t3 = t2 * t
    const h00 = 2 * t3 - 3 * t2 + 1
    const h10 = t3 - 2 * t2 + t
    const h01 = -2 * t3 + 3 * t2
    const h11 = t3 - t2
    const y =
      h00 * pts[seg][1] +
      h10 * h * tangents[seg] +
      h01 * pts[seg + 1][1] +
      h11 * h * tangents[seg + 1]
    out[i] = Math.max(0, Math.min(255, Math.round(y * 255)))
  }
  return out
}

function hslHueToLinearVec(hueDeg: number, satPct: number): [number, number, number] {
  const s = (satPct / 100) * 0.22
  if (s <= 0.0005) return [0, 0, 0]
  const rad = (hueDeg * Math.PI) / 180
  const r = Math.cos(rad) * s
  const g = Math.cos(rad - (2 * Math.PI) / 3) * s
  const b = Math.cos(rad + (2 * Math.PI) / 3) * s
  return [r, g, b]
}

export interface RendererOptions {
  canvas: HTMLCanvasElement
  onStats?: (stats: PhotometricStats) => void
}

export class OpticalShaderRenderer {
  private readonly canvas: HTMLCanvasElement
  private gl: WebGL2RenderingContext | null = null
  private ctx2d: CanvasRenderingContext2D | null = null
  private program: WebGLProgram | null = null
  private vao: WebGLVertexArrayObject | null = null
  private photoTex: WebGLTexture | null = null
  private lutTex: WebGLTexture | null = null
  private uniforms: Record<string, WebGLUniformLocation | null> = {}

  private currentImage: HTMLImageElement | null = null
  private imageCache = new Map<string, HTMLImageElement>()
  private thumbPixelCache = new Map<string, Uint8ClampedArray>()
  private currentThumbPixels: Uint8ClampedArray | null = null
  private lutBuffer = new Uint8Array(256 * 4)

  private params: DarkroomParams | null = null
  private rawBase: [number, number, number, number] = [-0.55, -22, -26, -12]
  private splitPos = -1
  private compareHold = false
  private showMask = false
  private showZebra = false
  private loupe = { x: 0.5, y: 0.5, enabled: false }

  private rafId = 0
  private needsDraw = true
  private statsCanvas: HTMLCanvasElement
  private statsCtx: CanvasRenderingContext2D | null
  private onStats?: (stats: PhotometricStats) => void
  private lastStatsTime = 0

  constructor(opts: RendererOptions) {
    this.canvas = opts.canvas
    this.onStats = opts.onStats
    this.statsCanvas = document.createElement('canvas')
    this.statsCanvas.width = 128
    this.statsCanvas.height = 85
    this.statsCtx = this.statsCanvas.getContext('2d', { willReadFrequently: true })

    for (let i = 0; i < 256; i++) {
      this.lutBuffer[i * 4] = i
      this.lutBuffer[i * 4 + 1] = i
      this.lutBuffer[i * 4 + 2] = i
      this.lutBuffer[i * 4 + 3] = i
    }

    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault()
      this.gl = null
      this.program = null
      this.vao = null
      this.photoTex = null
      this.lutTex = null
      this.canvas.classList.remove('is-ready')
    })

    this.canvas.addEventListener('webglcontextrestored', () => {
      this.initContext()
      if (this.currentImage && this.gl && this.photoTex) {
        this.gl.activeTexture(this.gl.TEXTURE0)
        this.gl.bindTexture(this.gl.TEXTURE_2D, this.photoTex)
        this.gl.texImage2D(
          this.gl.TEXTURE_2D,
          0,
          this.gl.RGBA,
          this.gl.RGBA,
          this.gl.UNSIGNED_BYTE,
          this.currentImage,
        )
        this.canvas.classList.add('is-ready')
      }
      if (this.params) this.uploadCurveLut(this.params.curves)
      this.requestRender(true)
    })

    this.initContext()
  }

  public get isWebGL2(): boolean {
    return this.gl !== null && !this.gl.isContextLost()
  }

  private initContext(): void {
    const gl = this.canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    })

    if (!gl) {
      this.ctx2d = this.canvas.getContext('2d')
      return
    }

    const vs = this.compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER_GLSL)
    const fs = this.compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER_GLSL)
    if (!vs || !fs) {
      this.ctx2d = this.canvas.getContext('2d')
      return
    }

    const prog = gl.createProgram()
    if (!prog) return
    gl.attachShader(prog, vs)
    gl.attachShader(prog, fs)
    gl.linkProgram(prog)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.warn('[chengying-gl] Link fallback to 2D:', gl.getProgramInfoLog(prog))
      this.ctx2d = this.canvas.getContext('2d')
      return
    }

    this.gl = gl
    this.program = prog

    const vao = gl.createVertexArray()
    gl.bindVertexArray(vao)
    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    )
    const loc = gl.getAttribLocation(prog, 'a_pos')
    gl.enableVertexAttribArray(loc)
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
    this.vao = vao

    const names = [
      'u_photo',
      'u_curveLut',
      'u_texelSize',
      'u_resolution',
      'u_time',
      'u_exposure',
      'u_temp',
      'u_tint',
      'u_contrast',
      'u_highlights',
      'u_shadows',
      'u_blacks',
      'u_vibrance',
      'u_saturation',
      'u_clarity',
      'u_dehaze',
      'u_shadowTint',
      'u_highlightTint',
      'u_rawBase',
      'u_maskGeomA',
      'u_maskGeomB',
      'u_splitPos',
      'u_compareHold',
      'u_showMask',
      'u_showZebra',
      'u_loupe',
    ]
    for (const n of names) {
      this.uniforms[n] = gl.getUniformLocation(prog, n)
    }

    gl.activeTexture(gl.TEXTURE0)
    this.photoTex = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, this.photoTex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      1,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array([18, 18, 22, 255]),
    )

    gl.activeTexture(gl.TEXTURE1)
    this.lutTex = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, this.lutBuffer)
    gl.activeTexture(gl.TEXTURE0)
  }

  private compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader | null {
    const sh = gl.createShader(type)
    if (!sh) return null
    gl.shaderSource(sh, src)
    gl.compileShader(sh)
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      console.warn('[chengying-gl] Shader compile warning:', gl.getShaderInfoLog(sh))
      gl.deleteShader(sh)
      return null
    }
    return sh
  }

  public async setPhoto(src: string): Promise<void> {
    let img = this.imageCache.get(src)
    if (!img) {
      img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image()
        el.decoding = 'async'
        el.onload = () => resolve(el)
        el.onerror = (err) => reject(err)
        el.src = src
      })
      this.imageCache.set(src, img)
    }
    this.currentImage = img

    let cachedThumb = this.thumbPixelCache.get(src)
    if (!cachedThumb && this.statsCtx) {
      this.statsCtx.clearRect(0, 0, this.statsCanvas.width, this.statsCanvas.height)
      this.statsCtx.drawImage(img, 0, 0, this.statsCanvas.width, this.statsCanvas.height)
      cachedThumb = new Uint8ClampedArray(
        this.statsCtx.getImageData(0, 0, this.statsCanvas.width, this.statsCanvas.height).data,
      )
      this.thumbPixelCache.set(src, cachedThumb)
    }
    this.currentThumbPixels = cachedThumb ?? null

    if (this.gl && this.photoTex && !this.gl.isContextLost()) {
      const gl = this.gl
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, this.photoTex)
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img)
    }
    this.requestRender(true)
  }

  public setParams(params: DarkroomParams): void {
    this.params = params
    this.uploadCurveLut(params.curves)
    this.requestRender(true)
  }

  public setRawBaseline(ev: number, contrast: number, sat: number, temp: number): void {
    this.rawBase = [ev, contrast, sat, temp]
    this.requestRender(false)
  }

  public setSplit(pos: number): void {
    this.splitPos = pos
    this.requestRender(false)
  }

  public setCompareHold(hold: boolean): void {
    this.compareHold = hold
    this.requestRender(true)
  }

  public setOverlays(showMask: boolean, showZebra: boolean): void {
    this.showMask = showMask
    this.showZebra = showZebra
    this.requestRender(false)
  }

  public setLoupe(enabled: boolean, x = 0.5, y = 0.5): void {
    this.loupe = { enabled, x, y }
    this.requestRender(false)
  }

  private uploadCurveLut(curves: Record<CurveChannel, Array<[number, number]>>): void {
    const r = evaluateMonotonicSpline256(curves.red)
    const g = evaluateMonotonicSpline256(curves.green)
    const b = evaluateMonotonicSpline256(curves.blue)
    const m = evaluateMonotonicSpline256(curves.master)
    for (let i = 0; i < 256; i++) {
      this.lutBuffer[i * 4] = r[i]
      this.lutBuffer[i * 4 + 1] = g[i]
      this.lutBuffer[i * 4 + 2] = b[i]
      this.lutBuffer[i * 4 + 3] = m[i]
    }
    if (this.gl && this.lutTex && !this.gl.isContextLost()) {
      const gl = this.gl
      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, this.lutTex)
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 1, gl.RGBA, gl.UNSIGNED_BYTE, this.lutBuffer)
      gl.activeTexture(gl.TEXTURE0)
    }
  }

  public resize(): void {
    const rect = this.canvas.getBoundingClientRect()
    if (rect.width < 4 || rect.height < 4) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    // Cap internal renderbuffer width to 1440px (matches 1600px source plates while keeping VRAM lean)
    const effScale = Math.min(dpr, 1440 / Math.max(1, rect.width))
    const targetW = Math.max(64, Math.round(rect.width * effScale))
    const targetH = Math.max(48, Math.round(rect.height * effScale))
    if (this.canvas.width !== targetW || this.canvas.height !== targetH) {
      this.canvas.width = targetW
      this.canvas.height = targetH
      this.requestRender(false)
    }
  }

  public requestRender(recomputeStats = false): void {
    this.needsDraw = true
    if (recomputeStats) this.lastStatsTime = 0
    if (this.rafId === 0) {
      this.rafId = requestAnimationFrame((ts) => this.tick(ts))
    }
  }

  private tick(ts: number): void {
    this.rafId = 0
    if (!this.needsDraw) return
    this.needsDraw = false
    this.resize()

    if (this.gl && this.program && this.vao && !this.gl.isContextLost()) {
      this.drawWebGL(ts * 0.001)
    } else if (this.ctx2d) {
      this.drawFallback2D()
    }

    if (this.onStats && ts - this.lastStatsTime > 60) {
      this.lastStatsTime = ts
      this.computePhotometricStats()
    }
  }

  private drawWebGL(timeSec: number): void {
    const gl = this.gl!
    const p = this.params
    gl.viewport(0, 0, this.canvas.width, this.canvas.height)
    gl.useProgram(this.program!)
    gl.bindVertexArray(this.vao!)

    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.photoTex)
    gl.uniform1i(this.uniforms.u_photo, 0)

    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex)
    gl.uniform1i(this.uniforms.u_curveLut, 1)

    const imgW = this.currentImage?.naturalWidth || 1600
    const imgH = this.currentImage?.naturalHeight || 1067
    gl.uniform2f(this.uniforms.u_texelSize, 1 / imgW, 1 / imgH)
    gl.uniform2f(this.uniforms.u_resolution, this.canvas.width, this.canvas.height)
    gl.uniform1f(this.uniforms.u_time, timeSec)

    gl.uniform1f(this.uniforms.u_exposure, p?.exposure ?? 0)
    gl.uniform1f(this.uniforms.u_temp, p?.temperature ?? 0)
    gl.uniform1f(this.uniforms.u_tint, p?.tint ?? 0)
    gl.uniform1f(this.uniforms.u_contrast, p?.contrast ?? 0)
    gl.uniform1f(this.uniforms.u_highlights, p?.highlights ?? 0)
    gl.uniform1f(this.uniforms.u_shadows, p?.shadows ?? 0)
    gl.uniform1f(this.uniforms.u_blacks, p?.blacks ?? 0)
    gl.uniform1f(this.uniforms.u_vibrance, p?.vibrance ?? 0)
    gl.uniform1f(this.uniforms.u_saturation, p?.saturation ?? 0)
    gl.uniform1f(this.uniforms.u_clarity, p?.clarity ?? 0)
    gl.uniform1f(this.uniforms.u_dehaze, p?.dehaze ?? 0)

    const shTint = hslHueToLinearVec(p?.splitShadowHue ?? 212, p?.splitShadowSat ?? 0)
    const hiTint = hslHueToLinearVec(p?.splitHighlightHue ?? 38, p?.splitHighlightSat ?? 0)
    gl.uniform3f(this.uniforms.u_shadowTint, shTint[0], shTint[1], shTint[2])
    gl.uniform3f(this.uniforms.u_highlightTint, hiTint[0], hiTint[1], hiTint[2])

    gl.uniform4f(
      this.uniforms.u_rawBase,
      this.rawBase[0],
      this.rawBase[1],
      this.rawBase[2],
      this.rawBase[3],
    )

    const mask = p?.mask
    const maskKindInt =
      !mask || mask.kind === 'none'
        ? 0
        : mask.kind === 'ellipse'
          ? 1
          : mask.kind === 'gradient'
            ? 2
            : 3
    gl.uniform4f(
      this.uniforms.u_maskGeomA,
      maskKindInt,
      mask?.cx ?? 0.5,
      mask?.cy ?? 0.42,
      mask?.feather ?? 0.18,
    )
    gl.uniform4f(
      this.uniforms.u_maskGeomB,
      mask?.rx ?? 0.22,
      mask?.ry ?? 0.28,
      mask?.ev ?? 0,
      mask?.temp ?? 0,
    )

    gl.uniform1f(this.uniforms.u_splitPos, this.splitPos)
    gl.uniform1f(this.uniforms.u_compareHold, this.compareHold ? 1 : 0)
    gl.uniform1f(this.uniforms.u_showMask, this.showMask ? 1 : 0)
    gl.uniform1f(this.uniforms.u_showZebra, this.showZebra ? 1 : 0)
    gl.uniform3f(
      this.uniforms.u_loupe,
      this.loupe.x,
      this.loupe.y,
      this.loupe.enabled ? 1 : 0,
    )

    gl.drawArrays(gl.TRIANGLES, 0, 6)
    gl.activeTexture(gl.TEXTURE0)
  }

  private drawFallback2D(): void {
    const ctx = this.ctx2d
    const img = this.currentImage
    if (!ctx || !img) return
    const w = this.canvas.width
    const h = this.canvas.height
    ctx.clearRect(0, 0, w, h)

    const p = this.params
    const drawFiltered = (ev: number, contrast: number, sat: number, temp: number) => {
      const bright = Math.pow(2, ev * 0.55) * 100
      const cont = 100 + contrast * 0.8
      const satur = Math.max(0, 100 + sat)
      const sepia = temp > 0 ? Math.min(28, temp * 0.4) : 0
      const hueRot = temp < 0 ? temp * 0.35 : 0
      ctx.filter = `brightness(${bright.toFixed(1)}%) contrast(${cont.toFixed(1)}%) saturate(${satur.toFixed(1)}%) sepia(${sepia.toFixed(1)}%) hue-rotate(${hueRot.toFixed(1)}deg)`
      ctx.drawImage(img, 0, 0, w, h)
      ctx.filter = 'none'
    }

    if (this.compareHold) {
      drawFiltered(this.rawBase[0], this.rawBase[1], this.rawBase[2], this.rawBase[3])
      return
    }

    if (this.splitPos >= 0) {
      const splitPx = Math.round(w * this.splitPos)
      ctx.save()
      ctx.beginPath()
      ctx.rect(0, 0, splitPx, h)
      ctx.clip()
      drawFiltered(this.rawBase[0], this.rawBase[1], this.rawBase[2], this.rawBase[3])
      ctx.restore()

      ctx.save()
      ctx.beginPath()
      ctx.rect(splitPx, 0, w - splitPx, h)
      ctx.clip()
      drawFiltered(
        p?.exposure ?? 0,
        p?.contrast ?? 0,
        (p?.saturation ?? 0) + (p?.vibrance ?? 0) * 0.6,
        p?.temperature ?? 0,
      )
      ctx.restore()
    } else {
      drawFiltered(
        p?.exposure ?? 0,
        p?.contrast ?? 0,
        (p?.saturation ?? 0) + (p?.vibrance ?? 0) * 0.6,
        p?.temperature ?? 0,
      )
    }
  }

  /**
   * Zero-stall photometric scope analyzer: evaluates graded tone/color & LUT
   * directly over the cached 128x85 source thumbnail (~0.2ms on CPU) without
   * ever stalling the WebGL GPU pipeline with readPixels / drawImage(glCanvas).
   */
  private computePhotometricStats(): void {
    const src = this.currentThumbPixels
    if (!src || !this.onStats) return

    const p = this.params
    const useRaw = this.compareHold
    const ev = useRaw ? this.rawBase[0] : (p?.exposure ?? 0)
    const evGain = Math.pow(2, ev)
    const temp = (useRaw ? this.rawBase[3] : (p?.temperature ?? 0)) * 0.0055
    const tint = (useRaw ? 0 : (p?.tint ?? 0)) * 0.0042
    const contrastSlope = 1 + (useRaw ? this.rawBase[1] * 0.008 : (p?.contrast ?? 0) * 0.0075)
    const satScale = Math.max(
      0,
      1 +
        (useRaw
          ? this.rawBase[2] * 0.01
          : ((p?.saturation ?? 0) + (p?.vibrance ?? 0) * 0.55) * 0.01),
    )
    const shLift = useRaw ? 0 : (p?.shadows ?? 0) * 0.0028
    const hiRoll = useRaw ? 0 : (p?.highlights ?? 0) * 0.003

    const lumaBins = new Uint32Array(64)
    const rBins = new Uint32Array(64)
    const gBins = new Uint32Array(64)
    const bBins = new Uint32Array(64)
    const luma256 = new Uint32Array(256)
    const total = src.length / 4
    let clipHigh = 0
    let clipLow = 0
    const lut = this.lutBuffer

    for (let i = 0; i < src.length; i += 4) {
      let r = Math.pow(src[i] / 255, 2.2) * evGain * (1 + temp + tint * 0.45)
      let g = Math.pow(src[i + 1] / 255, 2.2) * evGain * (1 - tint * 0.65)
      let b = Math.pow(src[i + 2] / 255, 2.2) * evGain * (1 - temp + tint * 0.35)

      r = Math.pow(Math.max(0, r), 1 / 2.2)
      g = Math.pow(Math.max(0, g), 1 / 2.2)
      b = Math.pow(Math.max(0, b), 1 / 2.2)

      const y0 = 0.2126 * r + 0.7152 * g + 0.0722 * b
      const dy = shLift * (1 - y0) * (1 - y0) + hiRoll * y0 * y0
      const y1 = Math.max(0, Math.min(1, (y0 + dy - 0.48) * contrastSlope + 0.48))
      const delta = y1 - y0
      r = y1 + (r + delta - y1) * satScale
      g = y1 + (g + delta - y1) * satScale
      b = y1 + (b + delta - y1) * satScale

      let ri = Math.max(0, Math.min(255, Math.round(r * 255)))
      let gi = Math.max(0, Math.min(255, Math.round(g * 255)))
      let bi = Math.max(0, Math.min(255, Math.round(b * 255)))

      if (!useRaw) {
        ri = lut[lut[ri * 4] * 4 + 3]
        gi = lut[lut[gi * 4 + 1] * 4 + 3]
        bi = lut[lut[bi * 4 + 2] * 4 + 3]
      }

      const yi = Math.min(255, Math.max(0, Math.round(0.2126 * ri + 0.7152 * gi + 0.0722 * bi)))
      luma256[yi]++
      lumaBins[yi >> 2]++
      rBins[ri >> 2]++
      gBins[gi >> 2]++
      bBins[bi >> 2]++
      if (yi >= 249 || (ri >= 253 && gi >= 253 && bi >= 253)) clipHigh++
      if (yi <= 4) clipLow++
    }

    const percentile = (q: number) => {
      const target = total * q
      let acc = 0
      for (let k = 0; k < 256; k++) {
        acc += luma256[k]
        if (acc >= target) return k
      }
      return 255
    }

    this.onStats({
      p05: percentile(0.05),
      p50: percentile(0.5),
      p95: percentile(0.95),
      clipHighPct: Number(((clipHigh / total) * 100).toFixed(2)),
      clipLowPct: Number(((clipLow / total) * 100).toFixed(2)),
      lumaBins,
      rBins,
      gBins,
      bBins,
    })
  }
}
