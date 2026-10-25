/**
 * darktable blending + masks.
 *
 * Blend parameters (dt_develop_blend_params_t) and drawn-mask forms are not
 * described by module introspection, so they are hand-mapped from darktable's
 * src/develop/blend.h and src/develop/masks.h. The mapping is version-gated:
 * it is only used when the installed darktable reports the same blend params
 * version (DEVELOP_BLEND_VERSION 14, darktable 4.x–5.x); otherwise masks
 * report "unsupported" instead of writing a wrong layout. Every blend field is
 * also reachable verbatim through MaskSpec.native.
 */
import type { MaskShape, MaskSpec, ParametricRange } from '../../../types.ts'
import type { ParamSchema } from '../../schema.ts'
import { ChengyingError } from '../../../util/errors.ts'

export const SUPPORTED_BLEND_VERSION = 14
export const SUPPORTED_MASKS_VERSION = 6
export const BLEND_PARAMS_SIZE = 420

export const BLEND_CS = { none: 0, raw: 1, lab: 2, rgb_display: 3, rgb_scene: 4 } as const

/** IOP colorspace (module default) → darktable's default blend colorspace in a scene-referred workflow. */
export function blendColorspaceFor(iopCs: number | undefined): number {
  switch (iopCs) {
    case 0: return BLEND_CS.raw
    case 1: case 3: return BLEND_CS.lab
    case 2: case 5: return BLEND_CS.rgb_scene
    case 4: return BLEND_CS.rgb_display
    default: return BLEND_CS.rgb_scene
  }
}

export const BLEND_MODES: Record<string, number> = {
  normal: 0x18, bounded: 0x19, lighten: 0x02, darken: 0x03, multiply: 0x04, average: 0x05, add: 0x06, subtract: 0x07,
  difference: 0x17, screen: 0x09, overlay: 0x0a, softlight: 0x0b, hardlight: 0x0c, vividlight: 0x0d, linearlight: 0x0e,
  pinlight: 0x0f, lightness: 0x10, chromaticity: 0x11, hue: 0x12, color: 0x13, coloradjust: 0x16, lab_lightness: 0x1a,
  lab_color: 0x1b, hsv_value: 0x1c, hsv_color: 0x1d, lab_l: 0x1e, lab_a: 0x1f, lab_b: 0x20, rgb_r: 0x21, rgb_g: 0x22,
  rgb_b: 0x23, subtract_inverse: 0x25, divide: 0x26, divide_inverse: 0x27, geometric_mean: 0x28, harmonic_mean: 0x29,
}

/** Channel indices per blend colorspace (input side; output = +4). */
const CHANNELS: Record<number, Partial<Record<ParametricRange['channel'], number>>> = {
  [BLEND_CS.lab]: { luminance: 0, lab_l: 0, lab_a: 1, lab_b: 2, chroma: 8, saturation: 8, hue: 9 },
  [BLEND_CS.rgb_display]: { luminance: 0, gray: 0, red: 1, green: 2, blue: 3, hue: 8, saturation: 9, value: 10 },
  [BLEND_CS.rgb_scene]: { luminance: 0, gray: 0, red: 1, green: 2, blue: 3, jzazbz_j: 8, chroma: 9, saturation: 9, hue: 10 },
}

export const MASK_MODE = { disabled: 0, enabled: 1, drawn: 2, parametric: 4, raster: 8 } as const

export interface BlendFields {
  mask_mode: number
  blend_cst: number
  blend_mode: number
  blend_parameter: number
  opacity: number
  mask_combine: number
  mask_id: number
  blendif: number
  feathering_radius: number
  feathering_guide: number
  blur_radius: number
  contrast: number
  brightness: number
  details: number
  feather_version: number
  blendif_parameters: number[]
  blendif_boost_factors: number[]
  raster_mask_source: string
  raster_mask_instance: number
  raster_mask_id: number
  raster_mask_invert: boolean
}

export function defaultBlend(cst: number): BlendFields {
  const params: number[] = []
  for (let i = 0; i < 16; i++) params.push(0, 0, 1, 1)
  const boost = new Array<number>(16).fill(0)
  if (cst === BLEND_CS.rgb_scene) for (const i of [8, 9, 12, 13]) boost[i] = -6.64385619
  return {
    mask_mode: MASK_MODE.disabled, blend_cst: cst, blend_mode: BLEND_MODES.normal as number, blend_parameter: 0, opacity: 100,
    mask_combine: 0, mask_id: 0, blendif: 0, feathering_radius: 0, feathering_guide: 0x05, blur_radius: 0, contrast: 0,
    brightness: 0, details: 0, feather_version: 1, blendif_parameters: params, blendif_boost_factors: boost,
    raster_mask_source: '', raster_mask_instance: 0, raster_mask_id: -1, raster_mask_invert: false,
  }
}

/** Schema of the native blend fields (documented for MaskSpec.native). */
export const BLEND_SCHEMA: ParamSchema = {
  type: 'object',
  description: 'darktable blending (dt_develop_blend_params_t v14). Prefer MaskSpec fields; native overrides these exact fields.',
  properties: {
    mask_mode: { type: 'integer', description: 'bit flags: 1 enabled, 2 drawn, 4 parametric, 8 raster' },
    blend_cst: { type: 'integer', description: '0 none, 1 raw, 2 Lab, 3 RGB display, 4 RGB scene' },
    blend_mode: { type: 'integer', description: `blend mode id (${Object.entries(BLEND_MODES).map(([k, v]) => `${k}=${v}`).join(', ')}); |0x80000000 reverses` },
    blend_parameter: { type: 'number', minimum: -18, maximum: 18, description: 'blend fulcrum / parameter (EV)' },
    opacity: { type: 'number', minimum: 0, maximum: 100 },
    mask_combine: { type: 'integer', description: 'bit 1 invert combined mask, bit 2 include (union) parametric with drawn' },
    feathering_radius: { type: 'number', minimum: 0, maximum: 250, description: 'guided-filter feathering radius (px)' },
    feathering_guide: { type: 'integer', description: '1 in/before blur, 2 out/before blur, 5 in/after blur, 6 out/after blur' },
    blur_radius: { type: 'number', minimum: 0, maximum: 100 },
    contrast: { type: 'number', minimum: -1, maximum: 1 },
    brightness: { type: 'number', minimum: -1, maximum: 1 },
    details: { type: 'number', minimum: -1, maximum: 1, description: 'details threshold (detail mask)' },
    blendif: { type: 'integer', description: 'bit i: channel i active; bit 16+i: channel i inverted' },
    blendif_parameters: { type: 'array', items: { type: 'number' }, minItems: 64, maxItems: 64, description: '4 per channel: ramp-start, full-start, full-end, ramp-end (0..1)' },
    blendif_boost_factors: { type: 'array', items: { type: 'number' }, minItems: 16, maxItems: 16 },
    raster_mask_source: { type: 'string', description: 'operation providing a raster mask' },
    raster_mask_instance: { type: 'integer' },
    raster_mask_id: { type: 'integer' },
    raster_mask_invert: { type: 'boolean' },
  },
}

export function encodeBlend(f: BlendFields): Buffer {
  const b = Buffer.alloc(BLEND_PARAMS_SIZE)
  let o = 0
  const u32 = (v: number): void => { b.writeUInt32LE(v >>> 0, o); o += 4 }
  const i32 = (v: number): void => { b.writeInt32LE(v | 0, o); o += 4 }
  const f32 = (v: number): void => { b.writeFloatLE(v, o); o += 4 }
  u32(f.mask_mode); i32(f.blend_cst); u32(f.blend_mode); f32(f.blend_parameter); f32(f.opacity); u32(f.mask_combine)
  i32(f.mask_id); u32(f.blendif); f32(f.feathering_radius); u32(f.feathering_guide); f32(f.blur_radius); f32(f.contrast)
  f32(f.brightness); f32(f.details); u32(f.feather_version); u32(0); u32(0)
  for (let i = 0; i < 64; i++) f32(f.blendif_parameters[i] ?? (i % 4 < 2 ? 0 : 1))
  for (let i = 0; i < 16; i++) f32(f.blendif_boost_factors[i] ?? 0)
  Buffer.from(f.raster_mask_source, 'utf8').subarray(0, 19).copy(b, o); o += 20
  i32(f.raster_mask_instance); i32(f.raster_mask_id); i32(f.raster_mask_invert ? 1 : 0)
  if (o !== BLEND_PARAMS_SIZE) throw new ChengyingError('internal', `blend params size ${o} != ${BLEND_PARAMS_SIZE}`)
  return b
}

export function decodeBlend(b: Buffer): BlendFields | undefined {
  if (b.length !== BLEND_PARAMS_SIZE) return undefined
  let o = 0
  const u32 = (): number => { const v = b.readUInt32LE(o); o += 4; return v }
  const i32 = (): number => { const v = b.readInt32LE(o); o += 4; return v }
  const f32 = (): number => { const v = b.readFloatLE(o); o += 4; return Math.round(v * 1e6) / 1e6 }
  const f: Partial<BlendFields> = {}
  f.mask_mode = u32(); f.blend_cst = i32(); f.blend_mode = u32(); f.blend_parameter = f32(); f.opacity = f32(); f.mask_combine = u32()
  f.mask_id = i32(); f.blendif = u32(); f.feathering_radius = f32(); f.feathering_guide = u32(); f.blur_radius = f32(); f.contrast = f32()
  f.brightness = f32(); f.details = f32(); f.feather_version = u32(); o += 8
  f.blendif_parameters = Array.from({ length: 64 }, () => f32())
  f.blendif_boost_factors = Array.from({ length: 16 }, () => f32())
  const src = b.subarray(o, o + 20); o += 20
  const end = src.indexOf(0)
  f.raster_mask_source = src.subarray(0, end < 0 ? 20 : end).toString('utf8')
  f.raster_mask_instance = i32(); f.raster_mask_id = i32(); f.raster_mask_invert = i32() !== 0
  return f as BlendFields
}

/* ------------------------------------------------------------------ forms */

export const FORM_TYPE = { circle: 1, path: 2, group: 4, clone: 8, gradient: 16, ellipse: 32, brush: 64, nonClone: 128 } as const
const STATE = { use: 1, show: 2, inverse: 4, union: 8, intersection: 16, difference: 32, exclusion: 64 }

export interface DtForm {
  id: number
  type: number
  name: string
  version: number
  points: Buffer
  nb: number
  src: Buffer
}

let nextFormId = 1_000_000 + Math.floor(Math.random() * 1_000_000)

function floats(values: number[]): Buffer {
  const b = Buffer.alloc(values.length * 4)
  values.forEach((v, i) => b.writeFloatLE(v, i * 4))
  return b
}

function pathPoints(points: Array<[number, number]>, border: number, brush?: { hardness: number; radius: number }): Buffer {
  const size = brush === undefined ? 36 : 44
  const b = Buffer.alloc(points.length * size)
  points.forEach(([x, y], i) => {
    const o = i * size
    b.writeFloatLE(x, o); b.writeFloatLE(y, o + 4)
    b.writeFloatLE(x, o + 8); b.writeFloatLE(y, o + 12)
    b.writeFloatLE(x, o + 16); b.writeFloatLE(y, o + 20)
    b.writeFloatLE(brush?.radius ?? border, o + 24); b.writeFloatLE(brush?.radius ?? border, o + 28)
    if (brush === undefined) {
      b.writeInt32LE(1, o + 32)
    } else {
      b.writeFloatLE(1, o + 32) // density
      b.writeFloatLE(brush.hardness, o + 36)
      b.writeInt32LE(1, o + 40)
    }
  })
  return b
}

/**
 * Convert engine-neutral shapes (normalized 0..1 coordinates of the oriented
 * image) to darktable forms. Radii are normalized to the image's shorter
 * side, borders (feather) likewise.
 */
export function shapesToForms(shapes: MaskShape[], combine: MaskSpec['shapesCombine'], aspect: number): { group: DtForm; forms: DtForm[] } {
  const forms: DtForm[] = []
  const groupPoints: Buffer[] = []
  const groupId = nextFormId++
  const op = combine === 'intersection' ? STATE.intersection : combine === 'difference' ? STATE.difference : combine === 'exclusion' ? STATE.exclusion : STATE.union
  // darktable normalizes circle/ellipse radii by the larger image dimension in x and y separately.
  const rxScale = aspect >= 1 ? 1 : aspect
  shapes.forEach((s, i) => {
    const id = nextFormId++
    let form: DtForm
    const feather = s.type === 'gradient' || s.type === 'brush' ? 0 : (s.feather ?? 0.05)
    switch (s.type) {
      case 'circle':
        form = { id, type: FORM_TYPE.circle, name: `circle #${i + 1}`, version: SUPPORTED_MASKS_VERSION, nb: 1, src: floats([0, 0]), points: floats([s.cx, s.cy, s.r * rxScale, feather]) }
        break
      case 'ellipse': {
        const b = Buffer.alloc(28)
        b.writeFloatLE(s.cx, 0); b.writeFloatLE(s.cy, 4); b.writeFloatLE(s.rx * rxScale, 8); b.writeFloatLE(s.ry * rxScale, 12)
        b.writeFloatLE(s.rotation ?? 0, 16); b.writeFloatLE(feather, 20); b.writeInt32LE(0, 24)
        form = { id, type: FORM_TYPE.ellipse, name: `ellipse #${i + 1}`, version: SUPPORTED_MASKS_VERSION, nb: 1, src: floats([0, 0]), points: b }
        break
      }
      case 'gradient': {
        const dx = s.x1 - s.x0
        const dy = s.y1 - s.y0
        const rotation = (Math.atan2(dy, dx) * 180) / Math.PI - 90
        const b = Buffer.alloc(28)
        b.writeFloatLE((s.x0 + s.x1) / 2, 0); b.writeFloatLE((s.y0 + s.y1) / 2, 4); b.writeFloatLE(rotation, 8)
        b.writeFloatLE(Math.max(0.01, Math.min(1, Math.hypot(dx, dy))), 12); b.writeFloatLE(0, 16); b.writeFloatLE(0, 20); b.writeInt32LE(2, 24)
        form = { id, type: FORM_TYPE.gradient, name: `gradient #${i + 1}`, version: SUPPORTED_MASKS_VERSION, nb: 1, src: floats([0, 0]), points: b }
        break
      }
      case 'rectangle': {
        const pts: Array<[number, number]> = [[s.x, s.y], [s.x + s.w, s.y], [s.x + s.w, s.y + s.h], [s.x, s.y + s.h]]
        form = { id, type: FORM_TYPE.path, name: `rectangle #${i + 1}`, version: SUPPORTED_MASKS_VERSION, nb: 4, src: floats([0, 0]), points: pathPoints(pts, feather) }
        break
      }
      case 'polygon':
        if (s.points.length < 3) throw new ChengyingError('invalid-argument', 'polygon needs at least 3 points')
        form = { id, type: FORM_TYPE.path, name: `polygon #${i + 1}`, version: SUPPORTED_MASKS_VERSION, nb: s.points.length, src: floats([0, 0]), points: pathPoints(s.points, feather) }
        break
      case 'brush': {
        const stroke = s.strokes[0]
        if (stroke === undefined || stroke.points.length === 0) throw new ChengyingError('invalid-argument', 'brush needs a stroke')
        if (s.strokes.length > 1) {
          // one darktable brush form per stroke
          s.strokes.slice(1).forEach((st, j) => {
            const sid = nextFormId++
            forms.push({ id: sid, type: FORM_TYPE.brush, name: `brush #${i + 1}.${j + 2}`, version: SUPPORTED_MASKS_VERSION, nb: st.points.length, src: floats([0, 0]), points: pathPoints(st.points, 0, { radius: st.radius * rxScale, hardness: st.hardness ?? 0.66 }) })
            groupPoints.push(groupPoint(sid, groupId, STATE.use | STATE.show | STATE.union | (s.invert ? STATE.inverse : 0), s.opacity ?? 1))
          })
        }
        form = { id, type: FORM_TYPE.brush, name: `brush #${i + 1}`, version: SUPPORTED_MASKS_VERSION, nb: stroke.points.length, src: floats([0, 0]), points: pathPoints(stroke.points, 0, { radius: stroke.radius * rxScale, hardness: stroke.hardness ?? 0.66 }) }
        break
      }
    }
    forms.push(form)
    const state = STATE.use | STATE.show | (i === 0 ? 0 : op) | (s.invert ? STATE.inverse : 0)
    groupPoints.push(groupPoint(id, groupId, state, s.opacity ?? 1))
  })
  const group: DtForm = { id: groupId, type: FORM_TYPE.group, name: 'chengying mask', version: SUPPORTED_MASKS_VERSION, nb: groupPoints.length, src: floats([0, 0]), points: Buffer.concat(groupPoints) }
  return { group, forms }
}

function groupPoint(formId: number, parentId: number, state: number, opacity: number): Buffer {
  const b = Buffer.alloc(16)
  b.writeInt32LE(formId, 0); b.writeInt32LE(parentId, 4); b.writeInt32LE(state, 8); b.writeFloatLE(opacity, 12)
  return b
}

/** Apply a MaskSpec to blend fields; returns forms to write into masks_history. */
export function applyMask(fields: BlendFields, mask: MaskSpec | undefined, aspect: number): { fields: BlendFields; forms: DtForm[] } {
  if (mask === undefined) return { fields, forms: [] }
  const out = { ...fields, blendif_parameters: [...fields.blendif_parameters], blendif_boost_factors: [...fields.blendif_boost_factors] }
  let forms: DtForm[] = []
  out.mask_mode = MASK_MODE.enabled
  if (mask.opacity !== undefined) out.opacity = Math.max(0, Math.min(100, mask.opacity * 100))
  if (mask.blendMode !== undefined) {
    const m = BLEND_MODES[mask.blendMode.toLowerCase().replace(/[\s-]/g, '_')]
    if (m === undefined) throw new ChengyingError('invalid-argument', `unknown darktable blend mode "${mask.blendMode}"; valid: ${Object.keys(BLEND_MODES).join(', ')}`)
    out.blend_mode = m
  }
  if (mask.shapes !== undefined && mask.shapes.length > 0) {
    const { group, forms: f } = shapesToForms(mask.shapes, mask.shapesCombine, aspect)
    forms = [...f, group]
    out.mask_mode |= MASK_MODE.drawn
    out.mask_id = group.id
  }
  if (mask.parametric !== undefined && mask.parametric.length > 0) {
    const table = CHANNELS[out.blend_cst]
    if (table === undefined) throw new ChengyingError('unsupported', 'parametric masks are not available for this module (raw blend colorspace)')
    out.mask_mode |= MASK_MODE.parametric
    for (const r of mask.parametric) {
      const base = table[r.channel]
      if (base === undefined) throw new ChengyingError('invalid-argument', `channel "${r.channel}" is not available in blend colorspace ${out.blend_cst}; valid: ${Object.keys(table).join(', ')}`)
      const ch = base + (r.output === true ? 4 : 0)
      const norm = (v: number): number => (r.channel === 'hue' ? v / 360 : r.channel === 'lab_a' || r.channel === 'lab_b' ? v / 256 + 0.5 : v)
      const soft = r.softness ?? 0.05
      const from = norm(r.from)
      const to = norm(r.to)
      out.blendif_parameters.splice(ch * 4, 4, Math.max(0, from - soft), Math.max(0, from), Math.min(1, to), Math.min(1, to + soft))
      out.blendif |= 1 << ch
      if (r.invert === true) out.blendif |= 1 << (ch + 16)
    }
  }
  // drawn & parametric combination: include (union) or exclude (intersection, darktable default)
  if (mask.combine === 'union') out.mask_combine |= 0x02
  if (mask.invert === true) out.mask_combine |= 0x01
  if (mask.feather !== undefined) out.feathering_radius = Math.max(0, Math.min(250, mask.feather * 500))
  if (mask.blur !== undefined) out.blur_radius = Math.max(0, Math.min(100, mask.blur * 200))
  if (mask.native !== undefined) Object.assign(out, mask.native)
  return { fields: out, forms }
}
