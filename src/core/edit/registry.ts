/** Engine registry: constructs the adapters, probes them and picks defaults. */
import { join } from 'node:path'
import type { Catalog, EngineAdapter, EngineProbe } from './engine.ts'
import { DarktableEngine } from './engines/darktable/index.ts'
import { RawTherapeeEngine } from './engines/rawtherapee/index.ts'
import { BuiltinEngine } from './engines/builtin/index.ts'
import { AiEngine, type AiEngineOptions } from './engines/ai/index.ts'
import { ChengyingError } from '../util/errors.ts'

export interface EngineSettings {
  darktable?: { enabled?: boolean; path?: string }
  rawtherapee?: { enabled?: boolean; path?: string }
  builtin?: { enabled?: boolean }
  ai?: { enabled?: boolean } & Omit<AiEngineOptions, 'workDir'>
  preferred?: 'auto' | 'darktable' | 'rawtherapee' | 'builtin'
  maxParallel?: number
}

export class EngineRegistry {
  readonly engines = new Map<string, EngineAdapter>()
  private readonly catalogs = new Map<string, Promise<Catalog>>()

  constructor(workDir: string, private readonly settings: EngineSettings = {}) {
    if (settings.darktable?.enabled !== false) this.engines.set('darktable', new DarktableEngine({ cli: settings.darktable?.path, workDir: join(workDir, 'darktable'), maxParallel: settings.maxParallel }))
    if (settings.rawtherapee?.enabled !== false) this.engines.set('rawtherapee', new RawTherapeeEngine({ cli: settings.rawtherapee?.path, workDir: join(workDir, 'rawtherapee'), maxParallel: settings.maxParallel }))
    if (settings.builtin?.enabled !== false) this.engines.set('builtin', new BuiltinEngine())
    if (settings.ai?.enabled !== false) this.engines.set('ai', new AiEngine({ ...settings.ai, workDir: join(workDir, 'ai') }))
  }

  /** Register an additional adapter (extensions, tests). */
  add(engine: EngineAdapter): void {
    this.engines.set(engine.id, engine)
    this.catalogs.delete(engine.id)
  }

  get(id: string): EngineAdapter {
    const e = this.engines.get(id)
    if (e === undefined) throw new ChengyingError('not-found', `unknown engine "${id}"; available: ${[...this.engines.keys()].join(', ')}`)
    return e
  }

  async probeAll(force = false): Promise<EngineProbe[]> {
    return await Promise.all([...this.engines.values()].map(e => e.probe(force)))
  }

  async catalog(id: string, refresh = false, signal?: AbortSignal): Promise<Catalog> {
    if (refresh) this.catalogs.delete(id)
    let c = this.catalogs.get(id)
    if (c === undefined) {
      c = this.get(id).catalog({ refresh, signal })
      this.catalogs.set(id, c)
      c.catch(() => this.catalogs.delete(id))
    }
    return await c
  }

  /** Preferred engine for a source kind: configured choice when available, else darktable → RawTherapee → built-in. */
  async pick(kind: 'raw' | 'raster', requested?: string): Promise<string> {
    const order = requested !== undefined && requested !== 'auto' ? [requested] : this.settings.preferred !== undefined && this.settings.preferred !== 'auto' ? [this.settings.preferred, 'darktable', 'rawtherapee', 'builtin'] : ['darktable', 'rawtherapee', 'builtin']
    for (const id of order) {
      const e = this.engines.get(id)
      if (e === undefined) continue
      const p = await e.probe()
      if (p.available && p.inputs[kind]) return id
      if (requested === id) throw new ChengyingError('engine-unavailable', `${id}: ${p.reason ?? `cannot develop ${kind} inputs`}`)
    }
    if (kind === 'raw') return await this.pick('raster')
    throw new ChengyingError('engine-unavailable', 'no editing engine available')
  }

  async close(): Promise<void> {
    await Promise.all([...this.engines.values()].map(e => e.close?.()))
  }
}
