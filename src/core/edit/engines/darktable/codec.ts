/**
 * darktable params blobs ⇄ JSON objects, driven entirely by the module's own
 * introspection (types, offsets, sizes, ranges, defaults, enum tables).
 *
 * Offsets in the introspection tree are absolute for index 0 of every
 * enclosing array; element i of an array is shifted by i × element.size.
 */
import type { ParamSchema } from '../../schema.ts'
import { ChengyingError } from '../../../util/errors.ts'

export interface DtField {
  type: 'opaque' | 'float' | 'double' | 'float_complex' | 'char' | 'int8' | 'uint8' | 'short' | 'ushort' | 'int' | 'uint' | 'long' | 'ulong' | 'bool' | 'array' | 'enum' | 'struct' | 'union' | 'none' | string
  typeName?: string
  name?: string
  field?: string
  description?: string
  size: number
  offset: number
  min?: number | string
  max?: number | string
  default?: number | boolean
  values?: Array<{ name: string; value: number; description?: string }>
  count?: number
  elementType?: string
  element?: DtField
  fields?: DtField[]
}

export interface DtModule {
  operation: string
  title?: string
  apiVersion?: number
  moduleVersion?: number
  group?: number
  flags?: number
  defaultColorspace?: number
  blendColorspace?: number
  introspection?: boolean
  introspectionApi?: number
  paramsVersion?: number
  paramsType?: string
  paramsSize?: number
  params?: DtField
  /** Optional hex-encoded default_params struct from darktable module init. */
  defaultBlob?: string
  error?: string
  docUrl?: string
}

const INT_TYPES: Record<string, { bytes: number; signed: boolean }> = {
  char: { bytes: 1, signed: true }, int8: { bytes: 1, signed: true }, uint8: { bytes: 1, signed: false },
  short: { bytes: 2, signed: true }, ushort: { bytes: 2, signed: false }, int: { bytes: 4, signed: true }, uint: { bytes: 4, signed: false },
  long: { bytes: 8, signed: true }, ulong: { bytes: 8, signed: false },
}

const finite = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1e30 ? v : undefined)

const isCharArray = (f: DtField): boolean => f.type === 'array' && (f.elementType === 'char' || f.element?.type === 'char')

function clean(s: string | undefined): string | undefined {
  const t = s?.trim()
  return t === undefined || t === '' ? undefined : t
}

/** JSON Schema for a field. */
export function fieldSchema(f: DtField): ParamSchema {
  const description = clean(f.description)
  const native = { type: f.typeName ?? f.type, offset: f.offset, size: f.size }
  switch (f.type) {
    case 'float':
    case 'double': {
      const s: ParamSchema = { type: 'number', 'x-native': native }
      const min = finite(f.min); const max = finite(f.max); const def = finite(f.default)
      if (min !== undefined) s.minimum = min
      if (max !== undefined) s.maximum = max
      s.default = def ?? 0
      if (description) s.description = description
      return s
    }
    case 'bool':
      return { type: 'boolean', default: f.default === true, ...(description ? { description } : {}), 'x-native': native }
    case 'enum': {
      const values = f.values ?? []
      const def = values.find(v => v.value === f.default) ?? values[0]
      return {
        type: 'string',
        enum: values.map(v => v.name),
        enumLabels: values.map(v => clean(v.description) ?? v.name),
        default: def?.name,
        ...(description ? { description } : {}),
        'x-native': { ...native, values: values.map(v => [v.name, v.value]) },
      }
    }
    case 'array': {
      if (isCharArray(f)) return { type: 'string', default: '', description: `${description ?? 'text'} (max ${(f.count ?? 1) - 1} bytes)`, 'x-native': { ...native, charArray: true } }
      const el = f.element === undefined ? { type: 'number' as const } : fieldSchema(f.element)
      const count = f.count ?? 0
      const elDefault = el.default ?? (el.type === 'object' ? defaultsOf(el) : 0)
      return { type: 'array', items: el, minItems: count, maxItems: count, default: Array.from({ length: count }, () => structuredClone(elDefault)), ...(description ? { description } : {}), 'x-native': { ...native, count } }
    }
    case 'struct':
    case 'union': {
      const properties: Record<string, ParamSchema> = {}
      for (const c of f.fields ?? []) properties[c.field || c.name || `f${c.offset}`] = fieldSchema(c)
      return { type: 'object', properties, additionalProperties: false, ...(description ? { description } : {}), 'x-native': { ...native, union: f.type === 'union' } }
    }
    case 'opaque':
      return { type: 'string', description: `opaque ${f.size}-byte value as hex`, default: '', 'x-native': native }
    default: {
      const it = INT_TYPES[f.type]
      if (it !== undefined) {
        const s: ParamSchema = { type: 'integer', 'x-native': native }
        const min = finite(f.min); const max = finite(f.max)
        if (min !== undefined) s.minimum = min
        if (max !== undefined) s.maximum = max
        s.default = finite(f.default) ?? 0
        if (description) s.description = description
        return s
      }
      return { type: 'string', description: `unsupported native type ${f.type}`, 'x-native': native }
    }
  }
}

function defaultsOf(s: ParamSchema): unknown {
  if (s.type === 'object' && s.properties) return Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, v.default ?? defaultsOf(v)]))
  return s.default
}


/**
 * High-level spline curve descriptors for darktable modules whose native C
 * structs represent curves as fixed-length 2D node arrays + node-count arrays
 * + curve-type arrays. Full native fields remain 100% accessible; the `curves`
 * property lets an AI agent pass natural `[[x, y], ...]` control points per
 * channel (just like in Photoshop / RawTherapee) without hand-filling 60 slots.
 */
export interface DtCurveDescriptor {
  nodesField: string
  countField: string
  typeField: string
  channels: readonly string[]
  aliases?: Readonly<Record<string, number>>
  /** Default y endpoint [y0, y1] for untouched channels ([0,1] for tone/rgb curves, [0.5,0.5] for colorzones). */
  identityY: [number, number]
  /** Default spline interpolation type (2 = MONOTONE_HERMITE in darktable). */
  defaultCurveType: number
  maxNodes: number
}

export const DT_CURVE_MODULES: Readonly<Record<string, DtCurveDescriptor>> = {
  tonecurve: {
    nodesField: 'tonecurve',
    countField: 'tonecurve_nodes',
    typeField: 'tonecurve_type',
    channels: ['L', 'a', 'b'],
    aliases: { l: 0, luminance: 0, master: 0, a: 1, b: 2 },
    identityY: [0, 1],
    defaultCurveType: 2,
    maxNodes: 20,
  },
  rgbcurve: {
    nodesField: 'curve_nodes',
    countField: 'curve_num_nodes',
    typeField: 'curve_type',
    channels: ['r', 'g', 'b'],
    aliases: { master: -1, all: -1, rgb: -1, r: 0, red: 0, g: 1, green: 1, b: 2, blue: 2 },
    identityY: [0, 1],
    defaultCurveType: 2,
    maxNodes: 20,
  },
  basecurve: {
    nodesField: 'basecurve',
    countField: 'basecurve_nodes',
    typeField: 'basecurve_type',
    channels: ['r', 'g', 'b'],
    aliases: { master: 0, l: 0, r: 0, g: 1, b: 2 },
    identityY: [0, 1],
    defaultCurveType: 2,
    maxNodes: 20,
  },
  colorzones: {
    nodesField: 'curve',
    countField: 'curve_num_nodes',
    typeField: 'curve_type',
    channels: ['lightness', 'saturation', 'hue'],
    aliases: { lightness: 0, l: 0, saturation: 1, sat: 1, s: 1, hue: 2, h: 2 },
    identityY: [0.5, 0.5],
    defaultCurveType: 2,
    maxNodes: 20,
  },
}

const POINT_ARRAY_SCHEMA: ParamSchema = {
  type: 'array',
  description: 'Control points [[x, y], ...] with x, y in 0..1 (2 to 20 points, sorted by x).',
  minItems: 2,
  maxItems: 20,
  items: {
    type: 'array',
    minItems: 2,
    maxItems: 2,
    items: { type: 'number', minimum: 0, maximum: 1 },
  },
}

function curveSugarSchema(op: string): ParamSchema | undefined {
  const desc = DT_CURVE_MODULES[op]
  if (desc === undefined) return undefined
  const properties: Record<string, ParamSchema> = {}
  for (const ch of desc.channels) properties[ch] = POINT_ARRAY_SCHEMA
  if (desc.aliases && 'master' in desc.aliases) {
    properties.master = { ...POINT_ARRAY_SCHEMA, description: 'Apply the same [[x, y], ...] curve across channels.' }
  }
  return {
    type: 'object',
    additionalProperties: false,
    description: `High-level spline control points per channel (${desc.channels.join(', ')}). Automatically populates ${desc.nodesField}, ${desc.countField} and ${desc.typeField} with monotone Hermite splines and keeps unedited channels at neutral identity.`,
    properties,
  }
}

/** Expand high-level `params.curves` into darktable's native fixed-size struct arrays before encoding. */
export function expandCurveSugar(operation: string, params: Record<string, unknown>): Record<string, unknown> {
  const desc = DT_CURVE_MODULES[operation]
  if (desc === undefined || params.curves === undefined || typeof params.curves !== 'object' || params.curves === null) {
    return params
  }
  const curvesInput = params.curves as Record<string, unknown>
  const out: Record<string, unknown> = { ...params }
  delete out.curves

  const baseNodes = Array.isArray(out[desc.nodesField])
    ? (structuredClone(out[desc.nodesField]) as Array<Array<Record<string, unknown>>>)
    : Array.from({ length: desc.channels.length }, () => Array.from({ length: desc.maxNodes }, () => ({ x: 0, y: 0 })))
  const counts = Array.isArray(out[desc.countField])
    ? [...(out[desc.countField] as number[])]
    : new Array<number>(desc.channels.length).fill(0)
  const types = Array.isArray(out[desc.typeField])
    ? [...(out[desc.typeField] as number[])]
    : new Array<number>(desc.channels.length).fill(desc.defaultCurveType)

  const setChannel = (chIdx: number, rawPts: unknown): void => {
    if (!Array.isArray(rawPts) || rawPts.length < 2) {
      throw new ChengyingError('invalid-argument', `${operation}.curves: each curve needs at least 2 [x, y] points`)
    }
    const pts = rawPts.slice(0, desc.maxNodes).map((pt, idx) => {
      if (Array.isArray(pt) && pt.length >= 2) return { x: Math.max(0, Math.min(1, Number(pt[0]))), y: Math.max(0, Math.min(1, Number(pt[1]))) }
      if (typeof pt === 'object' && pt !== null && 'x' in pt && 'y' in pt) {
        const p = pt as { x: unknown; y: unknown }
        return { x: Math.max(0, Math.min(1, Number(p.x))), y: Math.max(0, Math.min(1, Number(p.y))) }
      }
      throw new ChengyingError('invalid-argument', `${operation}.curves[${idx}]: expected [x, y]`)
    }).sort((a, b) => a.x - b.x)
    const row = baseNodes[chIdx] ?? Array.from({ length: desc.maxNodes }, () => ({ x: 0, y: 0 }))
    for (let i = 0; i < desc.maxNodes; i++) {
      const prev = (row[i] ?? {}) as Record<string, unknown>
      row[i] = i < pts.length ? { ...prev, x: pts[i]!.x, y: pts[i]!.y } : { ...prev, x: 0, y: 0 }
    }
    baseNodes[chIdx] = row
    counts[chIdx] = pts.length
    if (!types[chIdx] || types[chIdx] === 0) types[chIdx] = desc.defaultCurveType
  }

  for (const [key, val] of Object.entries(curvesInput)) {
    if (val === undefined) continue
    const lower = key.toLowerCase()
    const directIdx = desc.channels.findIndex(c => c.toLowerCase() === lower)
    const aliasIdx = desc.aliases?.[lower]
    const target = directIdx >= 0 ? directIdx : aliasIdx
    if (target === undefined) {
      throw new ChengyingError('invalid-argument', `${operation}.curves.${key}: unknown curve channel; valid: ${desc.channels.join(', ')}`)
    }
    if (target === -1) {
      for (let c = 0; c < desc.channels.length; c++) setChannel(c, val)
    } else {
      setChannel(target, val)
    }
  }

  // Ensure untouched sibling channels have valid 2-node identity curves instead of 0-node zeroed arrays.
  for (let c = 0; c < desc.channels.length; c++) {
    if ((counts[c] ?? 0) < 2) {
      setChannel(c, [[0, desc.identityY[0]], [1, desc.identityY[1]]])
    }
  }

  out[desc.nodesField] = baseNodes
  out[desc.countField] = counts
  out[desc.typeField] = types
  return out
}

/**
 * Non-zero runtime defaults set in darktable's module `init()` functions that
 * are not captured by static C `$DEFAULT` header annotations (e.g. identity
 * matrices, crop right/bottom bounds, wavelet frequency grids, level endpoints).
 */
export const DT_MODULE_FIELD_DEFAULTS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  crop: {
    cx: 0,
    cy: 0,
    cw: 1,
    ch: 1,
  },
  channelmixerrgb: {
    red: [1, 0, 0, 0],
    green: [0, 1, 0, 0],
    blue: [0, 0, 1, 0],
    saturation: [0, 0, 0, 0],
    lightness: [0, 0, 0, 0],
    grey: [0, 0.5, 0, 0],
  },
  channelmixer: {
    red: [1, 0, 0, 0, 0, 0, 0],
    green: [0, 1, 0, 0, 0, 0, 0],
    blue: [0, 0, 1, 0, 0, 0, 0],
  },
  levels: {
    levels: [0, 50, 100],
  },
  rgblevels: {
    levels: [[0, 0.5, 1], [0, 0.5, 1], [0, 0.5, 1]],
  },
  denoiseprofile: {
    a: [1, 1, 1],
    b: [0, 0, 0],
    x: Array.from({ length: 6 }, () => [0, 1 / 6, 2 / 6, 3 / 6, 4 / 6, 5 / 6, 1]),
    y: Array.from({ length: 6 }, () => [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]),
  },
  atrous: {
    x: Array.from({ length: 5 }, () => [0, 0.2, 0.4, 0.6, 0.8, 1]),
    y: Array.from({ length: 5 }, () => [0.5, 0.5, 0.5, 0.5, 0.5, 0.5]),
  },
}

/** Normalize high-level aliases on darktable module parameters before schema validation. */
export function normalizeDarktableParams(operation: string, params: Record<string, unknown>): Record<string, unknown> {
  if (operation === 'crop') {
    const out: Record<string, unknown> = { ...params }
    if (out.left !== undefined && out.cx === undefined) out.cx = out.left
    if (out.top !== undefined && out.cy === undefined) out.cy = out.top
    if (out.right !== undefined && out.cw === undefined) out.cw = out.right
    if (out.bottom !== undefined && out.ch === undefined) out.ch = out.bottom
    delete out.left; delete out.top; delete out.right; delete out.bottom
    if (out.x !== undefined && out.cx === undefined) out.cx = out.x
    if (out.y !== undefined && out.cy === undefined) out.cy = out.y
    if (typeof out.w === 'number' && out.cw === undefined) out.cw = Math.min(1, Number(out.cx ?? 0) + out.w)
    if (typeof out.h === 'number' && out.ch === undefined) out.ch = Math.min(1, Number(out.cy ?? 0) + out.h)
    delete out.x; delete out.y; delete out.w; delete out.h
    return out
  }
  return params
}

export function paramsSchema(m: DtModule): ParamSchema {
  if (m.params === undefined) return { type: 'object', properties: { blob: { type: 'string', description: 'raw params blob (hex); this module publishes no introspection' } }, additionalProperties: false }
  const s = fieldSchema(m.params)
  const overrides = DT_MODULE_FIELD_DEFAULTS[m.operation]
  if (overrides !== undefined && s.properties !== undefined) {
    for (const [k, defVal] of Object.entries(overrides)) {
      if (s.properties[k] !== undefined) {
        s.properties[k] = { ...s.properties[k], default: structuredClone(defVal) }
      }
    }
  }
  const sugar = curveSugarSchema(m.operation)
  if (sugar !== undefined && s.properties !== undefined) {
    s.properties = { curves: sugar, ...s.properties }
  }
  return s
}

function writeNumber(buf: Buffer, f: DtField, at: number, v: number): void {
  if (f.type === 'float') { buf.writeFloatLE(v, at); return }
  if (f.type === 'double') { buf.writeDoubleLE(v, at); return }
  const it = INT_TYPES[f.type]
  if (it === undefined) return
  const n = Math.round(v)
  switch (it.bytes) {
    case 1: it.signed ? buf.writeInt8(Math.max(-128, Math.min(127, n)), at) : buf.writeUInt8(Math.max(0, Math.min(255, n)), at); break
    case 2: it.signed ? buf.writeInt16LE(n, at) : buf.writeUInt16LE(n, at); break
    case 4: it.signed ? buf.writeInt32LE(n | 0, at) : buf.writeUInt32LE(n >>> 0, at); break
    case 8: it.signed ? buf.writeBigInt64LE(BigInt(n), at) : buf.writeBigUInt64LE(BigInt(Math.max(0, n)), at); break
  }
}

function encodeField(buf: Buffer, f: DtField, value: unknown, shift: number, path: string): void {
  const at = f.offset + shift
  if (at < 0 || at + Math.max(1, f.size) > buf.length + 0) {
    throw new ChengyingError('internal', `${path}: offset ${at} outside params blob (${buf.length})`)
  }
  switch (f.type) {
    case 'float': case 'double': case 'char': case 'int8': case 'uint8': case 'short': case 'ushort': case 'int': case 'uint': case 'long': case 'ulong':
      writeNumber(buf, f, at, typeof value === 'number' ? value : Number(value ?? 0))
      return
    case 'bool':
      buf.writeInt32LE(value === true ? 1 : 0, at)
      return
    case 'enum': {
      const entry = (f.values ?? []).find(v => v.name === value) ?? (f.values ?? []).find(v => v.value === value)
      if (entry === undefined) throw new ChengyingError('invalid-argument', `${path}: unknown enum value ${JSON.stringify(value)}`)
      buf.writeInt32LE(entry.value, at)
      return
    }
    case 'array': {
      const count = f.count ?? 0
      if (isCharArray(f)) {
        const bytes = Buffer.from(String(value ?? ''), 'utf8').subarray(0, Math.max(0, count - 1))
        buf.fill(0, at, at + count)
        bytes.copy(buf, at)
        return
      }
      const el = f.element
      if (el === undefined) return
      const arr = Array.isArray(value) ? value : []
      for (let i = 0; i < Math.min(count, arr.length); i++) encodeField(buf, el, arr[i], shift + i * el.size, `${path}[${i}]`)
      return
    }
    case 'struct':
    case 'union': {
      const obj = (value ?? {}) as Record<string, unknown>
      for (const c of f.fields ?? []) {
        const key = c.field || c.name || `f${c.offset}`
        if (obj[key] !== undefined) encodeField(buf, c, obj[key], shift, `${path}.${key}`)
      }
      return
    }
    case 'opaque': {
      const hex = String(value ?? '')
      if (hex !== '') Buffer.from(hex, 'hex').subarray(0, f.size).copy(buf, at)
      return
    }
    default:
      return
  }
}

/** Encode a fully-normalised params object into the module's binary blob. */
export function encodeParams(m: DtModule, params: Record<string, unknown>): Buffer {
  if (m.params === undefined || m.paramsSize === undefined) {
    const hex = String(params.blob ?? '')
    if (!/^[0-9a-f]*$/i.test(hex) || hex.length === 0) throw new ChengyingError('invalid-argument', `${m.operation} has no introspection; pass params.blob as hex`)
    return Buffer.from(hex, 'hex')
  }
  const normalized = normalizeDarktableParams(m.operation, params)
  const expanded = expandCurveSugar(m.operation, normalized)
  const buf = Buffer.alloc(m.paramsSize)
  if (typeof m.defaultBlob === 'string' && m.defaultBlob.length === m.paramsSize * 2) {
    Buffer.from(m.defaultBlob, 'hex').copy(buf)
  }
  encodeField(buf, m.params, expanded, 0, m.operation)
  return buf
}

function readNumber(buf: Buffer, f: DtField, at: number): number {
  if (f.type === 'float') return Math.round(buf.readFloatLE(at) * 1e7) / 1e7
  if (f.type === 'double') return buf.readDoubleLE(at)
  const it = INT_TYPES[f.type]
  if (it === undefined) return 0
  switch (it.bytes) {
    case 1: return it.signed ? buf.readInt8(at) : buf.readUInt8(at)
    case 2: return it.signed ? buf.readInt16LE(at) : buf.readUInt16LE(at)
    case 4: return it.signed ? buf.readInt32LE(at) : buf.readUInt32LE(at)
    default: return Number(it.signed ? buf.readBigInt64LE(at) : buf.readBigUInt64LE(at))
  }
}

function decodeField(buf: Buffer, f: DtField, shift: number): unknown {
  const at = f.offset + shift
  switch (f.type) {
    case 'bool': return buf.readInt32LE(at) !== 0
    case 'enum': {
      const v = buf.readInt32LE(at)
      return (f.values ?? []).find(x => x.value === v)?.name ?? v
    }
    case 'array': {
      const count = f.count ?? 0
      if (isCharArray(f)) {
        const slice = buf.subarray(at, at + count)
        const end = slice.indexOf(0)
        return slice.subarray(0, end < 0 ? count : end).toString('utf8')
      }
      const el = f.element
      if (el === undefined) return []
      return Array.from({ length: count }, (_, i) => decodeField(buf, el, shift + i * el.size))
    }
    case 'struct':
    case 'union':
      return Object.fromEntries((f.fields ?? []).map(c => [c.field || c.name || `f${c.offset}`, decodeField(buf, c, shift)]))
    case 'opaque':
      return buf.subarray(at, at + f.size).toString('hex')
    default:
      return readNumber(buf, f, at)
  }
}

export function decodeParams(m: DtModule, blob: Buffer): Record<string, unknown> {
  if (m.params === undefined) return { blob: blob.toString('hex') }
  if (m.paramsSize !== undefined && blob.length !== m.paramsSize) {
    throw new ChengyingError('unsupported', `${m.operation}: blob is ${blob.length} bytes, module v${m.paramsVersion} expects ${m.paramsSize} (older module version; darktable upgrades it at render time)`)
  }
  return decodeField(blob, m.params, 0) as Record<string, unknown>
}

/** darktable XMP encoding: plain hex, or "gz" + 2-digit factor + base64(zlib) for long blobs. */
export async function encodeXmpBlob(blob: Buffer): Promise<string> {
  return blob.toString('hex')
}

export async function decodeXmpBlob(text: string): Promise<Buffer> {
  if (text.startsWith('gz')) {
    const { inflateSync } = await import('node:zlib')
    return inflateSync(Buffer.from(text.slice(4), 'base64'))
  }
  return Buffer.from(text, 'hex')
}
