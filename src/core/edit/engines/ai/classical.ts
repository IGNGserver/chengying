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
    const di = dist[i] as number
    const acc = [0, 0, 0]
    let wsum = 0
    // Safe distance gradient using only non-INSIDE neighbours (avoids 1e6 sentinel overflow)
    const hasL = x > 0 && flag[i - 1] !== INSIDE
    const hasR = x < w - 1 && flag[i + 1] !== INSIDE
    const hasU = y > 0 && flag[i - w] !== INSIDE
    const hasD = y < h - 1 && flag[i + w] !== INSIDE
    const dL = hasL ? (dist[i - 1] as number) : di
    const dR = hasR ? (dist[i + 1] as number) : di
    const dU = hasU ? (dist[i - w] as number) : di
    const dD = hasD ? (dist[i + w] as number) : di
    const gx = (dR - dL) / ((hasL ? 1 : 0) + (hasR ? 1 : 0) || 1)
    const gy = (dD - dU) / ((hasU ? 1 : 0) + (hasD ? 1 : 0) || 1)
    const gLen = Math.hypot(gx, gy) || 1
    const nx = gx / gLen
    const ny = gy / gLen
    for (let yy = Math.max(0, y - radius); yy <= Math.min(h - 1, y + radius); yy++) {
      for (let xx = Math.max(0, x - radius); xx <= Math.min(w - 1, x + radius); xx++) {
        const j = yy * w + xx
        if (flag[j] === INSIDE) continue
        const rx = x - xx; const ry = y - yy
        const len2 = rx * rx + ry * ry
        if (len2 > radius * radius || len2 === 0) continue
        const len = Math.sqrt(len2)
        let dir = Math.abs((rx * nx + ry * ny) / len)
        if (dir < 1e-4) dir = 1e-4
        const dst = 1 / (len2 * len)
        const lev = 1 / (1 + Math.abs((dist[j] as number) - di))
        const wgt = dir * dst * lev
        // First-order Taylor projection using known image gradient at j (clamped for stability)
        const jHasL = xx > 0 && flag[j - 1] !== INSIDE
        const jHasR = xx < w - 1 && flag[j + 1] !== INSIDE
        const jHasU = yy > 0 && flag[j - w] !== INSIDE
        const jHasD = yy < h - 1 && flag[j + w] !== INSIDE
        for (let c = 0; c < 3; c++) {
          const baseVal = out[j * 3 + c] as number
          let igx = 0; let igy = 0
          if (jHasL && jHasR) igx = ((out[(j + 1) * 3 + c] as number) - (out[(j - 1) * 3 + c] as number)) * 0.5
          if (jHasU && jHasD) igy = ((out[(j + w) * 3 + c] as number) - (out[(j - w) * 3 + c] as number)) * 0.5
          const proj = Math.max(-0.08, Math.min(0.08, (igx * rx + igy * ry) * 0.35))
          acc[c] = (acc[c] as number) + wgt * Math.min(1, Math.max(0, baseVal + proj))
        }
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
  // Micro-texture transfer for interior pixels (dist > 2.5): copy high-frequency
  // detail residual from the closest matching known ring pixel so larger repairs
  // do not look like flat plastic smudges.
  const knownRing: Array<{ x: number; y: number; luma: number; hf: [number, number, number] }> = []
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      if ((mask[i] as number) > 0.5) continue
      // Only sample unmasked ring pixels within 2..radius*2 px of the mask
      let nearMask = false
      const stepR = Math.max(1, Math.min(4, radius))
      for (const [dx, dy] of [[stepR, 0], [-stepR, 0], [0, stepR], [0, -stepR]] as const) {
        const nx = x + dx; const ny = y + dy
        if (nx >= 0 && ny >= 0 && nx < w && ny < h && (mask[ny * w + nx] as number) > 0.5) { nearMask = true; break }
      }
      if (!nearMask) continue
      const hf: [number, number, number] = [0, 0, 0]
      for (let c = 0; c < 3; c++) {
        const center = out[i * 3 + c] as number
        const avg4 = ((out[(i - 1) * 3 + c] as number) + (out[(i + 1) * 3 + c] as number) + (out[(i - w) * 3 + c] as number) + (out[(i + w) * 3 + c] as number)) * 0.25
        hf[c] = center - avg4
      }
      const luma = 0.2126 * (out[i * 3] as number) + 0.7152 * (out[i * 3 + 1] as number) + 0.0722 * (out[i * 3 + 2] as number)
      knownRing.push({ x, y, luma, hf })
    }
  }
  if (knownRing.length >= 8) {
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x
        const d = dist[i] as number
        if ((mask[i] as number) <= 0.5 || d <= 2.2) continue
        const luma = 0.2126 * (out[i * 3] as number) + 0.7152 * (out[i * 3 + 1] as number) + 0.0722 * (out[i * 3 + 2] as number)
        const idx = ((x * 73 + y * 37) >>> 0) % knownRing.length
        let bestSample = knownRing[idx]!
        let bestDiff = Math.abs(bestSample.luma - luma)
        for (let k = 1; k <= 4; k++) {
          const cand = knownRing[(idx + k * 13) % knownRing.length]!
          const diff = Math.abs(cand.luma - luma)
          if (diff < bestDiff) { bestDiff = diff; bestSample = cand }
        }
        const blend = Math.min(0.65, (d - 2.2) / 3.5)
        for (let c = 0; c < 3; c++) {
          out[i * 3 + c] = Math.min(1, Math.max(0, (out[i * 3 + c] as number) + (bestSample.hf[c] as number) * blend))
        }
      }
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
    // Protect extremes and skin hues (A in 5..20, B in 10..25)
    const skin = (A > 5 && A < 25 && B > 8 && B < 30) ? 0.2 : 1
    const w = protect ? smooth(2, 12, L) * (1 - smooth(85, 99, L)) * skin : 1
    if (opts.tone) {
      const mappedL = mapL(L)
      // Cap extreme quantile jumps when strength < 1 so local contrast is not torn
      const maxDeltaL = s < 0.99 ? 28 : 100
      const deltaL = Math.max(-maxDeltaL, Math.min(maxDeltaL, mappedL - L))
      L = L + deltaL * s * (protect ? 0.3 + 0.7 * w : 1)
    }
    if (opts.color) {
      // Gentle skin-hue protection when strength < 0.95 so landscape casts do not tint portraits green/magenta
      const isSkinHue = protect && s < 0.95 && L > 25 && L < 85 && A > 5 && A < 26 && B > 7 && B < 34 && B >= A * 0.75
      const skinDamp = isSkinHue ? 0.55 : 1
      const tA = src.mean[1] + shiftA + (A - src.mean[1]) * ratioA
      const tB = src.mean[2] + shiftB + (B - src.mean[2]) * ratioB
      A = A + (tA - A) * s * w * skinDamp
      B = B + (tB - B) * s * w * skinDamp
    }
    const [r, g, b] = labToLin(L, A, B)
    out[j] = Math.max(0, r); out[j + 1] = Math.max(0, g); out[j + 2] = Math.max(0, b)
  }
  return { width: img.width, height: img.height, data: out }
}
