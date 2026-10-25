import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Project } from '../src/core/project.ts'
import { buildTravelWorkspace, freshDir, rawFixture, type FixtureShot } from './helpers/fixtures.ts'
import { parseSelectionRequest } from '../src/core/select/nl.ts'
import { mergeDims } from '../src/core/select/selector.ts'

let root: string
let state: string
let fixture: FixtureShot[]
let project: Project
const hashes = new Map<string, string>()

async function sha(p: string): Promise<string> {
  return createHash('sha256').update(await readFile(p)).digest('hex')
}

beforeAll(async () => {
  root = await freshDir('ws')
  state = await freshDir('state')
  fixture = await buildTravelWorkspace(root, { withRaw: true })
  for (const f of fixture) hashes.set(f.file, await sha(f.file))
  project = Project.open(root, { stateRoot: state })
})

afterAll(async () => {
  await project?.close()
})

const shotByName = (name: string): string => {
  const f = project.repo.files().find(x => x.base === name)
  if (f === undefined || f.shotId === null) throw new Error(`no shot for ${name}`)
  return f.shotId
}

describe('phase 1 · culling pipeline', () => {
  it('scans, reads metadata and pairs RAW+JPEG', async () => {
    const r = await project.scan()
    const hasRaw = rawFixture('20170902_0047.NEF') !== undefined
    expect(r.errors).toEqual([])
    expect(r.files).toBe(fixture.length)
    expect(r.pairs).toBe(hasRaw ? 1 : 0)
    const s = project.repo.shot(shotByName('DSC_0001'))
    expect(s?.captureTime).toBe('2026-05-01T08:10:00')
    expect(s?.tzOffset).toBe('+08:00')
    expect(s?.gps?.lat).toBeCloseTo(30.2475, 4)
    expect(s?.gps?.lon).toBeCloseTo(120.155, 4)
    expect(s?.camera).toContain('X-T5')
    if (hasRaw) {
      const raw = project.repo.shot(project.repo.files().find(x => x.ext === 'nef')?.shotId as string)
      expect(raw?.rawFile).not.toBeNull()
      expect(raw?.rasterFile).not.toBeNull()
    }
    // incremental rescan
    const again = await project.scan()
    expect(again.added).toBe(0)
    expect(again.updated).toBe(0)
  })

  it('builds previews for raster and RAW (embedded JPEG)', async () => {
    const r = await project.buildPreviews()
    expect(r.failed).toEqual([])
    expect(r.built).toBe(project.repo.shotCount())
    for (const s of project.repo.shots()) expect(s.previewPath).not.toBeNull()
  })

  it('scores technical faults correctly', async () => {
    const r = await project.analyze()
    expect(r.failed).toEqual([])
    const tech = (name: string): number => project.repo.scores(shotByName(name)).technical?.technical ?? -1
    const issues = (name: string): string[] => project.repo.scores(shotByName(name)).technical?.issues ?? []
    expect(tech('DSC_0001')).toBeGreaterThan(tech('DSC_0003') + 10)
    expect(issues('DSC_0003')).toContain('out-of-focus')
    expect(issues('DSC_0011')).toContain('highlight-clipping')
    expect(issues('DSC_0020')).toContain('noisy')
    expect(issues('DSC_0121')).toContain('underexposed')
    const f = project.repo.features(shotByName('DSC_0001'))
    expect(f?.phash).toMatch(/^[0-9a-f]{16}$/)
  })

  it('groups exact duplicates, near duplicates, scenes and travel segments', () => {
    const exact = project.groups('exact')
    expect(exact.some(g => g.members.map(m => m.shotId).sort().join() === [shotByName('DSC_0010'), shotByName('DSC_0010_copy')].sort().join())).toBe(true)
    const near = project.groups('near')
    const burst = near.find(g => g.members.some(m => m.shotId === shotByName('DSC_0001')))
    expect(burst?.members.map(m => m.shotId)).toContain(shotByName('DSC_0002'))
    // best member of the burst is not the blurred frame
    expect(burst?.members[0]?.shotId).not.toBe(shotByName('DSC_0003'))
    const segments = project.groups('segment')
    expect(segments.length).toBeGreaterThanOrEqual(4)
    const days = new Set(segments.map(g => (g.info as { day?: string }).day))
    expect(days.has('2026-05-01') && days.has('2026-05-02')).toBe(true)
    expect(project.groups('location').length).toBeGreaterThanOrEqual(2)
  })

  it('selects an exact count with no duplicates and narrative coverage', () => {
    const { selectionId, result } = project.select({ count: 5, narrative: true, request: 'pick 5' })
    const included = result.items.filter(i => i.included)
    expect(included).toHaveLength(5)
    const ids = included.map(i => i.shotId)
    expect(ids.includes(shotByName('DSC_0010')) && ids.includes(shotByName('DSC_0010_copy'))).toBe(false)
    expect(ids).not.toContain(shotByName('DSC_0003'))
    const days = new Set(ids.map(id => project.repo.shot(id)?.day))
    expect(days.has('2026-05-01') && days.has('2026-05-02')).toBe(true)
    expect(project.repo.selection(selectionId)?.items.filter(i => i.included)).toHaveLength(5)
    for (const it of included) expect(it.reason.length).toBeGreaterThan(5)
  })

  it('threshold mode returns every frame above the floor', () => {
    const low = project.select({ minScore: 10 }).result.items.length
    const high = project.select({ minScore: 75 }).result.items.length
    expect(low).toBeGreaterThan(high)
  })

  it('manual adjustments persist and teach the preference profile', () => {
    const { selectionId, result } = project.select({ count: 3 })
    const removed = result.items[0]?.shotId as string
    const added = shotByName('DSC_0020')
    project.adjustSelection(selectionId, { remove: [removed], add: [added], lock: [added] })
    const sel = project.repo.selection(selectionId)
    expect(sel?.items.find(i => i.shotId === removed)?.included).toBe(false)
    expect(sel?.items.find(i => i.shotId === added)).toMatchObject({ included: true, locked: true, source: 'user' })
    expect(project.profile().examples).toBe(2)
    // Re-running on top of the adjusted selection keeps the user's choices.
    const again = project.select({ count: 3 }, { base: selectionId }).result
    expect(again.items.find(i => i.shotId === added)?.included).toBe(true)
    expect(again.items.find(i => i.shotId === removed)?.included ?? false).toBe(false)
  })

  it('records agent/VLM judgments and fuses them', () => {
    const id = shotByName('DSC_0101')
    const before = mergeDims(project.repo.scores(id)).aesthetic ?? 0
    project.recordScores(id, 'agent', { aesthetic: 99, content: 95, story: 90, tags: ['sunrise', 'landscape'] })
    const after = mergeDims(project.repo.scores(id))
    expect(after.aesthetic).toBeGreaterThan(before)
    expect(after.tags).toContain('landscape')
    const pick = project.select({ count: 1, preferTags: ['landscape'] }).result.items[0]
    expect(pick?.shotId).toBe(id)
  })

  it('builds labeled contact sheets', async () => {
    const ids = project.repo.shots().slice(0, 4).map(s => s.id)
    const sheet = await project.sheet(ids)
    expect(sheet.labels).toEqual(['#1', '#2', '#3', '#4'])
    expect((await readFile(sheet.path)).length).toBeGreaterThan(10_000)
  })

  it('never modifies originals and refuses writes into the workspace', async () => {
    for (const [file, h] of hashes) expect(await sha(file)).toBe(h)
    expect(() => project.guard.writable(join(root, 'day1', 'DSC_0001.JPG'))).toThrow(/write outside|original/)
    expect(() => project.guard.writable(join(root, 'day1', 'new.jpg'))).toThrow(/write outside/)
    expect(project.guard.writable(join(project.exportDir, 'x.jpg'))).toContain('_chengying_export')
    expect(() => project.guard.readable('/etc/passwd')).toThrow(/read outside/)
  })
})

describe('natural-language selection requests', () => {
  it('parses counts, thresholds and tags', () => {
    expect(parseSelectionRequest('帮我选30张最好的风景照')).toMatchObject({ count: 30, preferTags: ['landscape'] })
    expect(parseSelectionRequest('挑出二十张，要多样一些，按行程讲故事')).toMatchObject({ count: 20, diversity: 0.6, narrative: true })
    expect(parseSelectionRequest('不限数量，质量80分以上的都要，不要自拍')).toMatchObject({ minScore: 80, avoidTags: ['selfie'] })
    expect(parseSelectionRequest('select 12 photos with people, vertical')).toMatchObject({ count: 12, orientation: 'portrait', preferTags: ['people'] })
    expect(parseSelectionRequest('所有合格的照片').count).toBeUndefined()
  })
})
