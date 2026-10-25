/** Locate a darktable installation: CLI, MCP server, plugin directory, data directory. */
import { existsSync, readdirSync, statSync, realpathSync } from 'node:fs'
import { delimiter, dirname, join, resolve } from 'node:path'
import { homedir, platform } from 'node:os'
import { run } from '../../../util/proc.ts'

export interface DarktableInstall {
  cli: string
  mcp?: string
  pluginDir?: string
  root: string
  version: string
  /** macOS app bundle root (…/darktable.app/Contents) when applicable. */
  bundle?: string
  mtimeMs: number
}

const exe = platform() === 'win32' ? '.exe' : ''

function candidates(explicit?: string): string[] {
  const list: string[] = []
  if (explicit) list.push(explicit)
  if (process.env.CHENGYING_DARKTABLE_CLI) list.push(process.env.CHENGYING_DARKTABLE_CLI)
  for (const dir of (process.env.PATH ?? '').split(delimiter)) if (dir) list.push(join(dir, `darktable-cli${exe}`))
  if (platform() === 'darwin') {
    list.push('/Applications/darktable.app/Contents/MacOS/darktable-cli', join(homedir(), 'Applications/darktable.app/Contents/MacOS/darktable-cli'))
  } else if (platform() === 'win32') {
    for (const pf of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], 'C:\\Program Files']) if (pf) list.push(join(pf, 'darktable', 'bin', 'darktable-cli.exe'))
  } else {
    list.push('/usr/bin/darktable-cli', '/usr/local/bin/darktable-cli', '/opt/darktable/bin/darktable-cli', '/var/lib/flatpak/exports/bin/org.darktable.Darktable')
  }
  return [...new Set(list)]
}

function findPluginDir(cli: string): string | undefined {
  const bin = dirname(cli)
  const roots = [
    resolve(bin, '../Resources/lib/darktable/plugins'), // macOS bundle
    resolve(bin, '../lib/darktable/plugins'),
    resolve(bin, '../lib64/darktable/plugins'),
    resolve(bin, '../lib/x86_64-linux-gnu/darktable/plugins'),
    resolve(bin, '../lib/aarch64-linux-gnu/darktable/plugins'),
    '/usr/lib/darktable/plugins', '/usr/lib64/darktable/plugins', '/usr/lib/x86_64-linux-gnu/darktable/plugins', '/usr/lib/aarch64-linux-gnu/darktable/plugins',
  ]
  return roots.find(r => existsSync(r) && readdirSync(r).some(f => /^libexposure\.(so|dylib|dll)$/.test(f)))
}

export async function locateDarktable(explicit?: string): Promise<DarktableInstall | { error: string }> {
  for (const c of candidates(explicit)) {
    if (!existsSync(c)) continue
    let cli: string
    try { cli = realpathSync.native(c) } catch { cli = c }
    try {
      const r = await run(cli, ['--version'], { timeoutMs: 60_000 })
      const m = /darktable\s+(\d+\.\d+(?:\.\d+)?[^\s]*)/i.exec(r.stdout + r.stderr)
      if (m === null) continue
      const bin = dirname(cli)
      const mcp = join(bin, `darktable-mcp${exe}`)
      const bundle = cli.includes('.app/Contents/MacOS/') ? resolve(bin, '..') : undefined
      return {
        cli,
        mcp: existsSync(mcp) ? mcp : undefined,
        pluginDir: findPluginDir(cli),
        root: resolve(bin, '..'),
        version: m[1] as string,
        bundle,
        mtimeMs: statSync(cli).mtimeMs,
      }
    } catch {
      continue
    }
  }
  return { error: 'darktable-cli not found (install darktable or set engines.darktable.path / CHENGYING_DARKTABLE_CLI)' }
}
