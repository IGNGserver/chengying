import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { ChengyingRuntime } from '../src/dsh/runtime.ts'
import { resolveConfig } from '../src/dsh/config.ts'
import { defaultPlan, writePlan } from '../src/dsh/plan.ts'
import { aiTools } from '../src/dsh/tools/ai.ts'
import type { HostContext, ToolRunContext } from '../src/dsh/host-types.ts'
import { buildTravelWorkspace, freshDir } from './helpers/fixtures.ts'

function stubCtx(): HostContext {
  return {
    get: () => undefined,
    effect: (fn: () => (() => void) | undefined | void) => fn(),
    inject: () => undefined,
    on: () => () => undefined,
    logger: () => console,
    tools: { register: () => () => undefined, restrict: () => () => undefined },
  } as unknown as HostContext
}

function execFor(ctx: HostContext, name: string): ToolRunContext {
  return {
    callId: 'call_redraw',
    name,
    arguments: {},
    signal: new AbortController().signal,
    agent: { id: 'agent_redraw', ctx, options: {}, session: { id: 'redraw-session', requestHeader: () => ({}) } },
  }
}

describe('batch AI redraw', () => {
  let root: string
  let state: string
  let tools: string
  let rt: ChengyingRuntime
  let selectionId: string

  beforeAll(async () => {
    root = await freshDir('redraw-ws')
    state = await freshDir('redraw-state')
    tools = await freshDir('redraw-tools')
    await buildTravelWorkspace(root)
    const sharpPath = pathToFileURL(createRequire(join(process.cwd(), 'package.json')).resolve('sharp')).href
    writeFileSync(join(tools, 'fake-gen.mjs'), `import sharp from ${JSON.stringify(sharpPath)}
const a = process.argv.slice(2); const input = a[0]; const output = a[2]
await sharp(input).png().toFile(output)
`)
    rt = new ChengyingRuntime(stubCtx(), resolveConfig({
      stateRoot: state,
      ui: { enabled: false, basePath: '/api/chengying' },
      generative: { providers: [{ id: 'fake', type: 'command', command: process.execPath, args: [join(tools, 'fake-gen.mjs'), '{input}', '{mask}', '{output}', '{prompt}'] }], requireApproval: true },
      editing: { subagentProvider: 'spawn', maxConcurrent: 2, maxAttempts: 3, maxRevisionsPerTask: 8, maxTokensPerTask: 120_000, previewEdge: 1400 },
    }), console)
    const project = rt.openProject(root, 'agent_redraw')
    await project.scan()
    await project.buildPreviews()
    await project.analyze()
    const selection = project.select({ count: 2 })
    selectionId = selection.selectionId
    writePlan(project, defaultPlan(project, 'redraw-session', root, { goal: 'retouch-deliver', retouch: 'generative' }))
    project.repo.addAuthorization({ scope: 'generative', shotId: null, taskId: null, grantedBy: 'user (test)', note: 'batch redraw', expiresAt: null, maxUses: 2 })
  }, 180_000)

  afterAll(async () => { await rt?.close() })

  it('runs one provider call per selected photo under one batch grant', async () => {
    const project = rt.project(undefined, 'agent_redraw')
    const tool = aiTools(rt).find(t => t.name === 'photo_ai_redraw')
    expect(tool).toBeDefined()
    const result = await tool?.execute({ selection: selectionId, prompt: 'repaint the sky', kind: 'edit', background: false, replace: true, confirm: true }, execFor(stubCtx(), 'photo_ai_redraw')) as { processed: number; failed: number; results: Array<{ task?: string; error?: string }> }
    expect(result.failed).toBe(0)
    expect(result.processed).toBe(2)
    const tasks = project.repo.tasks()
    expect(tasks).toHaveLength(2)
    for (const task of tasks) {
      expect(task.status).toBe('succeeded')
      const head = project.repo.revision(task.headRevision as string)
      expect(head?.doc.provenance?.generative).toBe(true)
      expect(head?.doc.stages.some(stage => stage.steps.some(step => step.op === 'gen_layer'))).toBe(true)
    }
    const used = project.repo.authorizations().find(a => a.scope === 'generative')
    expect(used?.uses).toBe(2)
  }, 240_000)
})
