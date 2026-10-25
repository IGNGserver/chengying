/**
 * Workspace scan: discover photos, read metadata, fingerprint content and pair
 * RAW+JPEG captures into shots. Originals are opened read-only; nothing is
 * written next to them. Rescans are incremental (path + size + mtime).
 *
 * Content fingerprint: a cheap sampled hash (size + head/middle/tail 64 KiB) is
 * computed for every file; only files whose sampled hash collides are hashed in
 * full, so exact-duplicate detection stays exact without reading every byte of
 * a large RAW library over a slow network share.
 */
import { createHash } from 'node:crypto'
import { open, readdir, stat } from 'node:fs/promises'
import { basename, dirname, extname, join, relative } from 'node:path'
import type { FileRecord, Shot } from '../types.ts'
import type { MetadataService } from '../meta/exif.ts'
import type { Repo } from '../store/repo.ts'
import { RAW_EXTENSIONS, RASTER_EXTENSIONS } from '../image/preview.ts'
import { isInside } from '../fsguard.ts'
import { mapLimit } from '../util/misc.ts'
import { errorMessage } from '../util/errors.ts'

export interface ScanProgress { phase: 'walk' | 'metadata' | 'fingerprint' | 'pair'; done: number; total: number; current?: string }

export interface ScanOptions {
  root: string
  skipDirs: readonly string[]
  metadata: MetadataService
  repo: Repo
  concurrency?: number
  signal?: AbortSignal
  onProgress?: (p: ScanProgress) => void
}

export interface ScanResult {
  files: number
  shots: number
  raw: number
  raster: number
  pairs: number
  added: number
  updated: number
  removed: number
  errors: Array<{ path: string; error: string }>
}

const SKIP_NAMES = new Set(['@eaDir', '#recycle', '$RECYCLE.BIN', 'System Volume Information', 'node_modules', '.git', '.Trashes', '.Spotlight-V100', '.fseventsd'])

async function walk(root: string, skipDirs: readonly string[], out: string[], signal?: AbortSignal): Promise<void> {
  const stack = [root]
  while (stack.length > 0) {
    signal?.throwIfAborted()
    const dir = stack.pop() as string
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name.startsWith('._') || SKIP_NAMES.has(e.name)) continue
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        if (skipDirs.some(s => isInside(p, s))) continue
        stack.push(p)
      } else if (e.isFile()) {
        const ext = extname(e.name).slice(1).toLowerCase()
        if (RAW_EXTENSIONS.has(ext) || RASTER_EXTENSIONS.has(ext)) out.push(p)
      }
    }
  }
}

const SAMPLE = 64 * 1024

export async function sampledHash(path: string, size: number): Promise<string> {
  const fh = await open(path, 'r')
  try {
    if (size <= SAMPLE * 3) {
      // Small file: the whole content is cheap, so the fingerprint is already exact.
      const whole = Buffer.alloc(size)
      const { bytesRead } = await fh.read(whole, 0, size, 0)
      return `full:${createHash('sha256').update(whole.subarray(0, bytesRead)).digest('hex')}`
    }
    const h = createHash('sha256')
    h.update(`size:${size};`)
    const buf = Buffer.alloc(SAMPLE)
    for (const off of [0, Math.floor(size / 2) - SAMPLE / 2, size - SAMPLE]) {
      const { bytesRead } = await fh.read(buf, 0, SAMPLE, off)
      h.update(buf.subarray(0, bytesRead))
    }
    return `sample:${h.digest('hex')}`
  } finally {
    await fh.close()
  }
}

export async function fullHash(path: string, signal?: AbortSignal): Promise<string> {
  const h = createHash('sha256')
  const fh = await open(path, 'r')
  try {
    const buf = Buffer.alloc(1024 * 1024)
    let pos = 0
    while (true) {
      signal?.throwIfAborted()
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos)
      if (bytesRead === 0) break
      h.update(buf.subarray(0, bytesRead))
      pos += bytesRead
    }
  } finally {
    await fh.close()
  }
  return `full:${h.digest('hex')}`
}

export function shotIdFor(primaryPath: string): string {
  return `s_${createHash('sha1').update(primaryPath).digest('hex').slice(0, 16)}`
}

function fileIdFor(path: string): string {
  return `f_${createHash('sha1').update(path).digest('hex').slice(0, 16)}`
}

function localDay(local: string | undefined): string | null {
  return local !== undefined && /^\d{4}-\d{2}-\d{2}/.test(local) ? local.slice(0, 10) : null
}

function captureTs(f: FileRecord): number | null {
  if (f.meta.captureTimeUtc !== undefined) return Date.parse(f.meta.captureTimeUtc) / 1000
  if (f.meta.captureTime !== undefined) {
    const t = Date.parse(`${f.meta.captureTime}Z`)
    return Number.isNaN(t) ? null : t / 1000
  }
  return f.mtimeMs / 1000
}

export async function scanWorkspace(opts: ScanOptions): Promise<ScanResult> {
  const { root, repo, metadata, signal } = opts
  const conc = opts.concurrency ?? 6
  const paths: string[] = []
  opts.onProgress?.({ phase: 'walk', done: 0, total: 0 })
  await walk(root, opts.skipDirs, paths, signal)
  paths.sort()
  const errors: ScanResult['errors'] = []
  let added = 0
  let updated = 0
  let done = 0

  const records = await mapLimit(paths, conc, async (path): Promise<FileRecord | undefined> => {
    signal?.throwIfAborted()
    try {
      const st = await stat(path)
      const prev = repo.fileByPath(path)
      if (prev !== undefined && prev.size === st.size && prev.mtimeMs === Math.round(st.mtimeMs) && prev.status === 'ok') {
        opts.onProgress?.({ phase: 'metadata', done: ++done, total: paths.length, current: path })
        return prev
      }
      const ext = extname(path).slice(1).toLowerCase()
      const { meta } = await metadata.read(path)
      const rec: FileRecord = {
        id: fileIdFor(path),
        shotId: null,
        path,
        relPath: relative(root, path),
        dir: dirname(path),
        base: basename(path, extname(path)),
        ext,
        kind: RAW_EXTENSIONS.has(ext) ? 'raw' : 'raster',
        format: ext === 'jpeg' || ext === 'jpe' ? 'jpg' : ext === 'tif' ? 'tiff' : ext === 'hif' ? 'heif' : ext,
        size: st.size,
        mtimeMs: Math.round(st.mtimeMs),
        sha256: await sampledHash(path, st.size),
        status: 'ok',
        error: null,
        meta,
      }
      if (prev === undefined) added++
      else updated++
      opts.onProgress?.({ phase: 'metadata', done: ++done, total: paths.length, current: path })
      return rec
    } catch (error) {
      if (signal?.aborted) throw error
      errors.push({ path, error: errorMessage(error) })
      opts.onProgress?.({ phase: 'metadata', done: ++done, total: paths.length, current: path })
      return undefined
    }
  }, signal)
  const files = records.filter((r): r is FileRecord => r !== undefined)

  // Confirm sampled-hash collisions with a full hash (exact duplicates).
  const bySample = new Map<string, FileRecord[]>()
  for (const f of files) {
    if (f.sha256 === null || f.sha256.startsWith('full:')) continue
    const list = bySample.get(f.sha256) ?? []
    list.push(f)
    bySample.set(f.sha256, list)
  }
  const collisions = [...bySample.values()].filter(l => l.length > 1).flat()
  let fp = 0
  await mapLimit(collisions, 3, async (f) => {
    f.sha256 = await fullHash(f.path, signal)
    opts.onProgress?.({ phase: 'fingerprint', done: ++fp, total: collisions.length, current: f.path })
  }, signal)

  // Pairing.
  opts.onProgress?.({ phase: 'pair', done: 0, total: files.length })
  const shots = new Map<string, { raw: FileRecord[]; raster: FileRecord[] }>()
  const byDirBase = new Map<string, { raw: FileRecord[]; raster: FileRecord[] }>()
  for (const f of files) {
    const key = `${f.dir}\u0000${f.base.toLowerCase()}`
    const e = byDirBase.get(key) ?? { raw: [], raster: [] }
    e[f.kind].push(f)
    byDirBase.set(key, e)
  }
  const looseRaster: FileRecord[] = []
  const looseRaw: FileRecord[] = []
  for (const e of byDirBase.values()) {
    if (e.raw.length > 0 && e.raster.length > 0) shots.set(`pair:${e.raw[0]?.path}`, e)
    else if (e.raw.length > 0) looseRaw.push(...e.raw)
    else looseRaster.push(...e.raster)
  }
  // Cross-directory pairing (e.g. RAW/ and JPG/ folders): same base name, same capture second, same camera.
  const rawIndex = new Map<string, FileRecord>()
  for (const r of looseRaw) {
    if (r.meta.captureTime === undefined) continue
    rawIndex.set(`${r.base.toLowerCase()}|${r.meta.captureTime.slice(0, 19)}|${r.meta.camera ?? ''}`, r)
  }
  const pairedRaw = new Set<string>()
  for (const j of looseRaster) {
    const key = j.meta.captureTime === undefined ? undefined : `${j.base.toLowerCase()}|${j.meta.captureTime.slice(0, 19)}|${j.meta.camera ?? ''}`
    const r = key === undefined ? undefined : rawIndex.get(key)
    if (r !== undefined && !pairedRaw.has(r.path)) {
      pairedRaw.add(r.path)
      shots.set(`pair:${r.path}`, { raw: [r], raster: [j] })
    } else {
      shots.set(`single:${j.path}`, { raw: [], raster: [j] })
    }
  }
  for (const r of looseRaw) if (!pairedRaw.has(r.path)) shots.set(`single:${r.path}`, { raw: [r], raster: [] })

  let pairs = 0
  const shotIds = new Set<string>()
  repo.db.tx(() => {
    for (const e of shots.values()) {
      // Prefer a JPEG as the display raster when several rasters share a base name.
      e.raster.sort((a, b) => (a.format === 'jpg' ? 0 : 1) - (b.format === 'jpg' ? 0 : 1))
      const raw = e.raw[0]
      const raster = e.raster[0]
      const primary = (raw ?? raster) as FileRecord
      if (raw !== undefined && raster !== undefined) pairs++
      const id = shotIdFor(primary.path)
      shotIds.add(id)
      const metaSrc = primary.meta.captureTime !== undefined ? primary : (raster ?? primary)
      const prev = repo.shot(id)
      const shot: Shot = {
        id,
        primaryFile: primary.id,
        rawFile: raw?.id ?? null,
        rasterFile: raster?.id ?? null,
        captureTime: metaSrc.meta.captureTime ?? null,
        captureTs: captureTs(metaSrc),
        tzOffset: metaSrc.meta.tzOffset ?? null,
        day: localDay(metaSrc.meta.captureTime),
        gps: primary.meta.gps ?? raster?.meta.gps ?? null,
        camera: metaSrc.meta.camera ?? null,
        lens: metaSrc.meta.lens ?? null,
        iso: metaSrc.meta.iso ?? null,
        exposureTime: metaSrc.meta.exposureTime ?? null,
        aperture: metaSrc.meta.aperture ?? null,
        focalLength: metaSrc.meta.focalLength ?? null,
        width: prev?.width ?? metaSrc.meta.width ?? null,
        height: prev?.height ?? metaSrc.meta.height ?? null,
        orientation: primary.meta.orientation ?? null,
        previewPath: prev?.previewPath ?? null,
        thumbPath: prev?.thumbPath ?? null,
        previewSource: prev?.previewSource ?? null,
        previewError: prev?.previewError ?? null,
        userFlag: prev?.userFlag ?? null,
        userRating: prev?.userRating ?? (metaSrc.meta.rating ?? null),
        note: prev?.note ?? null,
        tags: prev?.tags ?? [],
      }
      repo.saveShot(shot)
      for (const f of [...e.raw, ...e.raster]) {
        f.shotId = id
        repo.saveFile(f)
      }
    }
  })
  const removedFiles = repo.deleteFilesNotIn(new Set(files.map(f => f.path)))
  repo.deleteShotsNotIn(shotIds)
  return {
    files: files.length,
    shots: shotIds.size,
    raw: files.filter(f => f.kind === 'raw').length,
    raster: files.filter(f => f.kind === 'raster').length,
    pairs,
    added,
    updated,
    removed: removedFiles,
    errors,
  }
}
