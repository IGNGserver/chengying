/**
 * Parameter schemas for engine operations. Every engine publishes each
 * operation's parameters as JSON Schema (draft-07 subset: object/array/
 * number/integer/boolean/string, enum, minimum/maximum, default, items,
 * minItems/maxItems, description). The same validator normalises agent input
 * for every engine: fills defaults, accepts enum names case-insensitively,
 * clamps to declared ranges (reporting it) and rejects unknown fields with the
 * list of valid ones, so a wrong guess becomes an actionable error instead of
 * a silently ignored value.
 */
import { ChengyingError } from '../util/errors.ts'
import { isRecord } from '../util/misc.ts'

export interface ParamSchema {
  type?: 'object' | 'array' | 'number' | 'integer' | 'boolean' | 'string'
  description?: string
  title?: string
  default?: unknown
  enum?: Array<string | number>
  /** Human-readable labels for enum values (same order). */
  enumLabels?: string[]
  minimum?: number
  maximum?: number
  multipleOf?: number
  properties?: Record<string, ParamSchema>
  required?: string[]
  additionalProperties?: boolean
  items?: ParamSchema
  minItems?: number
  maxItems?: number
  /** Opaque engine detail (offsets, native type names…), never validated. */
  'x-native'?: Record<string, unknown>
  /** Units / semantic hints for the agent (EV, degrees, percent…). */
  'x-unit'?: string
}

export interface NormalizeResult {
  value: Record<string, unknown>
  warnings: string[]
}

function typeOf(v: unknown): string {
  if (Array.isArray(v)) return 'array'
  if (v === null) return 'null'
  return typeof v
}

function normalizeValue(schema: ParamSchema, value: unknown, path: string, warnings: string[], fill: boolean): unknown {
  if (value === undefined) {
    if (fill && schema.default !== undefined) return structuredClone(schema.default)
    if (fill && schema.type === 'object' && schema.properties !== undefined) return normalizeObject(schema, {}, path, warnings, fill)
    return undefined
  }
  if (schema.enum !== undefined) {
    if (schema.enum.includes(value as string | number)) return value
    if (typeof value === 'string') {
      const lower = value.toLowerCase()
      const byName = schema.enum.find(e => String(e).toLowerCase() === lower)
      if (byName !== undefined) return byName
      const idx = schema.enumLabels?.findIndex(l => l.toLowerCase() === lower) ?? -1
      if (idx >= 0) return schema.enum[idx]
      // darktable-style prefixed names: accept a unique suffix match (e.g. "manual" for EXPOSURE_MODE_MANUAL).
      const suffix = schema.enum.filter(e => String(e).toLowerCase().endsWith(`_${lower}`))
      if (suffix.length === 1) return suffix[0]
    }
    if (typeof value === 'number' && schema.enumLabels !== undefined) {
      // numeric index into a string enum is not allowed; fall through
    }
    throw new ChengyingError('invalid-argument', `${path}: ${JSON.stringify(value)} is not one of ${schema.enum.map(e => JSON.stringify(e)).join(', ')}${schema.enumLabels ? ` (${schema.enumLabels.join(', ')})` : ''}`)
  }
  switch (schema.type) {
    case 'number':
    case 'integer': {
      let n: number
      if (typeof value === 'number') n = value
      else if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) n = Number(value)
      else if (typeof value === 'boolean') n = value ? 1 : 0
      else throw new ChengyingError('invalid-argument', `${path}: expected a number, got ${typeOf(value)}`)
      if (!Number.isFinite(n)) throw new ChengyingError('invalid-argument', `${path}: not a finite number`)
      if (schema.type === 'integer' && !Number.isInteger(n)) { warnings.push(`${path}: rounded ${n} to ${Math.round(n)}`); n = Math.round(n) }
      if (schema.minimum !== undefined && n < schema.minimum) { warnings.push(`${path}: clamped ${n} to minimum ${schema.minimum}`); n = schema.minimum }
      if (schema.maximum !== undefined && n > schema.maximum) { warnings.push(`${path}: clamped ${n} to maximum ${schema.maximum}`); n = schema.maximum }
      return n
    }
    case 'boolean':
      if (typeof value === 'boolean') return value
      if (value === 0 || value === 1) return value === 1
      if (typeof value === 'string' && ['true', 'false', '1', '0', 'yes', 'no', 'on', 'off'].includes(value.toLowerCase())) return ['true', '1', 'yes', 'on'].includes(value.toLowerCase())
      throw new ChengyingError('invalid-argument', `${path}: expected boolean, got ${typeOf(value)}`)
    case 'string':
      if (typeof value === 'string') return value
      if (typeof value === 'number' || typeof value === 'boolean') return String(value)
      throw new ChengyingError('invalid-argument', `${path}: expected string, got ${typeOf(value)}`)
    case 'array': {
      if (!Array.isArray(value)) throw new ChengyingError('invalid-argument', `${path}: expected array, got ${typeOf(value)}`)
      let arr = value
      if (schema.maxItems !== undefined && arr.length > schema.maxItems) throw new ChengyingError('invalid-argument', `${path}: at most ${schema.maxItems} items (got ${arr.length})`)
      if (schema.minItems !== undefined && arr.length < schema.minItems) {
        // Fixed-length native arrays: pad with defaults when the agent passes fewer values.
        const def = Array.isArray(schema.default) ? schema.default : []
        if (def.length >= schema.minItems) {
          warnings.push(`${path}: padded ${arr.length} → ${schema.minItems} items from defaults`)
          arr = [...arr, ...def.slice(arr.length, schema.minItems)]
        } else {
          throw new ChengyingError('invalid-argument', `${path}: at least ${schema.minItems} items (got ${arr.length})`)
        }
      }
      return schema.items === undefined ? arr : arr.map((v, i) => normalizeValue(schema.items as ParamSchema, v, `${path}[${i}]`, warnings, fill))
    }
    case 'object':
      if (!isRecord(value)) throw new ChengyingError('invalid-argument', `${path}: expected object, got ${typeOf(value)}`)
      return normalizeObject(schema, value, path, warnings, fill)
    default:
      return value
  }
}

function normalizeObject(schema: ParamSchema, value: Record<string, unknown>, path: string, warnings: string[], fill: boolean): Record<string, unknown> {
  const props = schema.properties ?? {}
  const out: Record<string, unknown> = {}
  const known = Object.keys(props)
  for (const [k, v] of Object.entries(value)) {
    const sub = props[k] ?? props[Object.keys(props).find(p => p.toLowerCase() === k.toLowerCase()) ?? '']
    if (sub === undefined) {
      if (schema.additionalProperties === false) {
        const hint = known.filter(n => n.toLowerCase().includes(k.toLowerCase().slice(0, 4))).slice(0, 8)
        throw new ChengyingError('invalid-argument', `${path ? `${path}.` : ''}${k}: unknown parameter; valid: ${(hint.length > 0 ? hint : known).slice(0, 40).join(', ')}${known.length > 40 ? ', …' : ''}`)
      }
      out[k] = v
      continue
    }
    const key = props[k] !== undefined ? k : (Object.keys(props).find(p => p.toLowerCase() === k.toLowerCase()) as string)
    out[key] = normalizeValue(sub, v, path ? `${path}.${key}` : key, warnings, fill)
  }
  if (fill) {
    for (const [k, sub] of Object.entries(props)) {
      if (out[k] === undefined) {
        const v = normalizeValue(sub, undefined, path ? `${path}.${k}` : k, warnings, fill)
        if (v !== undefined) out[k] = v
      }
    }
  }
  for (const r of schema.required ?? []) {
    if (out[r] === undefined) throw new ChengyingError('invalid-argument', `${path ? `${path}.` : ''}${r}: required`)
  }
  return out
}

/**
 * Validate and normalise operation parameters.
 * @param fill - fill every omitted field from its default (engines whose
 *   native format needs complete parameter sets, e.g. darktable blobs).
 */
export function normalizeParams(schema: ParamSchema, params: unknown, fill = false): NormalizeResult {
  const warnings: string[] = []
  const value = normalizeValue({ ...schema, type: 'object' }, params ?? {}, '', warnings, fill) as Record<string, unknown>
  return { value, warnings }
}

/** Deep merge for partial updates of nested parameter objects (arrays are replaced). */
export function mergeParams(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isRecord(v) && isRecord(base[k]) ? mergeParams(base[k] as Record<string, unknown>, v) : v
  }
  return out
}

/** Count leaf parameters (coverage statistics). */
export function countLeaves(schema: ParamSchema): number {
  if (schema.type === 'object' && schema.properties !== undefined) return Object.values(schema.properties).reduce((a, s) => a + countLeaves(s), 0)
  return 1
}

/** Compact one-line signature for listings: name:type[min..max]=default. */
export function signature(schema: ParamSchema, max = 12): string {
  const props = Object.entries(schema.properties ?? {})
  const parts = props.slice(0, max).map(([k, s]) => {
    const range = s.minimum !== undefined || s.maximum !== undefined ? `[${s.minimum ?? ''}..${s.maximum ?? ''}]` : ''
    const t = s.enum !== undefined ? `enum(${s.enum.length})` : s.type ?? 'any'
    return `${k}:${t}${range}`
  })
  return parts.join(', ') + (props.length > max ? `, … +${props.length - max}` : '')
}
