/**
 * Discover darktable's modules and their parameter layouts.
 *
 * Backends, in order of preference:
 *  1. darktable-mcp (darktable ≥ 5.7 built with USE_MCP): list_modules +
 *     module_schema from the official MCP server, encode/decode through it.
 *  2. native introspection: compile native/dt-introspect.c once with the
 *     system C compiler and read every module's introspection directly from
 *     the installed plugin binaries (darktable 3.x–5.x).
 *  3. snapshot: a dump shipped with Chengying for an exactly matching
 *     darktable version (used when no compiler is available).
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync, rmSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { platform, arch } from 'node:os'
import type { DarktableInstall } from './locate.ts'
import type { DtField, DtModule } from './codec.ts'
import { run } from '../../../util/proc.ts'
import { ChengyingError, errorMessage } from '../../../util/errors.ts'
import { McpStdioClient } from '../../mcp-client.ts'

export interface DtIntrospection {
  source: 'native' | 'mcp' | 'snapshot'
  blendVersion: number
  modules: DtModule[]
  /** Built-in pipeline orders by iop_order_version ("op,instance,…"). */
  iopOrders?: Record<string, string>
  helper?: string
  notes: string[]
}

/** Find a file shipped with the package (native sources, catalogs) from src/ or lib/. */
export function packageFile(rel: string): string | undefined {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 8; i++) {
    const p = join(dir, rel)
    if (existsSync(p)) return p
    const parent = resolve(dir, '..')
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

async function compiler(): Promise<string | undefined> {
  for (const cc of [process.env.CC, 'cc', 'clang', 'gcc'].filter((x): x is string => x !== undefined && x !== '')) {
    try {
      const r = await run(cc, ['--version'], { timeoutMs: 30_000 })
      if (r.code === 0) return cc
    } catch { /* next */ }
  }
  return undefined
}

/** Build (once) the helper binary laid out so that @executable_path/../Resources resolves on macOS bundles. */
export async function buildHelper(install: DarktableInstall, workDir: string): Promise<string> {
  const src = packageFile('native/dt-introspect.c')
  if (src === undefined) throw new ChengyingError('engine-unavailable', 'native/dt-introspect.c is missing from the package')
  const source = readFileSync(src)
  const tag = createHash('sha1').update(source).update(`${platform()}-${arch()}-${install.bundle ?? install.root}`).digest('hex').slice(0, 12)
  const base = join(workDir, `dt-introspect-${tag}`)
  const exeDir = install.bundle !== undefined ? join(base, 'Contents', 'MacOS') : base
  const exe = join(exeDir, 'dt-introspect')
  if (existsSync(exe)) return exe
  const cc = await compiler()
  if (cc === undefined) throw new ChengyingError('engine-unavailable', 'no C compiler (cc/clang/gcc) to build the darktable introspection helper')
  mkdirSync(exeDir, { recursive: true })
  if (install.bundle !== undefined) {
    const link = join(base, 'Contents', 'Resources')
    rmSync(link, { force: true, recursive: false })
    symlinkSync(join(install.bundle, 'Resources'), link)
  }
  const attempts = [['-O1', '-o', exe, src], ['-O1', '-o', exe, src, '-ldl']]
  let last = ''
  for (const args of attempts) {
    const r = await run(cc, args, { timeoutMs: 120_000 })
    if (r.code === 0 && existsSync(exe)) return exe
    last = r.stderr
  }
  throw new ChengyingError('engine-unavailable', `cannot compile darktable introspection helper: ${last.slice(-600)}`)
}

export async function introspectNative(install: DarktableInstall, workDir: string, signal?: AbortSignal): Promise<DtIntrospection> {
  if (install.pluginDir === undefined) throw new ChengyingError('engine-unavailable', 'darktable plugin directory not found')
  const helper = await buildHelper(install, workDir)
  const r = await run(helper, [install.pluginDir], { timeoutMs: 600_000, signal, maxOutputBytes: 64 * 1024 * 1024 })
  if (r.code !== 0) throw new ChengyingError('engine-failed', `introspection helper failed (${r.code}): ${r.stderr.slice(-600)}`)
  const parsed = JSON.parse(r.stdout) as { blendVersion: number; modules: DtModule[]; iopOrders?: Record<string, string> }
  const notes: string[] = []
  const failed = parsed.modules.filter(m => m.error !== undefined)
  if (failed.length > 0) notes.push(`modules not introspectable: ${failed.map(m => `${m.operation} (${m.error})`).join(', ')}`)
  return { source: 'native', blendVersion: parsed.blendVersion, modules: parsed.modules, iopOrders: parsed.iopOrders, helper, notes }
}

export function snapshotFor(version: string): { blendVersion: number; modules: DtModule[]; iopOrders?: Record<string, string> } | undefined {
  const dir = packageFile('catalogs')
  if (dir === undefined) return undefined
  const name = readdirSync(dir).find(f => f === `darktable-${version}.json`)
  if (name === undefined) return undefined
  return JSON.parse(readFileSync(join(dir, name), 'utf8')) as { blendVersion: number; modules: DtModule[]; iopOrders?: Record<string, string> }
}

/* -------------------------------------------------------------- MCP mode */

interface McpField { name: string; type: string; offset?: number; size?: number; min?: number; max?: number; default?: unknown; values?: Array<{ name: string; value: number; description?: string } | string>; description?: string; count?: number }

/** Rebuild a nested DtField tree from darktable-mcp's flat field list ("a.b", "c[3]"). */
export function fieldsFromMcp(operation: string, fields: McpField[]): DtField {
  const root: DtField = { type: 'struct', size: 0, offset: 0, fields: [] }
  for (const f of fields) {
    const parts = f.name.split('.')
    let node = root
    for (let i = 0; i < parts.length; i++) {
      const raw = parts[i] as string
      const m = /^([^[]+)(?:\[(\d+)\])?$/.exec(raw)
      const key = m?.[1] ?? raw
      const last = i === parts.length - 1
      let child = node.fields?.find(c => c.field === key)
      if (child === undefined) {
        const values = f.values?.map((v, idx) => (typeof v === 'string' ? { name: v, value: idx } : v))
        child = last
          ? { type: f.count !== undefined && f.count > 1 && f.type !== 'char' ? 'array' : (f.type === 'enum' ? 'enum' : f.type), field: key, name: f.name, description: f.description, size: f.size ?? 4, offset: f.offset ?? 0, min: f.min, max: f.max, default: typeof f.default === 'number' || typeof f.default === 'boolean' ? f.default : undefined, values }
          : { type: 'struct', field: key, name: key, size: 0, offset: f.offset ?? 0, fields: [] }
        if (last && child.type === 'array') {
          child.count = f.count
          child.element = { type: f.type, size: Math.floor((f.size ?? 4) / (f.count ?? 1)), offset: f.offset ?? 0, min: f.min, max: f.max, default: typeof f.default === 'number' ? f.default : undefined }
        }
        node.fields = [...(node.fields ?? []), child]
      }
      node = child
    }
  }
  return root
}

export class DarktableMcp {
  private client: McpStdioClient | undefined

  constructor(private readonly install: DarktableInstall, private readonly configDir: string) {}

  async start(): Promise<McpStdioClient> {
    if (this.client !== undefined) return this.client
    if (this.install.mcp === undefined) throw new ChengyingError('engine-unavailable', 'darktable-mcp is not part of this darktable build')
    mkdirSync(this.configDir, { recursive: true })
    const c = new McpStdioClient(this.install.mcp, ['--core', '--configdir', this.configDir, '--cachedir', join(this.configDir, 'cache'), '--library', ':memory:', '--conf', 'write_sidecar_files=never', '--disable-opencl'])
    await c.start()
    this.client = c
    return c
  }

  async introspect(signal?: AbortSignal): Promise<DtIntrospection> {
    const c = await this.start()
    const list = await c.callJson<Array<{ operation: string; version: number; have_introspection: boolean; doc_url?: string }>>('list_modules', {})
    const modules: DtModule[] = []
    const notes: string[] = []
    for (const m of list) {
      signal?.throwIfAborted()
      if (!m.have_introspection) { modules.push({ operation: m.operation, moduleVersion: m.version, introspection: false, docUrl: m.doc_url }); continue }
      try {
        const schema = await c.callJson<{ fields: McpField[]; doc_url?: string; size?: number; title?: string }>('module_schema', { operation: m.operation })
        modules.push({ operation: m.operation, title: schema.title, moduleVersion: m.version, paramsVersion: m.version, introspection: true, paramsSize: schema.size, params: fieldsFromMcp(m.operation, schema.fields), docUrl: schema.doc_url ?? m.doc_url })
      } catch (error) {
        notes.push(`${m.operation}: ${errorMessage(error)}`)
        modules.push({ operation: m.operation, moduleVersion: m.version, introspection: false, error: errorMessage(error) })
      }
    }
    return { source: 'mcp', blendVersion: 14, modules, notes }
  }

  async encode(operation: string, fields: Record<string, unknown>): Promise<Buffer> {
    const c = await this.start()
    const r = await c.callJson<{ blob_hex: string }>('encode_params', { operation, fields })
    return Buffer.from(r.blob_hex, 'hex')
  }

  async tools(): Promise<Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>> {
    return await (await this.start()).listTools()
  }

  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    const c = await this.start()
    return await c.callTool(name, args)
  }

  async close(): Promise<void> {
    await this.client?.close()
    this.client = undefined
  }
}

/** Write a snapshot (used by the release tooling to ship catalogs for a darktable version). */
export function writeSnapshot(path: string, data: { version: string; blendVersion: number; modules: DtModule[] }): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(data))
}
