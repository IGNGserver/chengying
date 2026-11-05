import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { copyFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { ChengyingRuntime } from '../src/dsh/runtime.ts'
import { resolveConfig } from '../src/dsh/config.ts'
import { sessionTools } from '../src/dsh/tools/session.ts'
import { defaultPlan, inferGoal, readPlan, writePlan } from '../src/dsh/plan.ts'
import { deliverOriginals, writeDeliveryManifest } from '../src/core/export/deliver.ts'
import { resolveUserPath } from '../src/core/util/path.ts'
import type { HostContext, ToolRunContext } from '../src/dsh/host-types.ts'
import { buildTravelWorkspace, freshDir } from './helpers/fixtures.ts'

function stubCtx(services: Record<string, unknown> = {}): HostContext {
  return {
    get: (name: string) => services[name],
    effect: (fn: () => (() => void) | undefined | void) => fn(),
    inject: () => undefined,
    on: () => () => undefined,
    logger: () => console,
    tools: { register: () => () => undefined, restrict: () => () => undefined },
  } as unknown as HostContext
}

function execFor(ctx: HostContext, name: string, sessionId = 's1', cwd?: string): ToolRunContext {
  return {
    callId: 'call_1',
    name,
    arguments: {},
    signal: new AbortController().signal,
    agent: {
      id: 'agent_1',
      ctx,
      options: {},
      session: { id: sessionId, requestHeader: () => ({ cwd }) },
    },
  }
}

describe('session plan and intake', () => {
  let root: string
  let state: string
  let delivery: string
  let rt: ChengyingRuntime

  beforeAll(async () => {
    root = await freshDir('session-ws')
    state = await freshDir('session-state')
    delivery = await freshDir('session-delivery')
    await buildTravelWorkspace(root)
    rt = new ChengyingRuntime(stubCtx(), resolveConfig({ stateRoot: state, ui: { enabled: false, basePath: '/api/chengying' } }), console)
  })

  afterAll(async () => {
    await rt?.close()
  })

  it('expands ~ and relative paths against the session cwd', () => {
    expect(resolveUserPath('~')).toBe(homedir())
    expect(resolveUserPath('~/photos', '/tmp')).toBe(join(homedir(), 'photos'))
    // Build the expectation with node:path so the assertion holds on Windows too.
    expect(resolveUserPath('shots', '/tmp/work')).toBe(resolve('/tmp/work', 'shots'))
    expect(resolveUserPath('"shots"', '/tmp/work')).toBe(resolve('/tmp/work', 'shots'))
  })

  it('infers cull-only vs full delivery from natural language', () => {
    expect(inferGoal('这次只筛图，不要修')).toBe('cull')
    expect(inferGoal('筛图然后修图交付')).toBe('retouch-deliver')
    expect(inferGoal('直接 AI 重绘后导出')).toBe('retouch-deliver')
    expect(inferGoal('挑图，按行程选片')).toBe('cull')
  })

  it('records a cull-only plan and updates the same plan in place', async () => {
    const project = rt.openProject(root, 'agent_1', { cwd: root })
    const first = defaultPlan(project, 's1', root, { goal: 'cull', outputDir: join(delivery, 'picked'), cwd: root })
    writePlan(project, first)
    expect(first.retouch).toBe('none')
    expect(first.deliverMode).toBe('originals')
    expect(first.checkpoint).toBe('none')
    expect(readPlan(project, 's1')?.outputDir).toBe(join(delivery, 'picked'))
    expect(project.summary().plans).toHaveLength(1)

    const updated = defaultPlan(project, 's1', root, { goal: 'retouch-deliver', retouch: 'engine', existing: first, cwd: root })
    writePlan(project, updated)
    expect(updated.id).toBe(first.id)
    expect(updated.goal).toBe('retouch-deliver')
    expect(updated.retouch).toBe('engine')
    expect(readPlan(project, 's1')?.goal).toBe('retouch-deliver')

    const reopened = rt.openProject(root, 'agent_1', { exportDir: join(delivery, 'reopened'), cwd: root })
    expect(reopened.exportDir).toBe(join(delivery, 'reopened'))
  })

  it('photo_session_start opens a directory and records its scope', async () => {
    const tool = sessionTools(rt).find(t => t.name === 'photo_session_start')
    expect(tool).toBeDefined()
    const dir = join(delivery, 'started')
    const result = await tool?.execute({ path: root, goal: 'cull', output_dir: dir }, execFor(stubCtx(), 'photo_session_start', 's0', root)) as { plan: { goal: string; retouch: string; outputDir: string }; project: { exportDir: string } }
    expect(result.plan.goal).toBe('cull')
    expect(result.plan.retouch).toBe('none')
    expect(result.plan.outputDir).toBe(dir)
    expect(result.project.exportDir).toBe(dir)
  })

  it('starts a session from a chat attachment with no path', async () => {
    const attached = join(state, 'attached.jpg')
    await mkdir(state, { recursive: true })
    await copyFile(join(root, 'day1', 'DSC_0001.JPG'), attached)
    const sessions = {
      get: () => ({
        header: {},
        snapshotEvents: () => [{
          type: 'user/message',
          data: { source: { kind: 'user' }, content: [{ type: 'image', attachment: { attachmentId: 'a1', mediaType: 'image/jpeg', bytes: 1, width: 1, height: 1 } }] },
        }],
      }),
    }
    const attachments = {
      imageHostPath: () => attached,
      saveImage: async () => ({ attachmentId: 'x', mediaType: 'image/jpeg', bytes: 1, width: 1, height: 1 }),
      imageLimits: { mediaTypes: ['image/jpeg'], maxImageBytes: 1, maxMessageImageBytes: 1, maxImageDimension: 1, maxImagePixels: 1 },
    }
    const ctx = stubCtx({ sessions, attachments })
    const local = new ChengyingRuntime(ctx, resolveConfig({ stateRoot: state, ui: { enabled: false, basePath: '/api/chengying' } }), console)
    try {
      const tool = sessionTools(local).find(t => t.name === 'photo_session_start')
      expect(tool).toBeDefined()
      const result = await tool?.execute({ goal: 'cull', output_dir: join(delivery, 'attached') }, execFor(ctx, 'photo_session_start', 's2')) as { plan: { source: string; outputDir: string }; project: { root: string } }
      expect(result.plan.source).toMatch(/^attachments:/)
      expect(result.plan.outputDir).toBe(join(delivery, 'attached'))
      expect(result.project.root).toContain(join(state, 'inbox'))
      const project = local.project(undefined, 'agent_1')
      await project.scan()
      expect(project.repo.shotCount()).toBe(1)
    } finally {
      await local.close()
    }
  })

  it('delivers picked originals and writes a manifest', async () => {
    const project = rt.openProject(root, 'agent_1', { cwd: root })
    await project.scan()
    const { selectionId } = project.select({ count: 2 })
    const dir = join(delivery, 'originals')
    const out = deliverOriginals(project, { selectionId, dir, source: 'raster' })
    expect(out.failed).toBe(0)
    expect(out.exported).toBe(2)
    for (const item of out.items) {
      expect(item.path).toBeDefined()
      expect(existsSync(item.path as string)).toBe(true)
    }
    const manifest = writeDeliveryManifest(project, dir, {
      mode: 'originals',
      project: { id: project.id, root: project.root },
      plan: readPlan(project, 's1') ?? null,
      summary: { exported: out.exported, failed: out.failed, metadataVerified: true },
      items: out.items,
    })
    const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { format: string; mode: string; summary: { exported: number } }
    expect(parsed.format).toBe('chengying-delivery/1')
    expect(parsed.mode).toBe('originals')
    expect(parsed.summary.exported).toBe(2)
  })

  it('photo_deliver copies picked originals into the requested directory', async () => {
    const project = rt.openProject(root, 'agent_1', { cwd: root })
    const { selectionId } = project.select({ count: 2 })
    const tool = sessionTools(rt).find(t => t.name === 'photo_deliver')
    expect(tool).toBeDefined()
    const dir = join(delivery, 'tool-delivery')
    const result = await tool?.execute({ selection: selectionId, dir, mode: 'originals', background: false }, execFor(stubCtx(), 'photo_deliver', 's1', root)) as { exported: number; failed: number; dir: string; manifest?: string }
    expect(result.failed).toBe(0)
    expect(result.exported).toBe(2)
    expect(result.dir).toBe(dir)
    expect(result.manifest).toBeDefined()
    expect(existsSync(result.manifest as string)).toBe(true)
  })
})
