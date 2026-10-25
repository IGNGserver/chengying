/**
 * Non-generative "intelligent" image operations:
 *  - Telea fast-marching inpainting (removes small objects, wires, blemishes
 *    by propagating surrounding pixels inward; invents no new content)
 *  - Reinhard colour transfer in Lab + luminance histogram matching
 *    (unifies the look of a series with a reference photo)
 */
import type { FImage } from '../builtin/image.ts'
import { toLinear, toSrgb } from '../builtin/image.ts'

/** Binary min-heap keyed by distance. */
class Heap {
  private readonly keys: number[] = []
  private readonly vals: number[] = []
  get size(): number { return this.keys.length }
  push(k: number, v: number): void {
    this.keys.push(k); this.vals.push(v)
    let i = this.keys.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if ((this.keys[p] as number) <= k) break
      this.keys[i] = this.keys[p] as number; this.vals[i] = this.vals[p] as number
      i = p
    }
    this.keys[i] = k; this.vals[i] = v
  }
  pop(): number {
    const top = this.vals[0] as number
    const k = this.keys.pop() as number
    const v = this.vals.pop() as number
    if (this.keys.length > 0) {
      let i = 0
      const n = this.keys.length
      while (true) {
        const l = 2 * i + 1
        if (l >= n) break
        const r = l + 1
        const c = r < n && (this.keys[r] as number) < (this.keys[l] as number) ? r : l
        if ((this.keys[c] as number) >= k) break
        this.keys[i] = this.keys[c] as number; this.vals[i] = this.vals[c] as number
        i = c
      }
      this.keys[i] = k; this.vals[i] = v
    }
    return top
  }
}

/**
 * Telea (2004) inpainting. `mask` > 0.5 marks pixels to fill. Works on the
 * sRGB-encoded values for perceptually smooth propagation.
 */
export function inpaintTelea(img: FImage, mask: Float32Array, radius = 5): FImage {
  const { width: w, height: h } = img
  const n = w * h
  const KNOWN = 0; const BAND = 1; const INSIDE = 2
  const flag = new Uint8Array(n)
  const dist = new Float32Array(n).fill(1e6)
  const out = new Float32Array(img.data.length)
  for (let i = 0; i < img.data.length; i++) out[i] = toSrgb(img.data[i] as number)
  const heap = new Heap()
  for (let i = 0; i < n; i++) if ((mask[i] as number) > 0.5) flag[i] = INSIDE
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x
    if (flag[i] !== INSIDE) continue
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const xx = x + dx; const yy = y + dy
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue
      const j = yy * w + xx
      if (flag[j] === KNOWN) { flag[j] = BAND; dist[j] = 0; heap.push(0, j) }
    }
  }
  for (let i = 0; i < n; i++) if (flag[i] === KNOWN) dist[i] = 0
  const solve = (i1: number, i2: number): number => {
    let sol = 1e6
    const d1 = dist[i1] as number; const d2 = dist[i2] as number
    if (flag[i1] !== INSIDE && flag[i2] !== INSIDE) {
      const r = Math.sqrt(2 - (d1 - d2) ** 2)
      const s = (d1 + d2 - r) / 2
      if (s >= d1 && s >= d2) sol = s
      else { const s2 = (d1 + d2 + r) / 2; if (s2 >= d1 && s2 >= d2) sol = s2 }
    } else if (flag[i1] !== INSIDE) sol = 1 + d1
    else if (flag[i2] !== INSIDE) sol = 1 + d2
    return sol
  }
  const paint = (x: number, y: number): void => {
    const i = y * w + x
    const acc = [0, 0, 0]
    let wsum = 0
    // distance gradient for direction weighting
    const gx = ((dist[Math.min(n - 1, i + 1)] ?? 0) - (dist[Math.max(0, i - 1)] ?? 0)) / 2
    const gy = ((dist[Math.min(n - 1, i + w)] ?? 0) - (dist[Math.max(0, i - w)] ?? 0)) / 2
    for (let yy = Math.max(0, y - radius); yy <= Math.min(h - 1, y + radius); yy++) {
      for (let xx = Math.max(0, x - radius); xx <= Math.min(w - 1, x + radius); xx++) {
        const j = yy * w + xx
        if (flag[j] === INSIDE) continue
        const rx = x - xx; const ry = y - yy
        const len2 = rx * rx + ry * ry
        if (len2 > radius * radius || len2 === 0) continue
        const len = Math.sqrt(len2)
        let dir = Math.abs((rx * gx + ry * gy) / len)
        if (dir < 1e-6) dir = 1e-6
        const dst = 1 / (len2)
        const lev = 1 / (1 + Math.abs((dist[j] as number) - (dist[i] as number)))
        const wgt = dir * dst * lev
        for (let c = 0; c < 3; c++) acc[c] = (acc[c] as number) + wgt * (out[j * 3 + c] as number)
        wsum += wgt
      }
    }
    if (wsum > 0) for (let c = 0; c < 3; c++) out[i * 3 + c] = (acc[c] as number) / wsum
  }
  while (heap.size > 0) {
    const i = heap.pop()
    const x = i % w; const y = (i - x) / w
    flag[i] = KNOWN
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const xx = x + dx; const yy = y + dy
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue
      const j = yy * w + xx
      if (flag[j] !== INSIDE) continue
      const d = Math.min(
        solve(xx > 0 ? j - 1 : j, yy > 0 ? j - w : j), solve(xx < w - 1 ? j + 1 : j, yy > 0 ? j - w : j),
        solve(xx > 0 ? j - 1 : j, yy < h - 1 ? j + w : j), solve(xx < w - 1 ? j + 1 : j, yy < h - 1 ? j + w : j),
      )
      dist[j] = d
      paint(xx, yy)
      flag[j] = BAND
      heap.push(d, j)
    }
  }
  for (let i = 0; i < out.length; i++) out[i] = toLinear(Math.min(1, Math.max(0, out[i] as number)))
  return { width: w, height: h, data: out }
}

/* ------------------------------------------------------- style transfer */

function linToLab(r: number, g: number, b: number): [number, number, number] {
  const X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047
  const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b
  const Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883
  const f = (t: number): number => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116)
  const fx = f(X); const fy = f(Y); const fz = f(Z)
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}

function labToLin(L: number, a: number, b: number): [number, number, number] {
  const fy = (L + 16) / 116; const fx = fy + a / 500; const fz = fy - b / 200
  const inv = (t: number): number => (t ** 3 > 216 / 24389 ? t ** 3 : (116 * t - 16) / (24389 / 27))
  const X = inv(fx) * 0.95047; const Y = inv(fy); const Z = inv(fz) * 1.08883
  return [3.2406 * X - 1.5372 * Y - 0.4986 * Z, -0.9689 * X + 1.8758 * Y + 0.0415 * Z, 0.0557 * X - 0.204 * Y + 1.057 * Z]
}

export interface StyleFingerprint {
  mean: [number, number, number]
  std: [number, number, number]
  /** Luminance (L*) quantiles at 0, 5, 10 … 100 %. */
  quantiles: number[]
}

export function styleFingerprint(img: FImage): StyleFingerprint {
  const n = img.width * img.height
  const step = Math.max(1, Math.floor(n / 60000))
  const Ls: number[] = []
  const sum = [0, 0, 0]; const sum2 = [0, 0, 0]
  let k = 0
  for (let i = 0; i < n; i += step) {
    const lab = linToLab(img.data[i * 3] as number, img.data[i * 3 + 1] as number, img.data[i * 3 + 2] as number)
    for (let c = 0; c < 3; c++) { const v = lab[c] as number; sum[c] = (sum[c] as number) + v; sum2[c] = (sum2[c] as number) + v * v }
    Ls.push(lab[0])
    k++
  }
  Ls.sort((a, b) => a - b)
  const mean = sum.map(s => s / k) as [number, number, number]
  const std = sum2.map((s, c) => Math.sqrt(Math.max(1e-6, s / k - (mean[c] as number) ** 2))) as [number, number, number]
  const quantiles = Array.from({ length: 21 }, (_, q) => Ls[Math.min(Ls.length - 1, Math.floor((q / 20) * (Ls.length - 1)))] as number)
  return { mean, std, quantiles }
}

export interface StyleOptions {
  strength: number
  color: boolean
  tone: boolean
  /** Maximum shift of the mean a* and b* (Lab units); keeps unification gentle. */
  maxShift?: number
  /** Keep near-white highlights and near-black shadows neutral. */
  protectExtremes?: boolean
}

const smooth = (e0: number, e1: number, x: number): number => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t) }

/**
 * Match colour statistics (Reinhard, with bounded mean shift and contrast
 * ratio) and tonal distribution (quantile mapping) to a reference. Highlights
 * and shadows are protected so whites stay white and blacks stay black.
 */
export function applyStyle(img: FImage, ref: StyleFingerprint, opts: StyleOptions): FImage {
  const src = styleFingerprint(img)
  const out = new Float32Array(img.data.length)
  const s = Math.max(0, Math.min(1, opts.strength))
  const cap = opts.maxShift ?? 15
  const protect = opts.protectExtremes !== false
  const shiftA = Math.max(-cap, Math.min(cap, ref.mean[1] - src.mean[1]))
  const shiftB = Math.max(-cap, Math.min(cap, ref.mean[2] - src.mean[2]))
  const ratioA = Math.max(0.6, Math.min(1.6, ref.std[1] / src.std[1]))
  const ratioB = Math.max(0.6, Math.min(1.6, ref.std[2] / src.std[2]))
  const mapL = (L: number): number => {
    const q = src.quantiles
    let i = 0
    while (i < q.length - 2 && L > (q[i + 1] as number)) i++
    const a = q[i] as number; const b = q[i + 1] as number
    const t = b > a ? Math.min(1, Math.max(0, (L - a) / (b - a))) : 0
    return (ref.quantiles[i] as number) + t * ((ref.quantiles[i + 1] as number) - (ref.quantiles[i] as number))
  }
  for (let j = 0; j < img.data.length; j += 3) {
    const lab = linToLab(img.data[j] as number, img.data[j + 1] as number, img.data[j + 2] as number)
    let [L, A, B] = lab
    const w = protect ? smooth(2, 12, L) * (1 - smooth(85, 99, L)) : 1
    if (opts.tone) L = L + (mapL(L) - L) * s * (protect ? 0.3 + 0.7 * w : 1)
    if (opts.color) {
      const tA = src.mean[1] + shiftA + (A - src.mean[1]) * ratioA
      const tB = src.mean[2] + shiftB + (B - src.mean[2]) * ratioB
      A = A + (tA - A) * s * w
      B = B + (tB - B) * s * w
    }
    const [r, g, b] = labToLin(L, A, B)
    out[j] = Math.max(0, r); out[j + 1] = Math.max(0, g); out[j + 2] = Math.max(0, b)
  }
  return { width: img.width, height: img.height, data: out }
}
