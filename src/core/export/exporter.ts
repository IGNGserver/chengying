/**
 * Unified export: render each photo at full resolution from its latest
 * revision (or the engine default for unedited photos), copy every source
 * metadata tag (capture time + offset + sub-seconds, GPS, camera, lens,
 * exposure, copyright…), reset orientation, stamp provenance (including the
 * IPTC digital-source type for generative edits), then re-read the export and
 * verify the provenance tags against the source. A recoverable recipe (the
 * full edit document + each engine's native sidecar) is written beside the
 * exports in _recipes/.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import type { Project } from '../project.ts'
import type { EditService } from '../edit/service.ts'
import type { EditDocument, Shot } from '../types.ts'
import type { VerifyReport } from '../meta/exif.ts'
import { ChengyingError, errorMessage } from '../util/errors.ts'
import { newId, nowIso } from '../util/misc.ts'

declare const __CHENGYING_VERSION__: string
const VERSION = typeof __CHENGYING_VERSION__ === 'string' ? __CHENGYING_VERSION__ : 'dev'

export interface ExportOptions {
  shotIds?: string[]
  selectionId?: string
  taskIds?: string[]
  format?: 'jpeg' | 'tiff' | 'png'
  quality?: number
  maxEdge?: number
  bitDepth?: 8 | 16
  subdir?: string
  /** File naming: original base name (default) or capture time. */
  naming?: 'original' | 'datetime'
  overwrite?: boolean
  signal?: AbortSignal
  onProgress?: (done: number, total: number, current?: string) => void
  authorize?: (engine: string, step: import('../types.ts').EditStep) => Promise<string | undefined>
}

export interface ExportItem {
  shotId: string
  taskId: string | null
  revisionId: string | null
  path?: string
  recipe?: string
  verified: boolean
  verify?: VerifyReport
  error?: string
  generative: boolean
}

export async function exportPhotos(project: Project, edit: EditService, opts: ExportOptions): Promise<{ exported: number; failed: number; verifiedAll: boolean; dir: string; items: ExportItem[] }> {
  const format = opts.format ?? 'jpeg'
  const ext = format === 'tiff' ? 'tif' : format === 'png' ? 'png' : 'jpg'
  const shotIds = new Set<string>(opts.shotIds ?? [])
  if (opts.selectionId !== undefined) {
    const sel = project.repo.selection(opts.selectionId)
    if (sel === undefined) throw new ChengyingError('not-found', `no selection ${opts.selectionId}`)
    for (const i of sel.items) if (i.included) shotIds.add(i.shotId)
  }
  const taskByShot = new Map<string, string>()
  for (const tid of opts.taskIds ?? []) {
    const t = project.repo.task(tid)
    if (t === undefined) throw new ChengyingError('not-found', `no task ${tid}`)
    shotIds.add(t.shotId)
    taskByShot.set(t.shotId, tid)
  }
  if (shotIds.size === 0) throw new ChengyingError('invalid-argument', 'nothing to export (pass shots, a selection or tasks)')
  const dir = project.guard.writable(opts.subdir !== undefined ? join(project.exportDir, opts.subdir.replace(/\.\.+/g, '_')) : project.exportDir)
  const recipeDir = join(dir, '_recipes')
  mkdirSync(recipeDir, { recursive: true })
  const items: ExportItem[] = []
  let done = 0
  const total = shotIds.size
  for (const shotId of shotIds) {
    opts.signal?.throwIfAborted()
    const shot = project.repo.shot(shotId)
    if (shot === undefined) { items.push({ shotId, taskId: null, revisionId: null, verified: false, error: 'unknown shot', generative: false }); continue }
    const task = taskByShot.get(shotId) !== undefined ? project.repo.task(taskByShot.get(shotId) as string) : project.repo.tasks({ shotId }).filter(t => t.status !== 'cancelled' && t.headRevision !== null).sort((a, b) => (b.updatedAt > a.updatedAt ? 1 : -1))[0]
    let doc: EditDocument
    let revisionId: string | null = null
    if (task !== undefined && task.headRevision !== null) {
      const head = project.repo.revision(task.headRevision)
      if (head === undefined) throw new ChengyingError('internal', `task ${task.id} head revision missing`)
      doc = head.doc
      revisionId = head.id
    } else {
      const kind: 'raw' | 'raster' = shot.rawFile !== null ? 'raw' : 'raster'
      const engine = await edit.engines.pick(kind)
      const src = edit.sourceFor(shot, (await edit.engines.get(engine).probe()).inputs.raw ? kind : 'raster')
      doc = { schema: 1, sourceFile: src.fileId, stages: [{ id: 'default', engine, steps: [] }] }
    }
    const generative = doc.provenance?.generative === true || doc.stages.some(s => s.steps.some(st => st.enabled && /^gen_|generative|outpaint|inpaint_generative/.test(st.op)))
    const source = project.repo.file(doc.sourceFile)
    const base = (opts.naming === 'datetime' && shot.captureTime !== null ? shot.captureTime.replace(/[-:]/g, '').replace('T', '_').slice(0, 15) : basename(source?.path ?? shot.id, extname(source?.path ?? '')))
    let target = join(dir, `${base}.${ext}`)
    // Replace only our own earlier export of the same name (unless overwrite=false); never another file.
    const ownPrevious = project.repo.isExportPath(target) && opts.overwrite !== false
    if (existsSync(target) && !ownPrevious) {
      let k = 1
      while (existsSync(join(dir, `${base}_${k}.${ext}`))) k++
      target = join(dir, `${base}_${k}.${ext}`)
    }
    try {
      project.guard.writable(target)
      const out = await edit.renderDoc(shot, doc, { output: target, format, quality: opts.quality ?? 95, maxEdge: opts.maxEdge, bitDepth: opts.bitDepth, signal: opts.signal, authorize: opts.authorize })
      // metadata: copy from every original of the shot (RAW first, then camera JPEG fills gaps)
      const sources = [shot.rawFile, shot.rasterFile].filter((x): x is string => x !== null).map(id => project.repo.file(id)).filter(f => f !== undefined)
      const primary = sources.find(f => f?.id === doc.sourceFile) ?? sources[0]
      if (primary === undefined) throw new ChengyingError('not-found', 'no source file for metadata')
      const recipeName = `${basename(target)}.chengying.json`
      const history = doc.stages.map(s => `${s.engine}: ${s.steps.filter(x => x.enabled).map(x => x.op).join(', ') || 'default'}`).join(' | ')
      await project.metadata.copyForExport(project.guard.readable(primary.path), out.path, { software: `Chengying ${VERSION}`, recipe: `_recipes/${recipeName}`, generative, history }, opts.signal)
      const verify = await project.metadata.verify(project.guard.readable(primary.path), out.path)
      // native recipes for recoverability
      const natives: Record<string, string> = {}
      for (const [i, stage] of doc.stages.entries()) {
        try {
          const e = edit.engines.get(stage.engine)
          const r = await e.recipe(stage, await edit.engines.catalog(stage.engine), { kind: i === 0 ? (source?.kind ?? 'raster') : 'raster' })
          const nativePath = join(recipeDir, `${basename(target)}.stage${i}.${stage.engine}.${r.extension}`)
          writeFileSync(project.guard.writable(nativePath), r.text)
          natives[`stage${i}`] = basename(nativePath)
        } catch (error) {
          natives[`stage${i}`] = `unavailable: ${errorMessage(error)}`
        }
      }
      const recipePath = project.guard.writable(join(recipeDir, recipeName))
      writeFileSync(recipePath, JSON.stringify({
        format: 'chengying-recipe/1', exportedAt: nowIso(), chengying: VERSION, shot: { id: shot.id, captureTime: shot.captureTime, files: sources.map(f => f?.relPath) },
        source: source?.relPath, taskId: task?.id ?? null, revisionId, document: doc, nativeRecipes: natives, verification: verify,
        engines: Object.fromEntries(await Promise.all(doc.stages.map(async s => [s.engine, (await edit.engines.get(s.engine).probe()).version ?? '?']))),
      }, null, 2))
      project.repo.addExport({ taskId: task?.id ?? null, shotId, revisionId, path: out.path, format, verified: verify.ok, verify, recipePath })
      if (task !== undefined) project.repo.addEvent(task.id, verify.ok ? 'info' : 'warn', 'export', `exported ${basename(out.path)} (metadata ${verify.ok ? 'verified' : `MISMATCH: ${[...verify.missing, ...verify.mismatched.map(m => m.tag)].join(', ')}`})`, { path: out.path })
      items.push({ shotId, taskId: task?.id ?? null, revisionId, path: out.path, recipe: recipePath, verified: verify.ok, verify, generative })
    } catch (error) {
      items.push({ shotId, taskId: task?.id ?? null, revisionId, verified: false, error: errorMessage(error), generative })
    }
    opts.onProgress?.(++done, total, shotId)
  }
  const exported = items.filter(i => i.path !== undefined).length
  project.repo.addEvent(null, 'info', 'export', `exported ${exported}/${items.length} to ${dir}`, { id: newId('exp'), dir })
  return { exported, failed: items.length - exported, verifiedAll: items.every(i => i.verified), dir, items }
}

export function shotLabel(s: Shot): string {
  return s.captureTime?.replace('T', ' ') ?? s.id
}
