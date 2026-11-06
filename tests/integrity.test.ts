import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { appendFileSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { freshDir } from './helpers/fixtures.ts'
import { Project } from '../src/core/project.ts'

async function workspace(): Promise<string> {
  const ws = await freshDir('integrity-ws')
  await sharp({ create: { width: 24, height: 16, channels: 3, background: '#336699' } }).jpeg().toFile(join(ws, 'a.jpg'))
  await sharp({ create: { width: 24, height: 16, channels: 3, background: '#996633' } }).jpeg().toFile(join(ws, 'b.jpg'))
  return ws
}

describe('original-file integrity baseline', () => {
  it('captures at scan time, detects an in-place edit, and repairs explicitly', async () => {
    const ws = await workspace()
    const state = await freshDir('integrity-state')
    const p = Project.open(ws, { stateRoot: state })
    try {
      await p.scan()
      const captured = await p.integrity.check()
      expect(captured.ok).toBe(true)
      expect(captured.checked).toBeGreaterThanOrEqual(2)
      expect(captured.captured).toBe(0)

      const upgraded = await p.integrity.check({ hash: true })
      expect(upgraded.ok).toBe(true)
      expect(upgraded.hashCoverage).toBe('2/2')

      const file = p.repo.files().find(f => f.path.endsWith('a.jpg'))
      expect(file).toBeDefined()
      appendFileSync((file as { path: string }).path, Buffer.from([0]))

      const changed = await p.integrity.check({ hash: true })
      expect(changed.ok).toBe(false)
      expect(changed.changed.map(i => i.fileId)).toContain((file as { id: string }).id)
      expect(changed.changed[0]?.reason).toBe('content')

      const repaired = await p.integrity.check({ hash: true, repair: true })
      expect(repaired.ok).toBe(true)
      expect(repaired.repaired).toBe(1)

      const after = await p.integrity.check({ hash: true })
      expect(after.ok).toBe(true)
      expect(after.changed).toHaveLength(0)
    } finally {
      await p.close()
    }
  })

  it('separates a metadata-only touch from a content change once hashes exist', async () => {
    const ws = await workspace()
    const state = await freshDir('integrity-touch-state')
    const p = Project.open(ws, { stateRoot: state })
    try {
      await p.scan()
      await p.integrity.check({ hash: true })
      const file = p.repo.files().find(f => f.path.endsWith('b.jpg'))
      expect(file).toBeDefined()
      const future = new Date(Date.now() + 60_000)
      utimesSync((file as { path: string }).path, future, future)

      const report = await p.integrity.check({ hash: true })
      expect(report.ok).toBe(true)
      expect(report.touched.map(i => i.fileId)).toContain((file as { id: string }).id)
      expect(report.changed).toHaveLength(0)
    } finally {
      await p.close()
    }
  })
})
