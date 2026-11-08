import { describe, expect, it } from 'vitest'
import { parsePp3, writePp3, type Pp3 } from '../src/core/edit/engines/rawtherapee/pp3.ts'
import { guardRawTherapeeProfilePaths } from '../src/core/edit/engines/rawtherapee/index.ts'
import { EditOrchestrator } from '../src/dsh/orchestrator.ts'
import type { HostContext } from '../src/dsh/host-types.ts'

 describe('security and engine remediation', () => {
  it('round-trips GLib PP3 strings without double escaping', () => {
    const original: Pp3 = new Map([['Film Simulation', new Map([['ClutFilename', ' C:\\looks\\A\\B\nline\ttab\rreturn']])]])
    const once = writePp3(original)
    const parsed = parsePp3(once)
    expect(parsed.get('Film Simulation')?.get('ClutFilename')).toBe(original.get('Film Simulation')?.get('ClutFilename'))
    expect(writePp3(parsed)).toBe(once)
  })

  it('guards RawTherapee external paths but preserves built-in profiles', () => {
    const profile: Pp3 = new Map([
      ['Film Simulation', new Map([['ClutFilename', '/outside/clut.png']])],
      ['Color Management', new Map([['OutputProfile', 'RTv4_sRGB'], ['InputProfile', '/outside/input.icc']])],
    ])
    const seen: string[] = []
    guardRawTherapeeProfilePaths(profile, path => { seen.push(path); return `/allowed${path}` })
    expect(seen).toEqual(['/outside/clut.png', '/outside/input.icc'])
    expect(profile.get('Color Management')?.get('OutputProfile')).toBe('RTv4_sRGB')
    expect(() => guardRawTherapeeProfilePaths(profile, undefined)).toThrow(/read guard/)
  })

  it('fails closed when editing-child tools cannot be restricted', () => {
    let created: ((event: { agent: unknown }) => void) | undefined
    const ctx = {
      on: (event: string, fn: (event: { agent: unknown }) => void) => { if (event === 'agent/created') created = fn; return () => undefined },
      tools: { register: () => () => undefined, restrict: () => () => undefined },
    } as unknown as HostContext
    const rt = { config: { editing: { childProvider: 'spawn' } }, log: { info() {}, warn() {}, error() {} } }
    const orchestrator = new EditOrchestrator(rt as never, ctx)
    orchestrator.attach()
    const childId = 'child-isolation-test'
    ;(orchestrator as unknown as { children: Map<string, unknown> }).children.set(childId, { projectId: 'p', taskId: 't' })
    let registrations = 0
    let disposals = 0
    const restrictions: unknown[] = []
    const agent = {
      id: childId,
      ctx: {
        tools: {
          register: () => { registrations++; return () => { disposals++ } },
          restrict: (arg: unknown) => { restrictions.push(arg); throw new Error('restrict unavailable') },
        },
        effect: () => { throw new Error('effect must not be reached') },
      },
    }
    created?.({ agent })
    const child = (orchestrator as unknown as { children: Map<string, { setupError?: string; ready?: boolean }> }).children.get(childId)
    expect(child?.setupError).toContain('restrict unavailable')
    expect(child?.ready).not.toBe(true)
    expect(registrations).toBeGreaterThan(0)
    expect(disposals).toBe(registrations)
    expect(restrictions).toHaveLength(2)
    expect(restrictions[1]).toEqual({ allow: [] })
  })
})
