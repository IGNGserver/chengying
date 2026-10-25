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

export function paramsSchema(m: DtModule): ParamSchema {
  if (m.params === undefined) return { type: 'object', properties: { blob: { type: 'string', description: 'raw params blob (hex); this module publishes no introspection' } }, additionalProperties: false }
  return fieldSchema(m.params)
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
  const buf = Buffer.alloc(m.paramsSize)
  encodeField(buf, m.params, params, 0, m.operation)
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
