import { afterEach, describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Project } from '../src/core/project.ts'
import { EngineRegistry } from '../src/core/edit/registry.ts'
import { EditService } from '../src/core/edit/service.ts'
import { exportPhotos } from '../src/core/export/exporter.ts'
import { deliverOriginals, writeDeliveryManifest } from '../src/core/export/deliver.ts'
import { zipDirectory } from '../src/core/export/zip.ts'
import { FeaturePool } from '../src/core/analysis/pool.ts'
import { sha256File } from '../src/core/integrity.ts'
import { freshDir } from './helpers/fixtures.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { while (cleanups.length > 0) await cleanups.pop()?.() })
async function jpeg(path: string, color: string): Promise<void> {
  await sharp({ create: { width: 128, height: 96, channels: 3, background: color } }).jpeg().toFile(path)
}

describe('concurrent export, delivery and cache invalidation', () => {
  it('reserves same basenames, rolls back DB failures, and never claims unrelated files', async () => {
    const root = await freshDir('export-adversarial-root')
    const state = await freshDir('export-adversarial-state')
    await mkdir(join(root, 'a')); await mkdir(join(root, 'b'))
    await jpeg(join(root, 'a', 'same.jpg'), '#b04030')
    await jpeg(join(root, 'b', 'same.jpg'), '#3040b0')
    const project = Project.open(root, { stateRoot: state })
    const registry = new EngineRegistry(join(state, 'engines'), { darktable: { enabled: false }, rawtherapee: { enabled: false } })
    cleanups.push(async () => { await registry.close(); await project.close() })
    await project.scan()
    const edit = new EditService(project, registry)
    const shots = project.repo.shots()
    const created = await edit.createTasks({ shotIds: shots.map(shot => shot.id), instructions: 'neutral' })
    expect(created.created).toHaveLength(2)

    const batches = await Promise.all(created.created.map(task => exportPhotos(project, edit, { taskIds: [task.id] })))
    expect(batches.flatMap(batch => batch.items).every(item => item.status === 'exported')).toBe(true)
    const paths = batches.map(batch => batch.items[0]!.path!)
    expect(new Set(paths).size).toBe(2)
    expect(paths.every(existsSync)).toBe(true)

    const firstTask = created.created[0]!
    const firstPath = batches[0]!.items[0]!.path!
    const previousHash = await sha256File(firstPath)
    const commit = vi.spyOn(project.repo, 'addExport').mockImplementationOnce(() => { throw new Error('forced commit failure') })
    const rolledBack = await exportPhotos(project, edit, { taskIds: [firstTask.id] })
    commit.mockRestore()
    expect(rolledBack.exported).toBe(0)
    expect(rolledBack.failed).toBe(1)
    expect(rolledBack.items[0]!.error).toContain('forced commit failure')
    expect(await sha256File(firstPath)).toBe(previousHash)
    expect(project.repo.exportAtPath(firstPath)?.taskId).toBe(firstTask.id)
    expect((await exportPhotos(project, edit, { taskIds: [firstTask.id] })).exported).toBe(1)

    const delivery = join(root, 'custom-delivery')
    const delivered = deliverOriginals(project, { taskIds: created.created.map(task => task.id), dir: delivery })
    expect(delivered.exported).toBe(2)
    expect(new Set(delivered.items.map(item => item.path)).size).toBe(2)
    for (const item of delivered.items) expect((await readFile(item.path!)).equals(await readFile(item.sourcePath!))).toBe(true)
    const userManifest = join(delivery, 'manifest.json')
    await writeFile(userManifest, '{"owner":"user"}')
    const manifestInput = {
      mode: 'originals' as const,
      project: { id: project.id, root: project.root },
      plan: null,
      summary: { exported: 2, failed: 0, metadataVerified: true, originalsIntact: true },
      items: delivered.items,
    }
    const manifest = writeDeliveryManifest(project, delivery, manifestInput)
    expect(manifest).toBe(join(delivery, 'manifest_1.json'))
    expect(await readFile(userManifest, 'utf8')).toBe('{"owner":"user"}')
    expect(writeDeliveryManifest(project, delivery, manifestInput)).toBe(manifest)
    const archive = zipDirectory(delivery, join(delivery, 'bundle.zip'))
    expect(existsSync(archive.path)).toBe(true)
    expect(() => zipDirectory(delivery, archive.path)).toThrow(/refusing to replace/)
    await project.scan()
    expect(project.repo.files().filter(file => file.status === 'ok')).toHaveLength(2)

    const [left, right] = await Promise.all([edit.render(firstTask.id, { maxEdge: 96 }), edit.render(firstTask.id, { maxEdge: 96 })])
    expect(left.path).toBe(right.path)
    expect((await edit.render(firstTask.id, { maxEdge: 96 })).cached).toBe(true)
    const sourcePath = project.repo.file(edit.head(firstTask.id).doc.sourceFile)!.path
    await jpeg(sourcePath, '#20a080')
    await project.scan()
    expect((await edit.render(firstTask.id, { maxEdge: 96 })).cached).toBe(false)
  })
})

describe('feature pool shutdown', () => {
  it('settles queued fallback work and rejects new work after close', async () => {
    const root = await freshDir('pool-close')
    const image = join(root, 'photo.jpg')
    await jpeg(image, '#707070')
    const pool = new FeaturePool(1, new URL('file:///definitely/not/a/chengying-worker.mjs'))
    const pending = pool.compute(image, 32)
    const closed = pool.close()
    await expect(pending).rejects.toThrow(/closed before analysis completed/)
    await closed
    await pool.close()
    await expect(pool.compute(image, 32)).rejects.toThrow(/closed/)
  })
})
