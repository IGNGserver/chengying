/**
 * Original-file integrity baseline.
 *
 * Chengying's own tools are confined by FsGuard and can never write an
 * original. A mounted shell (bash/pwsh) runs outside that boundary, so the
 * promise "originals are read-only" becomes checkable instead of assumed:
 * remember size/mtime (and a full SHA-256 once requested) at scan time and
 * compare before delivery or on explicit request.
 *
 * The baseline is deliberately append-once: a rescan never refreshes it. That
 * is what lets a user notice an accidental in-place edit instead of having the
 * scanner quietly bless the modified bytes. Only an explicit `repair_baseline`
 * accepts the current files as the new reference.
 */
import { createHash } from 'node:crypto'
import { createReadStream, statSync } from 'node:fs'
import type { Project } from './project.ts'
import type { FileRecord } from './types.ts'
import { nowIso } from './util/misc.ts'

export interface IntegrityBaseline {
  fileId: string
  path: string
  size: number
  mtimeMs: number
  sha256: string | null
  capturedAt: string
  source: 'scan' | 'check' | 'repair'
}

export interface IntegrityIssue {
  fileId: string
  shotId: string | null
  path: string
  reason: 'size' | 'mtime' | 'content' | 'missing'
  expected?: { size: number; mtimeMs: number; sha256: string | null }
  actual?: { size: number; mtimeMs: number; sha256?: string }
  note?: string
}

export interface IntegrityReport {
  ok: boolean
  checked: number
  captured: number
  repaired: number
  hashed: number
  hashCoverage: string
  changed: IntegrityIssue[]
  touched: IntegrityIssue[]
  missing: IntegrityIssue[]
  note?: string
}

export interface IntegrityOptions {
  /** Restrict the check to files of these shots. */
  shotIds?: string[]
  /** Compute a full SHA-256 for files whose size/mtime changed. */
  hash?: boolean
  /** Record a baseline for files that do not have one yet (default true). */
  capture?: boolean
  /** Accept the current state as the new baseline (explicit user action). */
  repair?: boolean
}

interface BaselineRow {
  file_id: string
  path: string
  size: number
  mtime_ms: number
  sha256: string | null
  captured_at: string
  source: string
}

/** Full content hash for one file, streamed so large RAW files do not load whole. */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/** A stored `full:<hex>` scanner fingerprint is already a content hash. */
function fullHashFromRecord(file: FileRecord): string | null {
  return file.sha256 !== null && file.sha256.startsWith('full:') ? file.sha256.slice(5) : null
}

function issueOf(file: FileRecord, reason: IntegrityIssue['reason'], baseline?: BaselineRow, actual?: IntegrityIssue['actual'], note?: string): IntegrityIssue {
  return {
    fileId: file.id,
    shotId: file.shotId,
    path: file.path,
    reason,
    ...(baseline === undefined ? {} : { expected: { size: baseline.size, mtimeMs: baseline.mtime_ms, sha256: baseline.sha256 } }),
    ...(actual === undefined ? {} : { actual }),
    ...(note === undefined ? {} : { note }),
  }
}

export class IntegrityService {
  constructor(private readonly project: Project) {}

  private row(fileId: string): BaselineRow | undefined {
    return this.project.db.get<BaselineRow>('SELECT * FROM originals_baseline WHERE file_id = ?', fileId)
  }

  private insert(file: FileRecord, source: IntegrityBaseline['source'], sha256: string | null): boolean {
    const result = this.project.db.run(
      'INSERT OR IGNORE INTO originals_baseline (file_id, path, size, mtime_ms, sha256, captured_at, source) VALUES (?,?,?,?,?,?,?)',
      file.id, file.path, file.size, file.mtimeMs, sha256, nowIso(), source,
    )
    return result.changes > 0
  }

  /**
   * Record baselines for files the scanner has seen. Called when a scan
   * completes; existing rows are never overwritten.
   */
  capture(files: FileRecord[] = this.project.repo.files()): number {
    let captured = 0
    this.project.db.tx(() => {
      for (const file of files) {
        if (this.insert(file, 'scan', fullHashFromRecord(file))) captured++
      }
    })
    return captured
  }

  private filesOf(options: IntegrityOptions): FileRecord[] {
    const ids = options.shotIds?.filter(id => id.trim() !== '') ?? []
    if (ids.length === 0) return this.project.repo.files()
    const byShot = new Map<string, FileRecord>()
    for (const id of ids) for (const file of this.project.repo.filesOfShot(id)) byShot.set(file.id, file)
    return [...byShot.values()]
  }

  private hashCoverage(): string {
    const row = this.project.db.get<{ total: number; hashed: number }>(
      'SELECT count(*) total, sum(CASE WHEN sha256 IS NOT NULL THEN 1 ELSE 0 END) hashed FROM originals_baseline',
    )
    return `${Number(row?.hashed ?? 0)}/${Number(row?.total ?? 0)}`
  }

  /** Compare files against the baseline; optionally repair the baseline. */
  async check(options: IntegrityOptions = {}): Promise<IntegrityReport> {
    const files = this.filesOf(options)
    const captured = options.capture === false ? 0 : this.capture(files)
    const changed: IntegrityIssue[] = []
    const touched: IntegrityIssue[] = []
    const missing: IntegrityIssue[] = []
    let checked = 0
    let hashed = 0
    let repaired = 0

    for (const file of files) {
      let stat: ReturnType<typeof statSync>
      try {
        stat = statSync(file.path)
      } catch {
        missing.push(issueOf(file, 'missing'))
        continue
      }
      const actual = { size: stat.size, mtimeMs: Math.round(stat.mtimeMs) }
      const baseline = this.row(file.id)
      if (baseline === undefined) continue
      checked++
      if (actual.size === baseline.size && actual.mtimeMs === baseline.mtime_ms) {
        // A hash request also upgrades an unchanged file's baseline, so the next
        // check can distinguish a touch from a content change without guessing.
        if (options.hash === true && baseline.sha256 === null) {
          try {
            const actualHash = await sha256File(file.path)
            this.project.db.run('UPDATE originals_baseline SET sha256 = ? WHERE file_id = ?', actualHash, file.id)
            hashed++
          } catch {
            missing.push(issueOf(file, 'missing'))
          }
        }
        continue
      }

      let actualHash: string | undefined
      if (options.hash === true || options.repair === true) {
        try {
          actualHash = await sha256File(file.path)
          hashed++
        } catch {
          missing.push(issueOf(file, 'missing'))
          continue
        }
      }

      if (options.repair === true) {
        this.project.db.run(
          'UPDATE originals_baseline SET size = ?, mtime_ms = ?, sha256 = ?, captured_at = ?, source = ? WHERE file_id = ?',
          actual.size, actual.mtimeMs, actualHash ?? baseline.sha256, nowIso(), 'repair', file.id,
        )
        repaired++
        continue
      }

      if (actualHash !== undefined && baseline.sha256 !== null && actualHash === baseline.sha256) {
        touched.push(issueOf(file, 'mtime', baseline, { ...actual, sha256: actualHash }, 'mtime/size changed but the full content hash still matches (touch/metadata-only change)'))
        continue
      }
      const reason: IntegrityIssue['reason'] = actualHash !== undefined
        ? 'content'
        : actual.size !== baseline.size ? 'size' : 'mtime'
      const note = baseline.sha256 === null && actualHash === undefined
        ? 'no full baseline hash yet; pass hash=true or repair_baseline to confirm whether the bytes changed'
        : undefined
      changed.push(issueOf(file, reason, baseline, actualHash === undefined ? actual : { ...actual, sha256: actualHash }, note))
    }

    const ok = changed.length === 0 && missing.length === 0
    if (changed.length > 0 || missing.length > 0) {
      this.project.repo.addEvent(null, 'warn', 'integrity', `original files changed or missing: ${changed.length} changed, ${missing.length} missing`, {
        changed: changed.slice(0, 20).map(i => i.path), missing: missing.slice(0, 20).map(i => i.path),
      })
    }
    const notes: string[] = []
    if (captured > 0) notes.push(`captured ${captured} new baseline(s); re-run after the next scan for a complete reference`)
    if (repaired > 0) notes.push(`accepted the current files as the new baseline for ${repaired} file(s)`)
    if (hashed > 0) notes.push(`computed full SHA-256 for ${hashed} changed file(s)`)
    if (changed.some(i => i.expected?.sha256 === null) && options.hash !== true) notes.push('some baselines only have size/mtime; use hash=true for a definitive content check')
    return {
      ok,
      checked,
      captured,
      repaired,
      hashed,
      hashCoverage: this.hashCoverage(),
      changed,
      touched,
      missing,
      ...(notes.length === 0 ? {} : { note: notes.join('; ') }),
    }
  }

  /** Fast pre-delivery check: no hashing, but capture missing baselines. */
  async quick(): Promise<IntegrityReport> {
    return await this.check({ hash: false })
  }
}
