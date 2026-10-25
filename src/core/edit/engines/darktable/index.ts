/**
 * darktable engine adapter.
 *
 * Every image operation module of the installed darktable becomes one
 * catalog operation whose parameter schema is generated from the module's
 * own introspection; parameters are encoded into darktable's binary params
 * blobs, written as an XMP history stack (with blending / drawn masks) and
 * rendered by darktable-cli. Unknown future modules work the same way.
 */
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import type { EditStage, EditStep } from '../../../types.ts'
import type { Catalog, EngineAdapter, EngineProbe, OperationSpec, RenderRequest, RenderResult, ValidatedStep } from '../../engine.ts'
import { CatalogCache, coverageOf, fingerprintOf, validateWithCatalog } from '../../engine.ts'
import { normalizeParams, type ParamSchema } from '../../schema.ts'
import { locateDarktable, type DarktableInstall } from './locate.ts'
import { DarktableMcp, introspectNative, snapshotFor, type DtIntrospection } from './introspect.ts'
import { decodeParams, encodeParams, paramsSchema, type DtModule } from './codec.ts'
import { applyMask, BLEND_SCHEMA, blendColorspaceFor, decodeBlend, defaultBlend, encodeBlend, SUPPORTED_BLEND_VERSION, type DtForm } from './blend.ts'
import { buildXmp, parseDtStyle, parseXmpHistory, type DtHistoryItem, type ImportedItem } from './xmp.ts'
import { run } from '../../../util/proc.ts'
import { ChengyingError, errorMessage } from '../../../util/errors.ts'
import { newId, nowIso } from '../../../util/misc.ts'

const CATALOG_VERSION = 5
/** Modules the export pipeline inserts itself and drops from any supplied history (output size comes from the render request). */
const PIPELINE_INTERNAL = new Set(['finalscale'])
const FLAGS = { blending: 1 << 1, deprecated: 1 << 2, hidden: 1 << 5, oneInstance: 1 << 7, noHistory: 1 << 9, noMasks: 1 << 10 }
const GROUPS: Array<[number, string]> = [[1, 'basic'], [2, 'tone'], [4, 'color'], [8, 'correct'], [16, 'effect'], [32, 'technical'], [64, 'grading'], [128, 'effects']]

function category(group: number | undefined): string {
  const g = GROUPS.filter(([bit]) => ((group ?? 0) & bit) !== 0).map(([, n]) => n)
  return g.length === 0 ? 'other' : g.join('/')
}

const STAGE_OPTIONS: ParamSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    workflow: { type: 'string', enum: ['darktable-default', 'none'], default: 'darktable-default', description: 'darktable-default: apply darktable\'s auto-applied default pipeline (scene-referred workflow, exposure compensation, tone mapper, color calibration) under your steps; none: only the listed steps on top of the always-on modules' },
    iop_order: { type: 'string', enum: ['auto', 'v50', 'v50_jpg', 'v30', 'v30_jpg', 'legacy'], default: 'auto', description: 'pixelpipe module order' },
    hq: { type: 'boolean', default: true, description: 'high quality resampling (darktable-cli --hq)' },
    upscale: { type: 'boolean', default: false },
    style: { type: 'string', description: 'name of a darktable style to apply (darktable-cli --style)' },
    style_overwrite: { type: 'boolean', default: false },
    icc_type: { type: 'string', description: 'output ICC type (darktable-cli --icc-type): SRGB, ADOBERGB, LIN_REC709, LIN_REC2020, DISPLAY, …' },
    icc_file: { type: 'string', description: 'output ICC file (must be readable)' },
    icc_intent: { type: 'string', enum: ['PERCEPTUAL', 'RELATIVE_COLORIMETRIC', 'SATURATION', 'ABSOLUTE_COLORIMETRIC'], description: 'rendering intent' },
    conf: { type: 'object', additionalProperties: true, description: 'extra darktable configuration keys (--conf key=value), e.g. {"plugins/darkroom/workflow":"scene-referred (sigmoid)"}' },
  },
}

const IOP_ORDER: Record<string, number> = { legacy: 1, v30: 2, v30_jpg: 3, v50: 4, v50_jpg: 5 }

export class DarktableEngine implements EngineAdapter {
  readonly id = 'darktable'
  readonly title = 'darktable'
  private install: DarktableInstall | undefined
  private probed: EngineProbe | undefined
  private intro: DtIntrospection | undefined
  private modules = new Map<string, DtModule>()
  private mcp: DarktableMcp | undefined
  private slots: boolean[] = []
  private readonly cache: CatalogCache

  constructor(private readonly opts: { cli?: string; workDir: string; maxParallel?: number; preferMcp?: boolean }) {
    mkdirSync(opts.workDir, { recursive: true })
    this.cache = new CatalogCache(join(opts.workDir, 'catalogs'))
    this.slots = new Array(Math.max(1, opts.maxParallel ?? 3)).fill(false)
  }

  async probe(force = false): Promise<EngineProbe> {
    if (this.probed !== undefined && !force) return this.probed
    const found = await locateDarktable(this.opts.cli)
    if ('error' in found) {
      this.probed = { id: this.id, available: false, binaries: {}, reason: found.error, inputs: { raw: true, raster: true } }
      return this.probed
    }
    this.install = found
    let mode = found.mcp !== undefined && this.opts.preferMcp !== false ? 'mcp' : 'introspection'
    if (mode === 'introspection' && snapshotFor(found.version) !== undefined && found.pluginDir === undefined) mode = 'snapshot'
    this.probed = {
      id: this.id,
      available: true,
      version: found.version,
      mode,
      binaries: { cli: found.cli, ...(found.mcp ? { mcp: found.mcp } : {}), ...(found.pluginDir ? { plugins: found.pluginDir } : {}) },
      fingerprint: fingerprintOf([found.cli, found.version, found.mtimeMs, mode, CATALOG_VERSION]),
      inputs: { raw: true, raster: true },
    }
    return this.probed
  }

  private async introspect(signal?: AbortSignal): Promise<DtIntrospection> {
    if (this.intro !== undefined) return this.intro
    const p = await this.probe()
    const install = this.install
    if (!p.available || install === undefined) throw new ChengyingError('engine-unavailable', p.reason ?? 'darktable unavailable')
    const errors: string[] = []
    if (p.mode === 'mcp') {
      try {
        this.mcp = new DarktableMcp(install, join(this.opts.workDir, 'mcp-config'))
        this.intro = await this.mcp.introspect(signal)
      } catch (error) {
        errors.push(`darktable-mcp: ${errorMessage(error)}`)
        this.mcp = undefined
      }
    }
    if (this.intro === undefined) {
      try {
        this.intro = await introspectNative(install, this.opts.workDir, signal)
      } catch (error) {
        errors.push(`native introspection: ${errorMessage(error)}`)
      }
    }
    if (this.intro === undefined) {
      const snap = snapshotFor(install.version)
      if (snap !== undefined) this.intro = { source: 'snapshot', blendVersion: snap.blendVersion, modules: snap.modules, iopOrders: snap.iopOrders, notes: [`using shipped snapshot for darktable ${install.version}`] }
    }
    if (this.intro === undefined) throw new ChengyingError('engine-unavailable', `cannot discover darktable modules: ${errors.join('; ')}`)
    this.intro.notes.push(...errors)
    this.modules = new Map(this.intro.modules.map(m => [m.operation, m]))
    return this.intro
  }

  async catalog(options: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<Catalog> {
    const p = await this.probe(options.refresh)
    if (!p.available) throw new ChengyingError('engine-unavailable', p.reason ?? 'darktable unavailable')
    const fp = p.fingerprint as string
    if (!options.refresh) {
      const cached = this.cache.get(this.id, fp, CATALOG_VERSION)
      if (cached !== undefined) {
        if (this.modules.size === 0) {
          this.modules = new Map((cached.operations.map(o => o.native?.module).filter(Boolean) as DtModule[]).map(m => [m.operation, m]))
          this.intro = { source: cached.source as DtIntrospection['source'], blendVersion: Number(cached.maskModel?.blendVersion ?? 14), modules: [...this.modules.values()], iopOrders: cached.native?.iopOrders as Record<string, string> | undefined, notes: cached.notes ?? [] }
        }
        return cached
      }
    }
    const intro = await this.introspect(options.signal)
    const masksOk = intro.blendVersion === SUPPORTED_BLEND_VERSION
    const operations: OperationSpec[] = intro.modules.filter(m => m.error === undefined || m.introspection === false).map(m => {
      const flags = m.flags ?? 0
      const blending = (flags & FLAGS.blending) !== 0
      // NO_MASKS modules still blend (opacity / blend mode) but take no drawn or parametric mask.
      const masks: OperationSpec['masks'] = blending && masksOk ? ((flags & FLAGS.noMasks) !== 0 ? ['native'] : ['parametric', 'drawn', 'native']) : []
      return {
        id: m.operation,
        title: m.title ?? m.operation,
        description: `${m.title ?? m.operation} (darktable module "${m.operation}", params v${m.paramsVersion ?? m.moduleVersion})${m.introspection === false ? ' — no introspection: pass params.blob (hex) from a style/XMP' : ''}`,
        category: category(m.group),
        version: m.paramsVersion ?? m.moduleVersion,
        params: paramsSchema(m),
        masks,
        multiInstance: (flags & FLAGS.oneInstance) === 0,
        deprecated: (flags & FLAGS.deprecated) !== 0,
        hidden: (flags & FLAGS.hidden) !== 0 || (flags & FLAGS.noHistory) !== 0,
        tags: PIPELINE_INTERNAL.has(m.operation) ? ['pipeline-internal'] : undefined,
        docsUrl: m.docUrl ?? `https://docs.darktable.org/usermanual/stable/en/module-reference/processing-modules/${m.operation}/`,
        native: { module: m, flags, blendCs: blendColorspaceFor(m.defaultColorspace), paramsSize: m.paramsSize },
      }
    })
    const unsupported = intro.modules.filter(m => m.error !== undefined && m.introspection !== false).map(m => `${m.operation}: ${m.error}`)
    const catalog: Catalog = {
      engine: this.id,
      engineVersion: p.version ?? '?',
      catalogVersion: CATALOG_VERSION,
      fingerprint: fp,
      source: intro.source,
      discoveredAt: nowIso(),
      operations,
      stageOptions: STAGE_OPTIONS,
      maskModel: {
        blendVersion: intro.blendVersion,
        supported: masksOk,
        drawn: ['circle', 'ellipse', 'gradient', 'rectangle', 'polygon', 'brush'],
        parametric: 'channels by blend colorspace — RGB scene: luminance/gray, red, green, blue, jzazbz_j, chroma, hue; Lab: luminance/lab_l, lab_a, lab_b, chroma, hue; RGB display: gray, red, green, blue, hue, saturation, value. Values 0..1 (hue in degrees).',
        native: BLEND_SCHEMA,
      },
      nativeTools: [],
      native: { iopOrders: intro.iopOrders ?? {} },
      notes: [...intro.notes, masksOk ? 'blending & drawn masks: hand-mapped dt_develop_blend_params_t v14 + masks v6' : `masks disabled: installed blend params version ${intro.blendVersion} != supported ${SUPPORTED_BLEND_VERSION}`],
      coverage: coverageOf(operations, ['blending (all blend modes, opacity, parametric ranges, feathering, blur, contrast, raster masks via native)', 'drawn masks (circle, ellipse, gradient, path/polygon/rectangle, brush)', 'styles (.dtstyle) and XMP history import', 'darktable-cli export options (--hq, --upscale, --style, --icc-*)'], unsupported),
    }
    if (this.mcp !== undefined) {
      try {
        catalog.nativeTools = (await this.mcp.tools()).map(t => ({ name: t.name, description: t.description ?? '', inputSchema: t.inputSchema ?? {}, writes: ['import_images', 'save_style', 'import_style', 'apply_style', 'set_rating', 'set_color_label', 'reset_history', 'export_images'].includes(t.name) }))
      } catch (error) {
        catalog.notes?.push(`darktable-mcp tools/list failed: ${errorMessage(error)}`)
      }
    }
    this.cache.put(catalog)
    return catalog
  }

  private moduleOf(op: string): DtModule {
    const m = this.modules.get(op)
    if (m === undefined) throw new ChengyingError('invalid-argument', `unknown darktable module "${op}"`)
    return m
  }

  validateStep(step: EditStep, catalog: Catalog): ValidatedStep {
    if (typeof step.params?.$blob === 'string') {
      // Imported raw history item (possibly an older module version): pass through untouched.
      if (!catalog.operations.some(o => o.id === step.op)) throw new ChengyingError('invalid-argument', `unknown darktable module "${step.op}"`)
      return { step, warnings: [] }
    }
    const v = validateWithCatalog(step, catalog, { fill: true })
    const op = catalog.operations.find(o => o.id === v.step.op) as OperationSpec
    if (op.tags?.includes('pipeline-internal')) throw new ChengyingError('unsupported', `${op.id} is inserted by darktable's export pipeline and cannot be set through history; control output size with the render/export maxEdge`)
    if ((step.instance ?? 0) > 0 && !op.multiInstance) throw new ChengyingError('invalid-argument', `${op.id} allows only one instance`)
    if (step.mask !== undefined) {
      if (step.mask.shapes !== undefined && step.mask.shapes.length > 0 && !op.masks.includes('drawn')) throw new ChengyingError('unsupported', `${op.id} does not support drawn masks`)
      if (step.mask.parametric !== undefined && step.mask.parametric.length > 0 && !op.masks.includes('parametric')) throw new ChengyingError('unsupported', `${op.id} does not support parametric masks`)
    }
    return v
  }

  validateStageOptions(options: Record<string, unknown> | undefined): { options: Record<string, unknown>; warnings: string[] } {
    const { value, warnings } = normalizeParams(STAGE_OPTIONS, options ?? {}, true)
    return { options: value, warnings }
  }

  private async historyFor(stage: EditStage, catalog: Catalog, aspect: number): Promise<{ history: DtHistoryItem[]; forms: Array<{ num: number; form: DtForm }> }> {
    if (this.modules.size === 0) await this.introspect()
    const history: DtHistoryItem[] = []
    const allForms: DtForm[] = []
    let num = 0
    // A masked (local) adjustment must not replace the module's base instance,
    // which carries darktable's own global defaults (e.g. exposure +0.7 EV in the
    // scene-referred workflow): give it the next free instance unless one is set.
    const used = new Map<string, Set<number>>()
    for (const s of stage.steps) used.set(s.op, new Set([...(used.get(s.op) ?? []), s.instance ?? 0]))
    const steps = stage.steps.map(s => {
      if (s.mask === undefined || s.instance !== undefined) return s
      const taken = used.get(s.op) as Set<number>
      let inst = 1
      while (taken.has(inst)) inst++
      taken.add(inst)
      return { ...s, instance: inst, label: s.label ?? `local ${inst}` }
    })
    for (const step of steps) {
      const m = this.moduleOf(step.op)
      let params: Buffer
      let modversion = m.paramsVersion ?? m.moduleVersion ?? 1
      if (typeof step.params.$blob === 'string') {
        params = Buffer.from(step.params.$blob, 'hex')
        if (typeof step.params.$version === 'number') modversion = step.params.$version
      } else {
        const { step: v } = this.validateStep(step, catalog)
        params = this.mcp !== undefined ? await this.mcp.encode(m.operation, v.params) : encodeParams(m, v.params)
      }
      const op = catalog.operations.find(o => o.id === step.op)
      let blendopParams: Buffer | undefined
      if (typeof step.params.$blendop === 'string') {
        blendopParams = Buffer.from(step.params.$blendop, 'hex')
      } else if (op !== undefined && op.masks.length > 0) {
        const { fields, forms } = applyMask(defaultBlend(Number(op.native?.blendCs ?? 4)), step.mask, aspect)
        blendopParams = encodeBlend(fields)
        allForms.push(...forms)
      }
      history.push({ num: num++, operation: m.operation, enabled: step.enabled, modversion, params, multiName: step.label ?? (step.instance ? `${step.instance}` : ''), multiPriority: step.instance ?? 0, blendopVersion: SUPPORTED_BLEND_VERSION, blendopParams })
    }
    // darktable reads mask forms per history number, and when it auto-applies its
    // default workflow it inserts those items before ours and renumbers the
    // history without renumbering masks_history. Attaching the forms to every
    // number the shift can produce keeps our masks bound to their items.
    const span = history.length + 48
    const forms = allForms.length === 0 ? [] : Array.from({ length: span }, (_, num) => allForms.map(form => ({ num, form }))).flat()
    return { history, forms }
  }

  async recipe(stage: EditStage, catalog: Catalog, input: { kind: 'raw' | 'raster' }, aspect = 1.5): Promise<{ extension: string; text: string }> {
    const opts = this.validateStageOptions(stage.options).options
    const { history, forms } = await this.historyFor(stage, catalog, aspect)
    const order = String(opts.iop_order ?? 'auto')
    let iopOrderVersion = order === 'auto' ? (input.kind === 'raw' ? 4 : 5) : (IOP_ORDER[order] ?? 4)
    let iopOrderList: string | undefined
    // Additional instances are only kept by darktable when they appear in the
    // pipeline order: write a custom order (version 0) derived from darktable's
    // own built-in list with each extra instance right after its base module.
    const extra = history.filter(h => h.multiPriority > 0)
    if (extra.length > 0) {
      const base = String((catalog.native?.iopOrders as Record<string, string> | undefined)?.[String(iopOrderVersion)] ?? this.intro?.iopOrders?.[String(iopOrderVersion)] ?? '')
      if (base === '') throw new ChengyingError('unsupported', 'multiple module instances need darktable\'s pipeline order, which this discovery backend did not provide')
      const parts = base.split(',')
      const entries: Array<[string, number]> = []
      for (let i = 0; i + 1 < parts.length; i += 2) entries.push([parts[i] as string, Number(parts[i + 1])])
      for (const h of [...extra].sort((a, b) => a.multiPriority - b.multiPriority)) {
        if (entries.some(([op, inst]) => op === h.operation && inst === h.multiPriority)) continue
        let at = -1
        entries.forEach(([op], idx) => { if (op === h.operation) at = idx })
        if (at < 0) throw new ChengyingError('invalid-argument', `${h.operation} is not part of darktable's pipeline order`)
        entries.splice(at + 1, 0, [h.operation, h.multiPriority])
      }
      iopOrderList = entries.map(([op, inst]) => `${op},${inst}`).join(',')
      iopOrderVersion = 0
    }
    return { extension: 'xmp', text: buildXmp({ history, forms, autoPresets: opts.workflow !== 'none', iopOrderVersion, iopOrderList }) }
  }

  private async acquireSlot(signal?: AbortSignal): Promise<number> {
    while (true) {
      const i = this.slots.indexOf(false)
      if (i >= 0) { this.slots[i] = true; return i }
      signal?.throwIfAborted()
      await new Promise(r => setTimeout(r, 150))
    }
  }

  async render(req: RenderRequest, catalog: Catalog): Promise<RenderResult> {
    const p = await this.probe()
    const install = this.install
    if (!p.available || install === undefined) throw new ChengyingError('engine-unavailable', p.reason ?? 'darktable unavailable')
    const meta = await sharp(req.input, { failOn: 'none' }).metadata().catch(() => undefined)
    const aspect = meta?.width && meta?.height ? meta.width / meta.height : 1.5
    const recipe = await this.recipe(req.stage, catalog, { kind: req.inputKind }, aspect)
    const opts = this.validateStageOptions(req.stage.options).options
    mkdirSync(req.scratchDir, { recursive: true })
    const xmpPath = join(req.scratchDir, `${newId('dt')}.xmp`)
    writeFileSync(xmpPath, recipe.text)
    const ext = req.format === 'tiff' ? 'tif' : req.format === 'png' ? 'png' : 'jpg'
    const out = req.output.endsWith(`.${ext}`) ? req.output : `${req.output}.${ext}`
    if (existsSync(out)) rmSync(out)
    const slot = await this.acquireSlot(req.signal)
    try {
      const configDir = join(this.opts.workDir, `config-${slot}`)
      mkdirSync(configDir, { recursive: true })
      const args = [req.input, xmpPath, out, '--hq', String(opts.hq !== false), '--upscale', String(opts.upscale === true), '--apply-custom-presets', 'false']
      if (req.maxEdge !== undefined && req.maxEdge > 0) args.push('--width', String(req.maxEdge), '--height', String(req.maxEdge))
      if (typeof opts.style === 'string' && opts.style !== '') { args.push('--style', opts.style); if (opts.style_overwrite === true) args.push('--style-overwrite') }
      if (typeof opts.icc_type === 'string') args.push('--icc-type', opts.icc_type)
      if (typeof opts.icc_file === 'string') args.push('--icc-file', opts.icc_file)
      if (typeof opts.icc_intent === 'string') args.push('--icc-intent', opts.icc_intent)
      args.push('--core', '--configdir', configDir, '--library', ':memory:', '--conf', 'write_sidecar_files=never', '--disable-opencl')
      if (req.format === 'jpeg') args.push('--conf', `plugins/imageio/format/jpeg/quality=${req.quality ?? 92}`)
      if (req.format === 'tiff') args.push('--conf', `plugins/imageio/format/tiff/bpp=${req.bitDepth ?? 16}`, '--conf', 'plugins/imageio/format/tiff/compress=2')
      if (req.format === 'png') args.push('--conf', `plugins/imageio/format/png/bpp=${req.bitDepth ?? 8}`)
      for (const [k, v] of Object.entries((opts.conf ?? {}) as Record<string, unknown>)) args.push('--conf', `${k}=${String(v)}`)
      const r = await run(install.cli, args, { timeoutMs: 15 * 60_000, signal: req.signal, cwd: req.scratchDir })
      if (r.code !== 0 || !existsSync(out)) {
        throw new ChengyingError('engine-failed', `darktable-cli failed (${r.code}): ${(r.stderr || r.stdout).split('\n').slice(-12).join('\n')}`, { recipe: xmpPath })
      }
      const info = await sharp(out).metadata()
      const warnings = (r.stdout + r.stderr).split('\n').filter(l => /error|warning|failed|unsupported|could not/i.test(l) && !/opencl/i.test(l)).slice(0, 10)
      return { output: out, width: info.width ?? 0, height: info.height ?? 0, durationMs: r.durationMs, warnings, recipe: { path: xmpPath, format: 'darktable-xmp' }, command: [install.cli, ...args] }
    } finally {
      this.slots[slot] = false
    }
  }

  async importRecipe(text: string, catalog: Catalog, hint?: string): Promise<{ steps: EditStep[]; options?: Record<string, unknown>; warnings: string[] }> {
    if (this.modules.size === 0) await this.introspect()
    const warnings: string[] = []
    let items: ImportedItem[]
    let options: Record<string, unknown> | undefined
    if (hint === 'dtstyle' || text.includes('<darktable_style')) {
      const s = parseDtStyle(text)
      items = s.items
      warnings.push(`imported style "${s.name}"`)
    } else {
      const x = parseXmpHistory(text)
      items = x.items
      if (x.autoPresetsApplied === true) options = { workflow: 'none' }
    }
    const steps: EditStep[] = items.map(it => {
      const m = this.modules.get(it.operation)
      const op = catalog.operations.find(o => o.id === it.operation)
      if (m === undefined || op === undefined) {
        warnings.push(`${it.operation}: module not present in this darktable build; kept as raw blob`)
      }
      const blob = it.params.startsWith('gz') ? undefined : Buffer.from(it.params, 'hex')
      let params: Record<string, unknown> = { $blob: it.params, $version: it.modversion }
      if (m !== undefined && blob !== undefined && it.modversion === (m.paramsVersion ?? m.moduleVersion)) {
        try {
          params = decodeParams(m, blob)
        } catch (error) {
          warnings.push(`${it.operation}: ${errorMessage(error)}`)
        }
      } else if (m !== undefined) {
        warnings.push(`${it.operation}: params v${it.modversion} differ from installed v${m.paramsVersion}; kept verbatim (darktable upgrades legacy params when rendering)`)
      }
      if (it.blendopParams !== undefined && it.blendopParams !== '' && !it.blendopParams.startsWith('gz')) {
        const blend = decodeBlend(Buffer.from(it.blendopParams, 'hex'))
        if (blend === undefined || (blend.mask_mode & 2) !== 0) params.$blendop = it.blendopParams
        else if (blend.mask_mode !== 0) params.$blendop = it.blendopParams
      }
      return { id: newId('st'), op: it.operation, params, enabled: it.enabled, ...(it.multiPriority > 0 ? { instance: it.multiPriority } : {}), ...(it.multiName !== '' ? { label: it.multiName } : {}) }
    })
    return { steps, options, warnings }
  }

  async callNative(name: string, args: Record<string, unknown>, ctx: { scratchDir: string; readable: (p: string) => string; writable: (p: string) => string }): Promise<unknown> {
    if (this.mcp === undefined) {
      await this.catalog()
      if (this.mcp === undefined) throw new ChengyingError('unsupported', 'native darktable tools need darktable-mcp (darktable ≥ 5.7 built with USE_MCP); this install exposes its modules through the catalog instead')
    }
    // Path boundary: inputs must be readable, outputs must land in Chengying-owned roots.
    const guard = (v: unknown, key: string): unknown => {
      if (typeof v === 'string' && /path|folder|file/i.test(key)) return /out/i.test(key) ? ctx.writable(v) : ctx.readable(v)
      if (Array.isArray(v)) return v.map(x => guard(x, key))
      if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, guard(x, k)]))
      return v
    }
    const safe = guard(args, '') as Record<string, unknown>
    if (['export_images'].includes(name) && safe.out_path === undefined && safe.out_dir === undefined) safe.out_dir = ctx.writable(join(ctx.scratchDir, 'dt-export'))
    return await this.mcp.call(name, safe)
  }

  async close(): Promise<void> {
    await this.mcp?.close()
  }
}

export function darktableFileStat(p: string): number {
  return statSync(p).mtimeMs
}
