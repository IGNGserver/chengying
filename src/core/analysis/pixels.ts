/**
 * Classical computer-vision measurements on a small RGB buffer (~512 px long
 * edge). Pure and synchronous so it can run inside worker threads.
 *
 * Methods:
 *  - perceptual hashes: dHash (gradient) and pHash (32×32 DCT, 8×8 low band)
 *  - sharpness: variance of Laplacian, global + tiled peak + center weighted;
 *    structure-tensor anisotropy as a motion-blur indicator
 *  - exposure: luminance histogram statistics, clipping, entropy
 *  - noise: Immerkær fast noise variance estimate restricted to flat regions
 *  - color: Hasler–Süsstrunk colorfulness, saturation, neutral-cast in Lab
 *  - composition: spectral-residual + color-contrast saliency, rule of thirds,
 *    balance, symmetry, horizon/vertical tilt from gradient orientations,
 *    border clutter and subject isolation
 */
import type { Features } from '../types.ts'

export const FEATURE_VERSION = 3

export interface RgbImage {
  width: number
  height: number
  data: Uint8Array // RGB interleaved
}

/* ----------------------------------------------------------------- basics */

export function luminance(img: RgbImage): Float32Array {
  const n = img.width * img.height
  const out = new Float32Array(n)
  const d = img.data
  for (let i = 0, j = 0; i < n; i++, j += 3) {
    out[i] = 0.2126 * (d[j] as number) + 0.7152 * (d[j + 1] as number) + 0.0722 * (d[j + 2] as number)
  }
  return out
}

/** Area-average resample of a single channel. */
export function resampleGray(src: Float32Array, w: number, h: number, tw: number, th: number): Float32Array {
  const out = new Float32Array(tw * th)
  const sx = w / tw
  const sy = h / th
  for (let ty = 0; ty < th; ty++) {
    const y0 = Math.floor(ty * sy)
    const y1 = Math.max(y0 + 1, Math.floor((ty + 1) * sy))
    for (let tx = 0; tx < tw; tx++) {
      const x0 = Math.floor(tx * sx)
      const x1 = Math.max(x0 + 1, Math.floor((tx + 1) * sx))
      let sum = 0
      let count = 0
      for (let y = y0; y < y1 && y < h; y++) {
        const row = y * w
        for (let x = x0; x < x1 && x < w; x++) {
          sum += src[row + x] as number
          count++
        }
      }
      out[ty * tw + tx] = count > 0 ? sum / count : 0
    }
  }
  return out
}

function bitsToHex(bits: boolean[]): string {
  let hex = ''
  for (let i = 0; i < bits.length; i += 4) {
    const v = (bits[i] ? 8 : 0) | (bits[i + 1] ? 4 : 0) | (bits[i + 2] ? 2 : 0) | (bits[i + 3] ? 1 : 0)
    hex += v.toString(16)
  }
  return hex
}

export function hamming(a: string, b: string): number {
  if (a.length !== b.length) return 64
  let d = 0
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i] as string, 16) ^ parseInt(b[i] as string, 16)
    while (x) { d += x & 1; x >>= 1 }
  }
  return d
}

export function dHash(gray: Float32Array, w: number, h: number): string {
  const s = resampleGray(gray, w, h, 9, 8)
  const bits: boolean[] = []
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits.push((s[y * 9 + x] as number) < (s[y * 9 + x + 1] as number))
  return bitsToHex(bits)
}

const DCT32: Float64Array = (() => {
  const n = 32
  const m = new Float64Array(n * n)
  for (let k = 0; k < n; k++) {
    const c = k === 0 ? Math.sqrt(1 / n) : Math.sqrt(2 / n)
    for (let i = 0; i < n; i++) m[k * n + i] = c * Math.cos(((2 * i + 1) * k * Math.PI) / (2 * n))
  }
  return m
})()

export function pHash(gray: Float32Array, w: number, h: number): string {
  const n = 32
  const s = resampleGray(gray, w, h, n, n)
  // rows then columns, but only the 8 lowest frequencies are needed.
  const tmp = new Float64Array(8 * n)
  for (let k = 0; k < 8; k++) {
    for (let x = 0; x < n; x++) {
      let acc = 0
      for (let y = 0; y < n; y++) acc += (DCT32[k * n + y] as number) * (s[y * n + x] as number)
      tmp[k * n + x] = acc
    }
  }
  const coeffs: number[] = []
  for (let ky = 0; ky < 8; ky++) {
    for (let kx = 0; kx < 8; kx++) {
      let acc = 0
      for (let x = 0; x < n; x++) acc += (DCT32[kx * n + x] as number) * (tmp[ky * n + x] as number)
      coeffs.push(acc)
    }
  }
  const ac = coeffs.slice(1)
  const sorted = [...ac].sort((a, b) => a - b)
  const median = ((sorted[31] as number) + (sorted[32] as number)) / 2
  return bitsToHex(coeffs.map((c, i) => (i === 0 ? false : c > median)))
}

/* -------------------------------------------------------------- colorspace */

function srgbToLinear(c: number): number {
  const v = c / 255
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}

const LIN_LUT = new Float32Array(256).map((_, i) => srgbToLinear(i))

function labF(t: number): number {
  return t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116
}

export function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  const R = LIN_LUT[r] as number
  const G = LIN_LUT[g] as number
  const B = LIN_LUT[b] as number
  const X = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047
  const Y = 0.2126 * R + 0.7152 * G + 0.0722 * B
  const Z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883
  const fx = labF(X)
  const fy = labF(Y)
  const fz = labF(Z)
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}

function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  let h = 0
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h *= 60
    if (h < 0) h += 360
  }
  return [h, max === 0 ? 0 : d / max, max / 255]
}

/* ------------------------------------------------------------------- FFT */

function fft1d(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const tr = re[i] as number; re[i] = re[j] as number; re[j] = tr
      const ti = im[i] as number; im[i] = im[j] as number; im[j] = ti
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (2 * Math.PI / len) * (inverse ? 1 : -1)
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cr = 1
      let ci = 0
      for (let j = 0; j < len / 2; j++) {
        const ar = re[i + j] as number
        const ai = im[i + j] as number
        const br = (re[i + j + len / 2] as number) * cr - (im[i + j + len / 2] as number) * ci
        const bi = (re[i + j + len / 2] as number) * ci + (im[i + j + len / 2] as number) * cr
        re[i + j] = ar + br; im[i + j] = ai + bi
        re[i + j + len / 2] = ar - br; im[i + j + len / 2] = ai - bi
        const ncr = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = ncr
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] = (re[i] as number) / n; im[i] = (im[i] as number) / n }
}

function fft2d(re: Float64Array, im: Float64Array, n: number, inverse: boolean): void {
  const rr = new Float64Array(n)
  const ri = new Float64Array(n)
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) { rr[x] = re[y * n + x] as number; ri[x] = im[y * n + x] as number }
    fft1d(rr, ri, inverse)
    for (let x = 0; x < n; x++) { re[y * n + x] = rr[x] as number; im[y * n + x] = ri[x] as number }
  }
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) { rr[y] = re[y * n + x] as number; ri[y] = im[y * n + x] as number }
    fft1d(rr, ri, inverse)
    for (let y = 0; y < n; y++) { re[y * n + x] = rr[y] as number; im[y * n + x] = ri[y] as number }
  }
}

function boxBlur(src: Float64Array | Float32Array, w: number, h: number, r: number): Float64Array {
  const out = new Float64Array(w * h)
  const tmp = new Float64Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0; let c = 0
      for (let k = -r; k <= r; k++) { const xx = x + k; if (xx >= 0 && xx < w) { s += src[y * w + xx] as number; c++ } }
      tmp[y * w + x] = s / c
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let s = 0; let c = 0
      for (let k = -r; k <= r; k++) { const yy = y + k; if (yy >= 0 && yy < h) { s += tmp[yy * w + x] as number; c++ } }
      out[y * w + x] = s / c
    }
  }
  return out
}

/** Spectral residual saliency (Hou & Zhang 2007) on a 64×64 map, values 0..1. */
export function spectralSaliency(gray: Float32Array, w: number, h: number): Float64Array {
  const n = 64
  const s = resampleGray(gray, w, h, n, n)
  const re = new Float64Array(n * n)
  const im = new Float64Array(n * n)
  for (let i = 0; i < n * n; i++) re[i] = (s[i] as number) / 255
  fft2d(re, im, n, false)
  const logAmp = new Float64Array(n * n)
  const phase = new Float64Array(n * n)
  for (let i = 0; i < n * n; i++) {
    const a = Math.hypot(re[i] as number, im[i] as number)
    logAmp[i] = Math.log(a + 1e-9)
    phase[i] = Math.atan2(im[i] as number, re[i] as number)
  }
  const avg = boxBlur(logAmp, n, n, 1)
  for (let i = 0; i < n * n; i++) {
    const r = Math.exp((logAmp[i] as number) - (avg[i] as number))
    re[i] = r * Math.cos(phase[i] as number)
    im[i] = r * Math.sin(phase[i] as number)
  }
  fft2d(re, im, n, true)
  const mag = new Float64Array(n * n)
  for (let i = 0; i < n * n; i++) mag[i] = (re[i] as number) ** 2 + (im[i] as number) ** 2
  const blurred = boxBlur(boxBlur(mag, n, n, 2), n, n, 2)
  return normalize01(blurred)
}

function normalize01(a: Float64Array): Float64Array {
  let min = Infinity; let max = -Infinity
  for (const v of a) { if (v < min) min = v; if (v > max) max = v }
  const out = new Float64Array(a.length)
  const d = max - min || 1
  for (let i = 0; i < a.length; i++) out[i] = ((a[i] as number) - min) / d
  return out
}

/* ---------------------------------------------------------------- features */

function percentileFromHist(hist: Float64Array, total: number, p: number): number {
  let acc = 0
  const target = total * p
  for (let i = 0; i < hist.length; i++) {
    acc += hist[i] as number
    if (acc >= target) return i
  }
  return hist.length - 1
}

function laplacianVariance(gray: Float32Array, w: number, h: number, x0 = 1, y0 = 1, x1 = w - 1, y1 = h - 1): number {
  let sum = 0; let sum2 = 0; let n = 0
  for (let y = Math.max(1, y0); y < Math.min(h - 1, y1); y++) {
    for (let x = Math.max(1, x0); x < Math.min(w - 1, x1); x++) {
      const i = y * w + x
      const v = (gray[i - w] as number) + (gray[i + w] as number) + (gray[i - 1] as number) + (gray[i + 1] as number) - 4 * (gray[i] as number)
      sum += v; sum2 += v * v; n++
    }
  }
  if (n === 0) return 0
  const mean = sum / n
  return sum2 / n - mean * mean
}

export function computeFeatures(img: RgbImage): Features {
  const { width: w, height: h, data } = img
  const n = w * h
  const gray = luminance(img)

  // Exposure histogram.
  const hist = new Float64Array(256)
  let clipHigh = 0
  let clipLow = 0
  let lumSum = 0
  let lumSum2 = 0
  for (let i = 0, j = 0; i < n; i++, j += 3) {
    const l = gray[i] as number
    hist[Math.min(255, Math.round(l))]! += 1
    lumSum += l; lumSum2 += l * l
    const mx = Math.max(data[j] as number, data[j + 1] as number, data[j + 2] as number)
    if (mx >= 253) clipHigh++
    if (l <= 3) clipLow++
  }
  const mean = lumSum / n
  const std = Math.sqrt(Math.max(0, lumSum2 / n - mean * mean))
  let entropy = 0
  for (const c of hist) if (c > 0) { const p = c / n; entropy -= p * Math.log2(p) }
  const p01 = percentileFromHist(hist, n, 0.01)
  const p99 = percentileFromHist(hist, n, 0.99)
  const median = percentileFromHist(hist, n, 0.5)

  // Sharpness on a contrast-normalized copy (p1..p99 stretched to 0..255), so a
  // dark or flat but crisp frame is not mistaken for an out-of-focus one.
  const span = Math.max(24, p99 - p01)
  const norm = new Float32Array(n)
  for (let i = 0; i < n; i++) norm[i] = Math.max(0, Math.min(255, ((gray[i] as number) - p01) * 255 / span))
  const global = laplacianVariance(norm, w, h)
  const tiles: number[] = []
  const grid = 6
  let centerAcc = 0; let centerW = 0
  for (let ty = 0; ty < grid; ty++) {
    for (let tx = 0; tx < grid; tx++) {
      const v = laplacianVariance(norm, w, h, Math.floor(tx * w / grid), Math.floor(ty * h / grid), Math.floor((tx + 1) * w / grid), Math.floor((ty + 1) * h / grid))
      tiles.push(v)
      const cx = (tx + 0.5) / grid - 0.5
      const cy = (ty + 0.5) / grid - 0.5
      const weight = Math.exp(-(cx * cx + cy * cy) / 0.08)
      centerAcc += v * weight; centerW += weight
    }
  }
  tiles.sort((a, b) => a - b)
  const peak = tiles[Math.floor(tiles.length * 0.9)] ?? global

  // Structure tensor (motion blur shows strongly oriented residual gradients) + edge angles.
  let sxx = 0; let syy = 0; let sxy = 0
  const angleBins = new Float64Array(180)
  let gradMagSum = 0
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      const gx = (gray[i + 1] as number) - (gray[i - 1] as number)
      const gy = (gray[i + w] as number) - (gray[i - w] as number)
      sxx += gx * gx; syy += gy * gy; sxy += gx * gy
      const m = Math.hypot(gx, gy)
      gradMagSum += m
      if (m > 24) {
        // Edge (line) orientation is perpendicular to the gradient.
        let a = Math.atan2(gy, gx) * 180 / Math.PI + 90
        a = ((a % 180) + 180) % 180
        angleBins[Math.min(179, Math.floor(a))]! += m
      }
    }
  }
  const tr = sxx + syy
  const det = sxx * syy - sxy * sxy
  const disc = Math.sqrt(Math.max(0, tr * tr / 4 - det))
  const l1 = tr / 2 + disc
  const l2 = tr / 2 - disc
  const anisotropy = l1 > 0 ? (l1 - l2) / (l1 + l2 + 1e-9) : 0

  // Tilt: strongest line family within ±12° of horizontal or vertical.
  const smooth = (center: number): number => {
    let s = 0
    for (let k = -1; k <= 1; k++) s += angleBins[(center + k + 180) % 180] as number
    return s
  }
  let best = { dev: 0, strength: 0 }
  let totalAngle = 0
  for (const v of angleBins) totalAngle += v
  for (const base of [0, 90]) {
    for (let dev = -12; dev <= 12; dev++) {
      const s = smooth((base + dev + 180) % 180)
      if (s > best.strength) best = { dev, strength: s }
    }
  }
  // Sign convention: positive tilt means the horizon rises to the right (needs clockwise correction).
  const tiltDeg = -best.dev
  const tiltConfidence = totalAngle > 0 ? Math.min(1, (best.strength / totalAngle) * 12) : 0

  // Noise (Immerkær), restricted to low-gradient pixels.
  let noiseAcc = 0; let noiseN = 0
  const flatThreshold = Math.max(4, (gradMagSum / ((w - 2) * (h - 2))) * 0.6)
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      const gx = (gray[i + 1] as number) - (gray[i - 1] as number)
      const gy = (gray[i + w] as number) - (gray[i - w] as number)
      if (Math.hypot(gx, gy) > flatThreshold) continue
      const v = (gray[i - w - 1] as number) - 2 * (gray[i - w] as number) + (gray[i - w + 1] as number)
        - 2 * (gray[i - 1] as number) + 4 * (gray[i] as number) - 2 * (gray[i + 1] as number)
        + (gray[i + w - 1] as number) - 2 * (gray[i + w] as number) + (gray[i + w + 1] as number)
      noiseAcc += Math.abs(v); noiseN++
    }
  }
  const noise = noiseN > 100 ? Math.sqrt(Math.PI / 2) * noiseAcc / (6 * noiseN) : 0

  // Color.
  let rgS = 0; let rgS2 = 0; let ybS = 0; let ybS2 = 0; let satS = 0
  const hsvHist = new Array<number>(64).fill(0)
  let castA = 0; let castB = 0; let castN = 0; let aAll = 0; let bAll = 0
  const step = Math.max(1, Math.floor(n / 40000))
  let sampled = 0
  for (let i = 0; i < n; i += step) {
    const j = i * 3
    const r = data[j] as number; const g = data[j + 1] as number; const b = data[j + 2] as number
    const rg = r - g
    const yb = 0.5 * (r + g) - b
    rgS += rg; rgS2 += rg * rg; ybS += yb; ybS2 += yb * yb
    const [hh, ss, vv] = rgbToHsv(r, g, b)
    satS += ss
    const hb = ss < 0.12 ? 0 : 1 + Math.min(6, Math.floor(hh / (360 / 7)))
    const vb = Math.min(3, Math.floor(vv * 4))
    const sb = ss < 0.45 ? 0 : 1
    const bin = (hb * 4 + vb) * 2 + sb // 8 hue classes × 4 values × 2 saturations = 64 bins
    hsvHist[bin] = (hsvHist[bin] ?? 0) + 1
    const [L, A, B] = rgbToLab(r, g, b)
    aAll += A; bAll += B
    if (Math.hypot(A, B) < 12 && L > 15 && L < 95) { castA += A; castB += B; castN++ }
    sampled++
  }
  const rgMean = rgS / sampled; const ybMean = ybS / sampled
  const rgStd = Math.sqrt(Math.max(0, rgS2 / sampled - rgMean ** 2))
  const ybStd = Math.sqrt(Math.max(0, ybS2 / sampled - ybMean ** 2))
  const colorfulness = Math.sqrt(rgStd ** 2 + ybStd ** 2) + 0.3 * Math.sqrt(rgMean ** 2 + ybMean ** 2)
  const histTotal = hsvHist.reduce((a, b) => a + b, 0) || 1
  const colorHist = hsvHist.map(v => v / histTotal)
  const useNeutral = castN > sampled * 0.03

  // Layout: 8×8 Lab thumbnail.
  const layout: number[] = []
  for (let gy = 0; gy < 8; gy++) {
    for (let gx = 0; gx < 8; gx++) {
      let sr = 0; let sg = 0; let sb = 0; let c = 0
      const x0 = Math.floor(gx * w / 8); const x1 = Math.floor((gx + 1) * w / 8)
      const y0 = Math.floor(gy * h / 8); const y1 = Math.floor((gy + 1) * h / 8)
      for (let y = y0; y < y1; y += 2) {
        for (let x = x0; x < x1; x += 2) {
          const j = (y * w + x) * 3
          sr += data[j] as number; sg += data[j + 1] as number; sb += data[j + 2] as number; c++
        }
      }
      const [L, A, B] = rgbToLab(Math.round(sr / Math.max(1, c)), Math.round(sg / Math.max(1, c)), Math.round(sb / Math.max(1, c)))
      layout.push(L / 100, A / 128, B / 128)
    }
  }

  // Saliency: spectral residual blended with global color contrast.
  const spectral = spectralSaliency(gray, w, h)
  const sn = 64
  const contrastMap = new Float64Array(sn * sn)
  const meanL = layout.filter((_, i) => i % 3 === 0).reduce((a, b) => a + b, 0) / 64
  const meanA = layout.filter((_, i) => i % 3 === 1).reduce((a, b) => a + b, 0) / 64
  const meanB = layout.filter((_, i) => i % 3 === 2).reduce((a, b) => a + b, 0) / 64
  for (let y = 0; y < sn; y++) {
    for (let x = 0; x < sn; x++) {
      const px = Math.min(w - 1, Math.floor((x + 0.5) * w / sn))
      const py = Math.min(h - 1, Math.floor((y + 0.5) * h / sn))
      const j = (py * w + px) * 3
      const [L, A, B] = rgbToLab(data[j] as number, data[j + 1] as number, data[j + 2] as number)
      contrastMap[y * sn + x] = Math.hypot(L / 100 - meanL, A / 128 - meanA, B / 128 - meanB)
    }
  }
  const cm = normalize01(boxBlur(contrastMap, sn, sn, 2))
  const sal = new Float64Array(sn * sn)
  for (let i = 0; i < sal.length; i++) sal[i] = 0.55 * (spectral[i] as number) + 0.45 * (cm[i] as number)
  let mass = 0; let mx = 0; let my = 0
  for (let y = 0; y < sn; y++) for (let x = 0; x < sn; x++) {
    const v = (sal[y * sn + x] as number) ** 2
    mass += v; mx += v * (x + 0.5) / sn; my += v * (y + 0.5) / sn
  }
  const cx = mass > 0 ? mx / mass : 0.5
  const cy = mass > 0 ? my / mass : 0.5
  let spread = 0; let leftMass = 0; let rightMass = 0; let border = 0; let borderN = 0; let allSal = 0
  for (let y = 0; y < sn; y++) for (let x = 0; x < sn; x++) {
    const v = sal[y * sn + x] as number
    const v2 = v * v
    spread += v2 * ((((x + 0.5) / sn) - cx) ** 2 + (((y + 0.5) / sn) - cy) ** 2)
    if (x < sn / 2) leftMass += v2; else rightMass += v2
    allSal += v
    if (x < 4 || y < 4 || x >= sn - 4 || y >= sn - 4) { border += v; borderN++ }
  }
  spread = mass > 0 ? Math.sqrt(spread / mass) : 0.5
  const thirdsPoints: Array<[number, number]> = [[1 / 3, 1 / 3], [2 / 3, 1 / 3], [1 / 3, 2 / 3], [2 / 3, 2 / 3]]
  const dThirds = Math.min(...thirdsPoints.map(([px, py]) => Math.hypot(cx - px, cy - py)))
  const thirds = Math.max(0, 1 - dThirds / 0.22)
  const balance = 1 - Math.abs(leftMass - rightMass) / (leftMass + rightMass + 1e-9)
  // Symmetry on a 64-wide luminance map.
  const sym = resampleGray(gray, w, h, 64, 48)
  let symDiff = 0
  for (let y = 0; y < 48; y++) for (let x = 0; x < 32; x++) symDiff += Math.abs((sym[y * 64 + x] as number) - (sym[y * 64 + 63 - x] as number))
  const symmetry = 1 - symDiff / (48 * 32 * 255) * 4
  const sortedSal = Array.from(sal).sort((a, b) => b - a)
  const top = sortedSal.slice(0, Math.floor(sortedSal.length * 0.1))
  const topMean = top.reduce((a, b) => a + b, 0) / Math.max(1, top.length)
  const restMean = (allSal - topMean * top.length) / Math.max(1, sal.length - top.length)

  return {
    version: FEATURE_VERSION,
    width: w,
    height: h,
    phash: pHash(gray, w, h),
    dhash: dHash(gray, w, h),
    colorHist,
    layout: layout.map(v => Math.round(v * 1000) / 1000),
    sharpness: { global, peak, centerWeighted: centerW > 0 ? centerAcc / centerW : global, anisotropy },
    exposure: {
      mean: mean / 255,
      median: median / 255,
      p01: p01 / 255,
      p99: p99 / 255,
      clipHigh: clipHigh / n,
      clipLow: clipLow / n,
      entropy,
      dynamicRange: (p99 - p01) / 255,
    },
    contrast: std / 255,
    noise,
    color: {
      colorfulness,
      saturation: satS / sampled,
      castA: useNeutral ? castA / castN : aAll / sampled,
      castB: useNeutral ? castB / castN : bAll / sampled,
      warmth: bAll / sampled,
    },
    composition: {
      saliencyCentroid: [cx, cy],
      saliencySpread: spread,
      thirds,
      balance,
      tiltDeg,
      tiltConfidence,
      symmetry: Math.max(0, Math.min(1, symmetry)),
      borderClutter: borderN > 0 && allSal > 0 ? (border / borderN) / (allSal / sal.length) : 1,
      subjectContrast: restMean > 0 ? topMean / restMean : 1,
    },
  }
}

/* ------------------------------------------------------------- similarity */

export function histDistance(a: readonly number[], b: readonly number[]): number {
  // Chi-square distance, 0..~2
  let d = 0
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i] as number; const y = b[i] as number
    if (x + y > 0) d += (x - y) ** 2 / (x + y)
  }
  return d
}

export function layoutDistance(a: readonly number[], b: readonly number[]): number {
  let d = 0
  for (let i = 0; i < Math.min(a.length, b.length); i++) d += ((a[i] as number) - (b[i] as number)) ** 2
  return Math.sqrt(d / Math.max(1, a.length))
}

/** Visual dissimilarity 0 (identical) .. 1 (unrelated) combining hash, color and layout. */
export function visualDistance(a: Pick<Features, 'phash' | 'colorHist' | 'layout'>, b: Pick<Features, 'phash' | 'colorHist' | 'layout'>): number {
  const ph = hamming(a.phash, b.phash) / 32
  const hd = Math.min(1, histDistance(a.colorHist, b.colorHist) / 0.8)
  const ld = Math.min(1, layoutDistance(a.layout, b.layout) / 0.25)
  return Math.min(1, 0.35 * Math.min(1, ph) + 0.3 * hd + 0.35 * ld)
}
