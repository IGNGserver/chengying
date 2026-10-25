import { spawn } from 'node:child_process'
import { ChengyingError } from './errors.ts'

export interface RunOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  signal?: AbortSignal
  /** Maximum bytes kept per stream (the tail is kept). */
  maxOutputBytes?: number
  input?: string | Buffer
}

export interface RunResult {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
}

/** Spawn without a shell, capture bounded output, honor timeout and cancellation. */
export function run(command: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  const max = options.maxOutputBytes ?? 4 * 1024 * 1024
  const started = Date.now()
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new ChengyingError('cancelled', `cancelled before starting ${command}`))
      return
    }
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0)
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0)
    const append = (prev: Buffer<ArrayBufferLike>, data: Buffer): Buffer<ArrayBufferLike> => {
      const next = Buffer.concat([prev, data])
      return next.length > max ? next.subarray(next.length - max) : next
    }
    child.stdout.on('data', (d: Buffer) => { stdout = append(stdout, d) })
    child.stderr.on('data', (d: Buffer) => { stderr = append(stderr, d) })
    let timedOut = false
    const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, options.timeoutMs)
    const onAbort = (): void => { child.kill('SIGKILL') }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', (error) => {
      if (timer) clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      reject(new ChengyingError('engine-unavailable', `cannot start ${command}: ${error.message}`, { command }, { cause: error }))
    })
    child.on('close', (code, sig) => {
      if (timer) clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      if (options.signal?.aborted) {
        reject(new ChengyingError('cancelled', `${command} cancelled`))
        return
      }
      resolve({ code, signal: sig, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), durationMs: Date.now() - started, timedOut })
    })
    if (options.input !== undefined) child.stdin.end(options.input)
    else child.stdin.end()
  })
}

/** Like run() but throws engine-failed on a non-zero exit. */
export async function runChecked(command: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  const result = await run(command, args, options)
  if (result.code !== 0) {
    const tail = (result.stderr || result.stdout).split('\n').slice(-25).join('\n')
    throw new ChengyingError('engine-failed', `${command} exited with ${result.timedOut ? 'timeout' : result.code ?? result.signal}: ${tail}`, {
      command, code: result.code, timedOut: result.timedOut,
    })
  }
  return result
}
