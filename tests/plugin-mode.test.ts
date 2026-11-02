import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { apply } from '../src/dsh/index.ts'
import { resolveConfig } from '../src/dsh/config.ts'
import type { HostContext } from '../src/dsh/host-types.ts'

interface Capture {
  ctx: HostContext
  tools: string[]
  sections: string[]
  services: Map<string, unknown>
}

function capture(options: { presets?: boolean; profile?: string } = {}): Capture {
  const tools: string[] = []
  const sections: string[] = []
  const systemPrompt = { section: (spec: { name?: string }) => { sections.push(String(spec.name)); return () => undefined } }
  const services = new Map<string, unknown>([['systemPrompt', systemPrompt]])
  const ctx = {
    get: (name: string) => name === 'agentPresets' && options.presets === true ? {} : name === 'profileContext' && options.profile !== undefined ? { name: options.profile } : services.get(name),
    provide: (name: string, value: unknown) => { services.set(name, value); return () => services.delete(name) },
    effect: (fn: () => (() => void) | undefined | void) => fn(),
    inject: (_deps: string[], fn: (c: HostContext) => void) => fn(ctx as unknown as HostContext),
    on: () => () => undefined,
    logger: () => ({ info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined }),
    tools: {
      register: (tool: { name: string }) => { tools.push(tool.name); return () => undefined },
      restrict: () => () => undefined,
    },
    systemPrompt: { section: (spec: { name?: string }) => { sections.push(String(spec.name)); return () => undefined } },
  } as unknown as HostContext
  return { ctx, tools, sections, services }
}

const base = { ui: { enabled: false, basePath: '/api/chengying' } }

describe('Host / agent preset split', () => {
  it('host mode only provides the runtime (no model tools)', () => {
    const c = capture()
    apply(c.ctx, resolveConfig({ ...base, mode: 'host' }))
    expect(c.tools).toEqual([])
    expect(c.services.has('chengyingRuntime')).toBe(true)
  })

  it('agent mode registers the photo tools and the workflow prompt', () => {
    const c = capture()
    apply(c.ctx, resolveConfig({ ...base, mode: 'agent' }))
    expect(c.tools).toEqual(expect.arrayContaining(['photo_session_start', 'photo_workspace_import', 'photo_deliver', 'photo_ai_redraw', 'photo_cull_run', 'edit_run']))
    expect(c.sections).toContain('chengying:workflow')
  })

  it('auto scopes tools to presets when a preset roster exists, and keeps both otherwise', () => {
    const web = capture({ presets: true })
    apply(web.ctx, resolveConfig({ ...base, mode: 'auto' }))
    expect(web.tools).toEqual([])
    expect(web.services.has('chengyingRuntime')).toBe(true)

    const headless = capture()
    apply(headless.ctx, resolveConfig({ ...base, mode: 'auto' }))
    expect(headless.tools).toEqual(expect.arrayContaining(['photo_session_start', 'photo_deliver']))

    const webProfile = capture({ profile: 'web' })
    apply(webProfile.ctx, resolveConfig({ ...base, mode: 'auto' }))
    expect(webProfile.tools).toEqual([])
  })

  it('ships the preset patch in the bundle', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { dsh: { bundle: { patch: string[] } } }
    expect(pkg.dsh.bundle.patch).toContain('./presets/chengying.patch.yml')
    const preset = readFileSync(join(process.cwd(), 'presets', 'chengying.patch.yml'), 'utf8')
    expect(preset).toContain("@deepseek-ai/dsh-agent-preset")
    expect(preset).toContain('id: chengying')
    expect(preset).toContain('mode: agent')
  })
})
