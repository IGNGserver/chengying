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
  env: Array<Record<string, unknown>>
  skills: string[]
}

function capture(options: { presets?: boolean; profile?: string; extras?: boolean } = {}): Capture {
  const tools: string[] = []
  const sections: string[] = []
  const env: Array<Record<string, unknown>> = []
  const skills: string[] = []
  const systemPrompt = { section: (spec: { name?: string }) => { sections.push(String(spec.name)); return () => undefined } }
  const services = new Map<string, unknown>([['systemPrompt', systemPrompt]])
  if (options.extras === true) {
    services.set('shellEnv', { register: (contributor: Record<string, unknown>) => { env.push(contributor); return () => undefined } })
    services.set('skills', { register: (skill: { name?: string }) => { skills.push(String(skill.name)); return () => undefined } })
  }
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
  return { ctx, tools, sections, services, env, skills }
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

  it('keeps every existing photo tool and adds the integrity tool', () => {
    const c = capture()
    apply(c.ctx, resolveConfig({ ...base, mode: 'agent' }))
    const photoTools = [
      'edit_apply', 'edit_capabilities', 'edit_describe', 'edit_engines', 'edit_finish', 'edit_generate', 'edit_native',
      'edit_preview', 'edit_revert', 'edit_run', 'edit_style_reference', 'edit_task', 'edit_task_info', 'edit_tasks',
      'edit_tasks_create', 'edit_unify_style', 'export_run', 'gen_authorizations', 'gen_authorize', 'photo_ai_redraw',
      'photo_cull_run', 'photo_deliver', 'photo_flag', 'photo_groups', 'photo_models_run', 'photo_preferences',
      'photo_preview', 'photo_query', 'photo_score', 'photo_select', 'photo_selection', 'photo_session_start',
      'photo_status', 'photo_view', 'photo_vlm_score', 'photo_workspace_import', 'photo_workspace_open',
    ]
    expect(c.tools).toEqual(expect.arrayContaining(photoTools))
    expect(c.tools).toContain('photo_integrity_check')
  })

  it('host mode contributes workspace shell variables and packaged skills', () => {
    const c = capture({ extras: true })
    apply(c.ctx, resolveConfig({ ...base, mode: 'host' }))
    expect(c.tools).toEqual([])
    expect(c.skills).toEqual(['chengying-aesthetic-grading', 'chengying-style-recipes', 'chengying-engine-mastery', 'chengying-batch-ops', 'chengying-engine-troubleshoot'])
    expect(c.env).toHaveLength(1)
    expect(c.env[0]?.name).toBe('chengying')
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

  it('adds the general tool rows without removing the photo surface', () => {
    const preset = readFileSync(join(process.cwd(), 'presets', 'chengying.patch.yml'), 'utf8')
    for (const id of [
      'tool-bash', 'tool-pwsh', 'tool-jobs', 'tool-present', 'skill-filesystem', 'tool-skill',
      'command-goal', 'tool-goal', 'tool-schedule', 'tool-subagent', 'tool-subagent-fork',
      'tool-workflow', 'plan-mode',
    ]) {
      expect(preset, `missing preset row ${id}`).toContain(`id: ${id}`)
    }
    expect(preset).toContain("disabled: !!js process.platform === 'win32'")
    expect(preset).toContain("disabled: !!js process.platform !== 'win32'")
    expect(preset).toContain("ctx.get('schedule')")
    expect(preset).toContain('id: chengying-agent')
  })
})
