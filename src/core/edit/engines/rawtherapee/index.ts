/**
 * RawTherapee engine adapter.
 *
 * Discovery asks the installed rawtherapee-cli to write its COMPLETE
 * processing profile (-O) for a probe image, once plain and once with a local
 * adjustment spot whose every tool block is made visible. Each pp3 section
 * becomes an operation; each key a parameter with type and default from the
 * dump (ranges/enums refined by curated hints). Keys added by a newer
 * RawTherapee therefore appear automatically.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { homedir, platform } from 'node:os'
import sharp from 'sharp'
import type { EditStage, EditStep } from '../../../types.ts'
import type { Catalog, EngineAdapter, EngineProbe, OperationSpec, RenderRequest, RenderResult, SmokeResult, ValidatedStep } from '../../engine.ts'
import { CatalogCache, coverageOf, fingerprintOf, validateWithCatalog } from '../../engine.ts'
import { normalizeParams, type ParamSchema } from '../../schema.ts'
import { parsePp3, toPp3Value, writePp3, type Pp3 } from './pp3.ts'
import { hintFor } from './hints.ts'
import { run } from '../../../util/proc.ts'
import { cliPath } from '../../../util/path.ts'
import { ChengyingError, errorMessage } from '../../../util/errors.ts'
import { isRecord, newId, nowIso } from '../../../util/misc.ts'

const CATALOG_VERSION = 2
const SKIP_SECTIONS = new Set(['Version', 'General'])
const SPOT_TOOLS = ['Expblur', 'Expcbdl', 'Expcie', 'Expcolor', 'Expcontrast', 'Expexpose', 'Explog', 'Expmask', 'Expreti', 'Expshadhigh', 'Expsharp', 'Expsoft', 'Exptonemap', 'Expvibrance']
const exe = platform() === 'win32' ? '.exe' : ''

function candidates(explicit?: string): string[] {
  const list: string[] = []
  if (explicit) list.push(explicit)
  if (process.env.CHENGYING_RAWTHERAPEE_CLI) list.push(process.env.CHENGYING_RAWTHERAPEE_CLI)
  for (const dir of (process.env.PATH ?? '').split(delimiter)) if (dir) list.push(join(dir, `rawtherapee-cli${exe}`))
  if (platform() === 'darwin') list.push('/Applications/RawTherapee.app/Contents/MacOS/rawtherapee-cli', join(homedir(), 'Applications/RawTherapee.app/Contents/MacOS/rawtherapee-cli'))
  else if (platform() === 'win32') {
    for (const pf of [process.env.ProgramFiles, 'C:\\Program Files']) for (const v of ['5.13', '5.12', '5.11', '5.10', '5.9']) if (pf) list.push(join(pf, 'RawTherapee', v, 'rawtherapee-cli.exe'))
  } else list.push('/usr/bin/rawtherapee-cli', '/usr/local/bin/rawtherapee-cli')
  return [...new Set(list)]
}

function rtEnv(settings: string): NodeJS.ProcessEnv {
  const utf8 = platform() === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8'
  return { ...process.env, LC_ALL: utf8, LANG: utf8, G_FILENAME_ENCODING: 'UTF-8', RT_SETTINGS: settings, RT_CACHE: join(settings, 'cache') }
}

type Kind = 'boolean' | 'number' | 'list' | 'string'

function kindOf(v: string): Kind {
  if (v === 'true' || v === 'false') return 'boolean'
  if (/^-?\d+(\.\d+)?(e-?\d+)?$/i.test(v)) return 'number'
  if (v.includes(';')) return 'list'
  return 'string'
}

function keySchema(section: string, key: string, def: string): ParamSchema {
  const h = hintFor(section, key)
  const k = kindOf(def)
  const base: ParamSchema = { 'x-native': { pp3: `${section}.${key}`, default: def } }
  if (h?.description) base.description = h.description
  if (h?.unit) base['x-unit'] = h.unit
  switch (k) {
    case 'boolean': return { ...base, type: 'boolean', default: def === 'true' }
    case 'number': {
      const s: ParamSchema = { ...base, type: 'number', default: Number(def) }
      if (Number.isInteger(Number(def)) && h?.description === undefined) s.description = 'integral default: RawTherapee stores some of these as integers (fractions are rounded on retry)'
      if (h?.min !== undefined) s.minimum = h.min
      if (h?.max !== undefined) s.maximum = h.max
      return s
    }
    case 'list':
      return { ...base, default: def, description: `${h?.description ?? 'curve / list'} — pp3 string like "${def.slice(0, 40)}", an array of numbers, or {"type":1,"points":[[x,y],…]}` }
    default:
      return h?.enum !== undefined && (h.enum.includes(def) || def === '') ? { ...base, type: 'string', enum: def === '' || h.enum.includes(def) ? h.enum : [...h.enum, def], default: def } : { ...base, type: 'string', default: def }
  }
}

function curveValue(v: unknown): string {
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return toPp3Value(v.flat())
  if (isRecord(v) && Array.isArray(v.points)) {
    const pts = (v.points as Array<[number, number]>).flat()
    return toPp3Value([Number(v.type ?? 1), ...pts])
  }
  return toPp3Value(v)
}

function normalizeRtStep(step: EditStep): EditStep {
  const params: Record<string, unknown> = { ...(step.params ?? {}) }
  const opLower = step.op.toLowerCase()
  if (opLower === 'rotation') {
    if (params.Degrees !== undefined && params.Degree === undefined) params.Degree = params.Degrees
    delete params.Degrees
  } else if (opLower === 'white balance') {
    if (typeof params.Setting === 'string' && params.Setting.toLowerCase() === 'auto') {
      params.Setting = 'autitcgreen'
    } else if ((params.Temperature !== undefined || params.Green !== undefined) && params.Setting === undefined) {
      params.Setting = 'Custom'
    }
  } else if (opLower === 'crop') {
    if (params.Enabled === undefined) params.Enabled = true
  }
  return { ...step, params }
}

const RT_EXTERNAL_PATHS: Record<string, readonly string[]> = {
  'Film Simulation': ['ClutFilename'],
  'Color Management': ['InputProfile', 'OutputProfile', 'PrinterProfile'],
  LensProfile: ['LCPFile', 'LcpFile'],
  'Lens Profile': ['LCPFile', 'LcpFile'],
  'Flat Field': ['FlatFieldFile'],
  'Dark Frame': ['DarkFrameFile'],
}

/** Validate every PP3 value that can make the external CLI open another file. */
export function guardRawTherapeeProfilePaths(profile: Pp3, readable: ((path: string) => string) | undefined): void {
  for (const [section, fields] of Object.entries(RT_EXTERNAL_PATHS)) {
    const values = profile.get(section)
    if (values === undefined) continue
    for (const field of fields) {
      const value = values.get(field)
      if (value === undefined || value === '') continue
      const alwaysExternal = section === 'Film Simulation' && field === 'ClutFilename'
      const pathLike = /^(?:[a-zA-Z]:[\\/]|[\\/]|\.\.?[\\/])/.test(value) || /[\\/]/.test(value) || /\.(?:icc?|icm|png|jpe?g|tiff?|pp3)$/i.test(value)
      if (!alwaysExternal && !pathLike) continue // RT built-in profile identifiers such as RTv4_sRGB
      if (readable === undefined) throw new ChengyingError('permission-denied', `RawTherapee ${section}.${field} requires the project read guard`)
      values.set(field, cliPath(readable(value)))
    }
  }
}

export class RawTherapeeEngine implements EngineAdapter {
  readonly id = 'rawtherapee'
  readonly title = 'RawTherapee'
  private cli: string | undefined
  private probed: EngineProbe | undefined
  private slots: boolean[]
  private readonly cache: CatalogCache

  constructor(private readonly opts: { cli?: string; workDir: string; maxParallel?: number }) {
    mkdirSync(opts.workDir, { recursive: true })
    this.cache = new CatalogCache(join(opts.workDir, 'catalogs'))
    this.slots = new Array(Math.max(1, opts.maxParallel ?? 3)).fill(false)
  }

  /**
   * Render a 48×32 JPEG through the real CLI. RawTherapee handles non-raw
   * inputs, so the smoke render exercises the same argument path (profile,
   * output, resize) as a real photo without needing a RAW file.
   */
  async smokeTest(signal?: AbortSignal): Promise<SmokeResult> {
    const dir = join(this.opts.workDir, 'smoke')
    mkdirSync(dir, { recursive: true })
    const input = join(dir, 'in.jpg')
    const output = join(dir, 'out.jpg')
    if (!existsSync(input)) await sharp({ create: { width: 48, height: 32, channels: 3, background: '#808080' } }).jpeg({ quality: 80 }).toFile(input)
    rmSync(output, { force: true })
    try {
      const catalog = await this.catalog()
      const stage: EditStage = { id: 'stage_smoke', engine: this.id, steps: [] }
      await this.render({ input, inputKind: 'raster', stage, output, format: 'jpeg', quality: 70, maxEdge: 32, scratchDir: join(dir, 'scratch'), signal }, catalog)
      return existsSync(output) ? { ok: true } : { ok: false, reason: 'rawtherapee-cli reported success but wrote no file' }
    } catch (error) {
      // A build that refuses non-raw inputs is unusual but not broken: report
      // "skipped" so the engine stays usable for RAW work.
      if (/unsupported|not supported|cannot load|无法/i.test(errorMessage(error))) return { ok: true, skipped: true, reason: 'smoke render skipped: this build does not accept JPEG input' }
      return { ok: false, reason: errorMessage(error) }
    }
  }

  async probe(force = false): Promise<EngineProbe> {
    if (this.probed !== undefined && !force) return this.probed
    for (const c of candidates(this.opts.cli)) {
      if (!existsSync(c)) continue
      try {
        const r = await run(c, [], { timeoutMs: 60_000, env: rtEnv(join(this.opts.workDir, 'settings-probe')) })
        const m = /RawTherapee,\s*version\s*([\w.\-+]+)/i.exec(r.stdout + r.stderr)
        if (m === null) continue
        this.cli = c
        this.probed = { id: this.id, available: true, version: m[1], mode: 'profile-dump', binaries: { cli: c }, fingerprint: fingerprintOf([c, m[1], statSync(c).mtimeMs, CATALOG_VERSION]), inputs: { raw: true, raster: true } }
        return this.probed
      } catch { /* next */ }
    }
    this.probed = { id: this.id, available: false, binaries: {}, reason: 'rawtherapee-cli not found (install RawTherapee or set engines.rawtherapee.path / CHENGYING_RAWTHERAPEE_CLI)', inputs: { raw: true, raster: true } }
    return this.probed
  }

  private async dump(name: string, sidecar: string | undefined, signal?: AbortSignal): Promise<Pp3> {
    const dir = join(this.opts.workDir, 'discovery')
    mkdirSync(dir, { recursive: true })
    const probe = join(dir, `${name}.jpg`)
    await sharp({ create: { width: 64, height: 48, channels: 3, background: '#808080' } }).jpeg().toFile(probe)
    if (sidecar !== undefined) writeFileSync(`${probe}.pp3`, sidecar)
    const out = join(dir, `${name}-out.jpg`)
    rmSync(`${out}.pp3`, { force: true })
    const args = ['-O', cliPath(out), ...(sidecar !== undefined ? ['-s'] : []), '-Y', '-c', cliPath(probe)]
    const r = await run(this.cli as string, args, { timeoutMs: 120_000, env: rtEnv(join(this.opts.workDir, 'settings-probe')), signal })
    if (r.code !== 0 || r.timedOut || !existsSync(`${out}.pp3`)) throw new ChengyingError('engine-failed', `rawtherapee-cli did not write a valid profile (${r.timedOut ? 'timeout' : r.code}): ${(r.stderr || r.stdout).slice(-500)}`)
    return parsePp3(readFileSync(`${out}.pp3`, 'utf8'))
  }

  async catalog(options: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<Catalog> {
    const p = await this.probe(options.refresh)
    if (!p.available) throw new ChengyingError('engine-unavailable', p.reason ?? 'RawTherapee unavailable')
    const fp = p.fingerprint as string
    if (!options.refresh) {
      const c = this.cache.get(this.id, fp, CATALOG_VERSION)
      if (c !== undefined) return c
    }
    const full = await this.dump('probe', undefined, options.signal)
    const spotProfile = `[Locallab]\nEnabled=true\nSelspot=0\nName_0=probe\n${SPOT_TOOLS.map(t => `${t}_0=false`).join('\n')}\n`
    const spot = await this.dump('probe-spot', spotProfile, options.signal)
    const ppVersion = full.get('Version')?.get('Version') ?? '?'
    const operations: OperationSpec[] = []
    for (const [section, keys] of full) {
      if (SKIP_SECTIONS.has(section)) continue
      const properties: Record<string, ParamSchema> = {}
      for (const [k, v] of keys) properties[k] = keySchema(section, k, v)
      if (section === 'Locallab') {
        const spotProps: Record<string, ParamSchema> = {}
        for (const [k, v] of spot.get('Locallab') ?? []) {
          const m = /^(.+)_0$/.exec(k)
          if (m === null) continue
          spotProps[m[1] as string] = keySchema('Locallab', m[1] as string, v)
        }
        properties.spots = { type: 'array', items: { type: 'object', properties: spotProps, additionalProperties: false }, description: `local adjustment spots (${Object.keys(spotProps).length} keys each: geometry, scope, and per-tool blocks — set Exp<tool>=true to enable a tool, e.g. Expexpose with Expcomp; omitted keys take RawTherapee defaults)` }
      }
      operations.push({
        id: section,
        title: section,
        description: `RawTherapee tool "${section}" (pp3 section, ${Object.keys(properties).length} parameters). Partial parameter sets are merged over the base profile.`,
        category: /RAW|Demosaic|Preprocess/.test(section) ? 'raw' : /Crop|Rotation|Perspective|Distortion|Resize|Transformation|LensProfile|Coarse|Framing/.test(section) ? 'geometry' : 'tool',
        version: ppVersion,
        params: { type: 'object', properties, additionalProperties: false },
        masks: section === 'Locallab' ? ['native'] : [],
        multiInstance: false,
        native: { section },
      })
    }
    const catalog: Catalog = {
      engine: this.id,
      engineVersion: p.version ?? '?',
      catalogVersion: CATALOG_VERSION,
      fingerprint: fp,
      source: 'profile-dump',
      discoveredAt: nowIso(),
      operations,
      stageOptions: {
        type: 'object',
        additionalProperties: false,
        properties: {
          base: { type: 'string', enum: ['default', 'neutral'], default: 'default', description: 'default: RawTherapee\'s default raw/non-raw profile under your steps (-d); neutral: neutral values' },
          profiles: { type: 'array', items: { type: 'string' }, default: [], description: 'extra .pp3 profiles applied before the steps (paths must be readable)' },
          fast: { type: 'boolean', default: false, description: 'fast-export pipeline (-f)' },
          jpeg_subsampling: { type: 'integer', minimum: 1, maximum: 3, default: 3, description: '1 4:2:0, 2 4:2:2, 3 4:4:4' },
        },
      },
      maskModel: { native: 'Locallab spots (ellipse/rectangle, normal/excluding/full, ΔE colour scope, per-tool masks). Use operation "Locallab" with spots[].' },
      notes: [`pp3 version ${ppVersion}; local adjustment spots expose ${Object.keys((operations.find(o => o.id === 'Locallab')?.params.properties?.spots?.items?.properties) ?? {}).length} keys`],
      coverage: coverageOf(operations, ['Locallab local adjustments (all tools)', 'extra base profiles (-p)', 'fast export (-f)'], []),
    }
    this.cache.put(catalog)
    return catalog
  }

  validateStep(step: EditStep, catalog: Catalog): ValidatedStep {
    const v = validateWithCatalog(normalizeRtStep(step), catalog, { fill: false })
    if (step.mask !== undefined && step.op !== 'Locallab') throw new ChengyingError('unsupported', 'RawTherapee applies local edits through Locallab spots; use operation "Locallab" instead of a mask')
    if ((step.instance ?? 0) > 0) throw new ChengyingError('unsupported', 'RawTherapee tools have a single instance; use several Locallab spots for repeated local edits')
    return v
  }

  validateStageOptions(options: Record<string, unknown> | undefined, catalog: Catalog): { options: Record<string, unknown>; warnings: string[] } {
    const r = normalizeParams(catalog.stageOptions, options ?? {}, true)
    return { options: r.value, warnings: r.warnings }
  }

  /** Merge steps (in order) into one partial profile. */
  buildProfile(stage: EditStage, catalog: Catalog, dims?: { width: number; height: number }): Pp3 {
    const p: Pp3 = new Map()
    for (const s of stage.steps) {
      if (!s.enabled) continue
      const { step } = this.validateStep(s, catalog)
      const section = p.get(step.op) ?? new Map<string, string>()
      for (const [k, v] of Object.entries(step.params)) {
        if (k === 'spots' && step.op === 'Locallab' && Array.isArray(v)) {
          for (const old of [...section.keys()]) if (/_\d+$/.test(old)) section.delete(old)
          v.forEach((spot, i) => {
            if (!isRecord(spot)) return
            if (spot.Name === undefined) section.set(`Name_${i}`, `spot ${i + 1}`)
            for (const [sk, sv] of Object.entries(spot)) section.set(`${sk}_${i}`, kindOf(String(sv)) === 'list' || Array.isArray(sv) || isRecord(sv) ? curveValue(sv) : toPp3Value(sv))
          })
          if (!section.has('Enabled')) section.set('Enabled', 'true')
          continue
        }
        section.set(k, Array.isArray(v) || isRecord(v) ? curveValue(v) : toPp3Value(v))
      }
      if (step.op === 'Crop' && dims !== undefined && dims.width > 1 && dims.height > 1) {
        const xv = Number(step.params.X)
        const yv = Number(step.params.Y)
        const wv = Number(step.params.W)
        const hv = Number(step.params.H)
        const isNormalized = (Number.isFinite(wv) && wv > 0 && wv <= 1) || (Number.isFinite(hv) && hv > 0 && hv <= 1) || (Number.isFinite(xv) && xv > 0 && xv < 1) || (Number.isFinite(yv) && yv > 0 && yv < 1)
        if (isNormalized) {
          const nx = Number.isFinite(xv) && xv <= 1 ? xv : 0
          const ny = Number.isFinite(yv) && yv <= 1 ? yv : 0
          const nw = Number.isFinite(wv) && wv <= 1 ? wv : Math.max(0.05, 1 - nx)
          const nh = Number.isFinite(hv) && hv <= 1 ? hv : Math.max(0.05, 1 - ny)
          section.set('X', String(Math.max(0, Math.round(nx * dims.width))))
          section.set('Y', String(Math.max(0, Math.round(ny * dims.height))))
          section.set('W', String(Math.max(1, Math.min(dims.width, Math.round(nw * dims.width)))))
          section.set('H', String(Math.max(1, Math.min(dims.height, Math.round(nh * dims.height)))))
          if (!section.has('FixedRatio') && step.params.Ratio === undefined) section.set('FixedRatio', 'false')
          if (!section.has('Enabled')) section.set('Enabled', 'true')
        }
      }
      p.set(step.op, section)
    }
    return p
  }

  async recipe(stage: EditStage, catalog: Catalog): Promise<{ extension: string; text: string }> {
    return { extension: 'pp3', text: writePp3(this.buildProfile(stage, catalog)) }
  }

  private async acquire(signal?: AbortSignal): Promise<number> {
    while (true) {
      signal?.throwIfAborted()
      const i = this.slots.indexOf(false)
      if (i >= 0) { this.slots[i] = true; return i }
      await new Promise(r => setTimeout(r, 25))
    }
  }

  async render(req: RenderRequest, catalog: Catalog): Promise<RenderResult> {
    const p = await this.probe()
    if (!p.available || this.cli === undefined) throw new ChengyingError('engine-unavailable', p.reason ?? 'RawTherapee unavailable')
    const opts = this.validateStageOptions(req.stage.options, catalog).options
    const inputMeta = await sharp(req.input, { failOn: 'none' }).metadata().catch(() => undefined)
    const orient = req.orientation ?? inputMeta?.orientation ?? 1
    const dims = inputMeta?.width && inputMeta?.height
      ? (orient >= 5 ? { width: inputMeta.height, height: inputMeta.width } : { width: inputMeta.width, height: inputMeta.height })
      : (req.fullEdge !== undefined && req.fullEdge > 1 ? { width: req.fullEdge, height: req.fullEdge } : undefined)
    const profile = this.buildProfile(req.stage, catalog, dims)
    guardRawTherapeeProfilePaths(profile, req.readable)
    if (req.maxEdge !== undefined && req.maxEdge > 0) {
      profile.set('Resize', new Map([['Enabled', 'true'], ['AppliesTo', 'Cropped area'], ['Method', 'Lanczos'], ['DataSpecified', '3'], ['Width', String(req.maxEdge)], ['Height', String(req.maxEdge)], ['AllowUpscaling', 'false']]))
    }
    mkdirSync(req.scratchDir, { recursive: true })
    const ppPath = join(req.scratchDir, `${newId('rt')}.pp3`)
    writeFileSync(ppPath, writePp3(profile))
    const ext = req.format === 'tiff' ? 'tif' : req.format === 'png' ? 'png' : 'jpg'
    const out = req.output.endsWith(`.${ext}`) ? req.output : `${req.output}.${ext}`
    rmSync(out, { force: true })
    const args: string[] = []
    if (opts.base !== 'neutral') args.push('-d')
    for (const prof of (opts.profiles as string[] | undefined) ?? []) args.push('-p', cliPath(req.readable !== undefined ? req.readable(prof) : prof))
    args.push('-p', cliPath(ppPath), '-o', cliPath(out), '-Y')
    if (opts.fast === true) args.push('-f')
    if (req.format === 'jpeg') args.push(`-j${req.quality ?? 92}`, `-js${opts.jpeg_subsampling ?? 3}`)
    else if (req.format === 'tiff') args.push('-tz', `-b${req.bitDepth ?? 16}`)
    else args.push('-n', `-b${req.bitDepth ?? 8}`)
    // RawTherapee resolves sidecars next to the input; give it a private copy-free path by passing the original read-only.
    args.push('-c', cliPath(req.input))
    const slot = await this.acquire(req.signal)
    try {
      let r = await run(this.cli, args, { timeoutMs: 15 * 60_000, signal: req.signal, env: rtEnv(join(this.opts.workDir, `settings-${slot}`)), cwd: req.scratchDir })
      const extraWarnings: string[] = []
      if (!existsSync(out) && /not found/.test(r.stderr + r.stdout)) {
        // RawTherapee rejects the whole profile when an integer key holds a fraction;
        // round keys whose default is integral and retry once.
        const rounded: string[] = []
        for (const [section, keys] of profile) {
          const op = catalog.operations.find(o => o.id === section)
          for (const [k, v] of keys) {
            const m = /^(.+?)(_\d+)?$/.exec(k)
            const sch = section === 'Locallab' && m?.[2] !== undefined ? op?.params.properties?.spots?.items?.properties?.[m[1] as string] : op?.params.properties?.[k]
            if (sch?.type === 'number' && Number.isInteger(Number(sch.default)) && /^-?\d+\.\d+$/.test(v)) { keys.set(k, String(Math.round(Number(v)))); rounded.push(`${section}.${k}`) }
          }
        }
        if (rounded.length > 0) {
          writeFileSync(ppPath, writePp3(profile))
          r = await run(this.cli, args, { timeoutMs: 15 * 60_000, signal: req.signal, env: rtEnv(join(this.opts.workDir, `settings-${slot}`)), cwd: req.scratchDir })
          extraWarnings.push(`rounded integer parameters: ${rounded.join(', ')}`)
        }
      }
      if (r.code !== 0 || r.timedOut || !existsSync(out)) throw new ChengyingError('engine-failed', `rawtherapee-cli failed (${r.timedOut ? 'timeout' : r.code}): ${(r.stderr || r.stdout).split('\n').slice(-10).join('\n')}`, { recipe: ppPath })
      // A readable header is not enough: decode pixels so a truncated output
      // left by a failed process cannot become a successful export.
      await sharp(out, { failOn: 'error' }).stats()
      const info = await sharp(out, { failOn: 'error' }).metadata()
      const warnings = [...extraWarnings, ...(r.stdout + r.stderr).split('\n').filter(l => /error|warning|cannot|failed/i.test(l)).slice(0, 10)]
      return { output: out, width: info.width ?? 0, height: info.height ?? 0, durationMs: r.durationMs, warnings, recipe: { path: ppPath, format: 'rawtherapee-pp3' }, command: [this.cli, ...args] }
    } finally {
      this.slots[slot] = false
    }
  }

  /** Run a profile on the probe image and return the complete profile RawTherapee actually used (-O). */
  async dumpProfile(stage: EditStage, catalog: Catalog, signal?: AbortSignal): Promise<Pp3> {
    if ((await this.probe()).available !== true) throw new ChengyingError('engine-unavailable', 'RawTherapee unavailable')
    return await this.dump(`verify-${newId('v')}`, writePp3(this.buildProfile(stage, catalog)), signal)
  }

  async importRecipe(text: string, catalog: Catalog): Promise<{ steps: EditStep[]; warnings: string[] }> {
    const pp = parsePp3(text)
    const warnings: string[] = []
    const steps: EditStep[] = []
    for (const [section, keys] of pp) {
      if (SKIP_SECTIONS.has(section)) continue
      const op = catalog.operations.find(o => o.id === section)
      if (op === undefined) { warnings.push(`section [${section}] is unknown to this RawTherapee build; skipped`); continue }
      const params: Record<string, unknown> = {}
      const spots: Array<Record<string, unknown>> = []
      for (const [k, v] of keys) {
        const m = /^(.+)_(\d+)$/.exec(k)
        if (section === 'Locallab' && m !== null) {
          const i = Number(m[2])
          spots[i] = spots[i] ?? {}
          const sch = op.params.properties?.spots?.items?.properties?.[m[1] as string]
          ;(spots[i] as Record<string, unknown>)[m[1] as string] = sch?.type === 'number' ? Number(v) : sch?.type === 'boolean' ? v === 'true' : v
          continue
        }
        const sch = op.params.properties?.[k]
        if (sch === undefined) { warnings.push(`[${section}] ${k} unknown; skipped`); continue }
        params[k] = sch.type === 'number' ? Number(v) : sch.type === 'boolean' ? v === 'true' : v
      }
      if (spots.length > 0) params.spots = spots.filter(Boolean)
      steps.push({ id: newId('st'), op: section, params, enabled: true })
    }
    return { steps, warnings }
  }
}
