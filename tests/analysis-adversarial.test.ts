import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import { Project } from '../src/core/project.ts'
import { EngineRegistry } from '../src/core/edit/registry.ts'
import { EditService } from '../src/core/edit/service.ts'
import { createModelScorer, toScoreSet } from '../src/core/analysis/models.ts'
import { parseVlmResponse, type VlmItem } from '../src/core/analysis/vlm.ts'
import { computeGroups } from '../src/core/grouping/grouping.ts'
import { select } from '../src/core/select/selector.ts'
import { parseChineseNumber } from '../src/core/select/nl.ts'
import { chunk, mapLimit, Semaphore } from '../src/core/util/misc.ts'
import { McpStdioClient } from '../src/core/edit/mcp-client.ts'
import { resolveConfig } from '../src/dsh/config.ts'
import { freshDir } from './helpers/fixtures.ts'
import type { Features, Group, ScoreSet, SelectionItem, Shot } from '../src/core/types.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { while (cleanups.length > 0) await cleanups.pop()?.() })

function commandScorer(script: string, scale: 'auto' | '0-1' | '0-10' | '0-100' = '0-1') {
  return createModelScorer({ id: 'strict', type: 'command', command: process.execPath, args: ['-e', script, '{paths}'], scale, timeoutMs: 10_000 })
}

const outputRows = `const input=process.argv.slice(1); const rows=input.map(path=>({path,score:path==='/a'?0.5:0.75,aesthetic:path==='/a'?0.25:0.5})).reverse(); console.log(JSON.stringify(rows))`

describe('configuration compatibility', () => {
  it('allows fixed-scale super-resolution commands but requires input and output placeholders', () => {
    const base = { ui: { enabled: false, basePath: '/api/chengying' } }
    expect(() => resolveConfig({ ...base, superResolution: { args: ['-i', '{input}', '-o', '{output}', '-s', '2'] } })).not.toThrow()
    expect(() => resolveConfig({ ...base, superResolution: { args: ['-i', '{input}', '-s', '{scale}'] } })).toThrow(/\{output\}/)
  })
})

describe('strict model and VLM responses', () => {
  it('maps reordered rows by path and applies explicit scales', async () => {
    const scorer = commandScorer(outputRows)
    const result = await scorer.score(['/a', '/b'])
    expect(result[0]).toMatchObject({ aesthetic: 25 })
    expect(result[1]).toMatchObject({ aesthetic: 50 })
    const fixed = toScoreSet({ score: 0.5, aesthetic: 0.25 }, 'aesthetic', '0-100')
    expect(fixed).toMatchObject({ aesthetic: 0.25 })
    expect(toScoreSet(-1).aesthetic).toBeUndefined()
    expect(toScoreSet({ score: 0.5 }, 'aesthetic', '0-1').aesthetic).toBe(50)
  })

  it.each([
    ['missing', 'rows.pop()'],
    ['extra', 'rows.push({path:"/c",score:0.2})'],
    ['duplicate', 'rows[1].path=rows[0].path'],
  ])('rejects %s command rows', async (_name, mutation) => {
    const scorer = commandScorer(`${outputRows.replace('console.log', `${mutation}; console.log`)}`)
    await expect(scorer.score(['/a', '/b'])).rejects.toThrow(/path|rows/)
  })

  it('requires known unique VLM labels and valid dimensions', () => {
    const items: VlmItem[] = [{ label: '#1', shotId: 'a', context: '' }, { label: '#2', shotId: 'b', context: '' }]
    const parsed = parseVlmResponse(JSON.stringify([
      { label: '#2', technical: 0.5, aesthetic: 0.25 },
      { label: '#1', technical: 8, aesthetic: 7 },
      { label: '#2', technical: 100 },
      { label: '#99', technical: 100 },
      { technical: 100 },
    ]), items)
    expect(parsed.get('a')?.technical).toBe(80)
    expect(parsed.get('b')?.technical).toBe(50)
    expect(parsed.size).toBe(2)
    expect(parseVlmResponse('[{"label":"#1","technical":-1}]', items).size).toBe(0)
    expect(parseVlmResponse('[{"label":"#1","technical":1000}]', items).size).toBe(0)
    expect(parseVlmResponse('[{"label":"#1","tags":[]}]', items).size).toBe(0)
  })
})

const shot = (id: string, rawFile: string | null = null): Shot => ({
  id, status: 'active', sourceVersion: null, primaryFile: id, rawFile, rasterFile: join('/', `${id}.jpg`), captureTime: null, captureTs: null, day: null,
  tzOffset: null, camera: null, lens: null, gps: null, iso: null, exposureTime: null, aperture: null, focalLength: null,
  width: 100, height: 100, orientation: 1, previewPath: null, thumbPath: null, previewSource: null, previewError: null,
  userFlag: null, userRating: null, note: null, tags: [],
})
const emptyGroups = { exact: [], near: [], scene: [], segment: [] } as { exact: Group[]; near: Group[]; scene: Group[]; segment: Group[] }

describe('unknown metadata and protected selections', () => {
  it('does not merge entirely unknown shots into scene or segment groups', () => {
    const groups = computeGroups({ shots: [shot('a'), shot('b'), shot('c')], files: [], features: new Map<string, Features>(), rank: () => 0 })
    expect(groups.scene).toHaveLength(3)
    expect(groups.segment).toHaveLength(3)
    expect(groups.scene.every(group => group.members.length === 1)).toBe(true)
  })

  it('keeps locked user picks through filters, floors and duplicate collapsing', () => {
    const a = shot('a', '/a.raw'); const b = shot('b')
    const scores = new Map<string, Record<string, ScoreSet>>([
      ['a', { agent: { technical: 100, aesthetic: 100, tags: [], issues: [] } }],
      ['b', { agent: { technical: 10, aesthetic: 10, tags: [], issues: [] } }],
    ])
    const duplicate: Group = { id: 'g', kind: 'exact', label: 'duplicate', members: [{ shotId: 'a', rank: 1, role: 'best' }, { shotId: 'b', rank: 2, role: 'member' }], info: {} }
    const keep: SelectionItem[] = [{ shotId: 'b', rank: 1, score: 10, reason: 'user', source: 'user', locked: true, included: true }]
    const result = select({ shots: [a, b], scores, features: new Map(), groups: { ...emptyGroups, exact: [duplicate] }, keep }, { count: 2, minScore: 99, rawOnly: true })
    expect(result.items.filter(item => item.included)).toEqual([expect.objectContaining({ shotId: 'b', locked: true, source: 'user' })])
    expect(() => select({ shots: [a], scores, features: new Map(), groups: emptyGroups }, { weights: { technical: Number.NaN } })).toThrow(/finite|weight/)
  })

  it('parses large Chinese sections and rejects invalid unit order', () => {
    expect(parseChineseNumber('一亿零三万')).toBe(100_030_000)
    expect(parseChineseNumber('二十亿三千万零一十')).toBe(2_030_000_010)
    expect(parseChineseNumber('十百')).toBeUndefined()
  })
})

describe('render-original caching and concurrency primitives', () => {
  it('deduplicates renders, invalidates source content and honors pre-abort', async () => {
    const root = await freshDir('original-render-root'); const state = await freshDir('original-render-state')
    const source = join(root, 'source.jpg')
    await sharp({ create: { width: 80, height: 60, channels: 3, background: '#336699' } }).jpeg().toFile(source)
    const project = Project.open(root, { stateRoot: state }); cleanups.push(() => project.close())
    await project.scan()
    const registry = new EngineRegistry(join(state, 'engines'), { darktable: { enabled: false }, rawtherapee: { enabled: false } })
    const service = new EditService(project, registry)
    const task = (await service.createTasks({ shotIds: [project.repo.shots()[0]?.id as string], instructions: 'original' })).created[0]?.id as string
    const spy = vi.spyOn(registry.get('builtin'), 'render')
    const [first, joined] = await Promise.all([service.renderOriginal(task, { maxEdge: 64 }), service.renderOriginal(task, { maxEdge: 64 })])
    expect(first).toBe(joined); expect(spy).toHaveBeenCalledTimes(1)
    expect(readdirSync(project.path('scratch')).some(name => name.includes('.tmp-'))).toBe(false)
    await sharp({ create: { width: 80, height: 60, channels: 3, background: '#aa3344' } }).jpeg().toFile(source)
    await project.scan()
    const changed = await service.renderOriginal(task, { maxEdge: 64 })
    expect(changed).not.toBe(first); expect(spy).toHaveBeenCalledTimes(2)
    const controller = new AbortController(); controller.abort()
    await expect(service.renderOriginal(task, { signal: controller.signal })).rejects.toThrow()
    expect(spy).toHaveBeenCalledTimes(2)
    const lut = join(root, 'look.cube')
    const identity = 'LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n'
    writeFileSync(lut, identity)
    await service.applyOps(task, [{ op: 'add_step', step: { op: 'lut3d', params: { file: lut, strength: 1 } } }], { author: 'test' })
    const neutral = await service.render(task, { maxEdge: 32 })
    expect((await service.render(task, { maxEdge: 32 })).cached).toBe(true)
    writeFileSync(lut, identity.replace(/^0 0 0$/m, '1 0 0').replace(/^0 1 0$/m, '1 1 0').replace(/^0 0 1$/m, '1 0 1').replace(/^0 1 1$/m, '1 1 1'))
    const changedLut = await service.render(task, { maxEdge: 32 })
    expect(changedLut.path).not.toBe(neutral.path)
    expect(changedLut.stats.mean.r).toBeGreaterThan(neutral.stats.mean.r + 10)
    const grant = project.repo.addAuthorization({ scope: 'generative', shotId: null, taskId: null, grantedBy: 'test', note: '', expiresAt: null, maxUses: 1 })
    expect(project.repo.consumeAuthorization(grant)).toBe(true)
    expect(project.repo.consumeAuthorization(grant)).toBe(false)
    project.repo.revokeAuthorization(grant)
    expect(project.repo.consumeAuthorization(grant)).toBe(false)
    await expect(service.generate(task, { provider: { id: 'fake', type: 'command', command: process.execPath, args: [] }, kind: 'edit', prompt: 'test', authorizationId: 'missing', author: 'test' })).rejects.toThrow(/authorization/)
    spy.mockRestore()
  })

  it('releases a semaphore slot aborted after reservation and handles undefined rejection', async () => {
    const semaphore = new Semaphore(1)
    const release = await semaphore.acquire()
    const controller = new AbortController()
    const waiting = semaphore.acquire(controller.signal)
    release(); controller.abort()
    await expect(waiting).rejects.toThrow()
    const next = await semaphore.acquire(); next()
    await expect(mapLimit([1], 1, async () => { await Promise.resolve(); return await Promise.reject(undefined) })).rejects.toBeUndefined()
    expect(() => chunk([1], 0)).toThrow(/positive/)
  })

  it('shares MCP startup and shutdown without spawning duplicate servers', async () => {
    const dir = await freshDir('mcp-client'); const log = join(dir, 'pids')
    const server = `
      const fs=require('node:fs'); fs.writeFileSync(process.argv[1], process.pid+'\\n', {flag:'a'}); let b='';
      process.stdin.on('data',d=>{b+=d; let i; while((i=b.indexOf('\\n'))>=0){const m=JSON.parse(b.slice(0,i)); b=b.slice(i+1);
      if(m.method==='initialize') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{serverInfo:{name:'fake'}}})+'\\n');
      else if(m.method==='tools/list') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{tools:[{name:'ok'}]}})+'\\n');
      else if(m.method==='shutdown'){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{}})+'\\n'); setTimeout(()=>process.exit(0),10)}
      }});
    `
    const client = new McpStdioClient(process.execPath, ['-e', server, log], { timeoutMs: 5000 })
    await Promise.all([client.start(), client.start(), client.start()])
    expect((await client.listTools()).map(tool => tool.name)).toEqual(['ok'])
    await Promise.all([client.close(), client.close()])
    expect(readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(1)
  })
})
