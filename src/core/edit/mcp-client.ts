/**
 * Minimal stdio MCP client (JSON-RPC 2.0, newline-delimited) used to drive
 * engine-provided MCP servers such as darktable-mcp. Tool lists are read at
 * runtime, so tools added by a newer engine build appear automatically.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { ChengyingError } from '../util/errors.ts'

export interface McpTool { name: string; description?: string; inputSchema?: Record<string, unknown> }
export interface McpContent { type: string; text?: string; data?: string; mimeType?: string }

export class McpStdioClient {
  private child: ChildProcessWithoutNullStreams | undefined
  private buffer = ''
  private nextId = 1
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()
  private stderrTail = ''
  serverInfo: Record<string, unknown> | undefined

  constructor(private readonly command: string, private readonly args: string[], private readonly options: { env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number } = {}) {}

  async start(): Promise<void> {
    if (this.child !== undefined) return
    const child = spawn(this.command, this.args, { env: this.options.env ?? process.env, cwd: this.options.cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child = child
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (d: string) => this.onData(d))
    child.stderr.on('data', (d: Buffer) => { this.stderrTail = (this.stderrTail + d.toString()).slice(-4000) })
    child.on('exit', (code) => {
      for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new ChengyingError('engine-failed', `${this.command} exited (${code}): ${this.stderrTail.slice(-800)}`)) }
      this.pending.clear()
      this.child = undefined
    })
    child.on('error', (e) => {
      for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new ChengyingError('engine-unavailable', `cannot start ${this.command}: ${e.message}`)) }
      this.pending.clear()
    })
    const init = await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'chengying', version: '1' } }) as { serverInfo?: Record<string, unknown> }
    this.serverInfo = init.serverInfo
    this.notify('notifications/initialized', {})
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    let nl: number
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim()
      this.buffer = this.buffer.slice(nl + 1)
      if (line === '' || !line.startsWith('{')) continue
      let msg: { id?: number; result?: unknown; error?: { message?: string; code?: number } }
      try { msg = JSON.parse(line) } catch { continue }
      if (msg.id === undefined) continue
      const p = this.pending.get(msg.id)
      if (p === undefined) continue
      this.pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.error !== undefined) p.reject(new ChengyingError('engine-failed', `${this.command}: ${msg.error.message ?? 'error'} (${msg.error.code ?? ''})`))
      else p.resolve(msg.result)
    }
  }

  private notify(method: string, params: unknown): void {
    this.child?.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  }

  request(method: string, params: unknown, timeoutMs = this.options.timeoutMs ?? 300_000): Promise<unknown> {
    const child = this.child
    if (child === undefined) return Promise.reject(new ChengyingError('engine-unavailable', `${this.command} is not running`))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new ChengyingError('engine-failed', `${this.command} ${method} timed out`)) }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  async listTools(): Promise<McpTool[]> {
    const r = await this.request('tools/list', {}) as { tools?: McpTool[] }
    return r.tools ?? []
  }

  async callTool(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<{ content: McpContent[]; isError?: boolean; structuredContent?: unknown }> {
    return await this.request('tools/call', { name, arguments: args }, timeoutMs) as { content: McpContent[]; isError?: boolean }
  }

  /** Call a tool whose text content is JSON; throws on isError. */
  async callJson<T>(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    const r = await this.callTool(name, args, timeoutMs)
    const text = r.content.filter(c => c.type === 'text').map(c => c.text ?? '').join('\n')
    if (r.isError) throw new ChengyingError('engine-failed', `${name}: ${text.slice(0, 1000)}`)
    try { return JSON.parse(text) as T } catch { return text as unknown as T }
  }

  async close(): Promise<void> {
    const c = this.child
    if (c === undefined) return
    try { await this.request('shutdown', {}, 5000) } catch { /* ignore */ }
    c.kill()
    this.child = undefined
  }
}
