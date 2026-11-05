/** Engine registry: constructs the adapters, probes them and picks defaults. */
import { join } from 'node:path'
import type { Catalog, EngineAdapter, EngineHealth, EngineProbe } from './engine.ts'
import { DarktableEngine } from './engines/darktable/index.ts'
import { RawTherapeeEngine } from './engines/rawtherapee/index.ts'
import { BuiltinEngine } from './engines/builtin/index.ts'
import { AiEngine, type AiEngineOptions } from './engines/ai/index.ts'
import { ChengyingError, errorMessage } from '../util/errors.ts'

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
  private readonly healthCache = new Map<string, { fingerprint: string; health: EngineHealth }>()

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

  /**
   * Cheap capability check: catalog discovery plus one throw-away render.
   * Cached per probe fingerprint so repeated picks cost nothing; `refresh`
   * re-runs both after the user installs/updates an engine.
   */
  async health(id: string, opts: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<EngineHealth> {
    const engine = this.get(id)
    const probe = await engine.probe(opts.refresh === true)
    if (!probe.available) return { ok: false, catalog: 'failed', render: 'skipped', reason: probe.reason ?? 'not installed' }
    const fingerprint = probe.fingerprint ?? `${id}:${probe.version ?? '?'}`
    const cached = this.healthCache.get(id)
    if (opts.refresh !== true && cached !== undefined && cached.fingerprint === fingerprint) return cached.health
    const started = Date.now()
    let health: EngineHealth
    try {
      await this.catalog(id, opts.refresh === true, opts.signal)
    } catch (error) {
      health = { ok: false, catalog: 'failed', render: 'skipped', reason: errorMessage(error), durationMs: Date.now() - started }
      this.healthCache.set(id, { fingerprint, health })
      return health
    }
    let render: EngineHealth['render'] = 'skipped'
    let reason: string | undefined
    if (engine.smokeTest !== undefined) {
      try {
        const smoke = await engine.smokeTest(opts.signal)
        render = smoke.skipped === true ? 'skipped' : smoke.ok ? 'ok' : 'failed'
        reason = smoke.reason
      } catch (error) {
        render = 'failed'
        reason = errorMessage(error)
      }
    }
    health = { ok: render !== 'failed', catalog: 'ok', render, reason, durationMs: Date.now() - started }
    this.healthCache.set(id, { fingerprint, health })
    return health
  }

  /** Clear cached health results (after installing/updating an engine). */
  resetHealth(): void {
    this.healthCache.clear()
  }

  async catalog(id: string, refresh = false, signal?: AbortSignal): Promise<Catalog> {
    if (refresh) {
      this.catalogs.delete(id)
      this.healthCache.delete(id)
    }
    let c = this.catalogs.get(id)
    if (c === undefined) {
      c = this.get(id).catalog({ refresh, signal })
      this.catalogs.set(id, c)
      c.catch(() => this.catalogs.delete(id))
    }
    return await c
  }

  /**
   * Preferred engine for a source kind: configured choice when available, else
   * darktable → RawTherapee → built-in. An engine that is installed but cannot
   * actually render (broken CLI, missing discovery data) is skipped with its
   * reason kept, so the agent gets "darktable failed: …" instead of a render
   * error on the first photo.
   */
  async pick(kind: 'raw' | 'raster', requested?: string): Promise<string> {
    const builtinOrder = ['darktable', 'rawtherapee', 'builtin']
    const preferred = requested !== undefined && requested !== 'auto'
      ? [requested]
      : this.settings.preferred !== undefined && this.settings.preferred !== 'auto'
        ? [this.settings.preferred, ...builtinOrder]
        : builtinOrder
    // Engines registered at runtime (extensions, tests) come last but stay reachable.
    const order = [...new Set([...preferred, ...this.engines.keys()])]
    const rejected: string[] = []
    for (const id of order) {
      const e = this.engines.get(id)
      if (e === undefined) continue
      const p = await e.probe()
      if (!p.available || !p.inputs[kind]) {
        if (requested === id) throw new ChengyingError('engine-unavailable', `${id}: ${p.reason ?? `cannot develop ${kind} inputs`}`)
        continue
      }
      const h = await this.health(id)
      if (!h.ok) {
        rejected.push(`${id}: ${h.reason ?? 'health check failed'}`)
        if (requested === id) throw new ChengyingError('engine-unavailable', `${id}: ${h.reason ?? 'health check failed'}`, { engine: id, health: h })
        continue
      }
      return id
    }
    if (kind === 'raw' && (requested === undefined || requested === 'auto')) {
      // No RAW-capable engine: a raster engine can still handle the camera JPEG.
      return await this.pick('raster')
    }
    throw new ChengyingError('engine-unavailable', rejected.length > 0 ? `no usable editing engine for ${kind} inputs (${rejected.join('; ')})` : 'no editing engine available')
  }

  async close(): Promise<void> {
    await Promise.all([...this.engines.values()].map(e => e.close?.()))
  }
}
