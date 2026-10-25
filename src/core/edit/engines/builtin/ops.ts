/**
 * Built-in operators (linear-light float pipeline). Each operator declares a
 * complete JSON-Schema for its parameters; the catalog is generated from this
 * registry, so adding an operator here exposes it to the agent automatically.
 */
import { readFileSync } from 'node:fs'
import type { ParamSchema } from '../../schema.ts'
import { boxBlur, clone, gaussBlur, guidedFilter, lumaOf, luminancePlane, sample, toLinear, toSrgb, type FImage } from './image.ts'
import { ChengyingError } from '../../../util/errors.ts'

export interface OpContext { readable(path: string): string; seed: number }

export interface BuiltinOp {
  id: string
  title: string
  description: string
  category: 'tone' | 'color' | 'detail' | 'effect' | 'geometry' | 'repair'
  params: ParamSchema
  geometry?: boolean
  maskable: boolean
  apply(img: FImage, p: Record<string, any>, ctx: OpContext): FImage
}

const num = (min: number, max: number, def: number, description: string, unit?: string): ParamSchema => ({ type: 'number', minimum: min, maximum: max, default: def, description, ...(unit ? { 'x-unit': unit } : {}) })
const obj = (properties: Record<string, ParamSchema>, description?: string): ParamSchema => ({ type: 'object', properties, additionalProperties: false, ...(description ? { description } : {}) })
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

function mapPixels(img: FImage, fn: (r: number, g: number, b: number) => [number, number, number]): FImage {
  const out = new Float32Array(img.data.length)
  const d = img.data
  for (let j = 0; j < d.length; j += 3) {
    const [r, g, b] = fn(d[j] as number, d[j + 1] as number, d[j + 2] as number)
    out[j] = r; out[j + 1] = g; out[j + 2] = b
  }
  return { width: img.width, height: img.height, data: out }
}

/** Monotone cubic (Fritsch–Carlson) interpolation as a 4096-entry LUT on [0,1]. */
export function curveLut(points: Array<[number, number]>): Float32Array {
  const pts = [...points].map(([x, y]) => [clamp01(x), clamp01(y)] as [number, number]).sort((a, b) => a[0] - b[0])
  if (pts.length === 0 || pts[0]?.[0] !== 0) pts.unshift([0, pts[0]?.[1] ?? 0])
  if ((pts[pts.length - 1] as [number, number])[0] !== 1) pts.push([1, (pts[pts.length - 1] as [number, number])[1]])
  const n = pts.length
  const xs = pts.map(p => p[0]); const ys = pts.map(p => p[1])
  const dx: number[] = []; const m: number[] = []
  for (let i = 0; i < n - 1; i++) { dx.push(Math.max(1e-6, (xs[i + 1] as number) - (xs[i] as number))); m.push(((ys[i + 1] as number) - (ys[i] as number)) / (dx[i] as number)) }
  const t: number[] = [m[0] as number]
  for (let i = 1; i < n - 1; i++) t.push((m[i - 1] as number) * (m[i] as number) <= 0 ? 0 : ((m[i - 1] as number) + (m[i] as number)) / 2)
  t.push(m[n - 2] as number)
  for (let i = 0; i < n - 1; i++) {
    if ((m[i] as number) === 0) { t[i] = 0; t[i + 1] = 0; continue }
    const a = (t[i] as number) / (m[i] as number); const b = (t[i + 1] as number) / (m[i] as number)
    const s = a * a + b * b
    if (s > 9) { const k = 3 / Math.sqrt(s); t[i] = k * a * (m[i] as number); t[i + 1] = k * b * (m[i] as number) }
  }
  const lut = new Float32Array(4096)
  let seg = 0
  for (let k = 0; k < 4096; k++) {
    const x = k / 4095
    while (seg < n - 2 && x > (xs[seg + 1] as number)) seg++
    const h = dx[seg] as number
    const u = (x - (xs[seg] as number)) / h
    const h00 = 2 * u ** 3 - 3 * u ** 2 + 1; const h10 = u ** 3 - 2 * u ** 2 + u; const h01 = -2 * u ** 3 + 3 * u ** 2; const h11 = u ** 3 - u ** 2
    lut[k] = clamp01(h00 * (ys[seg] as number) + h10 * h * (t[seg] as number) + h01 * (ys[seg + 1] as number) + h11 * h * (t[seg + 1] as number))
  }
  return lut
}

const lutAt = (lut: Float32Array, v: number): number => lut[Math.round(clamp01(v) * 4095)] as number

/** Apply a perceptual-domain luminance mapping while keeping chroma ratios. */
function mapLuminance(img: FImage, f: (perceptualY: number) => number): FImage {
  return mapPixels(img, (r, g, b) => {
    const y = lumaOf(r, g, b)
    if (y <= 1e-7) return [r, g, b]
    const yp = toSrgb(y)
    const ny = toLinear(Math.max(0, f(yp)))
    const k = ny / y
    return [r * k, g * k, b * k]
  })
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b); const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  h *= 60
  return [h, s, l]
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s <= 0) return [l, l, l]
  const hue = (((h % 360) + 360) % 360) / 360
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const f = (t: number): number => {
    let tt = t
    if (tt < 0) tt += 1
    if (tt > 1) tt -= 1
    if (tt < 1 / 6) return p + (q - p) * 6 * tt
    if (tt < 1 / 2) return q
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6
    return p
  }
  return [f(hue + 1 / 3), f(hue), f(hue - 1 / 3)]
}

const HSL_BANDS: Array<[string, number]> = [['red', 0], ['orange', 30], ['yellow', 60], ['green', 120], ['aqua', 180], ['blue', 240], ['purple', 280], ['magenta', 320]]

function parseCube(text: string): { size: number; table: Float32Array; domainMin: number[]; domainMax: number[] } {
  let size = 0
  const values: number[] = []
  let domainMin = [0, 0, 0]
  let domainMax = [1, 1, 1]
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    if (line.startsWith('LUT_3D_SIZE')) { size = Number(line.split(/\s+/)[1]); continue }
    if (line.startsWith('DOMAIN_MIN')) { domainMin = line.split(/\s+/).slice(1).map(Number); continue }
    if (line.startsWith('DOMAIN_MAX')) { domainMax = line.split(/\s+/).slice(1).map(Number); continue }
    if (/^[A-Z_]/.test(line)) continue
    const parts = line.split(/\s+/).map(Number)
    if (parts.length >= 3 && parts.every(Number.isFinite)) values.push(parts[0] as number, parts[1] as number, parts[2] as number)
  }
  if (size < 2 || values.length !== size ** 3 * 3) throw new ChengyingError('invalid-argument', `.cube file: expected LUT_3D_SIZE with ${size ** 3} entries`)
  return { size, table: Float32Array.from(values), domainMin, domainMax }
}

function warpTo(src: FImage, w: number, h: number, map: (x: number, y: number) => [number, number]): FImage {
  const out = new Float32Array(w * h * 3)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [sx, sy] = map(x + 0.5, y + 0.5)
      const o = (y * w + x) * 3
      if (sx < -0.5 || sy < -0.5 || sx > src.width - 0.5 || sy > src.height - 0.5) { out[o] = 0; out[o + 1] = 0; out[o + 2] = 0; continue }
      for (let c = 0; c < 3; c++) out[o + c] = sample(src, sx - 0.5, sy - 0.5, c)
    }
  }
  return { width: w, height: h, data: out }
}

/** Largest axis-aligned rectangle (centered) inside a rotated w×h rectangle. */
function rotatedCrop(w: number, h: number, angle: number): [number, number] {
  const a = Math.abs(angle)
  const sin = Math.sin(a); const cos = Math.cos(a)
  const sideLong = Math.max(w, h); const sideShort = Math.min(w, h)
  if (sideShort <= 2 * sin * cos * sideLong || Math.abs(sin - cos) < 1e-10) {
    const x = 0.5 * sideShort
    return w >= h ? [x / sin, x / cos] : [x / cos, x / sin]
  }
  const cos2 = cos * cos - sin * sin
  return [(w * cos - h * sin) / cos2, (h * cos - w * sin) / cos2]
}

function solveHomography(src: Array<[number, number]>, dst: Array<[number, number]>): number[] {
  // Solve for H mapping dst → src (8 unknowns) with Gaussian elimination.
  const A: number[][] = []
  const b: number[] = []
  for (let i = 0; i < 4; i++) {
    const [x, y] = dst[i] as [number, number]
    const [u, v] = src[i] as [number, number]
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u)
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v)
  }
  const n = 8
  for (let c = 0; c < n; c++) {
    let p = c
    for (let r = c + 1; r < n; r++) if (Math.abs((A[r] as number[])[c] as number) > Math.abs((A[p] as number[])[c] as number)) p = r
    ;[A[c], A[p]] = [A[p] as number[], A[c] as number[]]
    ;[b[c], b[p]] = [b[p] as number, b[c] as number]
    const piv = (A[c] as number[])[c] as number
    for (let r = 0; r < n; r++) {
      if (r === c) continue
      const f = ((A[r] as number[])[c] as number) / piv
      for (let k = c; k < n; k++) (A[r] as number[])[k] = ((A[r] as number[])[k] as number) - f * ((A[c] as number[])[k] as number)
      b[r] = (b[r] as number) - f * (b[c] as number)
    }
  }
  return [...Array.from({ length: n }, (_, i) => (b[i] as number) / ((A[i] as number[])[i] as number)), 1]
}

let lutCache: { path: string; cube: ReturnType<typeof parseCube> } | undefined

export const BUILTIN_OPS: BuiltinOp[] = [
  {
    id: 'exposure', title: 'Exposure', category: 'tone', maskable: true,
    description: 'Scale scene light in EV (linear multiply).',
    params: obj({ ev: num(-6, 6, 0, 'exposure compensation', 'EV') }),
    apply: (img, p) => { const k = 2 ** p.ev; return mapPixels(img, (r, g, b) => [r * k, g * k, b * k]) },
  },
  {
    id: 'white_balance', title: 'White balance', category: 'color', maskable: true,
    description: 'Temperature (blue↔amber) and tint (green↔magenta) correction as channel gains in linear light.',
    params: obj({ temperature: num(-100, 100, 0, 'negative cooler, positive warmer'), tint: num(-100, 100, 0, 'negative greener, positive more magenta') }),
    apply: (img, p) => {
      const t = p.temperature / 100; const ti = p.tint / 100
      const kr = 2 ** (0.45 * t); const kb = 2 ** (-0.45 * t); const kg = 2 ** (-0.3 * ti)
      const norm = lumaOf(kr, kg, kb)
      return mapPixels(img, (r, g, b) => [(r * kr) / norm, (g * kg) / norm, (b * kb) / norm])
    },
  },
  {
    id: 'tone', title: 'Basic tone', category: 'tone', maskable: true,
    description: 'Lightroom-style basic tone: contrast, highlights, shadows, whites, blacks, brightness (perceptual luminance, chroma preserved).',
    params: obj({
      contrast: num(-100, 100, 0, 'midtone contrast'), highlights: num(-100, 100, 0, 'recover (−) or boost (+) highlights'),
      shadows: num(-100, 100, 0, 'lift (+) or deepen (−) shadows'), whites: num(-100, 100, 0, 'white point'), blacks: num(-100, 100, 0, 'black point'),
      brightness: num(-100, 100, 0, 'overall midtone brightness'),
    }),
    apply: (img, p) => {
      const c = p.contrast / 100; const hl = p.highlights / 100; const sh = p.shadows / 100; const wh = p.whites / 100; const bl = p.blacks / 100; const br = p.brightness / 100
      const lut = new Float32Array(4096)
      for (let k = 0; k < 4096; k++) {
        let x = k / 4095
        x = x * (1 + wh * 0.25) + bl * 0.06 * (1 - x)
        x = clamp01(x)
        if (br !== 0) x = x ** (br > 0 ? 1 / (1 + br * 0.8) : 1 - br * 0.8)
        if (c !== 0) { const s = 1 / (1 + Math.exp(-(x - 0.5) * (4 + 6 * Math.abs(c)))); const s0 = 1 / (1 + Math.exp((4 + 6 * Math.abs(c)) / 2)); const s1 = 1 - s0; const sc = (s - s0) / (s1 - s0); x = c > 0 ? x + (sc - x) * c : x + (x - sc) * c * 0.6 }
        const shadowW = (1 - x) ** 3; const highW = x ** 3
        x += sh * 0.35 * shadowW * (x < 0.5 ? 1 : 0.5) + hl * 0.35 * highW * (hl < 0 ? 1 : 0.5)
        lut[k] = clamp01(x)
      }
      return mapLuminance(img, y => lutAt(lut, y))
    },
  },
  {
    id: 'curve', title: 'Tone curve', category: 'tone', maskable: true,
    description: 'Monotone cubic curve through control points in perceptual (sRGB-encoded) space, applied to luminance, all RGB channels or a single channel.',
    params: obj({
      points: { type: 'array', items: { type: 'array', items: { type: 'number', minimum: 0, maximum: 1 }, minItems: 2, maxItems: 2 }, minItems: 2, maxItems: 32, default: [[0, 0], [1, 1]], description: '[[input, output], …] in 0..1' },
      channel: { type: 'string', enum: ['luma', 'rgb', 'red', 'green', 'blue'], default: 'luma', description: 'luma keeps saturation; rgb applies per channel' },
    }),
    apply: (img, p) => {
      const lut = curveLut(p.points)
      if (p.channel === 'luma') return mapLuminance(img, y => lutAt(lut, y))
      const ch = { red: 0, green: 1, blue: 2 } as Record<string, number>
      return mapPixels(img, (r, g, b) => {
        const v = [r, g, b]
        return v.map((x, i) => (p.channel === 'rgb' || ch[p.channel] === i ? toLinear(lutAt(lut, toSrgb(x))) : x)) as [number, number, number]
      })
    },
  },
  {
    id: 'levels', title: 'Levels', category: 'tone', maskable: true,
    description: 'Input black/white points and midtone gamma (perceptual).',
    params: obj({ black: num(0, 0.5, 0, 'input black point'), white: num(0.5, 1, 1, 'input white point'), gamma: num(0.2, 5, 1, 'midtone gamma (>1 brighter)'), channel: { type: 'string', enum: ['rgb', 'red', 'green', 'blue'], default: 'rgb' } }),
    apply: (img, p) => {
      const f = (x: number): number => toLinear(clamp01((toSrgb(x) - p.black) / Math.max(1e-3, p.white - p.black)) ** (1 / p.gamma))
      const ch = { red: 0, green: 1, blue: 2 } as Record<string, number>
      return mapPixels(img, (r, g, b) => [r, g, b].map((x, i) => (p.channel === 'rgb' || ch[p.channel] === i ? f(x) : x)) as [number, number, number])
    },
  },
  {
    id: 'saturation', title: 'Saturation & vibrance', category: 'color', maskable: true,
    description: 'Global saturation and vibrance (boosts muted colors more, protects skin-like hues).',
    params: obj({ saturation: num(-100, 100, 0, 'global saturation'), vibrance: num(-100, 100, 0, 'adaptive saturation') }),
    apply: (img, p) => mapPixels(img, (r, g, b) => {
      const y = lumaOf(r, g, b)
      const R = toSrgb(r); const G = toSrgb(g); const B = toSrgb(b)
      const [hh, s] = rgbToHsl(R, G, B)
      const skin = hh > 10 && hh < 50 ? 0.5 : 1
      let k = 1 + p.saturation / 100
      k *= 1 + (p.vibrance / 100) * (1 - s) * skin
      return [y + (r - y) * k, y + (g - y) * k, y + (b - y) * k]
    }),
  },
  {
    id: 'hsl', title: 'HSL / color mixer', category: 'color', maskable: true,
    description: 'Per-color hue shift, saturation and luminance for 8 hue bands (red, orange, yellow, green, aqua, blue, purple, magenta).',
    params: obj(Object.fromEntries(HSL_BANDS.map(([name]) => [name, obj({ hue: num(-100, 100, 0, 'hue shift (±30°)'), saturation: num(-100, 100, 0, 'saturation'), luminance: num(-100, 100, 0, 'luminance') })]))),
    apply: (img, p) => mapPixels(img, (r, g, b) => {
      const [hh, s, l] = rgbToHsl(toSrgb(r), toSrgb(g), toSrgb(b))
      if (s < 1e-4) return [r, g, b]
      let dh = 0; let ds = 0; let dl = 0; let wsum = 0
      for (const [name, center] of HSL_BANDS) {
        const d = Math.min(Math.abs(hh - center), 360 - Math.abs(hh - center))
        const w = Math.max(0, 1 - d / 40)
        if (w === 0) continue
        const band = p[name] as { hue: number; saturation: number; luminance: number }
        dh += w * band.hue * 0.3; ds += w * band.saturation / 100; dl += w * band.luminance / 100; wsum += w
      }
      if (wsum === 0) return [r, g, b]
      const nl = clamp01(l + dl * 0.25 * s)
      const [R, G, B] = hslToRgb(hh + dh, clamp01(s * (1 + ds)), nl)
      return [toLinear(R), toLinear(G), toLinear(B)]
    }),
  },
  {
    id: 'color_grading', title: 'Color grading', category: 'color', maskable: true,
    description: 'Three-way color grading: tint shadows, midtones and highlights (hue in degrees, saturation 0..100), with balance.',
    params: obj({
      shadows: obj({ hue: num(0, 360, 220, 'hue (deg)'), saturation: num(0, 100, 0, 'strength') }),
      midtones: obj({ hue: num(0, 360, 40, 'hue (deg)'), saturation: num(0, 100, 0, 'strength') }),
      highlights: obj({ hue: num(0, 360, 45, 'hue (deg)'), saturation: num(0, 100, 0, 'strength') }),
      balance: num(-100, 100, 0, 'shift the shadow/highlight split'),
    }),
    apply: (img, p) => {
      const tint = (hue: number, sat: number): [number, number, number] => {
        const [r, g, b] = hslToRgb(hue, 1, 0.5)
        const k = sat / 100 * 0.25
        return [r - 0.5, g - 0.5, b - 0.5].map(v => v * k) as [number, number, number]
      }
      const ts = tint(p.shadows.hue, p.shadows.saturation); const tm = tint(p.midtones.hue, p.midtones.saturation); const th = tint(p.highlights.hue, p.highlights.saturation)
      const pivot = 0.5 + p.balance / 250
      return mapPixels(img, (r, g, b) => {
        const y = toSrgb(lumaOf(r, g, b))
        const ws = clamp01(1 - y / pivot) ** 1.5; const wh = clamp01((y - pivot) / (1 - pivot)) ** 1.5; const wm = 1 - ws - wh
        return [r, g, b].map((v, i) => toLinear(clamp01(toSrgb(v) + ws * (ts[i] as number) + wm * (tm[i] as number) + wh * (th[i] as number)))) as [number, number, number]
      })
    },
  },
  {
    id: 'channel_mixer', title: 'Channel mixer', category: 'color', maskable: true,
    description: 'Linear 3×3 RGB matrix (rows: output R, G, B). Identity is [[1,0,0],[0,1,0],[0,0,1]].',
    params: obj({ matrix: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'number', minimum: -2, maximum: 2 } }, default: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] }, preserve_luminance: { type: 'boolean', default: true } }),
    apply: (img, p) => mapPixels(img, (r, g, b) => {
      const m = p.matrix as number[][]
      const out = m.map(row => (row[0] as number) * r + (row[1] as number) * g + (row[2] as number) * b) as [number, number, number]
      if (!p.preserve_luminance) return out
      const y0 = lumaOf(r, g, b); const y1 = lumaOf(...out)
      const k = y1 > 1e-7 ? y0 / y1 : 1
      return [out[0] * k, out[1] * k, out[2] * k]
    }),
  },
  {
    id: 'black_white', title: 'Black & white', category: 'color', maskable: true,
    description: 'Monochrome conversion with per-channel mix (like color filters on B&W film).',
    params: obj({ red: num(-200, 300, 30, 'red contribution %'), green: num(-200, 300, 59, 'green contribution %'), blue: num(-200, 300, 11, 'blue contribution %') }),
    apply: (img, p) => { const s = (p.red + p.green + p.blue) / 100 || 1; return mapPixels(img, (r, g, b) => { const y = Math.max(0, (r * p.red + g * p.green + b * p.blue) / 100 / s); return [y, y, y] }) },
  },
  {
    id: 'clarity', title: 'Clarity / local contrast', category: 'detail', maskable: true,
    description: 'Edge-aware local contrast on luminance (guided-filter base/detail split).',
    params: obj({ amount: num(-100, 100, 0, 'strength'), radius: num(2, 200, 30, 'detail scale in pixels at full size') }),
    apply: (img, p) => {
      const Y = luminancePlane(img)
      const L = new Float32Array(Y.length)
      for (let i = 0; i < Y.length; i++) L[i] = Math.log2((Y[i] as number) + 1e-4)
      const r = Math.max(1, Math.round(p.radius * Math.max(img.width, img.height) / 3000))
      const base = guidedFilter(L, L, img.width, img.height, r, 0.04)
      const k = p.amount / 100
      const out = new Float32Array(img.data.length)
      for (let i = 0, j = 0; i < Y.length; i++, j += 3) {
        const detail = (L[i] as number) - (base[i] as number)
        const gain = 2 ** (detail * k)
        out[j] = (img.data[j] as number) * gain; out[j + 1] = (img.data[j + 1] as number) * gain; out[j + 2] = (img.data[j + 2] as number) * gain
      }
      return { width: img.width, height: img.height, data: out }
    },
  },
  {
    id: 'dehaze', title: 'Dehaze', category: 'detail', maskable: true,
    description: 'Dark-channel-prior haze removal (positive) or atmospheric haze (negative).',
    params: obj({ amount: num(-100, 100, 0, 'strength') }),
    apply: (img, p) => {
      const n = img.width * img.height
      const dark = new Float32Array(n)
      for (let i = 0, j = 0; i < n; i++, j += 3) dark[i] = Math.min(img.data[j] as number, img.data[j + 1] as number, img.data[j + 2] as number)
      const r = Math.max(2, Math.round(Math.max(img.width, img.height) / 120))
      const dc = boxBlur(dark, img.width, img.height, r)
      const sorted = Array.from(dc).sort((a, b) => b - a)
      const A = Math.max(0.2, sorted[Math.floor(n * 0.001)] ?? 1)
      const k = p.amount / 100
      const out = new Float32Array(img.data.length)
      for (let i = 0, j = 0; i < n; i++, j += 3) {
        const t = Math.max(0.15, 1 - 0.95 * k * ((dc[i] as number) / A))
        for (let c = 0; c < 3; c++) {
          const v = img.data[j + c] as number
          out[j + c] = k >= 0 ? Math.max(0, (v - A) / t + A) : v + (A - v) * -k * 0.5
        }
      }
      return { width: img.width, height: img.height, data: out }
    },
  },
  {
    id: 'denoise', title: 'Noise reduction', category: 'detail', maskable: true,
    description: 'Edge-preserving luminance noise reduction (guided filter) and chroma noise reduction (opponent-channel smoothing).',
    params: obj({ luminance: num(0, 100, 0, 'luminance smoothing'), chroma: num(0, 100, 25, 'color noise smoothing'), detail: num(0, 100, 50, 'detail preservation') }),
    apply: (img, p) => {
      const { width: w, height: h } = img
      const n = w * h
      const Y = luminancePlane(img)
      let Yn = Y
      if (p.luminance > 0) {
        const eps = (p.luminance / 100) ** 2 * 0.004 * (1.5 - p.detail / 100)
        Yn = guidedFilter(Y, Y, w, h, Math.max(1, Math.round(1 + p.luminance / 40)), Math.max(1e-6, eps))
      }
      const cr = new Float32Array(n); const cb = new Float32Array(n)
      for (let i = 0, j = 0; i < n; i++, j += 3) { cr[i] = (img.data[j] as number) - (Y[i] as number); cb[i] = (img.data[j + 2] as number) - (Y[i] as number) }
      const rad = Math.round((p.chroma / 100) * Math.max(1, Math.max(w, h) / 600) * 3)
      const crn = rad > 0 ? gaussBlur(cr, w, h, rad) : cr
      const cbn = rad > 0 ? gaussBlur(cb, w, h, rad) : cb
      const out = new Float32Array(img.data.length)
      for (let i = 0, j = 0; i < n; i++, j += 3) {
        const y = Yn[i] as number
        const r = y + (crn[i] as number); const b = y + (cbn[i] as number)
        const g = (y - 0.2126 * r - 0.0722 * b) / 0.7152
        out[j] = r; out[j + 1] = g; out[j + 2] = b
      }
      return { width: w, height: h, data: out }
    },
  },
  {
    id: 'sharpen', title: 'Sharpen', category: 'detail', maskable: true,
    description: 'Unsharp mask on luminance with threshold and edge masking.',
    params: obj({ amount: num(0, 300, 60, 'strength %'), radius: num(0.3, 5, 1, 'radius px'), threshold: num(0, 50, 2, 'ignore differences below (‰)'), masking: num(0, 100, 0, 'restrict to edges') }),
    apply: (img, p) => {
      const { width: w, height: h } = img
      const Y = luminancePlane(img)
      const Yp = new Float32Array(Y.length)
      for (let i = 0; i < Y.length; i++) Yp[i] = toSrgb(Y[i] as number)
      const blur = gaussBlur(Yp, w, h, p.radius)
      const th = p.threshold / 1000
      let edge: Float32Array | undefined
      if (p.masking > 0) {
        edge = new Float32Array(Y.length)
        for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x; edge[i] = Math.hypot((Yp[i + 1] as number) - (Yp[i - 1] as number), (Yp[i + w] as number) - (Yp[i - w] as number)) }
        edge = gaussBlur(edge, w, h, 1.5)
      }
      const out = new Float32Array(img.data.length)
      for (let i = 0, j = 0; i < Y.length; i++, j += 3) {
        let d = (Yp[i] as number) - (blur[i] as number)
        if (Math.abs(d) < th) d = 0
        let k = p.amount / 100
        if (edge !== undefined) k *= clamp01(((edge[i] as number) * 12 - p.masking / 100) * 2 + 0.5)
        const ny = toLinear(clamp01((Yp[i] as number) + d * k))
        const yy = Y[i] as number
        const g = yy > 1e-7 ? ny / yy : 1
        out[j] = (img.data[j] as number) * g; out[j + 1] = (img.data[j + 1] as number) * g; out[j + 2] = (img.data[j + 2] as number) * g
      }
      return { width: w, height: h, data: out }
    },
  },
  {
    id: 'vignette', title: 'Vignette', category: 'effect', maskable: true,
    description: 'Darken (negative) or lighten (positive) the corners.',
    params: obj({ amount: num(-100, 100, 0, 'strength'), midpoint: num(0, 100, 50, 'where falloff starts'), roundness: num(-100, 100, 0, 'shape (positive rounder)'), feather: num(0, 100, 50, 'softness') }),
    apply: (img, p) => {
      const { width: w, height: h } = img
      const out = new Float32Array(img.data.length)
      const ar = w / h
      const round = 1 + p.roundness / 100
      const start = 0.3 + (p.midpoint / 100) * 0.6
      const soft = 0.1 + (p.feather / 100) * 0.8
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let dx = ((x + 0.5) / w - 0.5) * 2; let dy = ((y + 0.5) / h - 0.5) * 2
        dx *= ar >= 1 ? 1 : ar; dy *= ar >= 1 ? 1 / ar ** (round - 1) : 1
        const d = Math.hypot(dx, dy) / Math.SQRT2
        const t = clamp01((d - start) / soft)
        const f = 2 ** ((p.amount / 100) * 1.5 * t * t)
        const o = (y * w + x) * 3
        out[o] = (img.data[o] as number) * f; out[o + 1] = (img.data[o + 1] as number) * f; out[o + 2] = (img.data[o + 2] as number) * f
      }
      return { width: w, height: h, data: out }
    },
  },
  {
    id: 'grain', title: 'Film grain', category: 'effect', maskable: true,
    description: 'Luminance film grain (seeded, reproducible).',
    params: obj({ amount: num(0, 100, 0, 'strength'), size: num(1, 4, 1.5, 'grain size px'), seed: { type: 'integer', minimum: 0, maximum: 1_000_000, default: 7 } }),
    apply: (img, p) => {
      const { width: w, height: h } = img
      let s = (p.seed as number) >>> 0 || 1
      const rnd = (): number => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) / 4294967296) - 0.5 }
      let noise: Float32Array = new Float32Array(w * h).map(() => rnd())
      if (p.size > 1) noise = gaussBlur(noise, w, h, p.size / 2)
      let max = 1e-6
      for (const v of noise) max = Math.max(max, Math.abs(v))
      const k = (p.amount / 100) * 0.12 / max
      const out = new Float32Array(img.data.length)
      for (let i = 0, j = 0; i < w * h; i++, j += 3) {
        const y = lumaOf(img.data[j] as number, img.data[j + 1] as number, img.data[j + 2] as number)
        const mid = 4 * toSrgb(y) * (1 - toSrgb(y))
        const g = 2 ** ((noise[i] as number) * k * 4 * mid)
        out[j] = (img.data[j] as number) * g; out[j + 1] = (img.data[j + 1] as number) * g; out[j + 2] = (img.data[j + 2] as number) * g
      }
      return { width: w, height: h, data: out }
    },
  },
  {
    id: 'lut3d', title: '3D LUT', category: 'color', maskable: true,
    description: 'Apply a .cube 3D LUT (sRGB-encoded input/output, trilinear) with adjustable strength. The file must be inside the workspace, the Chengying state directory or a configured read root.',
    params: obj({ file: { type: 'string', description: 'path to a .cube file' }, strength: num(0, 1, 1, 'mix with the original') }),
    apply: (img, p, ctx) => {
      if (!p.file) throw new ChengyingError('invalid-argument', 'lut3d.file is required')
      const path = ctx.readable(p.file)
      if (lutCache?.path !== path) lutCache = { path, cube: parseCube(readFileSync(path, 'utf8')) }
      const { size, table, domainMin, domainMax } = lutCache.cube
      const at = (r: number, g: number, b: number, c: number): number => table[((b * size + g) * size + r) * 3 + c] as number
      return mapPixels(img, (r, g, b) => {
        const v = [r, g, b].map((x, i) => (clamp01((toSrgb(x) - (domainMin[i] ?? 0)) / ((domainMax[i] ?? 1) - (domainMin[i] ?? 0)))) * (size - 1))
        const [x, y, z] = v as [number, number, number]
        const x0 = Math.floor(x); const y0 = Math.floor(y); const z0 = Math.floor(z)
        const x1 = Math.min(size - 1, x0 + 1); const y1 = Math.min(size - 1, y0 + 1); const z1 = Math.min(size - 1, z0 + 1)
        const fx = x - x0; const fy = y - y0; const fz = z - z0
        const res = [0, 1, 2].map(c => {
          const c00 = at(x0, y0, z0, c) * (1 - fx) + at(x1, y0, z0, c) * fx
          const c10 = at(x0, y1, z0, c) * (1 - fx) + at(x1, y1, z0, c) * fx
          const c01 = at(x0, y0, z1, c) * (1 - fx) + at(x1, y0, z1, c) * fx
          const c11 = at(x0, y1, z1, c) * (1 - fx) + at(x1, y1, z1, c) * fx
          return (c00 * (1 - fy) + c10 * fy) * (1 - fz) + (c01 * (1 - fy) + c11 * fy) * fz
        })
        const orig = [r, g, b]
        return res.map((v2, i) => (orig[i] as number) + (toLinear(clamp01(v2)) - (orig[i] as number)) * p.strength) as [number, number, number]
      })
    },
  },
  {
    id: 'auto_tone', title: 'Auto tone', category: 'tone', maskable: false,
    description: 'Automatic levels: stretch the 0.5–99.5 percentile luminance range and neutralise a global cast (strength 0..100).',
    params: obj({ strength: num(0, 100, 70, 'how far to move toward the automatic result'), neutralize: { type: 'boolean', default: true } }),
    apply: (img, p) => {
      const Y = luminancePlane(img)
      const sorted = Array.from(Y).map(toSrgb).sort((a, b) => a - b)
      const lo = sorted[Math.floor(sorted.length * 0.005)] ?? 0
      const hi = sorted[Math.floor(sorted.length * 0.995)] ?? 1
      let rs = 0; let gs = 0; let bs = 0
      for (let j = 0; j < img.data.length; j += 3) { rs += img.data[j] as number; gs += img.data[j + 1] as number; bs += img.data[j + 2] as number }
      const avg = (rs + gs + bs) / 3
      const gains = p.neutralize ? [avg / Math.max(1e-6, rs), avg / Math.max(1e-6, gs), avg / Math.max(1e-6, bs)] : [1, 1, 1]
      const k = p.strength / 100
      return mapPixels(img, (r, g, b) => [r, g, b].map((v, i) => {
        const balanced = v * (1 + ((gains[i] as number) - 1) * k * 0.7)
        const s = toSrgb(balanced)
        const stretched = clamp01((s - lo) / Math.max(0.05, hi - lo))
        return toLinear(s + (stretched - s) * k)
      }) as [number, number, number])
    },
  },
  {
    id: 'heal', title: 'Spot healing (classical)', category: 'repair', maskable: false,
    description: 'Remove dust spots / small blemishes by cloning from a nearby source with feathered edges and tone matching. Non-generative.',
    params: obj({
      spots: { type: 'array', minItems: 1, maxItems: 200, items: obj({ x: num(0, 1, 0.5, 'spot center x'), y: num(0, 1, 0.5, 'spot center y'), r: num(0.001, 0.2, 0.01, 'radius (relative to longer side)'), src_x: { type: 'number', minimum: 0, maximum: 1, description: 'source center x (auto when omitted)' }, src_y: { type: 'number', minimum: 0, maximum: 1, description: 'source center y' } }), default: [] },
    }),
    apply: (img, p) => {
      const out = clone(img)
      const { width: w, height: h } = img
      const L = Math.max(w, h)
      for (const s of p.spots as Array<{ x: number; y: number; r: number; src_x?: number; src_y?: number }>) {
        const cx = s.x * w; const cy = s.y * h; const r = Math.max(1.5, s.r * L)
        let sx = s.src_x !== undefined ? s.src_x * w : cx + r * 2.5
        let sy = s.src_y !== undefined ? s.src_y * h : cy
        if (s.src_x === undefined) {
          // choose the flattest neighbouring patch among 8 directions
          let best = Infinity
          for (let k = 0; k < 8; k++) {
            const a = (k * Math.PI) / 4
            const px = cx + Math.cos(a) * r * 2.6; const py = cy + Math.sin(a) * r * 2.6
            if (px - r < 0 || py - r < 0 || px + r >= w || py + r >= h) continue
            let m = 0; let m2 = 0; let c = 0
            for (let y = -r; y <= r; y += Math.max(1, r / 6)) for (let x = -r; x <= r; x += Math.max(1, r / 6)) { const v = sample(img, px + x, py + y, 1); m += v; m2 += v * v; c++ }
            const variance = m2 / c - (m / c) ** 2
            if (variance < best) { best = variance; sx = px; sy = py }
          }
        }
        // tone match: mean difference between ring around target and ring around source
        const ring = (x0: number, y0: number, c: number): number => { let s2 = 0; let n = 0; for (let k = 0; k < 24; k++) { const a = (k * Math.PI) / 12; s2 += sample(img, x0 + Math.cos(a) * r * 1.2, y0 + Math.sin(a) * r * 1.2, c); n++ } return s2 / n }
        const offs = [0, 1, 2].map(c => ring(cx, cy, c) - ring(sx, sy, c))
        for (let y = Math.floor(cy - r * 1.3); y <= Math.ceil(cy + r * 1.3); y++) {
          for (let x = Math.floor(cx - r * 1.3); x <= Math.ceil(cx + r * 1.3); x++) {
            if (x < 0 || y < 0 || x >= w || y >= h) continue
            const d = Math.hypot(x - cx, y - cy) / r
            const a = d <= 0.8 ? 1 : d >= 1.3 ? 0 : 1 - (d - 0.8) / 0.5
            if (a <= 0) continue
            const o = (y * w + x) * 3
            for (let c = 0; c < 3; c++) {
              const v = sample(img, x + (sx - cx), y + (sy - cy), c) + (offs[c] as number)
              out.data[o + c] = (out.data[o + c] as number) * (1 - a) + Math.max(0, v) * a
            }
          }
        }
      }
      return out
    },
  },
  /* geometry (applied after tone/color operators, in step order) */
  {
    id: 'rotate', title: 'Straighten / rotate', category: 'geometry', geometry: true, maskable: false,
    description: 'Rotate by an arbitrary angle (positive = clockwise) with optional auto-crop to remove empty corners.',
    params: obj({ angle: num(-45, 45, 0, 'degrees', 'deg'), crop: { type: 'boolean', default: true, description: 'crop to the largest inner rectangle' } }),
    apply: (img, p) => {
      const a = (p.angle * Math.PI) / 180
      if (Math.abs(a) < 1e-6) return img
      const { width: w, height: h } = img
      const [cw, ch] = p.crop ? rotatedCrop(w, h, a) : [Math.abs(w * Math.cos(a)) + Math.abs(h * Math.sin(a)), Math.abs(w * Math.sin(a)) + Math.abs(h * Math.cos(a))]
      const W = Math.max(8, Math.floor(cw)); const H = Math.max(8, Math.floor(ch))
      const cos = Math.cos(a); const sin = Math.sin(a)
      return warpTo(img, W, H, (x, y) => {
        const dx = x - W / 2; const dy = y - H / 2
        return [dx * cos + dy * sin + w / 2, -dx * sin + dy * cos + h / 2]
      })
    },
  },
  {
    id: 'perspective', title: 'Perspective correction', category: 'geometry', geometry: true, maskable: false,
    description: 'Keystone correction: vertical / horizontal convergence, optional extra rotation and scale. Use vertical > 0 to straighten buildings photographed from below.',
    params: obj({ vertical: num(-100, 100, 0, 'vertical keystone'), horizontal: num(-100, 100, 0, 'horizontal keystone'), scale: num(50, 150, 100, 'zoom %'), crop: { type: 'boolean', default: true } }),
    apply: (img, p) => {
      const { width: w, height: h } = img
      const v = p.vertical / 100 * 0.35; const hz = p.horizontal / 100 * 0.35
      // The converging edge of the source quad is stretched to the full frame:
      // vertical > 0 widens the top (lines converging upwards), < 0 the bottom;
      // horizontal > 0 the right edge, < 0 the left edge.
      const tl: [number, number] = [0, 0]; const tr: [number, number] = [w, 0]; const br: [number, number] = [w, h]; const bl: [number, number] = [0, h]
      if (v > 0) { tl[0] += (w * v) / 2; tr[0] -= (w * v) / 2 } else if (v < 0) { bl[0] += (w * -v) / 2; br[0] -= (w * -v) / 2 }
      if (hz > 0) { tr[1] += (h * hz) / 2; br[1] -= (h * hz) / 2 } else if (hz < 0) { tl[1] += (h * -hz) / 2; bl[1] -= (h * -hz) / 2 }
      const src: Array<[number, number]> = [tl, tr, br, bl]
      const dst: Array<[number, number]> = [[0, 0], [w, 0], [w, h], [0, h]]
      const H = solveHomography(src, dst)
      const s = 100 / p.scale
      const margin = p.crop ? Math.max(Math.abs(v), Math.abs(hz)) / 2 : 0
      const W2 = Math.round(w * (1 - margin)); const H2 = Math.round(h * (1 - margin))
      return warpTo(img, W2, H2, (x, y) => {
        const X = (x - W2 / 2) * s + w / 2; const Y = (y - H2 / 2) * s + h / 2
        const d = (H[6] as number) * X + (H[7] as number) * Y + 1
        return [((H[0] as number) * X + (H[1] as number) * Y + (H[2] as number)) / d, ((H[3] as number) * X + (H[4] as number) * Y + (H[5] as number)) / d]
      })
    },
  },
  {
    id: 'crop', title: 'Crop', category: 'geometry', geometry: true, maskable: false,
    description: 'Crop to a normalized rectangle, or to an aspect ratio centered on (cx, cy).',
    params: obj({ x: num(0, 1, 0, 'left'), y: num(0, 1, 0, 'top'), w: num(0.01, 1, 1, 'width'), h: num(0.01, 1, 1, 'height'), aspect: { type: 'string', description: 'e.g. "3:2", "16:9", "1:1", "4:5" — overrides w/h, keeps the largest centered rect' }, cx: num(0, 1, 0.5, 'center x for aspect crops'), cy: num(0, 1, 0.5, 'center y for aspect crops') }),
    apply: (img, p) => {
      const { width: W, height: H } = img
      let x = p.x * W; let y = p.y * H; let w = p.w * W; let h = p.h * H
      if (typeof p.aspect === 'string' && /^\d+(\.\d+)?:\d+(\.\d+)?$/.test(p.aspect)) {
        const [a, b] = p.aspect.split(':').map(Number) as [number, number]
        const ratio = a / b
        w = Math.min(W, H * ratio); h = w / ratio
        x = Math.min(W - w, Math.max(0, p.cx * W - w / 2)); y = Math.min(H - h, Math.max(0, p.cy * H - h / 2))
      }
      const X = Math.max(0, Math.round(x)); const Y = Math.max(0, Math.round(y))
      const WW = Math.max(1, Math.min(W - X, Math.round(w))); const HH = Math.max(1, Math.min(H - Y, Math.round(h)))
      const out = new Float32Array(WW * HH * 3)
      for (let r = 0; r < HH; r++) out.set(img.data.subarray(((Y + r) * W + X) * 3, ((Y + r) * W + X + WW) * 3), r * WW * 3)
      return { width: WW, height: HH, data: out }
    },
  },
  {
    id: 'flip', title: 'Flip / rotate 90°', category: 'geometry', geometry: true, maskable: false,
    description: 'Mirror horizontally/vertically and rotate in 90° steps.',
    params: obj({ horizontal: { type: 'boolean', default: false }, vertical: { type: 'boolean', default: false }, quarter_turns: { type: 'integer', minimum: 0, maximum: 3, default: 0, description: 'clockwise 90° turns' } }),
    apply: (img, p) => {
      let cur = img
      const turns = ((p.quarter_turns % 4) + 4) % 4
      for (let t = 0; t < turns; t++) { const src = cur; cur = warpTo(src, src.height, src.width, (x, y) => [y, src.height - x]) }
      if (p.horizontal || p.vertical) { const src = cur; cur = warpTo(src, src.width, src.height, (x, y) => [p.horizontal ? src.width - x : x, p.vertical ? src.height - y : y]) }
      return cur
    },
  },
]
