/**
 * Delivery helpers for the two product-level outcomes:
 *  - originals: copy the selected source files byte-for-byte (cull-only);
 *  - manifest: describe exactly what was delivered and how it was produced.
 */
import { copyFileSync, existsSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { ChengyingError, errorMessage } from '../util/errors.ts'
import { newId, nowIso } from '../util/misc.ts'
import type { Project } from '../project.ts'
import type { Shot } from '../types.ts'
import { commitPublications, releaseReservation, reserveArtifact, temporaryFor, type Reservation } from './atomic.ts'

export type OriginalSource = 'raster' | 'raw' | 'both'

export interface DeliverOriginalsOptions {
  shotIds?: string[]
  selectionId?: string
  taskIds?: string[]
  dir: string
  source?: OriginalSource
  signal?: AbortSignal
  onProgress?: (done: number, total: number, current?: string) => void
}

export interface DeliveredOriginal {
  shotId: string
  sourcePath?: string
  path?: string
  bytes?: number
  kind?: 'raw' | 'raster'
  error?: string
}

export interface OriginalDelivery {
  mode: 'originals'
  dir: string
  exported: number
  failed: number
  items: DeliveredOriginal[]
}

function collect(project: Project, opts: DeliverOriginalsOptions): string[] {
  const ids = new Set<string>(opts.shotIds ?? [])
  if (opts.selectionId !== undefined) {
    const selection = project.repo.selection(opts.selectionId)
    if (selection === undefined) throw new ChengyingError('not-found', `no selection ${opts.selectionId}`)
    for (const item of selection.items) if (item.included) ids.add(item.shotId)
  }
  for (const taskId of opts.taskIds ?? []) {
    const task = project.repo.task(taskId)
    if (task === undefined) throw new ChengyingError('not-found', `no task ${taskId}`)
    ids.add(task.shotId)
  }
  return [...ids]
}

function sourcesOf(project: Project, shot: Shot, source: OriginalSource): Array<{ id: string; kind: 'raw' | 'raster'; ext: string }> {
  const raw = source === 'raster' ? null : shot.rawFile
  const raster = source === 'raw' ? null : shot.rasterFile
  const chosen = [raw, raster].filter((id): id is string => id !== null)
  if (chosen.length === 0) {
    const fallback = shot.rasterFile ?? shot.rawFile
    if (fallback !== null) chosen.push(fallback)
  }
  return chosen.map(id => {
    const file = project.repo.file(id)
    if (file === undefined) throw new ChengyingError('not-found', `missing file record for shot ${shot.id}`)
    return { id: file.path, kind: file.kind, ext: file.ext }
  })
}

/** Copy picked originals into a delivery directory; originals are only read. */
export function deliverOriginals(project: Project, opts: DeliverOriginalsOptions): OriginalDelivery {
  const dir = project.addWritableRoot(opts.dir)
  const ids = collect(project, opts)
  if (ids.length === 0) throw new ChengyingError('invalid-argument', 'nothing to deliver (pass shots, a selection or tasks)')
  const source = opts.source ?? 'raster'
  const items: DeliveredOriginal[] = []
  let done = 0
  for (const shotId of ids) {
    opts.signal?.throwIfAborted()
    const shot = project.repo.shot(shotId)
    if (shot === undefined) {
      items.push({ shotId, error: 'unknown shot' })
      opts.onProgress?.(++done, ids.length, shotId)
      continue
    }
    try {
      for (const src of sourcesOf(project, shot, source)) {
        let reservation: Reservation | undefined
        let temporary: string | undefined
        try {
          const readable = project.guard.readable(src.id)
          const name = basename(readable)
          // Extension-less intake copies keep their bytes; restore the extension
          // the scanner recovered so the delivery opens everywhere.
          const deliveryName = extname(name) === '' && src.ext !== '' ? `${name}.${src.ext}` : name
          reservation = reserveArtifact(project.guard, dir, deliveryName, candidate => {
            const previous = project.repo.deliveryArtifactAtPath(candidate)
            return previous?.shotId === shotId && previous.sourcePath === readable
          })
          temporary = project.guard.writable(temporaryFor(reservation.target, newId('delivery'), 'copy'))
          copyFileSync(readable, temporary)
          const stat = statSync(readable)
          utimesSync(temporary, stat.atime, stat.mtime)
          opts.signal?.throwIfAborted()
          const target = reservation.target
          const replacing = reservation.replacing
          commitPublications([{ temporary, target, overwrite: replacing }], () => {
            project.repo.addDeliveryArtifact({ path: target, shotId, sourcePath: readable, kind: src.kind, bytes: stat.size })
          })
          temporary = undefined
          items.push({ shotId, sourcePath: readable, path: target, bytes: stat.size, kind: src.kind })
        } finally {
          if (temporary !== undefined) { try { rmSync(temporary, { force: true }) } catch { /* scratch cleanup */ } }
          releaseReservation(reservation)
        }
      }
    } catch (error) {
      items.push({ shotId, error: errorMessage(error) })
    }
    opts.onProgress?.(++done, ids.length, shotId)
  }
  const exported = items.filter(item => item.path !== undefined).length
  const failed = ids.filter(id => !items.some(item => item.shotId === id && item.path !== undefined)).length
  project.repo.addEvent(null, 'info', 'deliver', `delivered ${exported} original file(s) to ${dir}`, { dir, mode: 'originals' })
  return { mode: 'originals', dir, exported, failed, items }
}

export interface DeliveryManifest {
  format: 'chengying-delivery/1'
  deliveredAt: string
  mode: 'originals' | 'rendered'
  project: { id: string; root: string }
  plan: unknown
  summary: { exported: number; failed: number; metadataVerified: boolean; originalsIntact: boolean }
  items: unknown[]
}

function isChengyingManifest(path: string): boolean {
  if (!existsSync(path)) return false
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as { format?: unknown }
    return value.format === 'chengying-delivery/1'
  } catch { return false }
}

/** Write the machine-readable delivery record next to the photos. */
export function writeDeliveryManifest(project: Project, dir: string, manifest: Omit<DeliveryManifest, 'format' | 'deliveredAt'>): string {
  const root = project.addWritableRoot(dir)
  const reservation = reserveArtifact(project.guard, root, 'manifest.json', isChengyingManifest)
  const temporary = project.guard.writable(temporaryFor(reservation.target, newId('manifest'), 'json'))
  try {
    writeFileSync(temporary, JSON.stringify({ format: 'chengying-delivery/1', deliveredAt: nowIso(), ...manifest }, null, 2), { flag: 'wx' })
    commitPublications([{ temporary, target: reservation.target, overwrite: reservation.replacing }])
    return reservation.target
  } finally {
    try { rmSync(temporary, { force: true }) } catch { /* scratch cleanup */ }
    releaseReservation(reservation)
  }
}
