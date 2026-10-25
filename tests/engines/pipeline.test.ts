import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { join } from 'node:path'
import { Project } from '../../src/core/project.ts'
import { EngineRegistry } from '../../src/core/edit/registry.ts'
import { EditService } from '../../src/core/edit/service.ts'
import { exportPhotos } from '../../src/core/export/exporter.ts'
import { buildTravelWorkspace, freshDir, rawFixture } from '../helpers/fixtures.ts'

const enabled = (process.env.CHENGYING_DARKTABLE_CLI !== undefined || process.env.CHENGYING_RAWTHERAPEE_CLI !== undefined) && rawFixture('20170902_0047.NEF') !== undefined

describe.skipIf(!enabled)('RAW pipelines through real engines', () => {
  let project: Project
  let edit: EditService
  let registry: EngineRegistry
  let rawShot: string

  beforeAll(async () => {
    const root = await freshDir('pipe-ws')
    const state = await freshDir('pipe-state')
    await buildTravelWorkspace(root, { withRaw: true })
    project = Project.open(root, { stateRoot: state })
    await project.scan()
    await project.buildPreviews()
    registry = new EngineRegistry(join(process.cwd(), '.test-tmp', 'pipe-engines'), {
      darktable: { path: process.env.CHENGYING_DARKTABLE_CLI, enabled: process.env.CHENGYING_DARKTABLE_CLI !== undefined },
      rawtherapee: { path: process.env.CHENGYING_RAWTHERAPEE_CLI, enabled: process.env.CHENGYING_RAWTHERAPEE_CLI !== undefined },
    })
    edit = new EditService(project, registry)
    rawShot = project.repo.shots().find(s => s.rawFile !== null)?.id as string
  })
  afterAll(async () => { await project?.close(); await registry?.close() })

  for (const engine of ['darktable', 'rawtherapee'] as const) {
    it(`${engine}: develops the RAW, finishes in the built-in stage and exports with verified metadata`, async () => {
      if (!(await registry.get(engine).probe()).available) return
      const task = (await edit.createTasks({ shotIds: [rawShot], instructions: 'test', engine, force: true })).created[0]
      expect(task?.engine).toBe(engine)
      const src = project.repo.file(edit.head(task?.id as string).doc.sourceFile)
      expect(src?.kind).toBe('raw')
      const global = engine === 'darktable' ? { op: 'exposure', params: { exposure: 0.5 } } : { op: 'Exposure', params: { Compensation: 0.5 } }
      await edit.applyOps(task?.id as string, [
        { op: 'add_step', step: global },
        { op: 'add_stage', engine: 'builtin' },
        { op: 'add_step', stage: 1, step: { op: 'crop', params: { aspect: '4:5' } } },
        { op: 'add_step', stage: 1, step: { op: 'vignette', params: { amount: -25 } } },
      ], { author: 'test' })
      const preview = await edit.render(task?.id as string, { maxEdge: 600 })
      expect(preview.stages.map(s => s.engine)).toEqual([engine, 'builtin'])
      expect(preview.width / preview.height).toBeCloseTo(0.8, 1)
      const jpg = await exportPhotos(project, edit, { taskIds: [task?.id as string], subdir: `${engine}-jpg`, maxEdge: 1200 })
      expect(jpg.items[0]?.error).toBeUndefined()
      expect(jpg.items[0]?.verified, JSON.stringify(jpg.items[0]?.verify?.mismatched)).toBe(true)
      expect(jpg.items[0]?.verify?.details.Model?.ok).toBe(true)
      const tif = await exportPhotos(project, edit, { taskIds: [task?.id as string], subdir: `${engine}-tif`, format: 'tiff', maxEdge: 800 })
      expect(tif.items[0]?.verified).toBe(true)
      expect((await sharp(tif.items[0]?.path as string).metadata()).depth).toBe('ushort')
      // Pixel content: the 16-bit TIFF and the JPEG export show the same picture.
      const small = async (p: string): Promise<Buffer> => await sharp(p).resize(64, 80, { fit: 'fill' }).toColourspace('srgb').removeAlpha().raw().toBuffer()
      const a = await small(jpg.items[0]?.path as string)
      const b = await small(tif.items[0]?.path as string)
      let diff = 0
      for (let i = 0; i < a.length; i++) diff += Math.abs((a[i] as number) - (b[i] as number))
      expect(diff / a.length).toBeLessThan(6)
    })
  }
})
