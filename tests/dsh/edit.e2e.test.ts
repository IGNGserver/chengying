import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildTravelWorkspace, freshDir } from '../helpers/fixtures.ts'
import { e2eAvailable, runHeadless } from './harness.ts'
import { firstUserText, startMockLlm, toolResults, type MockLlm, type MockReply, type MockRequest } from './mock-llm.ts'
import { Project } from '../../src/core/project.ts'

const enabled = e2eAvailable()

describe.skipIf(!enabled)('DSH e2e · phase 2 retouching with editing sub-agents', () => {
  let ws: string
  let home: string
  let state: string
  let llm: MockLlm
  const childRequests: MockRequest[] = []

  beforeAll(async () => {
    ws = await freshDir('e2e2-ws')
    home = await freshDir('e2e2-home')
    state = await freshDir('e2e2-state')
    await buildTravelWorkspace(ws)
  })
  afterAll(async () => { await llm?.close() })

  it('runs culling → tasks → sub-agent edits → verified export', async () => {
    const script = (req: MockRequest): MockReply => {
      const isChild = firstUserText(req).includes('You are a professional photo retoucher')
      const done = toolResults(req)
      if (isChild) {
        childRequests.push(req)
        switch (done.length) {
          case 0: return { tools: [{ name: 'edit_task_info', input: { view: true } }] }
          case 1: return { tools: [{ name: 'edit_apply', input: { ops: [{ op: 'add_step', step: { op: 'exposure', params: { ev: 0.4 } } }, { op: 'add_step', step: { op: 'tone', params: { shadows: 25 } } }], message: 'lift exposure and shadows' } }] }
          case 2: return { tools: [{ name: 'edit_preview', input: { compare: true } }] }
          case 3: return { tools: [{ name: 'edit_finish', input: { summary: 'brightened midtones and shadows' } }] }
          default: return { text: 'Retouch finished.' }
        }
      }
      if (!req.tools.some(t => t.name === 'photo_workspace_open')) return { text: 'Retouch trip' }
      switch (done.length) {
        case 0: return { tools: [{ name: 'photo_workspace_open', input: { path: ws } }] }
        case 1: return { tools: [{ name: 'photo_cull_run', input: { background: false } }] }
        case 2: return { tools: [{ name: 'photo_select', input: { count: 2, request: '选2张' } }] }
        case 3: return { tools: [{ name: 'edit_tasks_create', input: { instructions: 'natural, slightly brighter', engine: 'builtin' } }] }
        case 4: return { tools: [{ name: 'edit_run', input: { background: false, concurrency: 2 } }] }
        case 5: return { tools: [{ name: 'export_run', input: { background: false } }] }
        case 6: return { tools: [{ name: 'edit_tasks', input: {} }] }
        default: return { text: 'All done.' }
      }
    }
    llm = await startMockLlm(script)
    const run = await runHeadless({ home, baseUrl: llm.baseUrl, cwd: ws, task: '把这次旅行的照片挑两张修一下并导出', config: { stateRoot: state, ui: { enabled: false }, editing: { maxConcurrent: 2, previewEdge: 600 } } })
    const main = llm.requests.filter(r => !firstUserText(r).includes('You are a professional photo retoucher') && r.tools.some(t => t.name === 'photo_workspace_open')).at(-1)
    const results = main === undefined ? [] : toolResults(main)
    if (run.code !== 0 || results.length < 7 || results.some(r => r.isError)) {
      console.log('STDERR', run.stderr.slice(-5000))
      console.log('RESULTS', JSON.stringify(results.map(r => ({ e: r.isError, t: r.text.slice(0, 600) }))))
    }
    expect(run.code).toBe(0)
    expect(results).toHaveLength(7)
    for (const r of results) expect(r.isError, r.text.slice(0, 400)).toBe(false)

    // Sub-agents: one conversation per task, task-bound tools only, no shell/filesystem tools.
    const childTools = new Set(childRequests[0]?.tools.map(t => t.name))
    if (childTools.has('bash') || !childTools.has('edit_apply')) console.log('CHILD TOOLS', [...childTools].join(','), '\nSTDERR', run.stderr.slice(-3000))
    expect(childTools.has('edit_apply')).toBe(true)
    expect(childTools.has('edit_finish')).toBe(true)
    expect(childTools.has('edit_describe')).toBe(true)
    expect(childTools.has('bash')).toBe(false)
    expect(childTools.has('photo_select')).toBe(false)
    const applyTool = childRequests[0]?.tools.find(t => t.name === 'edit_apply') as { input_schema?: { properties?: Record<string, unknown> } } | undefined
    expect(Object.keys(applyTool?.input_schema?.properties ?? {})).not.toContain('task')
    const childConversations = new Set(childRequests.map(r => firstUserText(r).match(/task (task_[a-z0-9]+)/)?.[1]))
    expect(childConversations.size).toBe(2)

    const exportResult = JSON.parse(results[5]?.text ?? '{}') as { exported: number; metadataVerified: boolean }
    expect(exportResult.exported).toBe(2)
    expect(exportResult.metadataVerified).toBe(true)

    const p = Project.open(ws, { stateRoot: state })
    try {
      const tasks = p.repo.tasks()
      expect(tasks).toHaveLength(2)
      for (const t of tasks) {
        expect(t.status).toBe('succeeded')
        expect(t.usage.calls).toBeGreaterThan(0)
        const revs = p.repo.revisions(t.id)
        expect(revs.length).toBeGreaterThanOrEqual(2)
        expect(revs.at(-1)?.doc.stages[0]?.steps.map(s => s.op)).toEqual(['exposure', 'tone'])
        expect(p.repo.events({ taskId: t.id }).some(e => e.type === 'summary')).toBe(true)
      }
      expect(p.repo.usageSummary().some(u => u.purpose === 'edit-agent' && u.calls > 0)).toBe(true)
      expect(p.repo.exports().every(e => e.verified)).toBe(true)
    } finally {
      await p.close()
    }
  })
})
