import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildTravelWorkspace, freshDir } from '../helpers/fixtures.ts'
import { e2eAvailable, runHeadless } from './harness.ts'
import { firstUserText, startMockLlm, toolResults, type MockLlm, type MockReply, type MockRequest } from './mock-llm.ts'
import { Project } from '../../src/core/project.ts'

const enabled = e2eAvailable()
const CHILD = 'You are a professional photo retoucher'

describe.skipIf(!enabled)('DSH e2e · phase 3 AI stage and generative authorization', () => {
  let ws: string
  let home: string
  let state: string
  let llm: MockLlm
  const childRequests: MockRequest[] = []

  beforeAll(async () => {
    ws = await freshDir('e2e3-ws')
    home = await freshDir('e2e3-home')
    state = await freshDir('e2e3-state')
    await buildTravelWorkspace(ws)
  })
  afterAll(async () => { await llm?.close() })

  it('runs AI-stage edits, refuses generative edits without the user, unifies the look', async () => {
    const gen = join(home, 'fake-gen.mjs')
    writeFileSync(gen, 'process.exit(9)\n') // must never run: no authorization exists
    let referenceShot = ''
    const script = (req: MockRequest): MockReply => {
      const done = toolResults(req)
      if (firstUserText(req).includes(CHILD)) {
        childRequests.push(req)
        switch (done.length) {
          case 0: return { tools: [{ name: 'edit_task_info', input: {} }] }
          case 1: return { tools: [{ name: 'edit_apply', input: { ops: [{ op: 'add_step', stage: 'ai', step: { op: 'inpaint', params: { radius: 4 }, mask: { shapes: [{ type: 'circle', cx: 0.5, cy: 0.5, r: 0.02 }] } } }, { op: 'add_step', stage: 'ai', step: { op: 'upscale', params: { scale: 1.5, method: 'lanczos' } } }], message: 'remove a speck, enlarge' } }] }
          case 2: return { tools: [{ name: 'edit_generate', input: { kind: 'fill', prompt: 'blue sky', mask: { shapes: [{ type: 'rectangle', x: 0, y: 0, w: 0.2, h: 0.2 }] }, reason: 'test refusal' } }] }
          case 3: return { tools: [{ name: 'edit_finish', input: { summary: 'non-generative cleanup; generative fill was not authorized' } }] }
          default: return { text: 'done' }
        }
      }
      if (!req.tools.some(t => t.name === 'photo_workspace_open')) return { text: 'AI trip' }
      switch (done.length) {
        case 0: return { tools: [{ name: 'photo_workspace_open', input: { path: ws } }] }
        case 1: return { tools: [{ name: 'photo_cull_run', input: { background: false } }] }
        case 2: return { tools: [{ name: 'photo_select', input: { count: 2, request: '选2张' } }] }
        case 3: return { tools: [{ name: 'edit_tasks_create', input: { instructions: 'clean up, keep it natural', engine: 'builtin', ai_stage: true } }] }
        case 4: {
          referenceShot = (JSON.parse(done[3]?.text ?? '{}') as { created?: Array<{ shot: string }> }).created?.[0]?.shot ?? ''
          return { tools: [{ name: 'gen_authorize', input: { reason: 'sky replacement test' } }] }
        }
        case 5: return { tools: [{ name: 'edit_run', input: { background: false, concurrency: 2 } }] }
        case 6: return { tools: [{ name: 'edit_unify_style', input: { reference: referenceShot, strength: 0.4 } }] }
        case 7: return { tools: [{ name: 'gen_authorizations', input: {} }] }
        case 8: return { tools: [{ name: 'export_run', input: { background: false } }] }
        default: return { text: 'All done.' }
      }
    }
    llm = await startMockLlm(script)
    const run = await runHeadless({
      home, baseUrl: llm.baseUrl, cwd: ws, task: '挑两张做 AI 后期',
      config: { stateRoot: state, ui: { enabled: false }, editing: { maxConcurrent: 2, previewEdge: 500 }, generative: { providers: [{ id: 'fake', type: 'command', command: process.execPath, args: [gen, '{input}', '{mask}', '{output}', '{prompt}'] }] } },
    })
    const main = llm.requests.filter(r => !firstUserText(r).includes(CHILD) && r.tools.some(t => t.name === 'photo_workspace_open')).at(-1)
    const results = main === undefined ? [] : toolResults(main)
    if (run.code !== 0 || results.length < 9) {
      console.log('STDERR', run.stderr.slice(-4000))
      console.log('RESULTS', JSON.stringify(results.map(r => ({ e: r.isError, t: r.text.slice(0, 500) }))))
    }
    expect(run.code).toBe(0)
    expect(results).toHaveLength(9)
    // gen_authorize: no interactive user in a headless run → not granted, never self-granted.
    expect(results[4]?.text).toMatch(/"granted": false|authoriz/i)
    expect(results[4]?.text).not.toMatch(/"granted": true/)
    for (const i of [0, 1, 2, 3, 5, 6, 7, 8]) expect(results[i]?.isError, results[i]?.text.slice(0, 300)).toBe(false)
    const unify = JSON.parse(results[6]?.text ?? '{}') as { updated: number }
    expect(unify.updated).toBe(1)
    const auths = JSON.parse(results[7]?.text ?? '{}') as { authorizations: unknown[] }
    expect(auths.authorizations).toHaveLength(0)

    // Children had the AI tools; their generative request was refused.
    const childTools = new Set(childRequests[0]?.tools.map(t => t.name))
    for (const t of ['edit_generate', 'edit_style_reference', 'edit_apply']) expect(childTools.has(t), t).toBe(true)
    expect(childTools.has('gen_authorize')).toBe(false)
    const lastChild = childRequests.filter(r => toolResults(r).length >= 3)
    expect(lastChild.length).toBeGreaterThanOrEqual(2)
    for (const r of lastChild) {
      const genResult = toolResults(r)[2]
      expect(genResult?.isError).toBe(true)
      expect(genResult?.text).toMatch(/authorization/)
    }

    const p = Project.open(ws, { stateRoot: state })
    try {
      const tasks = p.repo.tasks()
      expect(tasks).toHaveLength(2)
      for (const t of tasks) {
        expect(t.status).toBe('succeeded')
        const doc = p.repo.revision(t.headRevision as string)?.doc
        const ai = doc?.stages.find(s => s.engine === 'ai')
        expect(ai?.steps.map(s => s.op)).toEqual(expect.arrayContaining(['inpaint', 'upscale']))
        expect(ai?.steps.some(s => s.op.startsWith('gen_'))).toBe(false)
        expect(doc?.provenance?.generative).not.toBe(true)
      }
      expect(tasks.filter(t => p.repo.revision(t.headRevision as string)?.doc.stages.some(s => s.steps.some(x => x.op === 'style_match')))).toHaveLength(1)
      const ex = p.repo.exports()
      expect(ex.length).toBeGreaterThanOrEqual(2)
      expect(ex.every(e => e.verified)).toBe(true)
    } finally {
      await p.close()
    }
  })

  it('creates an authorized generative layer through a sub-agent and tags the export', async () => {
    const ws2 = await freshDir('e2e3b-ws')
    const home2 = await freshDir('e2e3b-home')
    const state2 = await freshDir('e2e3b-state')
    await buildTravelWorkspace(ws2)
    const { createRequire } = await import('node:module')
    const { pathToFileURL } = await import('node:url')
    const sharpUrl = pathToFileURL(createRequire(join(process.cwd(), 'package.json')).resolve('sharp')).href
    const gen = join(home2, 'fake-gen.mjs')
    writeFileSync(gen, `import sharp from ${JSON.stringify(sharpUrl)}
const [input, mask, output, prompt] = process.argv.slice(2)
const m = await sharp(input).metadata()
await sharp({ create: { width: m.width, height: m.height, channels: 3, background: '#3060c0' } }).png().toFile(output)
`)
    const children: MockRequest[] = []
    const script = (req: MockRequest): MockReply => {
      const done = toolResults(req)
      if (firstUserText(req).includes(CHILD)) {
        children.push(req)
        switch (done.length) {
          case 0: return { tools: [{ name: 'edit_generate', input: { kind: 'fill', prompt: 'clear blue sky', mask: { shapes: [{ type: 'rectangle', x: 0, y: 0, w: 1, h: 0.3 }] }, reason: 'user asked for a blue sky' } }] }
          case 1: return { tools: [{ name: 'edit_finish', input: { summary: 'sky replaced (authorized)' } }] }
          default: return { text: 'done' }
        }
      }
      if (!req.tools.some(t => t.name === 'photo_workspace_open')) return { text: 'Gen trip' }
      switch (done.length) {
        case 0: return { tools: [{ name: 'photo_workspace_open', input: { path: ws2 } }] }
        case 1: return { tools: [{ name: 'photo_cull_run', input: { background: false } }] }
        case 2: return { tools: [{ name: 'photo_select', input: { count: 1, request: '选1张' } }] }
        case 3: return { tools: [{ name: 'edit_tasks_create', input: { instructions: 'replace the sky with a clear blue sky', engine: 'builtin' } }] }
        case 4: return { tools: [{ name: 'edit_run', input: { background: false } }] }
        case 5: return { tools: [{ name: 'export_run', input: { background: false } }] }
        default: return { text: 'All done.' }
      }
    }
    const llm2 = await startMockLlm(script)
    try {
      const run = await runHeadless({
        home: home2, baseUrl: llm2.baseUrl, cwd: ws2, task: '把天空换成蓝天',
        config: { stateRoot: state2, ui: { enabled: false }, editing: { previewEdge: 500 }, generative: { requireApproval: false, providers: [{ id: 'fake', type: 'command', command: process.execPath, args: [gen, '{input}', '{mask}', '{output}', '{prompt}'] }] } },
      })
      const main = llm2.requests.filter(r => !firstUserText(r).includes(CHILD) && r.tools.some(t => t.name === 'photo_workspace_open')).at(-1)
      const results = main === undefined ? [] : toolResults(main)
      if (run.code !== 0 || results.length < 6 || results.some(r => r.isError)) console.log('RESULTS', JSON.stringify(results.map(r => ({ e: r.isError, t: r.text.slice(0, 500) }))), run.stderr.slice(-3000))
      expect(run.code).toBe(0)
      expect(results).toHaveLength(6)
      for (const r of results) expect(r.isError, r.text.slice(0, 300)).toBe(false)
      const childGen = toolResults(children.find(r => toolResults(r).length >= 1) as MockRequest)[0]
      expect(childGen?.isError, childGen?.text.slice(0, 400)).toBe(false)
      const exported = JSON.parse(results[5]?.text ?? '{}') as { exported: number; metadataVerified: boolean; items?: Array<{ generative?: boolean }> }
      expect(exported.exported).toBe(1)
      expect(exported.metadataVerified).toBe(true)
      const p = Project.open(ws2, { stateRoot: state2 })
      try {
        const t = p.repo.tasks()[0]
        const doc = p.repo.revision(t?.headRevision as string)?.doc
        expect(doc?.provenance?.generative).toBe(true)
        expect(doc?.stages.at(-1)?.steps.map(s => s.op)).toEqual(['gen_layer'])
        const auth = p.repo.authorizations()
        expect(auth).toHaveLength(1)
        expect(auth[0]?.grantedBy).toMatch(/requireApproval=false/)
        expect(p.repo.exports()[0]?.verified).toBe(true)
        const { ExifTool } = await import('exiftool-vendored')
        const et = new ExifTool()
        try {
          const tags = await et.read(p.repo.exports()[0]?.path as string) as Record<string, unknown>
          expect(String(tags.DigitalSourceType)).toContain('compositeWithTrainedAlgorithmicMedia')
        } finally { await et.end() }
      } finally {
        await p.close()
      }
    } finally {
      await llm2.close()
    }
  })
})
