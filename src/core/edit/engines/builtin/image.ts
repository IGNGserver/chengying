/**
 * Float image buffers for the built-in engine: linear-light RGB in
 * Float32Array, converted from / to 16-bit sRGB through sharp (libvips).
 */
import sharp from 'sharp'

export interface FImage { width: number; height: number; data: Float32Array /* RGB linear, interleaved */ }

const LUT16 = new Float32Array(65536).map((_, i) => {
  const v = i / 65535
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
})

export function toSrgb(v: number): number {
  if (v <= 0) return 0
  if (v >= 1) return 1
  return v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055
}

export function toLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}

export async function loadImage(path: string, maxEdge?: number, orientation?: number | null): Promise<FImage> {
  let img = sharp(path, { failOn: 'none', limitInputPixels: false }).rotate()
  void orientation
  if (maxEdge !== undefined && maxEdge > 0) img = img.resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
  const { data, info } = await img.removeAlpha().toColourspace('rgb16').raw({ depth: 'ushort' }).toBuffer({ resolveWithObject: true })
  const src = new Uint16Array(data.buffer, data.byteOffset, data.byteLength / 2)
  const out = new Float32Array(info.width * info.height * 3)
  for (let i = 0; i < out.length; i++) out[i] = LUT16[src[i] as number] as number
  return { width: info.width, height: info.height, data: out }
}

export async function saveImage(img: FImage, path: string, format: 'jpeg' | 'tiff' | 'png', quality = 92, bitDepth: 8 | 16 = 8): Promise<void> {
  const n = img.width * img.height * 3
  if (format === 'tiff' || (format === 'png' && bitDepth === 16)) {
    const buf = new Uint16Array(n)
    for (let i = 0; i < n; i++) buf[i] = Math.round(toSrgb(img.data[i] as number) * 65535)
    let s = sharp(Buffer.from(buf.buffer), { raw: { width: img.width, height: img.height, channels: 3, premultiplied: false } }).toColourspace('rgb16')
    s = format === 'tiff' ? s.tiff({ compression: 'deflate' }) : s.png({ compressionLevel: 6 })
    await s.toFile(path)
    return
  }
  const buf = Buffer.alloc(n)
  for (let i = 0; i < n; i++) buf[i] = Math.round(toSrgb(img.data[i] as number) * 255)
  let s = sharp(buf, { raw: { width: img.width, height: img.height, channels: 3 } })
  s = format === 'png' ? s.png({ compressionLevel: 6 }) : s.jpeg({ quality, chromaSubsampling: quality >= 90 ? '4:4:4' : '4:2:0' })
  await s.withIccProfile('srgb').toFile(path)
}

export function clone(img: FImage): FImage {
  return { width: img.width, height: img.height, data: new Float32Array(img.data) }
}

export const lumaOf = (r: number, g: number, b: number): number => 0.2126 * r + 0.7152 * g + 0.0722 * b

/** Separable box blur on a single-channel float plane (O(n) per pass). */
export function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  if (r < 1) return new Float32Array(src)
  const tmp = new Float32Array(w * h)
  const out = new Float32Array(w * h)
  const rr = Math.round(r)
  for (let y = 0; y < h; y++) {
    let acc = 0
    const row = y * w
    for (let x = -rr; x <= rr; x++) acc += src[row + Math.min(w - 1, Math.max(0, x))] as number
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc / (2 * rr + 1)
      acc += (src[row + Math.min(w - 1, x + rr + 1)] as number) - (src[row + Math.max(0, x - rr)] as number)
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0
    for (let y = -rr; y <= rr; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x] as number
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / (2 * rr + 1)
      acc += (tmp[Math.min(h - 1, y + rr + 1) * w + x] as number) - (tmp[Math.max(0, y - rr) * w + x] as number)
    }
  }
  return out
}

/** Approximate Gaussian blur: three box passes. */
export function gaussBlur(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  if (sigma <= 0.3) return new Float32Array(src)
  const r = Math.max(1, Math.round(Math.sqrt((12 * sigma * sigma) / 3 + 1) / 2))
  return boxBlur(boxBlur(boxBlur(src, w, h, r), w, h, r), w, h, r)
}

export function plane(img: FImage, c: 0 | 1 | 2): Float32Array {
  const n = img.width * img.height
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = img.data[i * 3 + c] as number
  return out
}

export function luminancePlane(img: FImage): Float32Array {
  const n = img.width * img.height
  const out = new Float32Array(n)
  const d = img.data
  for (let i = 0, j = 0; i < n; i++, j += 3) out[i] = lumaOf(d[j] as number, d[j + 1] as number, d[j + 2] as number)
  return out
}

/** Guided filter (He et al.) with the image's own luminance as guide: edge-preserving smoothing. */
export function guidedFilter(p: Float32Array, I: Float32Array, w: number, h: number, r: number, eps: number): Float32Array {
  const n = w * h
  const meanI = boxBlur(I, w, h, r)
  const meanP = boxBlur(p, w, h, r)
  const ip = new Float32Array(n)
  const ii = new Float32Array(n)
  for (let i = 0; i < n; i++) { ip[i] = (I[i] as number) * (p[i] as number); ii[i] = (I[i] as number) * (I[i] as number) }
  const corrIp = boxBlur(ip, w, h, r)
  const corrI = boxBlur(ii, w, h, r)
  const a = new Float32Array(n)
  const b = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const varI = (corrI[i] as number) - (meanI[i] as number) ** 2
    const cov = (corrIp[i] as number) - (meanI[i] as number) * (meanP[i] as number)
    a[i] = cov / (varI + eps)
    b[i] = (meanP[i] as number) - (a[i] as number) * (meanI[i] as number)
  }
  const ma = boxBlur(a, w, h, r)
  const mb = boxBlur(b, w, h, r)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = (ma[i] as number) * (I[i] as number) + (mb[i] as number)
  return out
}

/** Bilinear sample of channel c at fractional coordinates (clamped). */
export function sample(img: FImage, x: number, y: number, c: number): number {
  const w = img.width
  const h = img.height
  const xf = Math.min(w - 1, Math.max(0, x))
  const yf = Math.min(h - 1, Math.max(0, y))
  const x0 = Math.floor(xf); const y0 = Math.floor(yf)
  const x1 = Math.min(w - 1, x0 + 1); const y1 = Math.min(h - 1, y0 + 1)
  const fx = xf - x0; const fy = yf - y0
  const d = img.data
  const a = d[(y0 * w + x0) * 3 + c] as number
  const b = d[(y0 * w + x1) * 3 + c] as number
  const cc = d[(y1 * w + x0) * 3 + c] as number
  const dd = d[(y1 * w + x1) * 3 + c] as number
  return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + cc * (1 - fx) * fy + dd * fx * fy
}
