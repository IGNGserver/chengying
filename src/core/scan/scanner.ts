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
import { canonicalExtension, detectImageFormat } from '../image/format.ts'
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
  /** Detect extension-less files by content (default true). */
  sniffUnknown?: boolean
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
  /** Files seen in the workspace that were not indexed (non-photos or unreadable). */
  skipped: number
  errors: Array<{ path: string; error: string }>
}

/** One walked file; an empty `ext` means the format must come from the bytes. */
interface WalkEntry { path: string; ext: string }

const SKIP_NAMES = new Set(['@eaDir', '#recycle', '$RECYCLE.BIN', 'System Volume Information', 'node_modules', '.git', '.Trashes', '.Spotlight-V100', '.fseventsd', '_chengying_inbox', '_chengying_export'])

async function walk(root: string, skipDirs: readonly string[], sniffUnknown: boolean, out: WalkEntry[], stats: { seen: number }, signal: AbortSignal | undefined, generated: ReadonlySet<string>): Promise<void> {
  const stack = [root]
  while (stack.length > 0) {
    signal?.throwIfAborted()
    const dir = stack.pop() as string
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      // An unreadable directory is not an empty directory. Abort before any
      // reconciliation so a transient permission/I/O error cannot mark all of
      // its photos missing.
      throw new Error(`cannot read workspace directory ${dir}: ${errorMessage(error)}`, { cause: error })
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name.startsWith('._') || SKIP_NAMES.has(e.name)) continue
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        if (skipDirs.some(s => isInside(p, s))) continue
        stack.push(p)
      } else if (e.isFile()) {
        if (generated.has(p)) continue
        stats.seen++
        const ext = extname(e.name).slice(1).toLowerCase()
        if (RAW_EXTENSIONS.has(ext) || RASTER_EXTENSIONS.has(ext)) out.push({ path: p, ext })
        else if (sniffUnknown && ext === '') out.push({ path: p, ext: '' })
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

export function shotIdFor(stablePrimaryId: string): string {
  return `s_${createHash('sha1').update(stablePrimaryId).digest('hex').slice(0, 16)}`
}

function fileIdFor(path: string): string {
  return `f_${createHash('sha1').update(path).digest('hex').slice(0, 16)}`
}

function localDay(local: string | undefined): string | null {
  return local !== undefined && /^\d{4}-\d{2}-\d{2}/.test(local) ? local.slice(0, 10) : null
}

function captureTs(f: FileRecord, fallbackTzOffset?: string): number | null {
  if (f.meta.captureTimeUtc !== undefined) return Date.parse(f.meta.captureTimeUtc) / 1000
  if (f.meta.captureTime !== undefined) {
    const zone = f.meta.tzOffset !== undefined && /^[+-]\d{2}:\d{2}$/.test(f.meta.tzOffset)
      ? f.meta.tzOffset
      : (fallbackTzOffset !== undefined && /^[+-]\d{2}:\d{2}$/.test(fallbackTzOffset) ? fallbackTzOffset : 'Z')
    const t = Date.parse(`${f.meta.captureTime}${zone}`)
    return Number.isNaN(t) ? null : t / 1000
  }
  return f.mtimeMs / 1000
}

function compatiblePair(raw: FileRecord, raster: FileRecord): boolean {
  const rt = raw.meta.captureTime?.slice(0, 19)
  const jt = raster.meta.captureTime?.slice(0, 19)
  if (rt !== undefined && jt !== undefined && rt !== jt) return false
  const rc = raw.meta.camera?.trim().toLowerCase()
  const jc = raster.meta.camera?.trim().toLowerCase()
  return rc === undefined || rc === '' || jc === undefined || jc === '' || rc === jc
}

function exactPair(raw: FileRecord, raster: FileRecord): boolean {
  return raw.meta.captureTime !== undefined && raster.meta.captureTime !== undefined
    && raw.meta.captureTime.slice(0, 19) === raster.meta.captureTime.slice(0, 19)
}

export async function scanWorkspace(opts: ScanOptions): Promise<ScanResult> {
  const { root, repo, metadata, signal } = opts
  const conc = opts.concurrency ?? 6
  const sniffUnknown = opts.sniffUnknown ?? true
  const entries: WalkEntry[] = []
  const stats = { seen: 0 }
  opts.onProgress?.({ phase: 'walk', done: 0, total: 0 })
  await walk(root, opts.skipDirs, sniffUnknown, entries, stats, signal, repo.generatedArtifactPaths())
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const errors: ScanResult['errors'] = []
  const previousFiles = repo.files()
  const previousShotByFile = new Map(previousFiles.flatMap(f => f.shotId === null ? [] : [[f.id, f.shotId] as const]))
  let added = 0
  let updated = 0
  let done = 0

  const records = await mapLimit(entries, conc, async (entry): Promise<FileRecord | undefined> => {
    const path = entry.path
    signal?.throwIfAborted()
    try {
      const st = await stat(path)
      const prev = repo.fileByPath(path)
      if (prev !== undefined && prev.size === st.size && prev.mtimeMs === Math.round(st.mtimeMs) && prev.status === 'ok') {
        opts.onProgress?.({ phase: 'metadata', done: ++done, total: entries.length, current: path })
        return prev
      }
      let ext = entry.ext
      let fromContent = false
      if (ext === '') {
        const detected = await detectImageFormat(path)
        if (detected === undefined) {
          opts.onProgress?.({ phase: 'metadata', done: ++done, total: entries.length, current: path })
          return undefined
        }
        ext = detected.ext
        fromContent = true
      }
      const { meta, raw } = await metadata.read(path)
      if (fromContent) {
        // TIFF containers cover DNG/CR2/NEF/...: trust ExifTool's file type
        // when it names a format Chengying knows.
        const refined = canonicalExtension(raw.FileTypeExtension === undefined ? undefined : String(raw.FileTypeExtension))
        if (refined !== undefined) ext = refined
      }
      const rec: FileRecord = {
        id: prev?.id ?? fileIdFor(path),
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
        sha256: prev === undefined ? await sampledHash(path, st.size) : await fullHash(path, signal),
        contentVersion: null, // assigned immediately below from the final fingerprint
        status: 'ok',
        error: null,
        meta,
      }
      rec.contentVersion = rec.sha256
      if (prev === undefined) added++
      else updated++
      opts.onProgress?.({ phase: 'metadata', done: ++done, total: entries.length, current: path })
      return rec
    } catch (error) {
      if (signal?.aborted) throw error
      errors.push({ path, error: errorMessage(error) })
      const prev = repo.fileByPath(path)
      opts.onProgress?.({ phase: 'metadata', done: ++done, total: entries.length, current: path })
      // Preserve the last known identity and shot membership on a transient
      // read error. The error status forces a retry on the next scan.
      if (prev !== undefined) return { ...prev, status: 'error' as const, error: errorMessage(error) }
      return undefined
    }
  }, signal)
  const files = records.filter((r): r is FileRecord => r !== undefined)

  // A rename can reuse an ID only when the old row has a full content hash and
  // exactly one missing previous file matches it. Sampled hashes never prove
  // identity; otherwise a lookalike file could inherit another photo's edits.
  const walkedPaths = new Set(entries.map(e => e.path))
  const missingPrevious = previousFiles.filter(f => !walkedPaths.has(f.path))
  for (const f of files) {
    if (repo.fileByPath(f.path)?.id === f.id || f.sha256 === null || !f.sha256.startsWith('full:')) continue
    const matches = missingPrevious.filter(prev => prev.sha256 === f.sha256 && prev.size === f.size && prev.id !== f.id)
    if (matches.length === 1) f.id = (matches[0] as FileRecord).id
  }

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
    const usedRaw = new Set<string>()
    const usedRaster = new Set<string>()
    for (const raster of [...e.raster].sort((a, b) => a.path.localeCompare(b.path))) {
      const candidates = e.raw.filter(raw => !usedRaw.has(raw.path) && compatiblePair(raw, raster))
      const exact = candidates.filter(raw => exactPair(raw, raster))
      // Ambiguous names without unique metadata stay separate. Never let array
      // order decide which RAW inherits a JPEG's tasks and edits.
      const raw = exact.length === 1 ? exact[0] : candidates.length === 1 ? candidates[0] : undefined
      if (raw === undefined) continue
      usedRaw.add(raw.path)
      usedRaster.add(raster.path)
      shots.set(`pair:${raw.path}`, { raw: [raw], raster: [raster] })
    }
    looseRaw.push(...e.raw.filter(raw => !usedRaw.has(raw.path)))
    looseRaster.push(...e.raster.filter(raster => !usedRaster.has(raster.path)))
  }
  // Cross-directory pairing (e.g. RAW/ and JPG/ folders): same base name, same capture second, same camera.
  const rawIndex = new Map<string, FileRecord[]>()
  for (const r of looseRaw) {
    if (r.meta.captureTime === undefined) continue
    const key = `${r.base.toLowerCase()}|${r.meta.captureTime.slice(0, 19)}|${r.meta.camera ?? ''}`
    rawIndex.set(key, [...rawIndex.get(key) ?? [], r])
  }
  const pairedRaw = new Set<string>()
  for (const j of looseRaster) {
    const key = j.meta.captureTime === undefined ? undefined : `${j.base.toLowerCase()}|${j.meta.captureTime.slice(0, 19)}|${j.meta.camera ?? ''}`
    const candidates = (key === undefined ? [] : rawIndex.get(key) ?? []).filter(raw => !pairedRaw.has(raw.path) && compatiblePair(raw, j))
    const r = candidates.length === 1 ? candidates[0] : undefined
    if (r !== undefined) {
      pairedRaw.add(r.path)
      shots.set(`pair:${r.path}`, { raw: [r], raster: [j] })
    } else {
      shots.set(`single:${j.path}`, { raw: [], raster: [j] })
    }
  }
  for (const r of looseRaw) if (!pairedRaw.has(r.path)) shots.set(`single:${r.path}`, { raw: [r], raster: [] })

  let pairs = 0
  const shotIds = new Set<string>()
  const taskShotIds = new Set(repo.tasks().map(t => t.shotId))
  // When mixing phone photos (with OffsetTimeOriginal) and camera photos (without timezone offset)
  // in the same workspace, infer the workspace/day timezone offset so camera timestamps are not
  // misinterpreted as UTC 'Z' (which would shift them by e.g. 8 hours and break scene/segment grouping).
  const tzByDay = new Map<string, string>()
  let workspaceTz: string | undefined
  for (const f of files) {
    const tz = f.meta.tzOffset
    if (tz !== undefined && /^[+-]\d{2}:\d{2}$/.test(tz)) {
      workspaceTz ??= tz
      const d = localDay(f.meta.captureTime)
      if (d !== null && !tzByDay.has(d)) tzByDay.set(d, tz)
    }
  }
  type ShotFiles = { raw: FileRecord[]; raster: FileRecord[] }
  const writeGroups: ShotFiles[] = []
  for (const e of shots.values()) {
    const members = [...e.raw, ...e.raster]
    const prior = new Set(members.flatMap(f => previousShotByFile.get(f.id) ?? []))
    const taskBound = [...prior].filter(id => taskShotIds.has(id))
    if (taskBound.length > 1) {
      // Never merge two independently edited shots as a side effect of pairing.
      for (const f of members) writeGroups.push(f.kind === 'raw' ? { raw: [f], raster: [] } : { raw: [], raster: [f] })
    } else writeGroups.push(e)
  }
  let removedFiles = 0
  repo.db.tx(() => {
    for (const e of writeGroups) {
      e.raw.sort((a, b) => a.path.localeCompare(b.path))
      // Prefer a JPEG as the display raster when several rasters share a base name.
      e.raster.sort((a, b) => ((a.format === 'jpg' ? 0 : 1) - (b.format === 'jpg' ? 0 : 1)) || a.path.localeCompare(b.path))
      const raw = e.raw[0]
      const raster = e.raster[0]
      const primary = (raw ?? raster) as FileRecord
      const members = [...e.raw, ...e.raster]
      if (raw !== undefined && raster !== undefined) pairs++
      const prior = [...new Set(members.flatMap(f => previousShotByFile.get(f.id) ?? []))]
      const taskBound = prior.filter(id => taskShotIds.has(id) && !shotIds.has(id))
      let id = taskBound[0] ?? prior.find(candidate => !shotIds.has(candidate)) ?? shotIdFor(primary.id)
      for (let n = 1; shotIds.has(id); n++) id = shotIdFor(`${primary.id}:${n}`)
      shotIds.add(id)
      const metaSrc = primary.meta.captureTime !== undefined ? primary : (raster ?? primary)
      const day = localDay(metaSrc.meta.captureTime)
      const fallbackTz = raster?.meta.tzOffset ?? (day !== null ? tzByDay.get(day) : undefined) ?? workspaceTz
      const prev = repo.shot(id)
      const sourceVersion = createHash('sha256').update(JSON.stringify(members.map(f => [f.id, f.contentVersion ?? f.sha256, f.meta.orientation ?? null]).sort(([a], [b]) => String(a).localeCompare(String(b))))).digest('hex')
      const sourceChanged = prev !== undefined && prev.sourceVersion !== sourceVersion
      const shot: Shot = {
        id,
        status: 'active',
        sourceVersion,
        primaryFile: primary.id,
        rawFile: raw?.id ?? null,
        rasterFile: raster?.id ?? null,
        captureTime: metaSrc.meta.captureTime ?? null,
        captureTs: captureTs(metaSrc, fallbackTz),
        tzOffset: metaSrc.meta.tzOffset ?? fallbackTz ?? null,
        day,
        gps: primary.meta.gps ?? raster?.meta.gps ?? null,
        camera: metaSrc.meta.camera ?? null,
        lens: metaSrc.meta.lens ?? null,
        iso: metaSrc.meta.iso ?? null,
        exposureTime: metaSrc.meta.exposureTime ?? null,
        aperture: metaSrc.meta.aperture ?? null,
        focalLength: metaSrc.meta.focalLength ?? null,
        width: sourceChanged ? (metaSrc.meta.width ?? null) : (prev?.width ?? metaSrc.meta.width ?? null),
        height: sourceChanged ? (metaSrc.meta.height ?? null) : (prev?.height ?? metaSrc.meta.height ?? null),
        orientation: primary.meta.orientation ?? null,
        previewPath: sourceChanged ? null : (prev?.previewPath ?? null),
        thumbPath: sourceChanged ? null : (prev?.thumbPath ?? null),
        previewSource: sourceChanged ? null : (prev?.previewSource ?? null),
        previewError: sourceChanged ? 'source changed; rebuild previews and analysis' : (prev?.previewError ?? null),
        userFlag: prev?.userFlag ?? null,
        userRating: prev?.userRating ?? (metaSrc.meta.rating ?? null),
        note: prev?.note ?? null,
        tags: prev?.tags ?? [],
      }
      repo.saveShot(shot)
      if (sourceChanged) {
        repo.invalidateShotDerivatives(id)
        repo.addEvent(null, 'warn', 'source-changed', `source content changed for ${id}; previews, scores and groups invalidated`, { shotId: id })
      }
      for (const f of members) {
        f.shotId = id
        repo.saveFile(f)
      }
    }
    removedFiles = repo.markFilesMissingNotIn(new Set(files.map(f => f.path)))
    repo.markShotsMissingNotIn(shotIds)
  })
  return {
    files: files.length,
    shots: shotIds.size,
    raw: files.filter(f => f.kind === 'raw').length,
    raster: files.filter(f => f.kind === 'raster').length,
    pairs,
    added,
    updated,
    removed: removedFiles,
    skipped: Math.max(0, stats.seen - files.length),
    errors,
  }
}
