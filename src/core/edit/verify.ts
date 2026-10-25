/**
 * Interface coverage verification. For every operation an engine publishes:
 *  1. build a step that changes one parameter away from its default
 *     (number → +10 % of its range, boolean → flipped, enum → another value),
 *  2. render it through the real engine,
 *  3. read back what the engine actually used — darktable re-exports the
 *     history it parsed in the output's XMP; RawTherapee writes the complete
 *     profile it applied (-O) — and compare it with what Chengying wrote.
 * Operations are batched; a failing batch is re-run one operation at a time
 * so every failure is attributed to its operation.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Catalog, EngineAdapter, OperationSpec } from './engine.ts'
import type { EditStage, EditStep } from '../types.ts'
import type { ParamSchema } from './schema.ts'
import { MetadataService } from '../meta/exif.ts'
import { parseXmpHistory } from './engines/darktable/xmp.ts'
import { errorMessage } from '../util/errors.ts'
import { newId, nowIso } from '../util/misc.ts'

export interface OpVerification {
  id: string
  status: 'ok' | 'failed' | 'skipped'
  changed?: string
  render?: boolean
  roundtrip?: boolean | 'n/a'
  reason?: string
}

export interface VerificationReport {
  engine: string
  engineVersion: string
  source: string
  input: string
  verifiedAt: string
  operations: OpVerification[]
  summary: { total: number; ok: number; failed: number; skipped: number; parameters: number; renders: number; durationMs: number }
}

/** Parameters whose increase multiplies processing cost; perturbed only as a last resort. */
const COSTLY = /iter|radius|size|scale|passes|scales|detail|levels|sigma|window|depth|quality|precision|samples|steps|width|height/i

/**
 * Change one parameter minimally away from its default: integers ±1, floats
 * ±2 % of their range, booleans flipped, enums switched. Cost-driving
 * parameters (iterations, radii…) are avoided when anything else exists.
 */
export function perturb(schema: ParamSchema, prefer?: (name: string) => boolean): { params: Record<string, unknown>; changed: string } | undefined {
  const props = Object.entries(schema.properties ?? {}).filter(([k]) => !/^(enabled|version|.*path|.*file|.*filename|name|blob)$/i.test(k))
  const rank = (k: string): number => (prefer !== undefined && !prefer(k) ? 2 : 0) + (COSTLY.test(k) ? 1 : 0)
  const order = [...props].sort((a, b) => rank(a[0]) - rank(b[0]))
  for (const [k, s] of order) {
    if (s.type === 'number' || s.type === 'integer') {
      const def = typeof s.default === 'number' ? s.default : 0
      if (s.minimum === undefined || s.maximum === undefined || !Number.isFinite(s.maximum - s.minimum) || s.maximum - s.minimum > 1e6) continue
      const span = s.maximum - s.minimum
      const integral = s.type === 'integer' || (Number.isInteger(def) && span >= 10)
      let v = integral ? def + 1 : def + Math.max(span * 0.02, 1e-3)
      if (v > s.maximum) v = integral ? def - 1 : def - Math.max(span * 0.02, 1e-3)
      if (v < s.minimum || v === def) continue
      v = Math.round(v * 1e6) / 1e6
      return { params: { [k]: v }, changed: `${k}: ${def} → ${v}` }
    }
    if (s.type === 'boolean') return { params: { [k]: !(s.default === true) }, changed: `${k}: ${String(s.default === true)} → ${String(!(s.default === true))}` }
    if (s.type === 'string' && s.enum !== undefined && s.enum.length > 1) {
      const alt = s.enum.find(e => e !== s.default)
      if (alt !== undefined) return { params: { [k]: alt }, changed: `${k}: ${String(s.default)} → ${String(alt)}` }
    }
  }
  return undefined
}

function chunks<T>(a: T[], n: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n))
  return out
}

export async function verifyEngine(engine: EngineAdapter, catalog: Catalog, opts: { input: string; inputKind: 'raw' | 'raster'; workDir: string; batch?: number; renderTimeoutMs?: number; only?: string[]; onProgress?: (done: number, total: number) => void; signal?: AbortSignal }): Promise<VerificationReport> {
  const started = Date.now()
  mkdirSync(opts.workDir, { recursive: true })
  const meta = new MetadataService({ maxProcs: 1 })
  const results = new Map<string, OpVerification>()
  let renders = 0
  const ops = catalog.operations.filter(o => opts.only === undefined || opts.only.includes(o.id))
  const planned: Array<{ op: OperationSpec; step: EditStep; changed: string }> = []
  for (const op of ops) {
    if (engine.id === 'ai') {
      const special = await aiVerifyStep(op, opts.workDir)
      if (special !== undefined) { planned.push({ op, step: special.step, changed: special.changed }); continue }
    }
    if (engine.id === 'builtin' && op.id === 'lut3d') {
      // Needs a LUT file: a small warm-tint .cube generated for the run.
      const cube = join(opts.workDir, 'verify-warm.cube')
      const lines = ['LUT_3D_SIZE 2']
      for (let b = 0; b < 2; b++) for (let g = 0; g < 2; g++) for (let r = 0; r < 2; r++) lines.push(`${Math.min(1, r * 1.05)} ${g} ${b * 0.9}`)
      writeFileSync(cube, lines.join('\n'))
      planned.push({ op, step: { id: newId('v'), op: op.id, enabled: true, params: { file: cube, strength: 0.8 } }, changed: 'file: generated warm LUT, strength 0.8' })
      continue
    }
    if (engine.id === 'rawtherapee' && op.id === 'Locallab') {
      planned.push({ op, step: { id: newId('v'), op: op.id, enabled: true, params: { spots: [{ Shape: 'ELI', Expexpose: true, Expcomp: 1.2, Transit: 50 }] } }, changed: 'spots[0].Expcomp: 0 → 1.2' })
      continue
    }
    if (op.tags?.includes('pipeline-internal')) {
      results.set(op.id, { id: op.id, status: 'skipped', reason: 'pipeline-internal module (inserted by the engine at export, not addressable through history)' })
      continue
    }
    // Prefer a real tool parameter over the on/off switch; the switch is set separately below.
    const p = perturb(op.params, k => !/^(Enabled|enabled)$/.test(k))
    if (p === undefined) {
      if (op.params.properties === undefined || Object.keys(op.params.properties).length === 0 || op.params.properties.blob !== undefined) {
        results.set(op.id, { id: op.id, status: 'skipped', reason: op.params.properties?.blob !== undefined ? 'no introspection (params only as raw blob)' : 'no parameters' })
        continue
      }
      planned.push({ op, step: { id: newId('v'), op: op.id, enabled: true, params: {} }, changed: 'defaults' })
      continue
    }
    const params = { ...p.params }
    // RawTherapee tools are inert unless enabled.
    if (engine.id === 'rawtherapee' && op.params.properties?.Enabled !== undefined && Object.keys(p.params)[0] !== 'Enabled') params.Enabled = true
    planned.push({ op, step: { id: newId('v'), op: op.id, enabled: true, params }, changed: p.changed })
  }

  const renderBatch = async (batch: typeof planned): Promise<string> => {
    const stage: EditStage = { id: 'verify', engine: engine.id, steps: batch.map(b => b.step) }
    const out = join(opts.workDir, newId('render'))
    renders++
    const timeout = AbortSignal.timeout(opts.renderTimeoutMs ?? 300_000)
    const r = await engine.render({ input: opts.input, inputKind: opts.inputKind, stage, output: out, format: 'jpeg', maxEdge: 400, scratchDir: join(opts.workDir, 'scratch'), signal: opts.signal === undefined ? timeout : AbortSignal.any([opts.signal, timeout]), readable: (x: string) => x }, catalog)
    return r.output
  }

  let baselinePath: string | undefined
  const baseline = async (): Promise<string> => {
    baselinePath ??= await renderBatch([])
    return baselinePath
  }

  const checkRoundtrip = async (batch: typeof planned, output: string): Promise<Map<string, { ok: boolean | 'n/a'; reason?: string }>> => {
    const res = new Map<string, { ok: boolean | 'n/a'; reason?: string }>()
    if (engine.id === 'darktable') {
      const x = await meta.exec(['-b', '-xmp', output])
      const items = parseXmpHistory(x.stdout).items
      const recipe = await engine.recipe({ id: 'v', engine: engine.id, steps: batch.map(b => b.step) }, catalog, { kind: opts.inputKind })
      const ours = parseXmpHistory(recipe.text).items
      for (const b of batch) {
        const mine = ours.find(i => i.operation === b.op.id)
        const theirs = [...items].reverse().find(i => i.operation === b.op.id && i.multiPriority === (mine?.multiPriority ?? 0))
        if (mine === undefined || theirs === undefined) { res.set(b.op.id, { ok: false, reason: 'module missing from the history darktable used' }); continue }
        const decode = async (v: string): Promise<string> => (v.startsWith('gz') ? (await import('node:zlib')).inflateSync(Buffer.from(v.slice(4), 'base64')).toString('hex') : v)
        const same = (await decode(theirs.params)) === (await decode(mine.params))
        res.set(b.op.id, same ? { ok: true } : { ok: false, reason: 'darktable read different params than written' })
      }
    } else if (engine.id === 'rawtherapee') {
      const rt = engine as unknown as { dumpProfile(stage: EditStage, c: Catalog): Promise<Map<string, Map<string, string>>> }
      const used = await rt.dumpProfile({ id: 'v', engine: engine.id, steps: batch.map(b => b.step) }, catalog)
      for (const b of batch) {
        const section = used.get(b.op.id)
        if (section === undefined) { res.set(b.op.id, { ok: false, reason: 'section missing from the profile RawTherapee used' }); continue }
        let ok = true
        let reason: string | undefined
        for (const [k, v] of Object.entries(b.step.params)) {
          if (k === 'spots') {
            const got = section.get('Expcomp_0')
            ok = got !== undefined && Math.abs(Number(got) - 1.2) < 1e-6
            if (!ok) reason = `spot Expcomp read back as ${got}`
            continue
          }
          const got = section.get(k)
          const want = typeof v === 'boolean' ? String(v) : String(v)
          const eq = got !== undefined && (got === want || (Number.isFinite(Number(got)) && Math.abs(Number(got) - Number(want)) < 1e-6))
          if (!eq) { ok = false; reason = `${k}: wrote ${want}, RawTherapee used ${got}` }
        }
        res.set(b.op.id, { ok, reason })
      }
    } else {
      // Registry engines: the operation must visibly change the result compared with an empty recipe.
      const base = await baseline()
      const diff = await meanAbsDiff(base, output)
      for (const b of batch) res.set(b.op.id, diff > 0 ? { ok: true } : { ok: false, reason: 'output identical to the unedited render' })
    }
    return res
  }

  let done = results.size
  const total = ops.length
  for (const batch of chunks(planned, opts.batch ?? (engine.id === 'builtin' || engine.id === 'ai' ? 1 : 12))) {
    opts.signal?.throwIfAborted()
    const attempt = async (b: typeof planned): Promise<boolean> => {
      try {
        const out = await renderBatch(b)
        const rt = await checkRoundtrip(b, out)
        for (const x of b) {
          const r = rt.get(x.op.id) ?? { ok: 'n/a' as const }
          results.set(x.op.id, { id: x.op.id, status: r.ok === false ? 'failed' : 'ok', changed: x.changed, render: true, roundtrip: r.ok, ...(r.reason ? { reason: r.reason } : {}) })
        }
        return true
      } catch (error) {
        if (b.length === 1) {
          const x = b[0] as (typeof planned)[number]
          results.set(x.op.id, { id: x.op.id, status: 'failed', changed: x.changed, render: false, reason: errorMessage(error).slice(0, 400) })
          return false
        }
        return false
      }
    }
    if (!(await attempt(batch)) && batch.length > 1) for (const one of batch) await attempt([one])
    done += batch.length
    opts.onProgress?.(Math.min(done, total), total)
  }
  await meta.end()
  const operations = ops.map(o => results.get(o.id) ?? { id: o.id, status: 'skipped' as const, reason: 'not planned' })
  return {
    engine: engine.id,
    engineVersion: catalog.engineVersion,
    source: catalog.source,
    input: opts.inputKind,
    verifiedAt: nowIso(),
    operations,
    summary: {
      total: operations.length,
      ok: operations.filter(o => o.status === 'ok').length,
      failed: operations.filter(o => o.status === 'failed').length,
      skipped: operations.filter(o => o.status === 'skipped').length,
      parameters: catalog.coverage.parameters,
      renders,
      durationMs: Date.now() - started,
    },
  }
}

export function writeReport(path: string, report: VerificationReport): void {
  writeFileSync(path, JSON.stringify(report, null, 2))
}

/** Mean absolute 8-bit difference of two renders (resized to the first one's size when dimensions differ). */
async function meanAbsDiff(a: string, b: string): Promise<number> {
  const sharp = (await import('sharp')).default
  const A = await sharp(a).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const ma = await sharp(b).metadata()
  if (ma.width !== A.info.width || ma.height !== A.info.height) return 255
  const B = await sharp(b).removeAlpha().raw().toBuffer()
  let d = 0
  for (let i = 0; i < A.data.length; i++) d += Math.abs((A.data[i] as number) - (B[i] as number))
  return d / A.data.length
}

/** Inputs the AI-stage operations need (mask, reference fingerprint, generated layer). */
async function aiVerifyStep(op: OperationSpec, dir: string): Promise<{ step: EditStep; changed: string } | undefined> {
  const id = newId('v')
  switch (op.id) {
    case 'upscale': return { step: { id, op: op.id, enabled: true, params: { scale: 1.5, method: 'auto' } }, changed: 'scale 1.5' }
    case 'inpaint': return { step: { id, op: op.id, enabled: true, params: { radius: 4 }, mask: { shapes: [{ type: 'circle', cx: 0.5, cy: 0.5, r: 0.05 }] } }, changed: 'circle mask r=0.05' }
    case 'style_match': {
      const { styleFingerprint } = await import('./engines/ai/classical.ts')
      const w = 64; const h = 48; const data = new Float32Array(w * h * 3)
      for (let i = 0; i < w * h; i++) { data[i * 3] = 0.6 * (i % w) / w + 0.2; data[i * 3 + 1] = 0.35; data[i * 3 + 2] = 0.12 }
      return { step: { id, op: op.id, enabled: true, params: { fingerprint: styleFingerprint({ width: w, height: h, data }), strength: 0.7 } }, changed: 'warm synthetic reference, strength 0.7' }
    }
    case 'gen_layer': {
      const sharp = (await import('sharp')).default
      const asset = join(dir, 'verify-layer.png')
      await sharp({ create: { width: 320, height: 240, channels: 3, background: '#2050c0' } }).png().toFile(asset)
      return { step: { id, op: op.id, enabled: true, params: { asset, authorization: 'verify', kind: 'fill' }, mask: { shapes: [{ type: 'rectangle', x: 0, y: 0, w: 0.5, h: 0.3 }] } }, changed: 'solid layer in a rectangle mask' }
    }
    default: return undefined
  }
}
