/**
 * Boot a real DeepSeek Harness headless run with the built Chengying bundle
 * inserted through a --patch overlay, pointed at the scripted mock model.
 * DSH_E2E_RUNTIME must name a directory where @deepseek-ai/dsh is installed.
 */
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const RUNTIME = process.env.DSH_E2E_RUNTIME
export const BUNDLE = resolve(process.cwd(), 'lib', 'index.js')

export function e2eAvailable(): boolean {
  return RUNTIME !== undefined && existsSync(join(RUNTIME, 'node_modules', '.bin', 'dsh')) && existsSync(BUNDLE)
}

export interface HeadlessRun { code: number | null; stdout: string; stderr: string; events: Array<Record<string, unknown>> }

export async function runHeadless(opts: { home: string; baseUrl: string; task: string; config: Record<string, unknown>; cwd: string; timeoutMs?: number; extraRows?: string }): Promise<HeadlessRun> {
  await mkdir(opts.home, { recursive: true })
  const patch = join(opts.home, 'chengying.patch.yml')
  await writeFile(patch, `- insert:
    - id: chengying
      name: '${BUNDLE}'
      config: ${JSON.stringify(opts.config)}
${opts.extraRows ?? ''}`)
  const bin = join(RUNTIME as string, 'node_modules', '.bin', 'dsh')
  return await new Promise((resolveRun, reject) => {
    const child = spawn(bin, ['--profile', 'headless', '--patch', patch, '--json', opts.task], {
      cwd: opts.cwd,
      env: {
        ...process.env,
        DSH_HOME: opts.home,
        DEEPSEEK_API_KEY: 'mock-key',
        DEEPSEEK_BASE_URL: opts.baseUrl,
        DSH_TELEMETRY_MODE: 'DISABLED',
        DSH_PERMISSION_MODE: 'full-access',
        NO_COLOR: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`headless run timed out\nSTDERR:\n${stderr.slice(-4000)}`)) }, opts.timeoutMs ?? 600_000)
    child.on('close', (code) => {
      clearTimeout(timer)
      const events = stdout.split('\n').filter(l => l.trim().startsWith('{')).map(l => { try { return JSON.parse(l) as Record<string, unknown> } catch { return {} } })
      resolveRun({ code, stdout, stderr, events })
    })
  })
}
