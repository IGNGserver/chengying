/** Path intake shared by tools and the runtime: accept ~ and relative paths. */
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

/**
 * Path form for engine command-line arguments.
 *
 * Windows accepts forward slashes anywhere Node does, but some CLIs read their
 * path arguments as pattern strings where `\` is an escape character:
 * `darktable-cli <in> <out>` drops every backslash of `out`, so
 * `C:\a\b.jpg` is exported as `C:ab.jpg` — exit code 0, no file at the path we
 * asked for. Every path handed to an external tool goes through this helper so
 * the argv stays literal on every platform.
 */
export function cliPath(p: string, platformName: NodeJS.Platform = process.platform): string {
  return platformName === 'win32' ? p.replace(/\\/g, '/') : p
}

/** `cliPath` over an argument list (drops undefined entries). */
export function cliPaths(paths: Array<string | undefined>, platformName: NodeJS.Platform = process.platform): string[] {
  return paths.filter((p): p is string => p !== undefined).map(p => cliPath(p, platformName))
}

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
