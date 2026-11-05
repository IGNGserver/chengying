import { describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EngineRegistry } from '../src/core/edit/registry.ts'
import type { Catalog, EngineAdapter, EngineProbe, SmokeResult } from '../src/core/edit/engine.ts'
import { ChengyingError } from '../src/core/util/errors.ts'

function fake(id: string, opts: { smoke?: SmokeResult; catalogFails?: boolean; raw?: boolean } = {}): EngineAdapter & { smokeCalls: number } {
  const adapter: EngineAdapter & { smokeCalls: number } = {
    id,
    title: id,
    smokeCalls: 0,
    async probe(): Promise<EngineProbe> {
      return { id, available: true, version: '1.0.0', mode: 'fake', binaries: {}, fingerprint: `${id}:1.0.0`, inputs: { raw: opts.raw !== false, raster: true } }
    },
    async catalog(): Promise<Catalog> {
      if (opts.catalogFails === true) throw new ChengyingError('engine-unavailable', `${id}: cannot discover modules`)
      return {
        engine: id,
        engineVersion: '1.0.0',
        catalogVersion: 1,
        fingerprint: `${id}:1.0.0`,
        source: 'fake',
        discoveredAt: '2026-01-01T00:00:00.000Z',
        operations: [],
        stageOptions: { type: 'object' },
        coverage: { operations: 0, parameters: 0, withSchema: 0, extensions: [], unsupported: [] },
      }
    },
    validateStep(step) { return { step, warnings: [] } },
    async render(): Promise<never> { throw new Error('render is not exercised here') },
    async recipe(): Promise<{ extension: string; text: string }> { return { extension: 'json', text: '{}' } },
    async smokeTest(): Promise<SmokeResult> {
      adapter.smokeCalls++
      return opts.smoke ?? { ok: true }
    },
  }
  return adapter
}

function registry(): EngineRegistry {
  return new EngineRegistry(join(tmpdir(), `chengying-health-${process.pid}`), {
    darktable: { enabled: false },
    rawtherapee: { enabled: false },
    builtin: { enabled: false },
    ai: { enabled: false },
  })
}

describe('engine health gating', () => {
  it('skips an engine that is installed but cannot render', async () => {
    const reg = registry()
    reg.add(fake('broken', { smoke: { ok: false, reason: 'darktable-cli reported success but wrote no file' } }))
    reg.add(fake('healthy'))
    await expect(reg.pick('raw')).resolves.toBe('healthy')
  })

  it('reports why an explicitly requested engine is unusable', async () => {
    const reg = registry()
    reg.add(fake('broken', { smoke: { ok: false, reason: 'exported to a mangled path' } }))
    await expect(reg.pick('raw', 'broken')).rejects.toThrow(/mangled path/)
  })

  it('skips an engine whose catalog cannot be discovered', async () => {
    const reg = registry()
    reg.add(fake('nointro', { catalogFails: true }))
    reg.add(fake('healthy'))
    await expect(reg.pick('raw')).resolves.toBe('healthy')
  })

  it('caches the health check per engine fingerprint', async () => {
    const reg = registry()
    const engine = fake('cached')
    reg.add(engine)
    await reg.health('cached')
    await reg.health('cached')
    expect(engine.smokeCalls).toBe(1)
    await reg.health('cached', { refresh: true })
    expect(engine.smokeCalls).toBe(2)
  })
})
