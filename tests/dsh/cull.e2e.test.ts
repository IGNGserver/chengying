import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { buildTravelWorkspace, freshDir } from '../helpers/fixtures.ts'
import { e2eAvailable, runHeadless } from './harness.ts'
import { startMockLlm, toolResults, type MockLlm, type MockRequest } from './mock-llm.ts'
import { Project } from '../../src/core/project.ts'

const enabled = e2eAvailable()

describe.skipIf(!enabled)('DSH e2e · phase 1 culling through a real Harness agent loop', () => {
  let ws: string
  let home: string
  let state: string
  let llm: MockLlm

  beforeAll(async () => {
    ws = await freshDir('e2e-ws')
    home = await freshDir('e2e-home')
    state = await freshDir('e2e-state')
    await buildTravelWorkspace(ws)
  })
  afterAll(async () => { await llm?.close() })

  it('opens, culls, selects and adjusts via tools', async () => {
    const steps = (req: MockRequest): ReturnType<Parameters<typeof startMockLlm>[0]> => {
      if (!req.tools.some(t => t.name === 'photo_workspace_open')) return { text: 'Photo culling' }
      const done = toolResults(req)
      switch (done.length) {
        case 0: return { tools: [{ name: 'photo_workspace_open', input: { path: ws } }] }
        case 1: return { tools: [{ name: 'photo_cull_run', input: { background: false } }] }
        case 2: return { tools: [{ name: 'photo_select', input: { request: '帮我选4张最好的，按行程讲故事', count: 4 } }] }
        case 3: {
          const sel = JSON.parse(done[2]?.text ?? '{}') as { selectionId?: string; shots?: Array<{ id: string }> }
          return { tools: [{ name: 'photo_selection', input: { action: 'adjust', selection: sel.selectionId, remove: [sel.shots?.[0]?.id] } }] }
        }
        case 4: return { tools: [{ name: 'photo_status', input: {} }] }
        default: return { text: 'Selected 4 photos; one removed at your request.' }
      }
    }
    llm = await startMockLlm(steps)
    const run = await runHeadless({ home, baseUrl: llm.baseUrl, cwd: ws, task: `请帮我筛选 ${ws} 里的旅行照片`, config: { stateRoot: state, ui: { enabled: false } } })
    const last = llm.requests.at(-1)
    const results = last === undefined ? [] : toolResults(last)
    if (results.length < 5 || run.code !== 0) {
      console.log('STDERR', run.stderr.slice(-6000))
      console.log('RESULTS', JSON.stringify(results).slice(0, 4000))
    }
    expect(run.code).toBe(0)
    expect(results).toHaveLength(5)
    for (const r of results) expect(r.isError, r.text.slice(0, 500)).toBe(false)
    const cull = JSON.parse(results[1]?.text ?? '{}') as { scan?: { shots: number }; analyze?: { analyzed: number } }
    expect(cull.scan?.shots).toBe(11)
    expect(cull.analyze?.analyzed).toBe(11)
    const sel = JSON.parse(results[2]?.text ?? '{}') as { selectionId: string; shots: unknown[] }
    expect(sel.shots).toHaveLength(4)
    // The plugin's state is real and persistent: reopen it from disk.
    const p = Project.open(ws, { stateRoot: state })
    try {
      const s = p.repo.selection(sel.selectionId)
      expect(s?.items.filter(i => i.included)).toHaveLength(3)
      expect(p.profile().examples).toBe(1)
    } finally {
      await p.close()
    }
    // The workflow guidance reached the system prompt; our tools reached the model.
    expect(llm.requests.some(r => r.system.includes('澄影 Chengying photo workflow'))).toBe(true)
    expect(join(state)).toBeTruthy()
  })
})
