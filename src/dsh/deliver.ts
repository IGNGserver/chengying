/** Shared implementation behind photo_deliver and export_run. */
import type { ChengyingRuntime } from './runtime.ts'
import type { Project } from '../core/project.ts'
import type { ToolRunContext } from './host-types.ts'
import { join as joinPath, basename } from 'node:path'
import { releaseReservation, reserveArtifact } from '../core/export/atomic.ts'
import { exportPhotos } from '../core/export/exporter.ts'
import { deliverOriginals, writeDeliveryManifest, type OriginalSource } from '../core/export/deliver.ts'
import { zipDirectory } from '../core/export/zip.ts'
import { resolveUserPath } from '../core/util/path.ts'
import { ChengyingError } from '../core/util/errors.ts'

export interface DeliveryRequest {
  selection?: string
  tasks?: string[]
  shots?: string[]
  dir?: string
  mode?: 'originals' | 'rendered'
  manifest?: boolean
  format?: 'jpeg' | 'tiff' | 'png'
  quality?: number
  maxEdge?: number
  subdir?: string
  naming?: 'original' | 'datetime'
  source?: OriginalSource
  includeRaw?: boolean
  c2pa?: boolean
  overwrite?: boolean
  background?: boolean
  /** Also write a store-only .zip inside the guarded delivery directory. */
  archive?: boolean
}

export interface DeliveryResult {
  exported: number
  failed: number
  dir: string
  deliveryMode: 'originals' | 'rendered'
  manifest?: string
  metadataVerified: boolean
  /** Originals still match the scan-time baseline (see photo_integrity_check). */
  originalsIntact: boolean
  originalsChanged: number
  originalsMissing: number
  archivePath?: string
  archiveBytes?: number
  archiveEntries?: number
  items: unknown[]
}

function selectionCount(project: Project, id: string | undefined): number {
  if (id === undefined) return 0
  const selection = project.repo.selection(id)
  if (selection === undefined) throw new ChengyingError('not-found', `no selection ${id}`)
  return selection.items.filter(item => item.included).length
}

export async function runDelivery(rt: ChengyingRuntime, project: Project, exec: ToolRunContext, opts: DeliveryRequest): Promise<Record<string, unknown>> {
  const plan = rt.planFor(project, exec)
  const cwd = exec.agent?.session.requestHeader()?.cwd
  const requestedDir = opts.dir?.trim() === '' ? undefined : opts.dir
  const baseDir = resolveUserPath(requestedDir ?? plan?.outputDir ?? project.exportDir, cwd)
  const mode = opts.mode ?? plan?.deliverMode ?? 'rendered'
  const dir = mode === 'originals' && opts.subdir !== undefined ? joinPath(baseDir, opts.subdir.replace(/\.\.+/g, '_')) : baseDir
  const selection = opts.selection ?? (opts.shots === undefined && opts.tasks === undefined ? project.repo.latestSelectionId() : undefined)
  if (opts.selection === undefined && opts.shots === undefined && opts.tasks === undefined && selection === undefined) {
    throw new ChengyingError('invalid-argument', 'nothing to deliver: pass a selection, tasks or shots')
  }
  const count = (opts.tasks?.length ?? 0) + (opts.shots?.length ?? 0) + selectionCount(project, selection)
  const background = opts.background ?? count > 8

  const work = async (signal: AbortSignal, progress: (stage: string, done: number, total: number, message?: string) => void): Promise<DeliveryResult> => {
    // Shell commands run outside FsGuard, so verify the originals at delivery
    // time. This never blocks the delivery; it makes a changed original visible
    // in the result and in manifest.json.
    const integrity = await project.integrity.quick()
    const integrityFields = {
      originalsIntact: integrity.ok,
      originalsChanged: integrity.changed.length,
      originalsMissing: integrity.missing.length,
    }
    let result: DeliveryResult
    if (mode === 'originals') {
      const delivered = deliverOriginals(project, {
        shotIds: opts.shots, taskIds: opts.tasks, selectionId: selection, dir, source: opts.source,
        signal, onProgress: (done, total, current) => progress('deliver', done, total, current),
      })
      result = { exported: delivered.exported, failed: delivered.failed, dir: delivered.dir, deliveryMode: mode, metadataVerified: true, ...integrityFields, items: delivered.items }
    } else {
      const exported = await exportPhotos(project, rt.edit(project), {
        shotIds: opts.shots, taskIds: opts.tasks, selectionId: selection, dir,
        format: opts.format, quality: opts.quality, maxEdge: opts.maxEdge, subdir: opts.subdir,
        naming: opts.naming, includeRaw: opts.includeRaw, c2pa: opts.c2pa, overwrite: opts.overwrite, signal,
        onProgress: (done, total, current) => progress('export', done, total, current),
        authorize: rt.authorizer(project),
      })
      result = { exported: exported.exported, failed: exported.failed, dir: exported.dir, deliveryMode: mode, metadataVerified: exported.verifiedAll, ...integrityFields, items: exported.items }
    }
    if (opts.manifest !== false) {
      result.manifest = writeDeliveryManifest(project, result.dir, {
        mode,
        project: { id: project.id, root: project.root },
        plan,
        summary: { exported: result.exported, failed: result.failed, metadataVerified: result.metadataVerified, originalsIntact: result.originalsIntact },
        items: result.items,
      })
    }
    if (opts.archive === true) {
      const reservation = reserveArtifact(project.guard, result.dir, `${basename(result.dir)}.zip`, () => false)
      try {
        const archive = zipDirectory(result.dir, project.guard.writable(reservation.target))
        result.archivePath = archive.path
        result.archiveBytes = archive.bytes
        result.archiveEntries = archive.entries
      } finally { releaseReservation(reservation) }
    }
    rt.updatePlanStage(project, exec, 'delivered')
    return result
  }

  const r = await rt.runMaybeBackground(exec, { kind: 'deliver', label: `chengying deliver · ${project.root}`, projectId: project.id, background },
    work,
    res => `delivery (${res.deliveryMode}): ${res.exported} exported, ${res.failed} failed → ${res.dir}${res.originalsIntact ? '' : ` [originals changed: ${res.originalsChanged}, missing: ${res.originalsMissing}]`}${res.archivePath === undefined ? '' : `; archive ${res.archivePath}`}`)
  if (r.mode === 'background') return { mode: 'background', jobId: r.jobId, activityId: r.activityId, dir, note: 'Delivery is running in the background; you will be notified when it settles.' }
  return { mode: 'inline', ...r.result }
}
