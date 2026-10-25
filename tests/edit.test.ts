import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Project } from '../src/core/project.ts'
import { EngineRegistry } from '../src/core/edit/registry.ts'
import { EditService } from '../src/core/edit/service.ts'
import { exportPhotos } from '../src/core/export/exporter.ts'
import { buildTravelWorkspace, freshDir, type FixtureShot } from './helpers/fixtures.ts'

let root: string
let state: string
let fixture: FixtureShot[]
let project: Project
let edit: EditService
let registry: EngineRegistry
const hashes = new Map<string, string>()
const sha = async (p: string): Promise<string> => createHash('sha256').update(await readFile(p)).digest('hex')

beforeAll(async () => {
  root = await freshDir('edit-ws')
  state = await freshDir('edit-state')
  fixture = await buildTravelWorkspace(root)
  for (const f of fixture) hashes.set(f.file, await sha(f.file))
  project = Project.open(root, { stateRoot: state })
  await project.scan()
  await project.buildPreviews()
  await project.analyze()
  registry = new EngineRegistry(join(state, 'engines'), { darktable: { enabled: false }, rawtherapee: { enabled: false } })
  edit = new EditService(project, registry)
})

afterAll(async () => { await project?.close() })

const shotOf = (base: string): string => project.repo.files().find(f => f.base === base)?.shotId as string

describe('edit tasks, revisions and export', () => {
  let taskId: string

  it('creates one task per selected photo with an initial revision', async () => {
    const { selectionId } = project.select({ count: 3 })
    const r = await edit.createTasks({ selectionId, instructions: 'natural travel look, lift shadows' })
    expect(r.created).toHaveLength(3)
    const again = await edit.createTasks({ selectionId, instructions: 'x' })
    expect(again.created).toHaveLength(0)
    expect(again.existing).toHaveLength(3)
    taskId = r.created[0]?.id as string
    const head = edit.head(taskId)
    expect(head.seq).toBe(1)
    expect(head.doc.stages[0]?.engine).toBe('builtin')
  })

  it('applies validated operations as new revisions and renders previews', async () => {
    const before = await edit.render(taskId, { maxEdge: 500 })
    const r = await edit.applyOps(taskId, [
      { op: 'add_step', step: { op: 'exposure', params: { ev: 0.8 } } },
      { op: 'add_step', step: { op: 'tone', params: { shadows: 40, highlights: -30 } } },
      { op: 'add_step', step: { op: 'vignette', params: { amount: -30 }, mask: { shapes: [{ type: 'ellipse', cx: 0.5, cy: 0.5, rx: 0.3, ry: 0.2, invert: true }] } } },
    ], { author: 'test' })
    expect(r.revision.seq).toBe(2)
    const after = await edit.render(taskId, { maxEdge: 500 })
    expect(after.stats.mean.luma).toBeGreaterThan(before.stats.mean.luma + 5)
    expect(after.stats.histogram).toHaveLength(16)
    const cached = await edit.render(taskId, { maxEdge: 500 })
    expect(cached.cached).toBe(true)
    await expect(edit.applyOps(taskId, [{ op: 'add_step', step: { op: 'exposure', params: { nope: 1 } } }], { author: 'test' })).rejects.toThrow(/unknown parameter/)
    expect(edit.head(taskId).seq).toBe(2)
  })

  it('updates, undoes and checks out revisions without losing history', async () => {
    const stepId = edit.head(taskId).doc.stages[0]?.steps[0]?.id as string
    await edit.applyOps(taskId, [{ op: 'update_step', step_id: stepId, params: { ev: 1.5 } }], { author: 'test' })
    expect(edit.head(taskId).doc.stages[0]?.steps[0]?.params.ev).toBe(1.5)
    edit.undo(taskId, 'test')
    expect(edit.head(taskId).doc.stages[0]?.steps[0]?.params.ev).toBe(0.8)
    const first = project.repo.revisions(taskId)[0]
    edit.checkout(taskId, first?.id as string, 'test')
    expect(edit.head(taskId).doc.stages[0]?.steps).toHaveLength(0)
    expect(project.repo.revisions(taskId).length).toBe(5)
    edit.checkout(taskId, project.repo.revisions(taskId)[1]?.id as string, 'test')
    const cmp = await edit.compare(taskId, { maxEdge: 400 })
    expect(existsSync(cmp.path)).toBe(true)
  })

  it('supports multi-stage pipelines and recipe import', async () => {
    const t = (await edit.createTasks({ shotIds: [shotOf('DSC_0101')], instructions: 'b&w', force: true })).created[0]?.id as string
    await edit.applyOps(t, [{ op: 'add_stage', engine: 'builtin' }, { op: 'add_step', stage: 1, step: { op: 'black_white', params: {} } }, { op: 'add_step', stage: 0, step: { op: 'crop', params: { aspect: '1:1' } } }], { author: 'test' })
    const r = await edit.render(t, { maxEdge: 400 })
    expect(Math.abs(r.width - r.height)).toBeLessThanOrEqual(1)
    expect(Math.abs(r.stats.mean.r - r.stats.mean.b)).toBeLessThan(2)
    const recipe = await registry.get('builtin').recipe(edit.head(t).doc.stages[1] as never, await registry.catalog('builtin'), { kind: 'raster' })
    const t2 = (await edit.createTasks({ shotIds: [shotOf('DSC_0110')], instructions: 'same look', force: true })).created[0]?.id as string
    await edit.applyOps(t2, [{ op: 'import_recipe', text: recipe.text }], { author: 'test' })
    expect(edit.head(t2).doc.stages[0]?.steps.map(s => s.op)).toEqual(['black_white'])
  })

  it('exports with verified metadata and recoverable recipes, never touching originals', async () => {
    const res = await exportPhotos(project, edit, { taskIds: [taskId], shotIds: [shotOf('DSC_0120')], quality: 90 })
    expect(res.failed).toBe(0)
    expect(res.exported).toBe(2)
    for (const item of res.items) {
      expect(item.verified, JSON.stringify(item.verify?.mismatched ?? item.error)).toBe(true)
      expect(item.verify?.details.DateTimeOriginal?.ok).toBe(true)
      expect(item.verify?.details.GPSLatitude?.ok).toBe(true)
      expect(item.path?.startsWith(project.exportDir)).toBe(true)
      const recipe = JSON.parse(readFileSync(item.recipe as string, 'utf8')) as { document: { stages: unknown[] }; nativeRecipes: Record<string, string> }
      expect(recipe.document.stages.length).toBeGreaterThan(0)
    }
    const edited = res.items.find(i => i.taskId === taskId)
    const meta = await project.metadata.read(edited?.path as string)
    const expected = project.repo.shot(project.repo.task(taskId)?.shotId as string)
    expect(meta.meta.captureTime).toBe(expected?.captureTime)
    expect(meta.meta.gps?.lat).toBeCloseTo(expected?.gps?.lat as number, 5)
    expect(meta.raw.Orientation).toBe(1)
    expect(String(meta.raw.Software)).toContain('Chengying')
    // exporting again replaces our own file instead of piling up copies
    const again = await exportPhotos(project, edit, { taskIds: [taskId] })
    expect(again.items[0]?.path).toBe(edited?.path)
    for (const [file, h] of hashes) expect(await sha(file)).toBe(h)
  })

  it('persists tasks and recovers interrupted ones', async () => {
    edit.setStatus(taskId, 'running')
    const reopened = Project.open(root, { stateRoot: state })
    try {
      const svc = new EditService(reopened, registry)
      expect(svc.recover()).toBe(1)
      expect(reopened.repo.task(taskId)?.status).toBe('queued')
      expect(reopened.repo.revisions(taskId).length).toBeGreaterThan(3)
      expect(reopened.repo.events({ taskId }).some(e => e.type === 'revision')).toBe(true)
    } finally {
      await reopened.close()
    }
  })
})
