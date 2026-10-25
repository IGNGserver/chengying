/**
 * Project facade: one photo workspace (read-only originals) plus its
 * Chengying state directory (database, previews, renders, scratch) and export
 * directory. Every subsystem is reached through here so the permission guard
 * and persistence are always applied.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, realpathSync, existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { Db } from './store/db.ts'
import { Repo } from './store/repo.ts'
import { FsGuard } from './fsguard.ts'
import { MetadataService } from './meta/exif.ts'
import { scanWorkspace, type ScanProgress, type ScanResult } from './scan/scanner.ts'
import { makePreview, type RawFallbackRenderer } from './image/preview.ts'
import { FeaturePool } from './analysis/pool.ts'
import { aestheticScore, potentialScore, technicalScore } from './analysis/scoring.ts'
import { FEATURE_VERSION } from './analysis/pixels.ts'
import { computeGroups, DEFAULT_GROUPING, type GroupingOptions } from './grouping/grouping.ts'
import { mergeDims, select, type SelectionResult } from './select/selector.ts'
import { emptyProfile, learn, type PreferenceProfile } from './select/preferences.ts'
import { createModelScorer, type ModelConfig } from './analysis/models.ts'
import { contactSheet } from './image/contact.ts'
import type { Group, GroupKind, ScoreSet, SelectionItem, SelectionSpec, Shot } from './types.ts'
import { ChengyingError, errorMessage } from './util/errors.ts'
import { chunk, mapLimit, newId, round } from './util/misc.ts'

export interface ProjectOptions {
  stateRoot?: string
  exportDir?: string
  extraReadRoots?: string[]
  previewEdge?: number
  analysisEdge?: number
  concurrency?: number
  grouping?: Partial<GroupingOptions>
  rawFallback?: RawFallbackRenderer
}

export interface Progress { stage: string; done: number; total: number; message?: string }
export type ProgressFn = (p: Progress) => void

export function defaultStateRoot(): string {
  return process.env.CHENGYING_HOME ?? join(homedir(), '.chengying')
}

export function projectIdFor(root: string): string {
  return createHash('sha1').update(realpathSync.native(root)).digest('hex').slice(0, 12)
}

export class Project {
  readonly id: string
  readonly root: string
  readonly stateDir: string
  readonly exportDir: string
  readonly db: Db
  readonly repo: Repo
  readonly guard: FsGuard
  readonly metadata: MetadataService
  readonly features: FeaturePool
  readonly options: ProjectOptions
  private closed = false

  static open(root: string, options: ProjectOptions = {}): Project {
    const abs = resolve(root)
    if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new ChengyingError('not-found', `workspace is not a directory: ${root}`)
    return new Project(realpathSync.native(abs), options)
  }

  private constructor(root: string, options: ProjectOptions) {
    this.root = root
    this.options = options
    this.id = projectIdFor(root)
    const stateRoot = resolve(options.stateRoot ?? defaultStateRoot())
    this.stateDir = join(stateRoot, 'projects', this.id)
    this.exportDir = resolve(options.exportDir ?? join(root, '_chengying_export'))
    for (const d of ['previews', 'thumbs', 'scratch', 'renders', 'sheets', 'recipes', 'engines']) mkdirSync(join(this.stateDir, d), { recursive: true })
    this.db = new Db(join(this.stateDir, 'chengying.db'))
    this.repo = new Repo(this.db)
    this.db.setMeta('root', root)
    this.db.setMeta('exportDir', this.exportDir)
    this.guard = new FsGuard({
      workspaceRoots: [root],
      writableRoots: [this.stateDir, this.exportDir],
      extraReadRoots: options.extraReadRoots,
      isOriginal: p => this.repo.isOriginalPath(p),
    })
    this.metadata = new MetadataService({ maxProcs: Math.max(2, Math.min(6, options.concurrency ?? 4)) })
    this.features = new FeaturePool()
  }

  path(...parts: string[]): string {
    return join(this.stateDir, ...parts)
  }

  /* ------------------------------------------------------------ phase 1 */

  async scan(opts: { signal?: AbortSignal; onProgress?: ProgressFn } = {}): Promise<ScanResult> {
    const result = await scanWorkspace({
      root: this.root,
      skipDirs: this.guard.ownedRoots(),
      metadata: this.metadata,
      repo: this.repo,
      concurrency: this.options.concurrency ?? 6,
      signal: opts.signal,
      onProgress: (p: ScanProgress) => opts.onProgress?.({ stage: `scan:${p.phase}`, done: p.done, total: p.total, message: p.current }),
    })
    this.repo.addEvent(null, 'info', 'scan', `scanned ${result.files} files → ${result.shots} shots (${result.pairs} RAW+JPEG pairs)`, result)
    return result
  }

  async buildPreviews(opts: { force?: boolean; signal?: AbortSignal; onProgress?: ProgressFn } = {}): Promise<{ built: number; skipped: number; failed: Array<{ shotId: string; error: string }> }> {
    const shots = this.repo.shots()
    let done = 0
    let built = 0
    let skipped = 0
    const failed: Array<{ shotId: string; error: string }> = []
    await mapLimit(shots, this.options.concurrency ?? 4, async (shot) => {
      const previewPath = this.path('previews', `${shot.id}.jpg`)
      const thumbPath = this.path('thumbs', `${shot.id}.jpg`)
      if (!opts.force && shot.previewPath !== null && existsSync(shot.previewPath) && shot.thumbPath !== null && existsSync(shot.thumbPath)) {
        skipped++
      } else {
        // Prefer the camera JPEG for display (it is what the photographer saw), RAW otherwise.
        const file = this.repo.file(shot.rasterFile ?? shot.primaryFile)
        try {
          if (file === undefined) throw new Error('missing file record')
          const src = this.guard.readable(file.path)
          const r = await makePreview(src, file.ext, file.meta.orientation, this.guard.writable(previewPath), this.guard.writable(thumbPath), {
            maxEdge: this.options.previewEdge ?? 1600,
            metadata: this.metadata,
            rawFallback: this.options.rawFallback,
            scratchDir: this.path('scratch'),
          })
          this.repo.updateShot(shot.id, { previewPath, thumbPath, previewSource: r.source, previewError: null })
          built++
        } catch (error) {
          failed.push({ shotId: shot.id, error: errorMessage(error) })
          this.repo.updateShot(shot.id, { previewError: errorMessage(error) })
        }
      }
      opts.onProgress?.({ stage: 'previews', done: ++done, total: shots.length })
    }, opts.signal)
    return { built, skipped, failed }
  }

  async analyze(opts: { force?: boolean; signal?: AbortSignal; onProgress?: ProgressFn } = {}): Promise<{ analyzed: number; skipped: number; failed: Array<{ shotId: string; error: string }> }> {
    const shots = this.repo.shots()
    let done = 0
    let analyzed = 0
    let skipped = 0
    const failed: Array<{ shotId: string; error: string }> = []
    await mapLimit(shots, Math.max(2, this.options.concurrency ?? 4), async (shot) => {
      const prev = this.repo.features(shot.id)
      if (!opts.force && prev?.version === FEATURE_VERSION && this.repo.scores(shot.id).technical !== undefined) {
        skipped++
      } else if (shot.previewPath === null || !existsSync(shot.previewPath)) {
        failed.push({ shotId: shot.id, error: shot.previewError ?? 'no preview' })
      } else {
        try {
          const f = await this.features.compute(shot.previewPath, this.options.analysisEdge ?? 512)
          const ctx = {
            isRaw: shot.rawFile !== null,
            iso: shot.iso,
            exposureTime: shot.exposureTime,
            focalLength: shot.focalLength,
            hour: shot.captureTime !== null ? Number(shot.captureTime.slice(11, 13)) + Number(shot.captureTime.slice(14, 16)) / 60 : null,
          }
          const tech = technicalScore(f, ctx)
          const aes = aestheticScore(f, ctx)
          const pot = potentialScore(f, tech, ctx)
          this.db.tx(() => {
            this.repo.saveFeatures(shot.id, f)
            this.repo.saveScore(shot.id, 'technical', { ...tech, potential: pot.potential, reasons: { ...tech.reasons, ...pot.reasons }, overall: tech.technical }, FEATURE_VERSION)
            this.repo.saveScore(shot.id, 'aesthetic', { ...aes, overall: aes.aesthetic }, FEATURE_VERSION)
          })
          analyzed++
        } catch (error) {
          failed.push({ shotId: shot.id, error: errorMessage(error) })
        }
      }
      opts.onProgress?.({ stage: 'analyze', done: ++done, total: shots.length })
    }, opts.signal)
    this.regroup()
    return { analyzed, skipped, failed }
  }

  /** Run configured specialised models over shots (only those not yet scored by that model unless forced). */
  async scoreWithModels(configs: ModelConfig[], opts: { force?: boolean; shotIds?: string[]; signal?: AbortSignal; onProgress?: ProgressFn } = {}): Promise<Record<string, { scored: number; failed: number; error?: string }>> {
    const out: Record<string, { scored: number; failed: number; error?: string }> = {}
    const shots = this.repo.shots().filter(s => s.previewPath !== null && (opts.shotIds === undefined || opts.shotIds.includes(s.id)))
    for (const cfg of configs) {
      const scorer = createModelScorer(cfg)
      const source = `model:${cfg.id}`
      const todo = shots.filter(s => opts.force === true || this.repo.scores(s.id)[source] === undefined)
      const res = { scored: 0, failed: 0 } as { scored: number; failed: number; error?: string }
      let done = 0
      for (const batch of chunk(todo, scorer.batchSize)) {
        opts.signal?.throwIfAborted()
        try {
          const scores = await scorer.score(batch.map(s => s.previewPath as string), opts.signal)
          batch.forEach((s, i) => { const sc = scores[i]; if (sc !== undefined) { this.repo.saveScore(s.id, source, sc); res.scored++ } })
        } catch (error) {
          res.failed += batch.length
          res.error = errorMessage(error)
          if (error instanceof ChengyingError && error.code === 'engine-unavailable') break
        }
        done += batch.length
        opts.onProgress?.({ stage: `model:${cfg.id}`, done, total: todo.length })
      }
      await scorer.close?.()
      out[cfg.id] = res
    }
    return out
  }

  rankOf(shotId: string): number {
    const sc = this.repo.scores(shotId)
    const d = mergeDims(sc)
    return (d.technical ?? 0) * 0.5 + (d.aesthetic ?? 0) * 0.5
  }

  regroup(): Record<string, number> {
    const shots = this.repo.shots()
    const features = this.repo.allFeatures()
    const scores = this.repo.allScores()
    const rank = (id: string): number => {
      const d = mergeDims(scores.get(id) ?? {})
      return (d.technical ?? 0) * 0.5 + (d.aesthetic ?? 0) * 0.5
    }
    const g = computeGroups({ shots, files: this.repo.files(), features, rank }, { ...DEFAULT_GROUPING, ...(this.options.grouping ?? {}) })
    const counts: Record<string, number> = {}
    for (const kind of ['exact', 'near', 'scene', 'segment', 'location'] as const) {
      this.repo.replaceGroups(kind, g[kind])
      counts[kind] = g[kind].length
    }
    return counts
  }

  groups(kind: GroupKind): Group[] {
    return this.repo.groups(kind)
  }

  profile(): PreferenceProfile {
    return this.repo.pref<PreferenceProfile>('preference-profile', emptyProfile())
  }

  setProfile(p: PreferenceProfile): void {
    this.repo.setPref('preference-profile', p)
  }

  select(spec: SelectionSpec, opts: { name?: string; base?: string } = {}): { selectionId: string; result: SelectionResult } {
    const keep = opts.base !== undefined ? this.repo.selection(opts.base)?.items : undefined
    const result = select({
      shots: this.repo.shots(),
      scores: this.repo.allScores(),
      features: this.repo.allFeatures(),
      groups: { near: this.groups('near'), exact: this.groups('exact'), scene: this.groups('scene'), segment: this.groups('segment') },
      profile: this.profile(),
      keep,
    }, spec)
    const name = opts.name ?? spec.name ?? (spec.request !== undefined ? spec.request.slice(0, 40) : `selection ${new Date().toISOString().slice(0, 16)}`)
    const selectionId = this.repo.createSelection(name, spec, result.items, result.stats)
    this.repo.addEvent(null, 'info', 'select', `selection "${name}": ${result.stats.selected} photos`, { selectionId, stats: result.stats })
    return { selectionId, result }
  }

  /** Manual adjustment. User changes also teach the preference profile. */
  adjustSelection(selectionId: string, ops: { add?: string[]; remove?: string[]; lock?: string[]; unlock?: string[] }, by: 'user' | 'agent' = 'user'): { included: number } {
    const sel = this.repo.selection(selectionId)
    if (sel === undefined) throw new ChengyingError('not-found', `no selection ${selectionId}`)
    const items = new Map(sel.items.map(i => [i.shotId, i]))
    const allScores = this.repo.allScores()
    const means: Record<string, number> = {}
    const dimsOf = (id: string): Record<string, number> => {
      const d = mergeDims(allScores.get(id) ?? {})
      return Object.fromEntries(Object.entries(d).filter(([, v]) => typeof v === 'number')) as Record<string, number>
    }
    const all = [...allScores.keys()].map(dimsOf)
    for (const k of ['technical', 'aesthetic', 'composition', 'content', 'story', 'potential']) {
      const vals = all.map(d => d[k]).filter((v): v is number => v !== undefined)
      if (vals.length > 0) means[k] = vals.reduce((a, b) => a + b, 0) / vals.length
    }
    let profile = this.profile()
    const maxRank = Math.max(0, ...sel.items.map(i => i.rank))
    this.db.tx(() => {
      for (const id of ops.add ?? []) {
        if (this.repo.shot(id) === undefined) throw new ChengyingError('not-found', `no shot ${id}`)
        const prev = items.get(id)
        const it: SelectionItem = { shotId: id, rank: prev?.rank ?? maxRank + 1, score: prev?.score ?? round(this.rankOf(id), 1), reason: prev?.reason ?? `added by ${by}`, source: by === 'user' ? 'user' : (prev?.source ?? 'auto'), locked: prev?.locked ?? false, included: true }
        this.repo.saveSelectionItem(selectionId, it)
        if (by === 'user' && prev?.included !== true) {
          const d = dimsOf(id)
          this.repo.addFeedback(id, selectionId, 1, d)
          profile = learn(profile, 1, d, means, mergeDims(allScores.get(id) ?? {}).tags)
        }
      }
      for (const id of ops.remove ?? []) {
        const prev = items.get(id)
        if (prev === undefined) continue
        this.repo.saveSelectionItem(selectionId, { ...prev, included: false, source: by === 'user' ? 'user' : prev.source })
        if (by === 'user' && prev.included) {
          const d = dimsOf(id)
          this.repo.addFeedback(id, selectionId, -1, d)
          profile = learn(profile, -1, d, means, mergeDims(allScores.get(id) ?? {}).tags)
        }
      }
      // Lock/unlock see the rows written above (an item can be added and locked in one call).
      const current = new Map((this.repo.selection(selectionId)?.items ?? []).map(i => [i.shotId, i]))
      for (const id of ops.lock ?? []) { const prev = current.get(id); if (prev) this.repo.saveSelectionItem(selectionId, { ...prev, locked: true }) }
      for (const id of ops.unlock ?? []) { const prev = current.get(id); if (prev) this.repo.saveSelectionItem(selectionId, { ...prev, locked: false }) }
    })
    if (by === 'user') this.setProfile(profile)
    return { included: this.repo.selection(selectionId)?.items.filter(i => i.included).length ?? 0 }
  }

  /** Persist judgments from the vision LLM, the agent or the user. */
  recordScores(shotId: string, source: string, score: ScoreSet): void {
    if (this.repo.shot(shotId) === undefined) throw new ChengyingError('not-found', `no shot ${shotId}`)
    this.repo.saveScore(shotId, source, score)
    if (score.tags !== undefined && score.tags.length > 0) {
      const shot = this.repo.shot(shotId) as Shot
      this.repo.updateShot(shotId, { tags: [...new Set([...shot.tags, ...score.tags])] })
    }
  }

  async sheet(shotIds: string[], options: { labels?: string[]; captions?: string[]; columns?: number; cell?: number } = {}): Promise<{ path: string; labels: string[] }> {
    const cells = shotIds.map((id, i) => {
      const s = this.repo.shot(id)
      if (s === undefined || (s.thumbPath === null && s.previewPath === null)) throw new ChengyingError('not-found', `no preview for ${id}`)
      return { label: options.labels?.[i] ?? `#${i + 1}`, path: (options.cell ?? 360) > 400 ? (s.previewPath ?? s.thumbPath) as string : (s.thumbPath ?? s.previewPath) as string, caption: options.captions?.[i] }
    })
    const dest = this.guard.writable(this.path('sheets', `${newId('sheet')}.jpg`))
    await contactSheet(cells, dest, { columns: options.columns, cell: options.cell })
    return { path: dest, labels: cells.map(c => c.label) }
  }

  summary(): Record<string, unknown> {
    const shots = this.repo.shots()
    const scored = this.repo.allScores()
    return {
      projectId: this.id,
      root: this.root,
      stateDir: this.stateDir,
      exportDir: this.exportDir,
      shots: shots.length,
      raw: shots.filter(s => s.rawFile !== null).length,
      pairs: shots.filter(s => s.rawFile !== null && s.rasterFile !== null).length,
      withPreview: shots.filter(s => s.previewPath !== null).length,
      analyzed: [...scored.values()].filter(s => s.technical !== undefined).length,
      judged: [...scored.values()].filter(s => Object.keys(s).some(k => k.startsWith('vlm:') || k === 'agent')).length,
      groups: Object.fromEntries((['exact', 'near', 'scene', 'segment', 'location'] as const).map(k => [k, Number(this.db.get<{ c: number }>('SELECT count(*) c FROM groups WHERE kind = ?', k)?.c ?? 0)])),
      selections: this.repo.selections().length,
      tasks: Object.fromEntries(this.db.all<{ status: string; c: number }>('SELECT status, count(*) c FROM tasks GROUP BY status').map(r => [r.status, Number(r.c)])),
      exports: this.repo.exports().length,
      usage: this.repo.usageSummary(),
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.features.close()
    await this.metadata.end()
    this.db.close()
  }
}
