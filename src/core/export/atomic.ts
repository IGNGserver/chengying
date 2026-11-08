/** Same-directory staging, cross-process name reservations and rollback-capable publication. */
import { closeSync, existsSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'
import { ChengyingError } from '../util/errors.ts'
import { newId, nowIso } from '../util/misc.ts'

export interface WriteGuard { writable(path: string): string }
export interface Publication { temporary: string; target: string; overwrite: boolean; backup?: string }
export interface Reservation { target: string; lockPath: string; replacing: boolean }

export function temporaryFor(target: string, token: string, label = 'tmp'): string {
  const ext = extname(target)
  return join(dirname(target), `.${basename(target, ext)}.${token}.${label}${ext}`)
}

function staleLock(lockPath: string): boolean {
  try {
    const value = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid?: number; host?: string }
    if (value.host !== hostname() || typeof value.pid !== 'number') return false
    try { process.kill(value.pid, 0); return false } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' }
  } catch { return false }
}

export function releaseReservation(reservation: Reservation | undefined): void {
  if (reservation === undefined) return
  try { rmSync(reservation.lockPath, { force: true }) } catch { /* stale locks remain fail-closed */ }
}

/**
 * Reserve a path with an exclusive lock. `owned` alone authorizes replacement;
 * unrelated existing files always cause a numbered suffix to be selected.
 */
export function reserveArtifact(guard: WriteGuard, dir: string, name: string, owned: (target: string) => boolean, overwrite = true): Reservation {
  const ext = extname(name)
  const base = basename(name, ext)
  for (let index = 0; ; index++) {
    const candidate = join(dir, `${base}${index === 0 ? '' : `_${index}`}${ext}`)
    const replacing = owned(candidate)
    if (existsSync(candidate) && (!overwrite || !replacing)) continue
    const lockPath = guard.writable(`${candidate}.chengying.lock`)
    try {
      const fd = openSync(lockPath, 'wx', 0o600)
      writeFileSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), createdAt: nowIso() }))
      closeSync(fd)
      guard.writable(candidate)
      return { target: candidate, lockPath, replacing }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (staleLock(lockPath)) { rmSync(lockPath, { force: true }); continue }
    }
  }
}

/** Publish a set with backups and rollback, including the DB commit. */
export function commitPublications(publications: Publication[], commit: () => void = () => undefined): void {
  const completed: Publication[] = []
  try {
    for (const publication of publications) {
      if (existsSync(publication.target) && !publication.overwrite) throw new ChengyingError('conflict', `refusing to replace an unrelated export artifact: ${publication.target}`)
      if (existsSync(publication.target)) {
        publication.backup = temporaryFor(publication.target, newId('backup'), 'previous')
        renameSync(publication.target, publication.backup)
      }
      try { renameSync(publication.temporary, publication.target) } catch (error) {
        if (publication.backup !== undefined && existsSync(publication.backup)) renameSync(publication.backup, publication.target)
        throw error
      }
      completed.push(publication)
    }
    commit()
  } catch (error) {
    for (const publication of completed.reverse()) {
      try {
        rmSync(publication.target, { force: true })
        if (publication.backup !== undefined && existsSync(publication.backup)) renameSync(publication.backup, publication.target)
      } catch { /* best effort: never replace the original error */ }
    }
    throw error
  } finally {
    for (const publication of publications) {
      if (publication.backup !== undefined) {
        try { rmSync(publication.backup, { force: true }) } catch { /* a stale backup is safer than data loss */ }
      }
    }
  }
}
