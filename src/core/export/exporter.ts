/**
 * Unified export with collision-safe name reservation and transactional
 * publication. Engines and metadata tools only ever write same-directory
 * temporary files; the final JPEG/TIFF/PNG, RAW companion, recipes and C2PA
 * manifest become visible together after every step has completed.
 */
import {
  copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync,
} from 'node:fs'
import { basename, extname, join } from 'node:path'
import type { Project } from '../project.ts'
import type { EditService } from '../edit/service.ts'
import type { EditDocument, Shot } from '../types.ts'
import type { VerifyReport } from '../meta/exif.ts'
import { ChengyingError, errorMessage } from '../util/errors.ts'
import { newId, nowIso } from '../util/misc.ts'
import { run } from '../util/proc.ts'
import { commitPublications, releaseReservation, reserveArtifact, temporaryFor, type Publication, type Reservation } from './atomic.ts'

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
  naming?: 'original' | 'datetime'
  includeRaw?: boolean
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
  status: 'exported' | 'unverified' | 'failed'
  path?: string
  rawCopyPath?: string
  c2paManifest?: string
  c2paSigned?: boolean
  recipe?: string
  verified: boolean
  verify?: VerifyReport
  error?: string
  warnings?: string[]
  generative: boolean
}

/** Reserve a final path atomically across concurrent exporter processes. */
function reserveTarget(project: Project, dir: string, base: string, ext: string, shotId: string, taskId: string | null, overwrite: boolean): Reservation {
  return reserveArtifact(project.guard, dir, `${base}.${ext}`, candidate => {
    const previous = project.repo.exportAtPath(candidate)
    return previous?.shotId === shotId && (taskId === null ? previous.taskId === null : previous.taskId === taskId)
  }, overwrite)
}

export async function exportPhotos(project: Project, edit: EditService, opts: ExportOptions): Promise<{ exported: number; failed: number; verifiedAll: boolean; dir: string; items: ExportItem[] }> {
  const format = opts.format ?? 'jpeg'
  const ext = format === 'tiff' ? 'tif' : format === 'png' ? 'png' : 'jpg'
  const shotIds = new Set<string>(opts.shotIds ?? [])
  if (opts.selectionId !== undefined) {
    const sel = project.repo.selection(opts.selectionId)
    if (sel === undefined) throw new ChengyingError('not-found', `no selection ${opts.selectionId}`)
    for (const item of sel.items) if (item.included) shotIds.add(item.shotId)
  }
  const taskByShot = new Map<string, string>()
  for (const taskId of opts.taskIds ?? []) {
    const task = project.repo.task(taskId)
    if (task === undefined) throw new ChengyingError('not-found', `no task ${taskId}`)
    shotIds.add(task.shotId)
    taskByShot.set(task.shotId, taskId)
  }
  if (shotIds.size === 0) throw new ChengyingError('invalid-argument', 'nothing to export (pass shots, a selection or tasks)')
  const baseDir = project.addWritableRoot(opts.dir ?? project.exportDir)
  const dir = project.guard.writable(opts.subdir !== undefined ? join(baseDir, opts.subdir.replace(/\.\.+/g, '_')) : baseDir)
  const recipeDir = project.guard.writable(join(dir, '_recipes'))
  mkdirSync(recipeDir, { recursive: true })
  const items: ExportItem[] = []
  let done = 0

  for (const shotId of shotIds) {
    let task = opts.taskIds === undefined && opts.selectionId !== undefined
      ? project.repo.tasks({ shotId }).find(t => t.status === 'succeeded' && t.selectionId === opts.selectionId)
      : undefined
    task ??= project.repo.tasks({ shotId }).find(t => t.status === 'succeeded')
    const explicitTask = taskByShot.get(shotId)
    if (explicitTask !== undefined) task = project.repo.task(explicitTask)
    let revisionId: string | null = null
    let generative = false
    let reservation: Reservation | undefined
    const temporary = new Set<string>()
    const token = newId('export')
    const temp = (target: string, label = 'tmp'): string => {
      const path = project.guard.writable(temporaryFor(target, token, label))
      temporary.add(path)
      return path
    }
    try {
      opts.signal?.throwIfAborted()
      const shot = project.repo.shot(shotId)
      if (shot === undefined) throw new ChengyingError('not-found', `no shot ${shotId}`)
      let doc: EditDocument
      if (task !== undefined) {
        if (task.headRevision === null) throw new ChengyingError('internal', `task ${task.id} has no head revision`)
        const head = project.repo.revision(task.headRevision)
        if (head === undefined) throw new ChengyingError('internal', `task ${task.id} head revision missing`)
        doc = head.doc
        revisionId = head.id
        const hasActiveSteps = doc.stages.some(stage => stage.steps.some(step => step.enabled))
        if (task.options.unchanged === true && !hasActiveSteps && shot.rasterFile !== null && doc.sourceFile === shot.rawFile) {
          doc = { schema: 1, sourceFile: shot.rasterFile, stages: [{ id: 'unchanged_raster', engine: 'builtin', steps: [] }] }
        }
      } else {
        const kind: 'raw' | 'raster' = shot.rawFile !== null ? 'raw' : 'raster'
        const engine = await edit.engines.pick(kind)
        const source = edit.sourceFor(shot, (await edit.engines.get(engine).probe()).inputs.raw ? kind : 'raster')
        doc = { schema: 1, sourceFile: source.fileId, stages: [{ id: 'default', engine, steps: [] }] }
      }
      generative = doc.stages.some(stage => stage.steps.some(step => step.enabled && /^gen_/.test(step.op)))
      const source = project.repo.file(doc.sourceFile)
      const base = opts.naming === 'datetime' && shot.captureTime !== null
        ? shot.captureTime.replace(/[-:]/g, '').replace('T', '_').slice(0, 15)
        : basename(source?.path ?? shot.id, extname(source?.path ?? ''))
      reservation = reserveTarget(project, dir, base, ext, shotId, task?.id ?? null, opts.overwrite !== false)
      const target = reservation.target
      const finalBase = basename(target, extname(target))
      const mainTemporary = temp(target, 'render')
      await edit.renderDoc(shot, doc, {
        taskId: task?.id, output: mainTemporary, format, quality: opts.quality ?? 95,
        maxEdge: opts.maxEdge, bitDepth: opts.bitDepth, signal: opts.signal, authorize: opts.authorize,
      })

      const sources = [shot.rawFile, shot.rasterFile]
        .filter((id): id is string => id !== null)
        .map(id => project.repo.file(id))
        .filter((file): file is NonNullable<typeof file> => file !== undefined)
      const primary = sources.find(file => file.id === doc.sourceFile) ?? sources[0]
      if (primary === undefined) throw new ChengyingError('not-found', 'no source file for metadata')
      const orderedSourcePaths = [primary, ...sources.filter(file => file.id !== primary.id)].map(file => project.guard.readable(file.path))
      const recipeName = `${basename(target)}.chengying.json`
      const history = doc.stages.map(stage => `${stage.engine}: ${stage.steps.filter(step => step.enabled).map(step => step.op).join(', ') || 'default'}`).join(' | ')
      await project.metadata.copyForExport(orderedSourcePaths, mainTemporary, {
        software: `Chengying ${VERSION}`, recipe: `_recipes/${recipeName}`, generative, history,
      }, opts.signal)
      const verify = await project.metadata.verify(orderedSourcePaths, mainTemporary)
      const publications: Publication[] = [{ temporary: mainTemporary, target, overwrite: reservation.replacing }]
      const warnings: string[] = []

      let rawCopyPath: string | undefined
      if (opts.includeRaw === true && shot.rawFile !== null) {
        const raw = project.repo.file(shot.rawFile)
        if (raw !== undefined) {
          const rawSource = project.guard.readable(raw.path)
          const rawTarget = project.guard.writable(join(dir, `${finalBase}.${raw.ext}`))
          const rawTemporary = temp(rawTarget, 'raw')
          copyFileSync(rawSource, rawTemporary)
          const stat = statSync(rawSource)
          utimesSync(rawTemporary, stat.atime, stat.mtime)
          rawCopyPath = rawTarget
          publications.push({ temporary: rawTemporary, target: rawTarget, overwrite: reservation.replacing })
        }
      }

      const natives: Record<string, string> = {}
      for (const [index, stage] of doc.stages.entries()) {
        try {
          const engine = edit.engines.get(stage.engine)
          const recipe = await engine.recipe(stage, await edit.engines.catalog(stage.engine), { kind: index === 0 ? (source?.kind ?? 'raster') : 'raster' })
          const nativeTarget = project.guard.writable(join(recipeDir, `${basename(target)}.stage${index}.${stage.engine}.${recipe.extension}`))
          const nativeTemporary = temp(nativeTarget, `stage${index}`)
          writeFileSync(nativeTemporary, recipe.text)
          natives[`stage${index}`] = basename(nativeTarget)
          publications.push({ temporary: nativeTemporary, target: nativeTarget, overwrite: reservation.replacing })
        } catch (error) {
          if (opts.signal?.aborted) throw error
          natives[`stage${index}`] = `unavailable: ${errorMessage(error)}`
          warnings.push(`native recipe ${stage.engine}: ${errorMessage(error)}`)
        }
      }

      let c2paManifestPath: string | undefined
      let c2paSigned: boolean | undefined
      if (opts.c2pa === true || generative) {
        const manifest = {
          alg: 'ps256',
          claim_generator: `Chengying/${VERSION}`,
          title: basename(target),
          assertions: [{
            label: 'c2pa.actions',
            data: {
              actions: [{
                action: generative ? 'c2pa.edited' : 'c2pa.color_adjustments',
                softwareAgent: `Chengying ${VERSION}`,
                digitalSourceType: generative
                  ? 'http://cv.iptc.org/newscodes/digitalsourcetype/compositeWithTrainedAlgorithmicMedia'
                  : 'http://cv.iptc.org/newscodes/digitalsourcetype/digitalCapture',
                parameters: { history },
              }],
            },
          }],
        }
        const manifestTarget = project.guard.writable(join(recipeDir, `${basename(target)}.c2pa.json`))
        const manifestTemporary = temp(manifestTarget, 'c2pa-manifest')
        writeFileSync(manifestTemporary, JSON.stringify(manifest, null, 2))
        c2paManifestPath = manifestTarget
        publications.push({ temporary: manifestTemporary, target: manifestTarget, overwrite: reservation.replacing })
        if (opts.c2pa === true) {
          c2paSigned = false
          const c2paBin = process.env.CHENGYING_C2PATOOL ?? 'c2patool'
          const signedTemporary = temp(mainTemporary, 'c2pa-signed')
          try {
            const result = await run(c2paBin, [mainTemporary, '-m', manifestTemporary, '-o', signedTemporary, '-f'], { timeoutMs: 60_000, signal: opts.signal })
            if (result.code === 0 && !result.timedOut && existsSync(signedTemporary)) {
              renameSync(signedTemporary, mainTemporary)
              c2paSigned = true
            } else warnings.push(`c2patool did not sign the export (${result.timedOut ? 'timeout' : result.code}); the unsigned manifest is retained`)
          } catch (error) {
            if (opts.signal?.aborted) throw error
            warnings.push(`c2patool unavailable; the unsigned manifest is retained: ${errorMessage(error)}`)
          }
        }
      }

      const recipePath = project.guard.writable(join(recipeDir, recipeName))
      const recipeTemporary = temp(recipePath, 'recipe')
      writeFileSync(recipeTemporary, JSON.stringify({
        format: 'chengying-recipe/1', exportedAt: nowIso(), chengying: VERSION,
        shot: { id: shot.id, captureTime: shot.captureTime, files: sources.map(file => file?.relPath) },
        source: source?.relPath, rawCopy: rawCopyPath === undefined ? undefined : basename(rawCopyPath),
        c2paManifest: c2paManifestPath === undefined ? undefined : basename(c2paManifestPath), c2paSigned,
        taskId: task?.id ?? null, revisionId, document: doc, nativeRecipes: natives, verification: verify,
        engines: Object.fromEntries(await Promise.all(doc.stages.map(async stage => [stage.engine, (await edit.engines.get(stage.engine).probe()).version ?? '?']))),
      }, null, 2))
      publications.push({ temporary: recipeTemporary, target: recipePath, overwrite: reservation.replacing })

      commitPublications(publications, () => {
        project.db.tx(() => {
          project.repo.addExport({ taskId: task?.id ?? null, shotId, revisionId, path: target, format, verified: verify.ok, verify, recipePath, rawCopyPath: rawCopyPath ?? null, c2paManifestPath: c2paManifestPath ?? null })
          if (task !== undefined) project.repo.addEvent(task.id, verify.ok ? 'info' : 'warn', 'export', `exported ${basename(target)} (metadata ${verify.ok ? 'verified' : `MISMATCH: ${[...verify.missing, ...verify.mismatched.map(item => item.tag)].join(', ')}`})`, { path: target })
        })
      })
      items.push({
        shotId, taskId: task?.id ?? null, revisionId, status: verify.ok ? 'exported' : 'unverified',
        path: target, ...(rawCopyPath === undefined ? {} : { rawCopyPath }),
        ...(c2paManifestPath === undefined ? {} : { c2paManifest: c2paManifestPath }),
        ...(c2paSigned === undefined ? {} : { c2paSigned }), recipe: recipePath,
        verified: verify.ok, verify, generative, ...(warnings.length === 0 ? {} : { warnings }),
      })
    } catch (error) {
      items.push({ shotId, taskId: task?.id ?? null, revisionId, status: 'failed', verified: false, error: errorMessage(error), generative })
    } finally {
      for (const path of temporary) {
        try { rmSync(path, { force: true }) } catch { /* scratch cleanup */ }
      }
      releaseReservation(reservation)
      opts.onProgress?.(++done, shotIds.size, shotId)
    }
  }
  const exported = items.filter(item => item.status === 'exported' && item.path !== undefined && item.verified).length
  const failed = items.length - exported
  project.repo.addEvent(null, 'info', 'export', `exported ${exported}/${items.length} to ${dir}`, { id: newId('exp'), dir, unverified: items.filter(item => item.status === 'unverified').length })
  return { exported, failed, verifiedAll: items.length > 0 && failed === 0, dir, items }
}

export function shotLabel(s: Shot): string {
  return s.captureTime?.replace('T', ' ') ?? s.id
}
