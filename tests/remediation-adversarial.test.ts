import { afterEach, describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { rename, utimes, writeFile } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Project } from '../src/core/project.ts'
import { deliverOriginals } from '../src/core/export/deliver.ts'
import { freshDir } from './helpers/fixtures.ts'
import type { EditDocument } from '../src/core/types.ts'

const projects: Project[] = []
async function openProject(name: string): Promise<Project> {
  const root = await freshDir(`${name}-root`)
  const state = await freshDir(`${name}-state`)
  const project = Project.open(root, { stateRoot: state })
  projects.push(project)
  return project
}
async function jpeg(path: string, color: string): Promise<void> {
  await sharp({ create: { width: 96, height: 64, channels: 3, background: color } }).jpeg().toFile(path)
}
afterEach(async () => { while (projects.length > 0) await projects.pop()?.close() })

describe('scan reconciliation and generated-artifact boundaries', () => {
  it('retains identity across unique rename, invalidates changed sources, and preserves unrelated delivery photos', async () => {
    const project = await openProject('scan-adversarial')
    const source = join(project.root, 'source.jpg')
    await jpeg(source, '#a04020')
    await project.scan()
    const initial = project.repo.files().find(file => file.base === 'source')!
    const shotId = initial.shotId!
    const renamed = join(project.root, 'renamed.jpg')
    await rename(source, renamed)
    await project.scan()
    expect(project.repo.file(initial.id)?.path).toBe(renamed)
    expect(project.repo.file(initial.id)?.shotId).toBe(shotId)
    expect(project.repo.files().filter(file => file.base === 'source')).toHaveLength(0)

    project.repo.saveScore(shotId, 'test', { overall: 88 })
    const shot = project.repo.shot(shotId)!
    shot.previewPath = join(project.stateDir, 'stale.jpg')
    project.repo.saveShot(shot)
    const previousVersion = project.repo.file(initial.id)!.contentVersion
    await jpeg(renamed, '#2050a0')
    await project.scan()
    expect(project.repo.file(initial.id)?.id).toBe(initial.id)
    expect(project.repo.file(initial.id)?.contentVersion).not.toBe(previousVersion)
    expect(project.repo.scores(shotId)).toEqual({})
    expect(project.repo.shot(shotId)?.previewPath).toBeNull()

    const delivery = join(project.root, 'custom-delivery')
    project.setExportDir(delivery)
    await jpeg(join(delivery, 'keep.jpg'), '#309050')
    await project.scan()
    expect(project.repo.files().some(file => file.base === 'keep' && file.status === 'ok')).toBe(true)
    const delivered = deliverOriginals(project, { shotIds: [shotId], dir: delivery })
    expect(delivered.exported).toBe(1)
    const copy = delivered.items[0]!.path!
    expect(project.repo.generatedArtifactPaths().has(copy)).toBe(true)
    await project.scan()
    expect(project.repo.files().filter(file => file.status === 'ok')).toHaveLength(2)
    expect(project.repo.files().some(file => file.path === copy && file.status === 'ok')).toBe(false)

    await rename(renamed, join(project.root, 'elsewhere.jpg'))
    await project.scan()
    expect(project.repo.files().find(file => file.id === initial.id)?.status).toBe('ok')
    await rename(join(project.root, 'elsewhere.jpg'), join(project.stateDir, 'removed.jpg'))
    await project.scan()
    expect(project.repo.file(initial.id)?.status).toBe('missing')
    expect(project.repo.shot(shotId)?.status).toBe('missing')
  })
})

describe('database concurrency boundaries', () => {
  it('enforces revision CAS and allows only one conditional task claim', async () => {
    const project = await openProject('repo-adversarial')
    await jpeg(join(project.root, 'one.jpg'), '#406080')
    await jpeg(join(project.root, 'two.jpg'), '#806040')
    await project.scan()
    const files = project.repo.files()
    const first = project.repo.createTask({ kind: 'edit', shotId: files[0]!.shotId!, selectionId: null, status: 'queued', priority: 0, engine: 'builtin', instructions: 'one', options: {}, maxAttempts: 3 })
    const second = project.repo.createTask({ kind: 'edit', shotId: files[1]!.shotId!, selectionId: null, status: 'queued', priority: 0, engine: 'builtin', instructions: 'two', options: {}, maxAttempts: 3 })
    expect(() => project.repo.createTask({ kind: 'edit', shotId: files[0]!.shotId!, selectionId: null, status: 'queued', priority: 0, engine: 'builtin', instructions: 'duplicate', options: {}, maxAttempts: 3 })).toThrow(/already has active task/)
    const doc: EditDocument = { schema: 1, sourceFile: files[0]!.id, stages: [] }
    const head = project.repo.addRevision(first.id, null, doc, 'initial', 'test')
    const next = project.repo.addRevision(first.id, head.id, { ...doc, stages: [{ id: 's', engine: 'builtin', steps: [] }] }, 'next', 'test')
    expect(() => project.repo.addRevision(first.id, head.id, doc, 'stale', 'test')).toThrow(/head changed/)
    expect(project.repo.task(first.id)?.headRevision).toBe(next.id)

    const reopened = Project.open(project.root, { stateRoot: dirname(dirname(project.stateDir)) })
    projects.push(reopened)
    const claims = await Promise.all([Promise.resolve().then(() => project.repo.claimQueuedTask(first.id, 'worker-a')), Promise.resolve().then(() => reopened.repo.claimQueuedTask(first.id, 'worker-b'))])
    expect(claims.filter(Boolean)).toHaveLength(1)
    expect(project.repo.task(first.id)?.status).toBe('running')
    expect(reopened.repo.task(second.id)?.status).toBe('queued')
    expect(reopened.repo.claimQueuedTask(second.id, 'worker-b')?.id).toBe(second.id)
  })
})

describe('full integrity verification', () => {
  it('detects a same-size same-mtime content substitution and repairs only explicitly', async () => {
    const project = await openProject('integrity-adversarial')
    const source = join(project.root, 'photo.jpg')
    await jpeg(source, '#883344')
    await project.scan()
    expect((await project.integrity.check({ hash: true })).verified).toBe(true)
    const before = statSync(source)
    const bytes = await import('node:fs/promises').then(fs => fs.readFile(source))
    bytes[bytes.length - 20] = (bytes[bytes.length - 20]! ^ 0x5a) & 0xff
    await writeFile(source, bytes)
    await utimes(source, before.atime, before.mtime)
    const statOnly = await project.integrity.check({ hash: false })
    expect(statOnly.level).toBe('stat')
    expect(statOnly.verified).toBe(false)
    expect(statOnly.note).toContain('does not prove unchanged bytes')
    const full = await project.integrity.check({ hash: true })
    expect(full.ok).toBe(false)
    expect(full.changed.some(issue => issue.reason === 'content')).toBe(true)
    expect(full.verified).toBe(false)
    const repaired = await project.integrity.check({ hash: true, repair: true })
    expect(repaired.repaired).toBe(1)
    expect((await project.integrity.check({ hash: true })).verified).toBe(true)
  })
})
