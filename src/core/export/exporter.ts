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
import { copyFileSync, existsSync, mkdirSync, utimesSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import type { Project } from '../project.ts'
import type { EditService } from '../edit/service.ts'
import type { EditDocument, Shot } from '../types.ts'
import type { VerifyReport } from '../meta/exif.ts'
import { ChengyingError, errorMessage } from '../util/errors.ts'
import { newId, nowIso } from '../util/misc.ts'
import { run } from '../util/proc.ts'

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
  /** Per-run delivery directory; defaults to the project export directory. */
  dir?: string
  /** File naming: original base name (default) or capture time. */
  naming?: 'original' | 'datetime'
  /** Also copy the paired RAW original alongside the rendered export. */
  includeRaw?: boolean
  /** Generate a C2PA content-credentials manifest (and sign with c2patool when available). */
  c2pa?: boolean
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
  rawCopyPath?: string
  c2paManifest?: string
  c2paSigned?: boolean
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
  const baseDir = project.addWritableRoot(opts.dir ?? project.exportDir)
  const dir = project.guard.writable(opts.subdir !== undefined ? join(baseDir, opts.subdir.replace(/\.\.+/g, '_')) : baseDir)
  mkdirSync(dir, { recursive: true })
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
      // When a task finished with status="unchanged" (0 active steps) on a RAW+JPEG pair
      // whose culling preview came from the paired camera JPEG, preserve the camera JPEG
      // source instead of exporting a flat ungraded RAW baseline.
      const hasActiveSteps = doc.stages.some(s => s.steps.some(st => st.enabled))
      if (task.options.unchanged === true && !hasActiveSteps && shot.rasterFile !== null && doc.sourceFile === shot.rawFile) {
        doc = { schema: 1, sourceFile: shot.rasterFile, stages: [{ id: 'unchanged_raster', engine: 'builtin', steps: [] }] }
      }
    } else {
      const kind: 'raw' | 'raster' = shot.rawFile !== null ? 'raw' : 'raster'
      const engine = await edit.engines.pick(kind)
      const src = edit.sourceFor(shot, (await edit.engines.get(engine).probe()).inputs.raw ? kind : 'raster')
      doc = { schema: 1, sourceFile: src.fileId, stages: [{ id: 'default', engine, steps: [] }] }
    }
    // Generated pixels in the rendered result (a removed/disabled layer no longer counts).
    const generative = doc.stages.some(s => s.steps.some(st => st.enabled && /^gen_/.test(st.op)))
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
      // metadata: copy from every original of the shot (primary first, paired RAW/JPEG fills gaps)
      const sources = [shot.rawFile, shot.rasterFile].filter((x): x is string => x !== null).map(id => project.repo.file(id)).filter((f): f is NonNullable<typeof f> => f !== undefined)
      const primary = sources.find(f => f.id === doc.sourceFile) ?? sources[0]
      if (primary === undefined) throw new ChengyingError('not-found', 'no source file for metadata')
      const orderedSourcePaths = [primary, ...sources.filter(f => f.id !== primary.id)].map(f => project.guard.readable(f.path))
      const recipeName = `${basename(target)}.chengying.json`
      const history = doc.stages.map(s => `${s.engine}: ${s.steps.filter(x => x.enabled).map(x => x.op).join(', ') || 'default'}`).join(' | ')
      await project.metadata.copyForExport(orderedSourcePaths, out.path, { software: `Chengying ${VERSION}`, recipe: `_recipes/${recipeName}`, generative, history }, opts.signal)
      const verify = await project.metadata.verify(orderedSourcePaths, out.path)

      // Optional companion RAW copy in the delivery folder.
      let rawCopyPath: string | undefined
      if (opts.includeRaw === true && shot.rawFile !== null) {
        const rawRec = project.repo.file(shot.rawFile)
        if (rawRec !== undefined) {
          const rawSrc = project.guard.readable(rawRec.path)
          const rawDest = project.guard.writable(join(dir, `${base}.${rawRec.ext}`))
          copyFileSync(rawSrc, rawDest)
          const st = statSync(rawSrc)
          utimesSync(rawDest, st.atime, st.mtime)
          rawCopyPath = rawDest
        }
      }
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
      // C2PA content-credentials manifest (written for generative edits or when opts.c2pa is requested; signed via c2patool when available).
      let c2paManifestPath: string | undefined
      let c2paSigned: boolean | undefined
      if (opts.c2pa === true || generative) {
        const c2paObj = {
          alg: 'ps256',
          claim_generator: `Chengying/${VERSION}`,
          title: basename(out.path),
          assertions: [
            {
              label: 'c2pa.actions',
              data: {
                actions: [
                  {
                    action: generative ? 'c2pa.edited' : 'c2pa.color_adjustments',
                    softwareAgent: `Chengying ${VERSION}`,
                    digitalSourceType: generative
                      ? 'http://cv.iptc.org/newscodes/digitalsourcetype/compositeWithTrainedAlgorithmicMedia'
                      : 'http://cv.iptc.org/newscodes/digitalsourcetype/digitalCapture',
                    parameters: { history },
                  },
                ],
              },
            },
          ],
        }
        c2paManifestPath = project.guard.writable(join(recipeDir, `${basename(target)}.c2pa.json`))
        writeFileSync(c2paManifestPath, JSON.stringify(c2paObj, null, 2))
        if (opts.c2pa === true) {
          c2paSigned = false
          const c2paBin = process.env.CHENGYING_C2PATOOL ?? 'c2patool'
          try {
            const signedTmp = project.guard.writable(`${out.path}.c2pa.${ext}`)
            const r = await run(c2paBin, [out.path, '-m', c2paManifestPath, '-o', signedTmp, '-f'], { timeoutMs: 60_000, signal: opts.signal })
            if (r.code === 0 && existsSync(signedTmp)) {
              copyFileSync(signedTmp, out.path)
              c2paSigned = true
            }
          } catch {
            c2paSigned = false
          }
        }
      }

      const recipePath = project.guard.writable(join(recipeDir, recipeName))
      writeFileSync(recipePath, JSON.stringify({
        format: 'chengying-recipe/1', exportedAt: nowIso(), chengying: VERSION, shot: { id: shot.id, captureTime: shot.captureTime, files: sources.map(f => f?.relPath) },
        source: source?.relPath, rawCopy: rawCopyPath ? basename(rawCopyPath) : undefined, c2paManifest: c2paManifestPath ? basename(c2paManifestPath) : undefined, c2paSigned,
        taskId: task?.id ?? null, revisionId, document: doc, nativeRecipes: natives, verification: verify,
        engines: Object.fromEntries(await Promise.all(doc.stages.map(async s => [s.engine, (await edit.engines.get(s.engine).probe()).version ?? '?']))),
      }, null, 2))
      project.repo.addExport({ taskId: task?.id ?? null, shotId, revisionId, path: out.path, format, verified: verify.ok, verify, recipePath })
      if (task !== undefined) project.repo.addEvent(task.id, verify.ok ? 'info' : 'warn', 'export', `exported ${basename(out.path)} (metadata ${verify.ok ? 'verified' : `MISMATCH: ${[...verify.missing, ...verify.mismatched.map(m => m.tag)].join(', ')}`})`, { path: out.path })
      items.push({ shotId, taskId: task?.id ?? null, revisionId, path: out.path, ...(rawCopyPath ? { rawCopyPath } : {}), ...(c2paManifestPath ? { c2paManifest: c2paManifestPath } : {}), ...(c2paSigned !== undefined ? { c2paSigned } : {}), recipe: recipePath, verified: verify.ok, verify, generative })
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
