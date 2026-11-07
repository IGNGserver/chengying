/**
 * Editing service: one resumable task per photo, an immutable revision graph
 * (every change creates a revision; undo/redo/branching is a checkout of any
 * earlier revision), multi-stage pipelines (e.g. darktable RAW development →
 * built-in finishing → AI stage), cached previews with statistics, and
 * before/after comparisons. Originals are only ever read.
 */
import sharp from 'sharp'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Project } from '../project.ts'
import type { EngineRegistry } from './registry.ts'
import type { EditDocument, EditStage, EditStep, MaskSpec, RevisionRecord, Shot, TaskRecord, TaskStatus } from '../types.ts'
import { fingerprintOf } from './engine.ts'
import { mergeParams } from './schema.ts'
import { generateWith, type GenerativeProvider } from './generative.ts'
import { loadImage, saveImage } from './engines/builtin/image.ts'
import { rasterizeMask } from './engines/builtin/masks.ts'
import { styleFingerprint, type StyleFingerprint } from './engines/ai/classical.ts'
import { loadAsset, writeMaskPng } from './engines/ai/index.ts'
import { rgbToLab } from '../analysis/pixels.ts'
import { ChengyingError, errorMessage } from '../util/errors.ts'
import { newId, nowIso, round } from '../util/misc.ts'

export type EditOp =
  | { op: 'add_step'; stage?: string | number; step: { op: string; params?: Record<string, unknown>; mask?: MaskSpec; instance?: number; label?: string; enabled?: boolean }; position?: number }
  | { op: 'update_step'; step_id: string; params?: Record<string, unknown>; replace_params?: boolean; mask?: MaskSpec | null; enabled?: boolean; label?: string }
  | { op: 'remove_step'; step_id: string }
  | { op: 'move_step'; step_id: string; position: number }
  | { op: 'add_stage'; engine: string; position?: number; options?: Record<string, unknown> }
  | { op: 'remove_stage'; stage: string | number }
  | { op: 'set_stage_options'; stage: string | number; options: Record<string, unknown> }
  | { op: 'set_source'; source: 'raw' | 'raster' }
  | { op: 'import_recipe'; stage?: string | number; text?: string; path?: string; format?: string; replace?: boolean }
  | { op: 'copy_from_task'; task_id: string; include_masks?: boolean; include_geometry?: boolean; replace?: boolean }
  | { op: 'reset'; stage?: string | number }
  | { op: 'set_provenance'; generative?: boolean; authorization?: string; note?: string }

export interface ImageStats {
  width: number
  height: number
  mean: { r: number; g: number; b: number; luma: number }
  percentiles: { p05: number; p50: number; p95: number }
  clipHigh: number
  clipLow: number
  localContrast: number
  colorCast: { r: number; g: number; b: number }
  histogram: number[]
  saturation: number
  zones?: { shadows: number; midtones: number; highlights: number }
  cast?: { a: number; b: number }
  faceLuma?: number
  faceStats?: { luma: number; contrast: number }
}

export interface RenderOutcome {
  path: string
  width: number
  height: number
  cached: boolean
  durationMs: number
  warnings: string[]
  stats: ImageStats
  stages: Array<{ engine: string; durationMs: number; recipe?: string }>
}

const ACTIVE: TaskStatus[] = ['queued', 'running', 'paused', 'waiting-authorization']

export async function imageStats(path: string, opts?: { faceBox?: [number, number, number, number] } | [number, number, number, number]): Promise<ImageStats> {
  const { data, info } = await sharp(path, { failOn: 'none' })
    .resize({ width: 800, height: 800, fit: 'inside', withoutEnlargement: true })
    .toColourspace('srgb')
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const n = info.width * info.height
  const is16 = data.byteLength >= n * 6
  const u16 = is16 ? new Uint16Array(data.buffer, data.byteOffset, data.byteLength / 2) : undefined
  let r = 0; let g = 0; let b = 0; let hi = 0; let lo = 0; let sat = 0
  let rSq = 0; let gSq = 0; let bSq = 0
  let shSum = 0; let shN = 0; let midSum = 0; let midN = 0; let hlSum = 0; let hlN = 0
  let castA = 0; let castB = 0; let castN = 0; let allA = 0; let allB = 0; let labSampled = 0
  let faceSum = 0; let faceN = 0; let faceSq = 0
  const fb = Array.isArray(opts) ? opts : opts?.faceBox
  const fx0 = fb ? Math.floor(fb[0] * info.width) : -1
  const fy0 = fb ? Math.floor(fb[1] * info.height) : -1
  const fx1 = fb ? Math.ceil((fb[0] + fb[2]) * info.width) : -1
  const fy1 = fb ? Math.ceil((fb[1] + fb[3]) * info.height) : -1
  const labStep = Math.max(1, Math.floor(n / 8000))
  const hist = new Array<number>(256).fill(0)
  for (let i = 0, j = 0; i < n; i++, j += 3) {
    const R = u16 !== undefined ? Math.round((u16[j] as number) / 257) : (data[j] as number)
    const G = u16 !== undefined ? Math.round((u16[j + 1] as number) / 257) : (data[j + 1] as number)
    const B = u16 !== undefined ? Math.round((u16[j + 2] as number) / 257) : (data[j + 2] as number)
    r += R; g += G; b += B
    rSq += R * R; gSq += G * G; bSq += B * B
    const y = Math.min(255, Math.max(0, Math.round(0.2126 * R + 0.7152 * G + 0.0722 * B)))
    hist[y] = (hist[y] ?? 0) + 1
    if (y < 64) { shSum += y; shN++ } else if (y < 192) { midSum += y; midN++ } else { hlSum += y; hlN++ }
    if (fb !== undefined) {
      const px = i % info.width
      const py = (i - px) / info.width
      if (px >= fx0 && px < fx1 && py >= fy0 && py < fy1) {
        faceSum += y
        faceSq += y * y
        faceN++
      }
    }
    if (i % labStep === 0) {
      const [L, A, B_lab] = rgbToLab(R, G, B)
      allA += A; allB += B_lab; labSampled++
      if (Math.hypot(A, B_lab) < 14 && L > 15 && L < 95) { castA += A; castB += B_lab; castN++ }
    }
    const mx = Math.max(R, G, B); const mn = Math.min(R, G, B)
    if (mx >= 254) hi++
    if (mx <= 2) lo++
    sat += mx === 0 ? 0 : (mx - mn) / mx
  }
  const pct = (p: number): number => { let acc = 0; for (let i = 0; i < 256; i++) { acc += hist[i] as number; if (acc >= n * p) return i } return 255 }
  const coarse: number[] = []
  for (let i = 0; i < 16; i++) coarse.push(round(hist.slice(i * 16, i * 16 + 16).reduce((a, x) => a + x, 0) / n * 100, 2))
  const meta = await sharp(path, { failOn: 'none' }).metadata()
  const useNeutral = castN > labSampled * 0.03
  const meanR = r / n; const meanG = g / n; const meanB = b / n
  const stdR = Math.sqrt(Math.max(0, rSq / n - meanR ** 2))
  const stdG = Math.sqrt(Math.max(0, gSq / n - meanG ** 2))
  const stdB = Math.sqrt(Math.max(0, bSq / n - meanB ** 2))
  const fLuma = faceN > 0 ? faceSum / faceN : undefined
  const fContrast = faceN > 0 && fLuma !== undefined ? Math.sqrt(Math.max(0, faceSq / faceN - fLuma ** 2)) : undefined
  return {
    width: meta.width ?? info.width,
    height: meta.height ?? info.height,
    mean: { r: round(meanR, 1), g: round(meanG, 1), b: round(meanB, 1), luma: round(0.2126 * meanR + 0.7152 * meanG + 0.0722 * meanB, 1) },
    percentiles: { p05: pct(0.05), p50: pct(0.5), p95: pct(0.95) },
    clipHigh: round(hi / n * 100, 2),
    clipLow: round(lo / n * 100, 2),
    localContrast: round(Math.sqrt((stdR ** 2 + stdG ** 2 + stdB ** 2) / 3), 1),
    colorCast: { r: round(meanR - meanG, 1), g: round(meanG - meanB, 1), b: round(meanB - meanR, 1) },
    histogram: coarse,
    saturation: round(sat / n * 100, 1),
    zones: {
      shadows: shN > 0 ? round(shSum / shN, 1) : 0,
      midtones: midN > 0 ? round(midSum / midN, 1) : 0,
      highlights: hlN > 0 ? round(hlSum / hlN, 1) : 0,
    },
    cast: labSampled > 0 ? {
      a: round(useNeutral ? castA / castN : allA / labSampled, 2),
      b: round(useNeutral ? castB / castN : allB / labSampled, 2),
    } : undefined,
    ...(faceN > 0 ? { faceLuma: round(faceSum / faceN, 1), faceStats: { luma: round(fLuma!, 1), contrast: round(fContrast!, 1) } } : {}),
  }
}

export class EditService {
  /** Default render-time authorization check (generative layers); set by the host. */
  authorize: ((engine: string, step: EditStep) => Promise<string | undefined>) | undefined

  constructor(readonly project: Project, readonly engines: EngineRegistry) {}

  private task(id: string): TaskRecord {
    const t = this.project.repo.task(id)
    if (t === undefined) throw new ChengyingError('not-found', `no task ${id}`)
    return t
  }

  head(taskId: string): RevisionRecord {
    const t = this.task(taskId)
    const rev = t.headRevision === null ? undefined : this.project.repo.revision(t.headRevision)
    if (rev === undefined) throw new ChengyingError('not-found', `task ${taskId} has no revision`)
    return rev
  }

  sourceFor(shot: Shot, kind: 'raw' | 'raster'): { fileId: string; path: string; kind: 'raw' | 'raster' } {
    const id = kind === 'raw' ? shot.rawFile ?? shot.rasterFile : shot.rasterFile ?? shot.rawFile
    const f = id === null ? undefined : this.project.repo.file(id)
    if (f === undefined) throw new ChengyingError('not-found', `shot ${shot.id} has no ${kind} file`)
    return { fileId: f.id, path: this.project.guard.readable(f.path), kind: f.kind }
  }

  async createTasks(opts: { selectionId?: string; shotIds?: string[]; instructions: string; sceneInstructions?: Record<string, string>; maxRevisions?: number; maxTokens?: number; engine?: string; stageOptions?: Record<string, unknown>; priority?: number; maxAttempts?: number; force?: boolean; extraStages?: Array<{ engine: string; options?: Record<string, unknown> }> }): Promise<{ created: TaskRecord[]; existing: TaskRecord[] }> {
    let ids = opts.shotIds ?? []
    if (opts.selectionId !== undefined) {
      const sel = this.project.repo.selection(opts.selectionId)
      if (sel === undefined) throw new ChengyingError('not-found', `no selection ${opts.selectionId}`)
      ids = [...ids, ...sel.items.filter(i => i.included).map(i => i.shotId)]
    }
    ids = [...new Set(ids)]
    if (ids.length === 0) throw new ChengyingError('invalid-argument', 'no photos to edit (pass a selection or shot ids)')
    const created: TaskRecord[] = []
    const existing: TaskRecord[] = []
    // Count how many shots belong to each scene so multi-photo scenes get an anchor task scheduled first.
    const sceneMembers = new Map<string, string[]>()
    for (const shotId of ids) {
      const sc = this.project.repo.groupOf(shotId, 'scene')
      if (sc !== undefined) sceneMembers.set(sc, [...(sceneMembers.get(sc) ?? []), shotId])
    }
    const anchorShots = new Set<string>()
    for (const [, list] of sceneMembers) {
      if (list.length >= 2) {
        const best = [...list].sort((a, b) => this.project.rankOf(b) - this.project.rankOf(a))[0]
        if (best !== undefined) anchorShots.add(best)
      }
    }
    for (const shotId of ids) {
      const shot = this.project.repo.shot(shotId)
      if (shot === undefined) throw new ChengyingError('not-found', `no shot ${shotId}`)
      const prev = this.project.repo.tasks({ shotId }).find(t => ACTIVE.includes(t.status) || t.status === 'succeeded')
      if (prev !== undefined && opts.force !== true) { existing.push(prev); continue }
      const kind: 'raw' | 'raster' = shot.rawFile !== null ? 'raw' : 'raster'
      const engine = await this.engines.pick(kind, opts.engine)
      const probe = await this.engines.get(engine).probe()
      const src = this.sourceFor(shot, probe.inputs.raw ? kind : 'raster')
      const stages: EditStage[] = [{ id: newId('stage'), engine, steps: [], ...(opts.stageOptions ? { options: opts.stageOptions } : {}) }]
      for (const extra of opts.extraStages ?? []) stages.push({ id: newId('stage'), engine: extra.engine, steps: [], ...(extra.options ? { options: extra.options } : {}) })
      const sceneId = this.project.repo.groupOf(shotId, 'scene') ?? null
      const segmentId = this.project.repo.groupOf(shotId, 'segment') ?? null
      const sceneMap = opts.sceneInstructions ?? {}
      const sceneBrief = sceneMap[shotId] ?? (sceneId ? sceneMap[sceneId] : undefined) ?? (segmentId ? sceneMap[segmentId] : undefined)
      const isAnchor = anchorShots.has(shotId)
      const taskOptions: Record<string, unknown> = {
        ...(sceneId ? { sceneId } : {}),
        ...(segmentId ? { segmentId } : {}),
        ...(sceneBrief ? { sceneBrief } : {}),
        ...(isAnchor ? { sceneAnchor: true } : {}),
        ...(opts.maxRevisions !== undefined ? { maxRevisions: opts.maxRevisions } : {}),
        ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
      }
      const task = this.project.repo.createTask({
        kind: 'edit', shotId, selectionId: opts.selectionId ?? null, status: 'queued',
        priority: (opts.priority ?? 0) + (isAnchor ? 10 : 0), engine,
        instructions: opts.instructions, options: taskOptions, maxAttempts: opts.maxAttempts ?? 3,
      })
      const doc: EditDocument = { schema: 1, sourceFile: src.fileId, stages }
      this.project.repo.addRevision(task.id, null, doc, `created (${engine}, ${src.kind} source)`, 'system')
      this.project.repo.addEvent(task.id, 'info', 'task-created', `edit task for ${shotId} with ${engine}`, { engine, source: src.kind })
      created.push(this.task(task.id))
    }
    return { created, existing }
  }

  private stageIndex(doc: EditDocument, ref: string | number | undefined, opName?: string): number {
    if (ref === undefined) return -1
    if (typeof ref === 'number') {
      if (ref < 0 || ref >= doc.stages.length) throw new ChengyingError('invalid-argument', `stage index ${ref} out of range (0..${doc.stages.length - 1})`)
      return ref
    }
    const i = doc.stages.findIndex(s => s.id === ref || s.engine === ref)
    if (i < 0) throw new ChengyingError('invalid-argument', `no stage "${ref}"${opName ? ` for ${opName}` : ''}; stages: ${doc.stages.map((s, k) => `${k}:${s.engine}`).join(', ')}`)
    return i
  }

  private findStep(doc: EditDocument, stepId: string): { stage: EditStage; index: number } {
    for (const stage of doc.stages) {
      const index = stage.steps.findIndex(s => s.id === stepId)
      if (index >= 0) return { stage, index }
    }
    throw new ChengyingError('invalid-argument', `no step ${stepId}`)
  }

  /** Apply operations atomically: everything validates, or nothing changes. */
  async applyOps(taskId: string, ops: EditOp[], meta: { author: string; message?: string; signal?: AbortSignal; maxRevisions?: number }): Promise<{ revision: RevisionRecord; warnings: string[] }> {
    const task = this.task(taskId)
    if (task.status === 'cancelled') throw new ChengyingError('conflict', 'task is cancelled')
    const maxRev = meta.maxRevisions ?? (typeof task.options.maxRevisions === 'number' ? task.options.maxRevisions : undefined)
    if (maxRev !== undefined && maxRev > 0 && meta.author.startsWith('agent')) {
      const agentEdits = this.project.repo.revisions(taskId).filter(r => r.author.startsWith('agent') && !r.message.startsWith('checkout #')).length
      if (agentEdits >= maxRev) {
        throw new ChengyingError('conflict', `revision budget reached (${maxRev} edits on task ${taskId}); use edit_preview/edit_revert if needed and finish with edit_finish`)
      }
    }
    const head = this.head(taskId)
    const doc = structuredClone(head.doc)
    const warnings: string[] = []
    const summary: string[] = []
    for (const o of ops) {
      switch (o.op) {
        case 'add_step': {
          let si = this.stageIndex(doc, o.stage)
          if (si < 0) {
            // the stage whose engine knows this operation
            si = -1
            for (let k = 0; k < doc.stages.length; k++) {
              const cat = await this.engines.catalog((doc.stages[k] as EditStage).engine, false, meta.signal)
              if (cat.operations.some(x => x.id === o.step.op || x.id.toLowerCase() === o.step.op.toLowerCase())) { si = k; break }
            }
            if (si < 0) throw new ChengyingError('invalid-argument', `no stage engine provides "${o.step.op}"; stages: ${doc.stages.map(s => s.engine).join(', ')}`)
          }
          const stage = doc.stages[si] as EditStage
          const step: EditStep = { id: newId('st'), op: o.step.op, params: o.step.params ?? {}, enabled: o.step.enabled ?? true, ...(o.step.mask ? { mask: o.step.mask } : {}), ...(o.step.instance !== undefined ? { instance: o.step.instance } : {}), ...(o.step.label ? { label: o.step.label } : {}) }
          const cat = await this.engines.catalog(stage.engine, false, meta.signal)
          const v = this.engines.get(stage.engine).validateStep(step, cat)
          warnings.push(...v.warnings)
          step.op = v.step.op
          const pos = o.position === undefined ? stage.steps.length : Math.max(0, Math.min(stage.steps.length, o.position))
          stage.steps.splice(pos, 0, step)
          summary.push(`+${stage.engine}:${step.op}`)
          break
        }
        case 'update_step': {
          const { stage, index } = this.findStep(doc, o.step_id)
          const step = stage.steps[index] as EditStep
          if (o.params !== undefined) step.params = o.replace_params === true ? o.params : mergeParams(step.params, o.params)
          if (o.mask === null) delete step.mask
          else if (o.mask !== undefined) step.mask = o.mask
          if (o.enabled !== undefined) step.enabled = o.enabled
          if (o.label !== undefined) step.label = o.label
          const cat = await this.engines.catalog(stage.engine, false, meta.signal)
          warnings.push(...this.engines.get(stage.engine).validateStep(step, cat).warnings)
          summary.push(`~${step.op}`)
          break
        }
        case 'remove_step': {
          const { stage, index } = this.findStep(doc, o.step_id)
          summary.push(`-${(stage.steps[index] as EditStep).op}`)
          stage.steps.splice(index, 1)
          break
        }
        case 'move_step': {
          const { stage, index } = this.findStep(doc, o.step_id)
          const [s] = stage.steps.splice(index, 1)
          stage.steps.splice(Math.max(0, Math.min(stage.steps.length, o.position)), 0, s as EditStep)
          summary.push(`↕${(s as EditStep).op}`)
          break
        }
        case 'add_stage': {
          const engine = this.engines.get(o.engine)
          const probe = await engine.probe()
          if (!probe.available) throw new ChengyingError('engine-unavailable', `${o.engine}: ${probe.reason ?? 'unavailable'}`)
          const pos = o.position === undefined ? doc.stages.length : Math.max(1, Math.min(doc.stages.length, o.position))
          if (pos > 0 && !probe.inputs.raster) throw new ChengyingError('invalid-argument', `${o.engine} cannot take a rendered image as input; it can only be the first stage`)
          doc.stages.splice(pos, 0, { id: newId('stage'), engine: o.engine, steps: [], ...(o.options ? { options: o.options } : {}) })
          summary.push(`+stage ${o.engine}`)
          break
        }
        case 'remove_stage': {
          const i = this.stageIndex(doc, o.stage)
          if (doc.stages.length === 1) throw new ChengyingError('invalid-argument', 'cannot remove the only stage')
          summary.push(`-stage ${(doc.stages[i] as EditStage).engine}`)
          doc.stages.splice(i, 1)
          break
        }
        case 'set_stage_options': {
          const i = this.stageIndex(doc, o.stage)
          const stage = doc.stages[i] as EditStage
          stage.options = mergeParams(stage.options ?? {}, o.options)
          const e = this.engines.get(stage.engine)
          const cat = await this.engines.catalog(stage.engine, false, meta.signal)
          warnings.push(...(e.validateStageOptions?.(stage.options, cat).warnings ?? []))
          summary.push(`options ${stage.engine}`)
          break
        }
        case 'set_source': {
          const shot = this.project.repo.shot(task.shotId) as Shot
          const src = this.sourceFor(shot, o.source)
          doc.sourceFile = src.fileId
          summary.push(`source ${src.kind}`)
          break
        }
        case 'import_recipe': {
          const i = o.stage === undefined ? 0 : this.stageIndex(doc, o.stage)
          const stage = doc.stages[i] as EditStage
          const e = this.engines.get(stage.engine)
          if (e.importRecipe === undefined) throw new ChengyingError('unsupported', `${stage.engine} cannot import recipes`)
          const text = o.text ?? (o.path !== undefined ? readFileSync(this.project.guard.readable(o.path), 'utf8') : undefined)
          if (text === undefined) throw new ChengyingError('invalid-argument', 'import_recipe needs text or path')
          const cat = await this.engines.catalog(stage.engine, false, meta.signal)
          const imported = await e.importRecipe(text, cat, o.format)
          warnings.push(...imported.warnings)
          stage.steps = o.replace === true ? imported.steps : [...stage.steps, ...imported.steps]
          if (imported.options !== undefined) stage.options = { ...(stage.options ?? {}), ...imported.options }
          summary.push(`import ${imported.steps.length} steps`)
          break
        }
        case 'copy_from_task': {
          const srcTask = this.task(o.task_id)
          const srcRev = this.head(o.task_id)
          const GEOM_OPS = new Set(['crop', 'rotate', 'perspective', 'flip', 'ashift', 'Crop', 'Rotation', 'Perspective', 'Distortion', 'Framing'])
          let copiedCount = 0
          for (const srcStage of srcRev.doc.stages) {
            const eligible = srcStage.steps.filter(st => {
              if (!st.enabled) return false
              if (st.op.startsWith('gen_')) return false
              if (o.include_masks !== true && st.mask !== undefined) return false
              if (o.include_geometry !== true && GEOM_OPS.has(st.op)) return false
              return true
            })
            if (eligible.length === 0) continue
            let dstStage = doc.stages.find(s => s.engine === srcStage.engine)
            if (dstStage === undefined) {
              const probe = await this.engines.get(srcStage.engine).probe()
              if (!probe.available || (doc.stages.length > 0 && !probe.inputs.raster)) continue
              dstStage = { id: newId('stage'), engine: srcStage.engine, steps: [], ...(srcStage.options ? { options: structuredClone(srcStage.options) } : {}) }
              doc.stages.push(dstStage)
            }
            const cloned = eligible.map(st => ({ ...structuredClone(st), id: newId('st') }))
            if (o.replace === true) {
              dstStage.steps = cloned
            } else {
              for (const cl of cloned) {
                const existingIdx = cl.mask === undefined
                  ? dstStage.steps.findIndex(existing => existing.op === cl.op && existing.mask === undefined && (existing.instance ?? 0) === (cl.instance ?? 0))
                  : -1
                if (existingIdx >= 0) dstStage.steps[existingIdx] = { ...cl, id: dstStage.steps[existingIdx]!.id }
                else dstStage.steps.push(cl)
              }
            }
            copiedCount += cloned.length
          }
          const srcFeat = this.project.repo.features(srcTask.shotId)
          const dstFeat = this.project.repo.features(task.shotId)
          if (srcFeat?.exposure.median !== undefined && dstFeat?.exposure.median !== undefined && Math.abs(dstFeat.exposure.median - srcFeat.exposure.median) > 0.06) {
            const deltaEv = round(Math.log2(Math.max(0.04, srcFeat.exposure.median) / Math.max(0.04, dstFeat.exposure.median)) * 0.7, 2)
            warnings.push(`scene exposure hint: this frame's baseline median luminance (${round(dstFeat.exposure.median * 255, 0)}) differs from anchor ${srcTask.shotId} (${round(srcFeat.exposure.median * 255, 0)}); consider adjusting exposure by ${deltaEv >= 0 ? `+${deltaEv}` : deltaEv} EV relative to the copied anchor recipe`)
          }
          summary.push(`copy ${copiedCount} step(s) from ${o.task_id}`)
          break
        }
        case 'set_provenance': {
          const pv = doc.provenance ?? {}
          if (o.generative !== undefined) pv.generative = o.generative
          if (o.authorization !== undefined) pv.authorizationIds = [...new Set([...(pv.authorizationIds ?? []), o.authorization])]
          if (o.note !== undefined) pv.notes = [...(pv.notes ?? []), o.note]
          doc.provenance = pv
          summary.push('provenance')
          break
        }
        case 'reset': {
          const targets = o.stage === undefined ? doc.stages : [doc.stages[this.stageIndex(doc, o.stage)] as EditStage]
          for (const s of targets) s.steps = []
          summary.push('reset')
          break
        }
        default:
          throw new ChengyingError('invalid-argument', `unknown edit op ${JSON.stringify((o as { op?: string }).op)}`)
      }
    }
    const revision = this.project.repo.addRevision(taskId, head.id, doc, meta.message ?? summary.join(', '), meta.author)
    this.project.repo.addEvent(taskId, 'info', 'revision', `#${revision.seq} ${revision.message}`, { revisionId: revision.id, author: meta.author, warnings })
    return { revision, warnings }
  }

  /** Non-destructive undo / redo / branch: make an earlier revision the head (as a new revision). */
  checkout(taskId: string, revisionId: string, author: string): RevisionRecord {
    const target = this.project.repo.revision(revisionId)
    if (target === undefined || target.taskId !== taskId) throw new ChengyingError('not-found', `revision ${revisionId} does not belong to task ${taskId}`)
    const head = this.head(taskId)
    const rev = this.project.repo.addRevision(taskId, head.id, target.doc, `checkout #${target.seq}`, author)
    this.project.repo.addEvent(taskId, 'info', 'checkout', `head → #${target.seq} (as #${rev.seq})`, { from: head.id, to: target.id })
    return rev
  }

  undo(taskId: string, author: string): RevisionRecord {
    const head = this.head(taskId)
    const revs = this.project.repo.revisions(taskId)
    // The parent of the head, skipping checkouts that point back at it.
    const parent = head.parentId === null ? undefined : revs.find(r => r.id === head.parentId)
    if (parent === undefined) throw new ChengyingError('conflict', 'nothing to undo')
    return this.checkout(taskId, parent.id, author)
  }

  /** Render a revision through its stages. Previews are cached per revision and size. */
  async render(taskId: string, opts: { revisionId?: string; maxEdge?: number; format?: 'jpeg' | 'tiff' | 'png'; quality?: number; output?: string; signal?: AbortSignal; bitDepth?: 8 | 16; authorize?: (engine: string, step: EditStep) => Promise<string | undefined> } = {}): Promise<RenderOutcome> {
    const task = this.task(taskId)
    const rev = opts.revisionId !== undefined ? this.project.repo.revision(opts.revisionId) : this.head(taskId)
    if (rev === undefined || rev.taskId !== taskId) throw new ChengyingError('not-found', 'no such revision')
    const format = opts.format ?? 'jpeg'
    const edge = opts.maxEdge
    const dir = this.project.path('renders', taskId)
    mkdirSync(dir, { recursive: true })
    const isPreview = opts.output === undefined
    const finalPath = opts.output ?? join(dir, `${rev.id}-${edge ?? 'full'}.${format === 'tiff' ? 'tif' : format === 'png' ? 'png' : 'jpg'}`)
    this.project.guard.writable(finalPath)
    const shot = this.project.repo.shot(task.shotId) as Shot
    if (isPreview && existsSync(finalPath)) {
      const faceBox = this.project.repo.features(shot.id)?.subject?.faceBox
      const st = await imageStats(finalPath, { faceBox })
      return { path: finalPath, width: st.width, height: st.height, cached: true, durationMs: 0, warnings: [], stats: st, stages: [] }
    }
    try {
      const out = await this.renderDoc(shot, rev.doc, { ...opts, output: finalPath, taskId })
      if (isPreview) this.project.repo.setRevisionPreview(rev.id, out.path, out.stats as unknown as Record<string, unknown>)
      this.project.repo.addEvent(taskId, 'debug', 'render', `rendered #${rev.seq} ${out.width}×${out.height} in ${out.durationMs} ms`, { revisionId: rev.id, stages: out.stages, warnings: out.warnings })
      return out
    } catch (error) {
      this.project.repo.addEvent(taskId, 'error', 'render-failed', errorMessage(error), { revisionId: rev.id })
      throw error
    }
  }

  /** Render any edit document for a shot (used by tasks and by export of unedited photos). */
  async renderDoc(shot: Shot, doc: EditDocument, opts: { maxEdge?: number; format?: 'jpeg' | 'tiff' | 'png'; quality?: number; output: string; signal?: AbortSignal; bitDepth?: 8 | 16; taskId?: string; authorize?: (engine: string, step: EditStep) => Promise<string | undefined> }): Promise<RenderOutcome> {
    const format = opts.format ?? 'jpeg'
    const edge = opts.maxEdge
    const finalPath = this.project.guard.writable(opts.output)
    const file = this.project.repo.file(doc.sourceFile)
    if (file === undefined) throw new ChengyingError('not-found', 'source file record missing; rescan the workspace')
    let input = this.project.guard.readable(file.path)
    let inputKind: 'raw' | 'raster' = file.kind
    const warnings: string[] = []
    const stages: RenderOutcome['stages'] = []
    const scratch = this.project.path('scratch', 'render', newId('r'))
    mkdirSync(scratch, { recursive: true })
    const started = Date.now()
    try {
      for (let i = 0; i < doc.stages.length; i++) {
        opts.signal?.throwIfAborted()
        const stage = doc.stages[i] as EditStage
        const engine = this.engines.get(stage.engine)
        const probe = await engine.probe()
        if (!probe.available) throw new ChengyingError('engine-unavailable', `${stage.engine}: ${probe.reason ?? 'unavailable'}`)
        if (inputKind === 'raw' && !probe.inputs.raw) {
          // A raster-only first stage on a RAW shot: use the camera JPEG, or the shot's preview.
          const alt = shot.rasterFile !== null ? this.project.repo.file(shot.rasterFile) : undefined
          input = alt !== undefined ? this.project.guard.readable(alt.path) : (shot.previewPath ?? input)
          inputKind = 'raster'
          warnings.push(`${stage.engine} cannot read RAW; developed from ${alt !== undefined ? 'the camera JPEG' : 'the embedded preview'}`)
        }
        const authorize = opts.authorize ?? this.authorize
        if (authorize !== undefined) {
          for (const s of stage.steps) {
            if (!s.enabled) continue
            const denial = await authorize(stage.engine, s)
            if (denial !== undefined) throw new ChengyingError('authorization-required', denial, { step: s.id, op: s.op })
          }
        }
        const last = i === doc.stages.length - 1
        const out = last ? finalPath.replace(/\.(jpg|jpeg|tif|tiff|png)$/i, '') : join(scratch, `stage${i}`)
        const cat = await this.engines.catalog(stage.engine, false, opts.signal)
        const r = await engine.render({
          input, inputKind, stage, output: out, format: last ? format : 'tiff', bitDepth: last ? opts.bitDepth : 16,
          maxEdge: i === 0 ? edge : undefined, quality: opts.quality, scratchDir: scratch, signal: opts.signal,
          orientation: file.meta.orientation ?? null, readable: (p: string) => this.project.guard.readable(p),
          previewEdge: edge, fullEdge: Math.max(shot.width ?? file.meta.width ?? 0, shot.height ?? file.meta.height ?? 0) || undefined,
        }, cat)
        warnings.push(...r.warnings.map(w => `${stage.engine}: ${w}`))
        stages.push({ engine: stage.engine, durationMs: r.durationMs, recipe: r.recipe?.path })
        input = r.output
        inputKind = 'raster'
      }
      const faceBox = this.project.repo.features(shot.id)?.subject?.faceBox
      const stats = await imageStats(input, { faceBox })
      return { path: input, width: stats.width, height: stats.height, cached: false, durationMs: Date.now() - started, warnings, stats, stages }
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  }

  /**
   * Develop the untouched source (no steps) so an original/final comparison is
   * possible for RAW shots whose preview pipeline failed. Cached per task+edge:
   * the result only changes when the source file or engine changes.
   */
  async renderOriginal(taskId: string, opts: { maxEdge?: number; signal?: AbortSignal } = {}): Promise<string> {
    const task = this.task(taskId)
    const shot = this.project.repo.shot(task.shotId)
    if (shot === undefined) throw new ChengyingError('not-found', `no such shot: ${task.shotId}`)
    const edge = opts.maxEdge ?? 900
    const dir = this.project.path('renders', taskId)
    mkdirSync(dir, { recursive: true })
    const head = this.head(taskId)
    const first = head.doc.stages[0]
    const primary = this.project.repo.file(shot.primaryFile)
    const kind = primary?.kind === 'raw' ? 'raw' : 'raster'
    const engine = first?.engine ?? task.engine ?? (await this.engines.pick(kind))
    const optTag = first?.options && Object.keys(first.options).length > 0 ? `-${fingerprintOf([JSON.stringify(first.options)]).slice(0, 6)}` : ''
    const out = this.project.guard.writable(join(dir, `original-${engine}-${edge}${optTag}.jpg`))
    if (existsSync(out)) return out
    const doc: EditDocument = {
      ...head.doc,
      stages: [{ id: `stage_original_${engine}`, engine, steps: [], ...(first?.options !== undefined ? { options: first.options } : {}) }],
    }
    const rendered = await this.renderDoc(shot, doc, { maxEdge: edge, format: 'jpeg', quality: 90, output: out, signal: opts.signal, taskId })
    return rendered.path
  }

  /** Labeled side-by-side comparison image (original preview vs. revision, or two revisions). */
  async compare(taskId: string, opts: { revisionId?: string; againstRevisionId?: string; maxEdge?: number; signal?: AbortSignal } = {}): Promise<{ path: string; left: string; right: string }> {
    const task = this.task(taskId)
    const edge = opts.maxEdge ?? 900
    const right = await this.render(taskId, { revisionId: opts.revisionId, maxEdge: edge, signal: opts.signal })
    let leftPath: string
    let leftLabel = 'original'
    if (opts.againstRevisionId !== undefined) {
      leftPath = (await this.render(taskId, { revisionId: opts.againstRevisionId, maxEdge: edge, signal: opts.signal })).path
      leftLabel = `rev ${this.project.repo.revision(opts.againstRevisionId)?.seq ?? ''}`
    } else {
      const shot = this.project.repo.shot(task.shotId) as Shot
      const head = this.head(taskId)
      const srcFile = this.project.repo.file(head.doc.sourceFile)
      const firstEngine = head.doc.stages[0]?.engine
      if (shot.previewPath === null || (srcFile?.kind === 'raw' && firstEngine !== undefined && firstEngine !== 'builtin' && firstEngine !== 'ai')) {
        // RAW edited by a RAW engine (or RAW without a libvips preview): develop
        // the untouched source through the task's engine so the comparison shows
        // the true engine baseline vs. edited.
        try {
          leftPath = await this.renderOriginal(taskId, { maxEdge: edge, signal: opts.signal })
          leftLabel = 'original (developed)'
        } catch {
          if (shot.previewPath === null) throw new ChengyingError('not-found', `no preview for ${shot.id}`)
          leftPath = shot.previewPath
        }
      } else {
        leftPath = shot.previewPath
      }
    }
    const rightSeq = opts.revisionId !== undefined ? this.project.repo.revision(opts.revisionId)?.seq : this.head(taskId).seq
    const h = 800
    const a = await sharp(leftPath).resize({ height: h }).jpeg().toBuffer({ resolveWithObject: true })
    const b = await sharp(right.path).resize({ height: h }).jpeg().toBuffer({ resolveWithObject: true })
    const label = (t: string): Buffer => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="220" height="30"><rect width="100%" height="100%" fill="#000" fill-opacity="0.55"/><text x="8" y="21" font-family="Helvetica,Arial" font-size="17" fill="#fff">${t}</text></svg>`)
    const width = a.info.width + b.info.width + 12
    const out = this.project.guard.writable(this.project.path('sheets', `${newId('cmp')}.jpg`))
    await sharp({ create: { width, height: h, channels: 3, background: '#111' } })
      .composite([{ input: a.data, left: 0, top: 0 }, { input: b.data, left: a.info.width + 12, top: 0 }, { input: label(leftLabel), left: 6, top: 6 }, { input: label(`rev ${rightSeq}`), left: a.info.width + 18, top: 6 }])
      .jpeg({ quality: 92 }).toFile(out)
    return { path: out, left: leftPath, right: right.path }
  }

  setStatus(taskId: string, status: TaskStatus, detail: { error?: string | null; message?: string } = {}): TaskRecord {
    const t = this.task(taskId)
    const patch: Parameters<typeof this.project.repo.updateTask>[1] = { status }
    if (detail.error !== undefined) patch.error = detail.error
    if (status === 'running' && t.startedAt === null) patch.startedAt = nowIso()
    if (['succeeded', 'failed', 'cancelled'].includes(status)) patch.finishedAt = nowIso()
    this.project.repo.updateTask(taskId, patch)
    this.project.repo.addEvent(taskId, status === 'failed' ? 'error' : 'info', 'status', `${t.status} → ${status}${detail.message ? `: ${detail.message}` : ''}`, detail)
    return this.task(taskId)
  }

  /** Recover tasks left running by a crash/restart: their revisions are intact, so they resume from the head. */
  recover(): number {
    let n = 0
    for (const t of this.project.repo.tasks({ status: ['running'] })) {
      this.setStatus(t.id, 'queued', { message: 'interrupted (restart); resumes from the latest revision' })
      n++
    }
    return n
  }

  /** Style fingerprint of a photo's current look: its task head when edited, else the original preview. */
  async styleReference(ref: { shotId?: string; taskId?: string }, signal?: AbortSignal): Promise<{ fingerprint: StyleFingerprint; source: string; shotId: string }> {
    let taskId = ref.taskId
    let shotId = ref.shotId
    if (taskId === undefined && shotId !== undefined) taskId = this.project.repo.tasks().find(t => t.shotId === shotId && t.status !== 'cancelled')?.id
    let path: string
    if (taskId !== undefined) {
      const t = this.task(taskId)
      shotId = t.shotId
      path = (await this.render(taskId, { maxEdge: 1024, signal })).path
    } else {
      const shot = shotId === undefined ? undefined : this.project.repo.shot(shotId)
      if (shot?.previewPath == null) throw new ChengyingError('not-found', `no preview for ${shotId ?? '(no shot given)'}`)
      path = shot.previewPath
    }
    const fp = styleFingerprint(await loadImage(path, 1024))
    const r = (v: number): number => Math.round(v * 1000) / 1000
    return { fingerprint: { mean: fp.mean.map(r) as StyleFingerprint['mean'], std: fp.std.map(r) as StyleFingerprint['std'], quantiles: fp.quantiles.map(r) }, source: taskId !== undefined ? `task ${taskId} head` : 'original preview', shotId: shotId as string }
  }

  /**
   * Run a generative provider ONCE on the current head render and record the
   * result as a gen_layer step of the AI stage (added when missing). Callers
   * must have checked the user's authorization; its id is stored in the step
   * and in the document provenance.
   */
  async generate(taskId: string, opts: { provider: GenerativeProvider; kind: string; prompt: string; mask?: MaskSpec; authorizationId: string; author: string; maxEdge?: number; signal?: AbortSignal; message?: string }): Promise<{ revision: RevisionRecord; asset: string; warnings: string[]; provider: Record<string, unknown> }> {
    const base = await this.render(taskId, { maxEdge: opts.maxEdge ?? 2048, format: 'png', signal: opts.signal })
    const dir = this.project.guard.writable(this.project.path('assets', taskId))
    mkdirSync(dir, { recursive: true })
    const scratch = this.project.path('scratch', 'gen', newId('g'))
    mkdirSync(scratch, { recursive: true })
    try {
      const img = await loadImage(base.path)
      let maskPath: string | undefined
      let rawMask: Float32Array | undefined
      if (opts.mask !== undefined) {
        maskPath = join(scratch, 'mask.png')
        rawMask = rasterizeMask({ ...opts.mask, opacity: 1 }, img)
        await writeMaskPng(rawMask, img.width, img.height, maskPath)
      }
      // Localized crop-and-stitch: when a mask covers a small region (<45% of the image)
      // for remove/fill/replace, crop around the mask with generous context so the provider
      // generates high-density pixels for that region instead of downscaling the whole image.
      let cropBox: { left: number; top: number; width: number; height: number } | undefined
      if (rawMask !== undefined && ['remove', 'fill', 'replace'].includes(opts.kind)) {
        let minX = img.width; let minY = img.height; let maxX = -1; let maxY = -1
        for (let y = 0; y < img.height; y++) {
          for (let x = 0; x < img.width; x++) {
            if ((rawMask[y * img.width + x] as number) > 0.02) {
              if (x < minX) minX = x; if (x > maxX) maxX = x
              if (y < minY) minY = y; if (y > maxY) maxY = y
            }
          }
        }
        if (maxX >= minX && maxY >= minY) {
          const pad = Math.max(32, Math.round(Math.max(maxX - minX + 1, maxY - minY + 1) * 0.5))
          const left = Math.max(0, minX - pad)
          const top = Math.max(0, minY - pad)
          const width = Math.min(img.width - left, maxX - left + 1 + pad)
          const height = Math.min(img.height - top, maxY - top + 1 + pad)
          if (width >= 64 && height >= 64 && width * height < img.width * img.height * 0.45) {
            cropBox = { left, top, width, height }
          }
        }
      }
      const genId = newId('gen')
      const asset = join(dir, `${genId}.png`)
      let patchAsset: string | undefined
      let normCropBox: [number, number, number, number] | undefined
      let out: { path: string; detail: Record<string, unknown> }
      if (cropBox !== undefined && maskPath !== undefined && rawMask !== undefined) {
        const cropImgPath = join(scratch, 'crop-in.png')
        const cropMaskPath = join(scratch, 'crop-mask.png')
        await sharp(base.path).extract(cropBox).png().toFile(cropImgPath)
        await sharp(maskPath).extract(cropBox).png().toFile(cropMaskPath)
        out = await generateWith(opts.provider, { image: cropImgPath, mask: cropMaskPath, prompt: opts.prompt, kind: opts.kind, width: cropBox.width, height: cropBox.height, outDir: scratch, signal: opts.signal })
        const outMeta = await sharp(out.path, { failOn: 'none' }).metadata().catch(() => undefined)
        const patchW = Math.max(cropBox.width, Math.min(2048, outMeta?.width ?? cropBox.width))
        const patchH = Math.max(cropBox.height, Math.min(2048, Math.round(patchW * (cropBox.height / cropBox.width))))
        const hiPatch = await loadAsset(out.path, patchW, patchH)
        const patch = patchW === cropBox.width && patchH === cropBox.height ? hiPatch : await loadAsset(out.path, cropBox.width, cropBox.height)
        // Measure unmasked context pixels (rawMask <= 0.05) to compensate subtle VAE/provider exposure & colour drift
        let ctxSumSrc = [0, 0, 0]; let ctxSumDst = [0, 0, 0]; let ctxAbsDiff = 0; let ctxN = 0
        for (let y = 0; y < cropBox.height; y++) {
          for (let x = 0; x < cropBox.width; x++) {
            const mVal = rawMask[(cropBox.top + y) * img.width + (cropBox.left + x)] as number
            if (mVal > 0.05) continue
            const dst = ((cropBox.top + y) * img.width + (cropBox.left + x)) * 3
            const src = (y * cropBox.width + x) * 3
            for (let c = 0; c < 3; c++) {
              const dv = img.data[dst + c] as number
              const sv = patch.data[src + c] as number
              ctxSumDst[c] = (ctxSumDst[c] as number) + dv
              ctxSumSrc[c] = (ctxSumSrc[c] as number) + sv
              ctxAbsDiff += Math.abs(dv - sv)
            }
            ctxN++
          }
        }
        // Only apply drift compensation when the unmasked context clearly represents the same image with a slight shift (< 0.14 linear diff)
        if (ctxN >= 32) {
          const meanDiff = ctxAbsDiff / (ctxN * 3)
          if (meanDiff > 0.001 && meanDiff < 0.14) {
            const offsets = [0, 1, 2].map(c => Math.max(-0.06, Math.min(0.06, ((ctxSumDst[c] as number) - (ctxSumSrc[c] as number)) / ctxN)))
            for (const buf of patch === hiPatch ? [patch] : [patch, hiPatch]) {
              for (let i = 0; i < buf.data.length; i += 3) {
                buf.data[i] = Math.max(0, Math.min(1, (buf.data[i] as number) + (offsets[0] as number)))
                buf.data[i + 1] = Math.max(0, Math.min(1, (buf.data[i + 1] as number) + (offsets[1] as number)))
                buf.data[i + 2] = Math.max(0, Math.min(1, (buf.data[i + 2] as number) + (offsets[2] as number)))
              }
            }
          }
        }
        patchAsset = join(dir, `${genId}-patch.png`)
        await saveImage(hiPatch, patchAsset, 'png', 92, 16)
        normCropBox = [
          round(cropBox.left / img.width, 6),
          round(cropBox.top / img.height, 6),
          round(cropBox.width / img.width, 6),
          round(cropBox.height / img.height, 6),
        ]
        const stitched: typeof img = { width: img.width, height: img.height, data: new Float32Array(img.data) }
        for (let y = 0; y < cropBox.height; y++) {
          for (let x = 0; x < cropBox.width; x++) {
            const dst = ((cropBox.top + y) * img.width + (cropBox.left + x)) * 3
            const src = (y * cropBox.width + x) * 3
            stitched.data[dst] = patch.data[src] as number
            stitched.data[dst + 1] = patch.data[src + 1] as number
            stitched.data[dst + 2] = patch.data[src + 2] as number
          }
        }
        await saveImage(stitched, asset, 'png', 92, 16)
      } else {
        out = await generateWith(opts.provider, { image: base.path, mask: maskPath, prompt: opts.prompt, kind: opts.kind, width: img.width, height: img.height, outDir: scratch, signal: opts.signal })
        // Normalise to the render size so the layer registers with the photo.
        await saveImage(await loadAsset(out.path, img.width, img.height), asset, 'png', 92, 16)
      }
      const head = this.head(taskId)
      const ops: EditOp[] = []
      if (!head.doc.stages.some(st => st.engine === 'ai')) ops.push({ op: 'add_stage', engine: 'ai' })
      ops.push({
        op: 'add_step',
        stage: 'ai',
        step: {
          op: 'gen_layer',
          params: {
            asset,
            ...(patchAsset && normCropBox ? { patch_asset: patchAsset, crop_box: normCropBox } : {}),
            kind: opts.kind,
            prompt: opts.prompt,
            provider: opts.provider.id,
            authorization: opts.authorizationId,
          },
          ...(opts.mask !== undefined ? { mask: opts.mask } : {}),
          label: `${opts.kind}: ${opts.prompt.slice(0, 40)}`,
        },
      })
      ops.push({ op: 'set_provenance', generative: true, authorization: opts.authorizationId, note: `${opts.kind} via ${opts.provider.id} (${opts.provider.type}): ${opts.prompt.slice(0, 120)}` })
      const { revision, warnings } = await this.applyOps(taskId, ops, { author: opts.author, message: opts.message ?? `generative ${opts.kind} via ${opts.provider.id}`, signal: opts.signal })
      this.project.repo.addEvent(taskId, 'info', 'generative', `generated ${opts.kind} layer with ${opts.provider.id}`, { asset, authorization: opts.authorizationId, prompt: opts.prompt, provider: out.detail })
      return { revision, asset, warnings, provider: out.detail }
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  }

  summary(taskId: string): Record<string, unknown> {
    const t = this.task(taskId)
    const head = this.head(taskId)
    return {
      task: { id: t.id, shot: t.shotId, status: t.status, engine: t.engine, instructions: t.instructions, attempts: t.attempts, error: t.error, usage: t.usage },
      head: { id: head.id, seq: head.seq, message: head.message, author: head.author },
      document: head.doc,
      revisions: this.project.repo.revisions(taskId).map(r => ({ id: r.id, seq: r.seq, parent: r.parentId, message: r.message, author: r.author, at: r.createdAt })),
    }
  }
}
