/**
 * Mask rasterisation for the built-in engine. Geometry is in normalized
 * coordinates of the (oriented) source image; circle/ellipse radii and brush
 * radii are relative to the image's longer side (same convention as the
 * darktable adapter).
 */
import type { MaskShape, MaskSpec, ParametricRange } from '../../../types.ts'
import { boxBlur, gaussBlur, lumaOf, toSrgb, type FImage } from './image.ts'

const smooth = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t))

function shapeAlpha(s: MaskShape, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h)
  const L = Math.max(w, h)
  switch (s.type) {
    case 'circle':
    case 'ellipse': {
      const cx = s.cx * w
      const cy = s.cy * h
      const rx = (s.type === 'circle' ? s.r : s.rx) * L
      const ry = (s.type === 'circle' ? s.r : s.ry) * L
      const rot = s.type === 'ellipse' ? ((s.rotation ?? 0) * Math.PI) / 180 : 0
      const feather = Math.max(1e-3, (s.feather ?? 0.05) * L)
      const cos = Math.cos(rot); const sin = Math.sin(rot)
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const dx = x + 0.5 - cx; const dy = y + 0.5 - cy
          const u = (dx * cos + dy * sin) / rx
          const v = (-dx * sin + dy * cos) / ry
          const d = Math.sqrt(u * u + v * v) // 1 at the boundary
          const dist = (d - 1) * Math.min(rx, ry)
          out[y * w + x] = 1 - smooth(dist / feather)
        }
      }
      break
    }
    case 'rectangle': {
      const feather = Math.max(1e-3, (s.feather ?? 0.03) * L)
      const x0 = s.x * w; const y0 = s.y * h; const x1 = (s.x + s.w) * w; const y1 = (s.y + s.h) * h
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const dx = Math.max(x0 - x, 0, x - x1)
          const dy = Math.max(y0 - y, 0, y - y1)
          out[y * w + x] = 1 - smooth(Math.hypot(dx, dy) / feather)
        }
      }
      break
    }
    case 'gradient': {
      const x0 = s.x0 * w; const y0 = s.y0 * h; const x1 = s.x1 * w; const y1 = s.y1 * h
      const dx = x1 - x0; const dy = y1 - y0
      const len2 = Math.max(1e-6, dx * dx + dy * dy)
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const t = ((x - x0) * dx + (y - y0) * dy) / len2
          out[y * w + x] = 1 - smooth(t)
        }
      }
      break
    }
    case 'polygon': {
      const pts = s.points.map(([px, py]) => [px * w, py * h] as const)
      for (let y = 0; y < h; y++) {
        const yy = y + 0.5
        const xs: number[] = []
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
          const [xi, yi] = pts[i] as readonly [number, number]
          const [xj, yj] = pts[j] as readonly [number, number]
          if ((yi > yy) !== (yj > yy)) xs.push(xi + ((yy - yi) * (xj - xi)) / (yj - yi))
        }
        xs.sort((a, b) => a - b)
        for (let k = 0; k + 1 < xs.length; k += 2) {
          for (let x = Math.max(0, Math.ceil((xs[k] as number) - 0.5)); x < Math.min(w, Math.floor((xs[k + 1] as number) + 0.5)); x++) out[y * w + x] = 1
        }
      }
      const f = (s.feather ?? 0.02) * L
      if (f >= 1) return boxBlur(boxBlur(out, w, h, f / 2), w, h, f / 2)
      break
    }
    case 'brush': {
      for (const stroke of s.strokes) {
        const r = Math.max(1, stroke.radius * L)
        const hard = Math.min(0.99, Math.max(0, stroke.hardness ?? 0.6))
        const pts = stroke.points.map(([px, py]) => [px * w, py * h] as const)
        // densify the polyline so dabs overlap
        const dabs: Array<readonly [number, number]> = []
        for (let i = 0; i < pts.length; i++) {
          const a = pts[i] as readonly [number, number]
          dabs.push(a)
          const b = pts[i + 1]
          if (b === undefined) continue
          const steps = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / (r * 0.3))
          for (let k = 1; k < steps; k++) dabs.push([a[0] + ((b[0] - a[0]) * k) / steps, a[1] + ((b[1] - a[1]) * k) / steps])
        }
        for (const [cx, cy] of dabs) {
          for (let y = Math.max(0, Math.floor(cy - r)); y < Math.min(h, Math.ceil(cy + r)); y++) {
            for (let x = Math.max(0, Math.floor(cx - r)); x < Math.min(w, Math.ceil(cx + r)); x++) {
              const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / r
              const a = d <= hard ? 1 : 1 - smooth((d - hard) / (1 - hard))
              const i = y * w + x
              if (a > (out[i] as number)) out[i] = a
            }
          }
        }
      }
      break
    }
  }
  if (s.invert === true) for (let i = 0; i < out.length; i++) out[i] = 1 - (out[i] as number)
  if (s.opacity !== undefined) for (let i = 0; i < out.length; i++) out[i] = (out[i] as number) * s.opacity
  return out
}

function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  let hh = 0
  if (d > 1e-9) {
    if (max === r) hh = ((g - b) / d) % 6
    else if (max === g) hh = (b - r) / d + 2
    else hh = (r - g) / d + 4
    hh *= 60
    if (hh < 0) hh += 360
  }
  return [hh, max <= 0 ? 0 : d / max, max]
}

function channelValue(ch: ParametricRange['channel'], r: number, g: number, b: number): number {
  const R = toSrgb(r); const G = toSrgb(g); const B = toSrgb(b)
  switch (ch) {
    case 'luminance': case 'lab_l': case 'gray': case 'jzazbz_j': return toSrgb(lumaOf(r, g, b))
    case 'red': return R
    case 'green': return G
    case 'blue': return B
    case 'hue': return rgbToHsv(R, G, B)[0]
    case 'saturation': case 'chroma': return rgbToHsv(R, G, B)[1]
    case 'value': return rgbToHsv(R, G, B)[2]
    case 'lab_a': return (R - G) * 128
    case 'lab_b': return ((R + G) / 2 - B) * 128
  }
}

function rangeAlpha(v: number, r: ParametricRange): number {
  const soft = Math.max(1e-6, r.softness ?? (r.channel === 'hue' ? 15 : 0.05))
  let a: number
  if (r.channel === 'hue' && r.from > r.to) {
    // wrap-around hue range (e.g. 330..30 for reds)
    const inRange = v >= r.from || v <= r.to
    const dist = inRange ? 0 : Math.min(Math.abs(v - r.from), Math.abs(v - r.to))
    a = 1 - smooth(dist / soft)
  } else if (r.channel === 'hue') {
    const d = v < r.from ? Math.min(r.from - v, v + 360 - r.to) : v > r.to ? Math.min(v - r.to, r.from + 360 - v) : 0
    a = 1 - smooth(d / soft)
  } else {
    const d = v < r.from ? r.from - v : v > r.to ? v - r.to : 0
    a = 1 - smooth(d / soft)
  }
  return r.invert === true ? 1 - a : a
}

/** Rasterize a MaskSpec for an image; `source` supplies pixel values for parametric ranges. */
export function rasterizeMask(spec: MaskSpec, source: FImage): Float32Array {
  const { width: w, height: h } = source
  const n = w * h
  let drawn: Float32Array | undefined
  if (spec.shapes !== undefined && spec.shapes.length > 0) {
    const combine = spec.shapesCombine ?? 'union'
    for (const s of spec.shapes) {
      const a = shapeAlpha(s, w, h)
      if (drawn === undefined) { drawn = a; continue }
      for (let i = 0; i < n; i++) {
        const x = drawn[i] as number; const y = a[i] as number
        drawn[i] = combine === 'union' ? Math.max(x, y) : combine === 'intersection' ? Math.min(x, y) : combine === 'difference' ? x * (1 - y) : Math.abs(x - y)
      }
    }
  }
  let param: Float32Array | undefined
  if (spec.parametric !== undefined && spec.parametric.length > 0) {
    param = new Float32Array(n).fill(1)
    const d = source.data
    for (let i = 0, j = 0; i < n; i++, j += 3) {
      let a = 1
      for (const r of spec.parametric) a *= rangeAlpha(channelValue(r.channel, d[j] as number, d[j + 1] as number, d[j + 2] as number), r)
      param[i] = a
    }
  }
  let mask: Float32Array
  if (drawn !== undefined && param !== undefined) {
    mask = new Float32Array(n)
    for (let i = 0; i < n; i++) mask[i] = spec.combine === 'union' ? Math.max(drawn[i] as number, param[i] as number) : (drawn[i] as number) * (param[i] as number)
  } else {
    mask = drawn ?? param ?? new Float32Array(n).fill(1)
  }
  const L = Math.max(w, h)
  if (spec.feather !== undefined && spec.feather > 0) mask = gaussBlur(mask, w, h, spec.feather * L * 0.5)
  if (spec.blur !== undefined && spec.blur > 0) mask = gaussBlur(mask, w, h, spec.blur * L * 0.5)
  if (spec.invert === true) for (let i = 0; i < n; i++) mask[i] = 1 - (mask[i] as number)
  const op = spec.opacity ?? 1
  if (op !== 1) for (let i = 0; i < n; i++) mask[i] = (mask[i] as number) * op
  return mask
}

/** out = before + (after − before) · mask */
export function blendWithMask(before: FImage, after: FImage, mask: Float32Array): FImage {
  const out = new Float32Array(after.data.length)
  const a = before.data
  const b = after.data
  for (let i = 0, j = 0; i < mask.length; i++, j += 3) {
    const m = mask[i] as number
    out[j] = (a[j] as number) + ((b[j] as number) - (a[j] as number)) * m
    out[j + 1] = (a[j + 1] as number) + ((b[j + 1] as number) - (a[j + 1] as number)) * m
    out[j + 2] = (a[j + 2] as number) + ((b[j + 2] as number) - (a[j + 2] as number)) * m
  }
  return { width: after.width, height: after.height, data: out }
}
