/** Path intake shared by tools and the runtime: accept ~ and relative paths. */
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

/** Expand `~`, strip one pair of surrounding quotes, then resolve against `cwd`. */
export function resolveUserPath(input: string, cwd?: string): string {
  let p = input.trim()
  if (p.length >= 2 && ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'")))) {
    p = p.slice(1, -1).trim()
  }
  if (p === '~') p = homedir()
  else if (p.startsWith('~/') || p.startsWith('~\\')) p = join(homedir(), p.slice(2))
  return isAbsolute(p) ? resolve(p) : resolve(cwd ?? process.cwd(), p)
}
