/**
 * File permission boundary. Every path a tool, engine or exporter touches goes
 * through a guard:
 *  - reads are allowed inside the workspace roots and Chengying-owned roots;
 *  - writes are allowed only inside Chengying-owned roots (state, export,
 *    scratch), never inside a workspace root outside those, and never onto an
 *    original photo even if it somehow lives inside a writable root;
 *  - symlinks are resolved first so a link cannot escape a root.
 */
import { realpathSync, existsSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { ChengyingError } from './util/errors.ts'

export interface FsGuardOptions {
  /** Roots containing original photos (read-only). */
  workspaceRoots: string[]
  /** Chengying-owned roots (read-write). */
  writableRoots: string[]
  /** Extra read-only roots (engine installs, model files, style libraries). */
  extraReadRoots?: string[]
  /** Returns true when the path is a registered original file. */
  isOriginal?: (absPath: string) => boolean
}

function realish(p: string): string {
  // Resolve the deepest existing ancestor so not-yet-created outputs are checked too.
  let current = resolve(p)
  const tail: string[] = []
  while (!existsSync(current)) {
    const parent = dirname(current)
    if (parent === current) break
    tail.unshift(current.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)))
    current = parent
  }
  let base: string
  try {
    base = realpathSync.native(current)
  } catch {
    base = current
  }
  return tail.length === 0 ? base : resolve(base, ...tail)
}

export function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export class FsGuard {
  private readonly workspaceRoots: string[]
  private readonly writableRoots: string[]
  private readonly readRoots: string[]
  private readonly isOriginal: (absPath: string) => boolean

  constructor(options: FsGuardOptions) {
    this.workspaceRoots = options.workspaceRoots.map(realish)
    this.writableRoots = options.writableRoots.map(realish)
    this.readRoots = [...this.workspaceRoots, ...this.writableRoots, ...(options.extraReadRoots ?? []).map(realish)]
    this.isOriginal = options.isOriginal ?? (() => false)
  }

  /** Return the canonical path when reading is allowed. */
  readable(p: string): string {
    const abs = realish(p)
    if (!this.readRoots.some(root => isInside(abs, root))) {
      throw new ChengyingError('permission-denied', `read outside allowed roots: ${p}`, { path: p })
    }
    return abs
  }

  /** Return the canonical path when writing is allowed. */
  writable(p: string): string {
    const abs = realish(p)
    if (!this.writableRoots.some(root => isInside(abs, root))) {
      throw new ChengyingError('permission-denied', `write outside Chengying-owned roots: ${p}`, { path: p })
    }
    if (this.isOriginal(abs)) {
      throw new ChengyingError('permission-denied', `refusing to write an original photo: ${p}`, { path: p })
    }
    return abs
  }

  isWorkspacePath(p: string): boolean {
    const abs = realish(p)
    return this.workspaceRoots.some(root => isInside(abs, root))
  }

  /** Directories a recursive scan must skip because Chengying owns them. */
  ownedRoots(): readonly string[] {
    return this.writableRoots
  }
}
