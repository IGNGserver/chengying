/**
 * Minimal stdio MCP client (JSON-RPC 2.0, newline-delimited) used to drive
 * engine-provided MCP servers such as darktable-mcp. Tool lists are read at
 * runtime, so tools added by a newer engine build appear automatically.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { ChengyingError } from '../util/errors.ts'

export interface McpTool { name: string; description?: string; inputSchema?: Record<string, unknown> }
export interface McpContent { type: string; text?: string; data?: string; mimeType?: string }
type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }

export class McpStdioClient {
  private child: ChildProcessWithoutNullStreams | undefined
  private buffer = ''
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly exits = new Map<ChildProcessWithoutNullStreams, Promise<void>>()
  private stderrTail = ''
  private startPromise: Promise<void> | undefined
  private closePromise: Promise<void> | undefined
  private closing = false
  serverInfo: Record<string, unknown> | undefined

  constructor(private readonly command: string, private readonly args: string[], private readonly options: { env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number } = {}) {}

  start(): Promise<void> {
    if (this.startPromise !== undefined) return this.startPromise
    if (this.child !== undefined && !this.closing) return Promise.resolve()
    if (this.closing) return Promise.reject(new ChengyingError('engine-unavailable', `${this.command} is closed`))
    const child = spawn(this.command, this.args, { env: this.options.env ?? process.env, cwd: this.options.cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child = child
    this.buffer = ''
    this.stderrTail = ''
    const exited = new Promise<void>((resolve) => { child.once('close', () => resolve()) })
    this.exits.set(child, exited)
    void exited.finally(() => { this.exits.delete(child) })
    child.on('exit', (code) => {
      this.rejectPending(new ChengyingError('engine-failed', `${this.command} exited (${code ?? 'unknown'}): ${this.stderrTail.slice(-800)}`))
      if (this.child === child) this.child = undefined
    })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (d: string) => this.onData(d))
    child.stderr.on('data', (d: Buffer) => { this.stderrTail = (this.stderrTail + d.toString()).slice(-4000) })
    child.on('error', (error) => this.rejectPending(new ChengyingError('engine-unavailable', `cannot start ${this.command}: ${error.message}`)))
    child.stdin.on('error', (error) => this.rejectPending(new ChengyingError('engine-failed', `${this.command} stdin failed: ${error.message}`)))
    this.startPromise = (async () => {
      try {
        const init = await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'chengying', version: '1' } }) as { serverInfo?: Record<string, unknown> }
        this.serverInfo = init.serverInfo
        this.notify('notifications/initialized', {})
      } catch (error) {
        await this.terminate(child)
        throw error
      } finally {
        this.startPromise = undefined
      }
    })()
    return this.startPromise
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error) }
    this.pending.clear()
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    if (this.buffer.length > 16 * 1024 * 1024 && !this.buffer.includes('\n')) {
      this.buffer = ''
      this.rejectPending(new ChengyingError('engine-failed', `${this.command} exceeded the 16 MiB response-line limit`))
      return
    }
    let nl: number
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim()
      this.buffer = this.buffer.slice(nl + 1)
      if (line === '' || !line.startsWith('{')) continue
      let msg: { id?: number; result?: unknown; error?: { message?: string; code?: number } }
      try { msg = JSON.parse(line) } catch { continue }
      if (msg.id === undefined) continue
      const pending = this.pending.get(msg.id)
      if (pending === undefined) continue
      this.pending.delete(msg.id)
      clearTimeout(pending.timer)
      if (msg.error !== undefined) pending.reject(new ChengyingError('engine-failed', `${this.command}: ${msg.error.message ?? 'error'} (${msg.error.code ?? ''})`))
      else pending.resolve(msg.result)
    }
  }

  private notify(method: string, params: unknown): void {
    const child = this.child
    if (child === undefined) throw new ChengyingError('engine-unavailable', `${this.command} is not running`)
    try { child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`) } catch (error) {
      throw new ChengyingError('engine-failed', `${this.command} notification failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  request(method: string, params: unknown, timeoutMs = this.options.timeoutMs ?? 300_000): Promise<unknown> {
    const child = this.child
    if (child === undefined || (this.closing && method !== 'shutdown')) return Promise.reject(new ChengyingError('engine-unavailable', `${this.command} is not running`))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new ChengyingError('engine-failed', `${this.command} ${method} timed out`)) }, Math.max(1, timeoutMs))
      timer.unref()
      this.pending.set(id, { resolve, reject, timer })
      try { child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`) } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new ChengyingError('engine-failed', `${this.command} request failed: ${error instanceof Error ? error.message : String(error)}`))
      }
    })
  }

  async listTools(): Promise<McpTool[]> {
    const result = await this.request('tools/list', {}) as { tools?: McpTool[] }
    return Array.isArray(result.tools) ? result.tools : []
  }

  async callTool(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<{ content: McpContent[]; isError?: boolean; structuredContent?: unknown }> {
    return await this.request('tools/call', { name, arguments: args }, timeoutMs) as { content: McpContent[]; isError?: boolean }
  }

  /** Call a tool whose text content is JSON; throws on isError. */
  async callJson<T>(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    const result = await this.callTool(name, args, timeoutMs)
    const text = (Array.isArray(result.content) ? result.content : []).filter(c => c.type === 'text').map(c => c.text ?? '').join('\n')
    if (result.isError === true) throw new ChengyingError('engine-failed', `${name}: ${text.slice(0, 1000)}`)
    try { return JSON.parse(text) as T } catch { return text as unknown as T }
  }

  private async terminate(child: ChildProcessWithoutNullStreams): Promise<void> {
    const exited = this.exits.get(child)
    if (exited === undefined || child.exitCode !== null || child.signalCode !== null) return
    try { if (this.child === child) await this.request('shutdown', {}, 5000) } catch { /* process may already be gone */ }
    if (child.exitCode === null && child.signalCode === null) child.kill()
    let timer: NodeJS.Timeout | undefined
    try {
      await Promise.race([exited, new Promise<void>(resolve => { timer = setTimeout(resolve, 5000); timer.unref() })])
    } finally { if (timer !== undefined) clearTimeout(timer) }
    if (this.child === child) this.child = undefined
    this.exits.delete(child)
  }

  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise
    this.closing = true
    this.closePromise = (async () => {
      try { await this.startPromise } catch { /* failed start already cleaned up */ }
      this.rejectPending(new ChengyingError('engine-unavailable', `${this.command} closed`))
      const child = this.child
      if (child !== undefined) await this.terminate(child)
    })()
    return this.closePromise
  }
}
