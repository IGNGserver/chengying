/**
 * Engine adapter contract.
 *
 * An engine exposes its COMPLETE capability surface as a catalog discovered
 * from the installed engine itself (darktable module introspection,
 * RawTherapee's full processing-profile dump, the built-in operator registry,
 * MCP tools/list). The agent addresses operations generically by id with a
 * JSON parameter object validated against the operation's schema, so a new
 * engine release that adds modules or parameters is usable without code
 * changes. Catalogs are cached per engine fingerprint (binary path + version
 * + modification time) and rediscovered automatically when that changes.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import type { EditStage, EditStep, MaskSpec } from '../types.ts'
import type { ParamSchema } from './schema.ts'
import { normalizeParams } from './schema.ts'
import { ChengyingError } from '../util/errors.ts'

export interface EngineProbe {
  id: string
  available: boolean
  version?: string
  /** Discovery backend in use (introspection, mcp, profile-dump, snapshot, registry). */
  mode?: string
  binaries: Record<string, string>
  reason?: string
  fingerprint?: string
  inputs: { raw: boolean; raster: boolean }
}

export interface OperationSpec {
  id: string
  title: string
  description?: string
  category: string
  /** Engine-native module / section version. */
  version?: number | string
  params: ParamSchema
  /** Mask support: none, parametric and/or drawn shapes, or engine-native local tool. */
  masks: Array<'parametric' | 'drawn' | 'native'>
  multiInstance: boolean
  deprecated?: boolean
  hidden?: boolean
  tags?: string[]
  docsUrl?: string
  /** Engine-specific detail kept for encoding (struct layout, pp3 section…). */
  native?: Record<string, unknown>
}

export interface NativeToolSpec {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  /** True when the tool may write outside Chengying scratch (blocked unless explicitly allowed). */
  writes?: boolean
}

export interface Catalog {
  engine: string
  engineVersion: string
  catalogVersion: number
  fingerprint: string
  source: string
  discoveredAt: string
  operations: OperationSpec[]
  /** Engine-level options of a stage (base profile, workflow defaults, output). */
  stageOptions: ParamSchema
  /** Mask model the engine understands (documentation for the agent). */
  maskModel?: Record<string, unknown>
  nativeTools?: NativeToolSpec[]
  notes?: string[]
  /** Engine-specific discovery facts needed for encoding (e.g. darktable pipeline orders). */
  native?: Record<string, unknown>
  coverage: { operations: number; parameters: number; withSchema: number; extensions: string[]; unsupported: string[] }
}

export interface RenderRequest {
  input: string
  inputKind: 'raw' | 'raster'
  stage: EditStage
  output: string
  format: 'jpeg' | 'tiff' | 'png'
  bitDepth?: 8 | 16
  maxEdge?: number
  quality?: number
  scratchDir: string
  signal?: AbortSignal
  /** Source orientation for engines that ignore it. */
  orientation?: number | null
  /** Path guard for auxiliary files an operation reads (LUTs, profiles). */
  readable?: (path: string) => string
  /** Set for previews: the long edge the final image is shown at (stages after the first may still enlarge). */
  previewEdge?: number
  /** Long edge of the full-resolution source, so later stages can scale pixel-sized parameters on previews. */
  fullEdge?: number
}

export interface RenderResult {
  output: string
  width: number
  height: number
  durationMs: number
  warnings: string[]
  /** Native recipe written for recoverability (XMP, pp3, JSON). */
  recipe?: { path: string; format: string }
  command?: string[]
}

export interface ValidatedStep { step: EditStep; warnings: string[] }

export interface EngineAdapter {
  readonly id: string
  readonly title: string
  probe(force?: boolean): Promise<EngineProbe>
  catalog(options?: { refresh?: boolean; signal?: AbortSignal }): Promise<Catalog>
  /** Validate/normalise one step against the catalog. */
  validateStep(step: EditStep, catalog: Catalog): ValidatedStep
  validateStageOptions?(options: Record<string, unknown> | undefined, catalog: Catalog): { options: Record<string, unknown>; warnings: string[] }
  render(req: RenderRequest, catalog: Catalog): Promise<RenderResult>
  /** Native recipe text for a stage (XMP sidecar, pp3 profile, JSON). */
  recipe(stage: EditStage, catalog: Catalog, input: { kind: 'raw' | 'raster' }): Promise<{ extension: string; text: string }>
  /** Import an engine-native recipe (pp3, XMP, dtstyle, JSON) into steps. */
  importRecipe?(text: string, catalog: Catalog, hint?: string): Promise<{ steps: EditStep[]; options?: Record<string, unknown>; warnings: string[] }>
  callNative?(name: string, args: Record<string, unknown>, ctx: { scratchDir: string; signal?: AbortSignal; readable: (p: string) => string; writable: (p: string) => string }): Promise<unknown>
  close?(): Promise<void>
}

/** Default step validation: schema normalisation + mask capability check. */
export function validateWithCatalog(step: EditStep, catalog: Catalog, opts: { fill?: boolean } = {}): ValidatedStep {
  const op = catalog.operations.find(o => o.id === step.op) ?? catalog.operations.find(o => o.id.toLowerCase() === step.op.toLowerCase())
  if (op === undefined) {
    const near = catalog.operations.filter(o => o.id.includes(step.op.slice(0, 4)) || (o.title ?? '').toLowerCase().includes(step.op.toLowerCase())).slice(0, 10).map(o => o.id)
    throw new ChengyingError('invalid-argument', `unknown ${catalog.engine} operation "${step.op}"${near.length ? `; similar: ${near.join(', ')}` : ''}; use edit_capabilities to list operations`)
  }
  const { value, warnings } = normalizeParams(op.params, step.params, opts.fill ?? false)
  if (step.mask !== undefined && op.masks.length === 0) {
    throw new ChengyingError('unsupported', `${catalog.engine}:${op.id} does not support masks`)
  }
  if (op.deprecated) warnings.push(`${op.id} is deprecated in ${catalog.engine} ${catalog.engineVersion}`)
  return { step: { ...step, op: op.id, params: value }, warnings }
}

export function maskSummary(mask: MaskSpec | undefined): string {
  if (mask === undefined) return ''
  const shapes = mask.shapes?.map(s => s.type).join('+') ?? ''
  const par = mask.parametric?.map(p => `${p.channel}[${p.from}..${p.to}]`).join(',') ?? ''
  return [shapes, par].filter(Boolean).join(' & ')
}

export function fingerprintOf(parts: Array<string | number | undefined>): string {
  return createHash('sha1').update(parts.map(p => String(p ?? '')).join('|')).digest('hex').slice(0, 16)
}

/** On-disk catalog cache keyed by engine + fingerprint (shared across projects). */
export class CatalogCache {
  constructor(private readonly dir: string) { mkdirSync(dir, { recursive: true }) }

  private file(engine: string, fp: string): string {
    return join(this.dir, `${engine}-${fp}.json`)
  }

  get(engine: string, fp: string, version: number): Catalog | undefined {
    try {
      const c = JSON.parse(readFileSync(this.file(engine, fp), 'utf8')) as Catalog
      return c.catalogVersion === version ? c : undefined
    } catch {
      return undefined
    }
  }

  put(c: Catalog): void {
    const f = this.file(c.engine, c.fingerprint)
    writeFileSync(`${f}.tmp`, JSON.stringify(c))
    renameSync(`${f}.tmp`, f)
  }
}

export function coverageOf(ops: OperationSpec[], extensions: string[], unsupported: string[]): Catalog['coverage'] {
  const count = (s: ParamSchema): number => {
    if (s.type === 'object' && s.properties) return Object.values(s.properties).reduce((a, x) => a + count(x), 0)
    if (s.type === 'array' && s.items?.type === 'object') return count(s.items)
    return 1
  }
  return {
    operations: ops.length,
    parameters: ops.reduce((a, o) => a + count(o.params), 0),
    withSchema: ops.filter(o => o.params.properties !== undefined && Object.keys(o.params.properties).length > 0).length,
    extensions,
    unsupported,
  }
}
