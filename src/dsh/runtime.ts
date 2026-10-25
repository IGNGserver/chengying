/**
 * Plugin runtime: owns open projects, background activities, model-facing
 * images and the automated vision-LLM pass. Tools and the HTTP API are thin
 * adapters over this object.
 */
import sharp from 'sharp'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, renameSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Config } from './config.ts'
import type { AgentLike, AttachmentsService, HostContext, JobsService, LlmService, ToolRunContext } from './host-types.ts'
import type { ToolImage } from './tool.ts'
import { Project, defaultStateRoot, projectIdFor } from '../core/project.ts'
import { isInside } from '../core/fsguard.ts'
import { ChengyingError, errorMessage } from '../core/util/errors.ts'
import { chunk, newId, nowIso, round } from '../core/util/misc.ts'
import { buildVlmPrompt, parseVlmResponse, type VlmItem } from '../core/analysis/vlm.ts'
import { mergeDims } from '../core/select/selector.ts'
import type { Shot } from '../core/types.ts'

export interface Activity {
  id: string
  projectId: string | null
  kind: string
  label: string
  state: 'running' | 'completed' | 'failed' | 'cancelled'
  stage: string
  done: number
  total: number
  message?: string
  jobId?: string
  startedAt: string
  finishedAt?: string
  error?: string
  result?: unknown
}

export type Log = { info(...a: unknown[]): void; warn(...a: unknown[]): void; error(...a: unknown[]): void }

export class ChengyingRuntime {
  /** HTTP router (set when the web server is mounted). */
  router!: import('./http.ts').ApiRouter
  readonly projects = new Map<string, Project>()
  readonly activities = new Map<string, Activity>()
  private readonly current = new Map<string, string>()
  private lastProject: string | undefined
  private readonly controllers = new Map<string, AbortController>()

  constructor(readonly ctx: HostContext, readonly config: Config, readonly log: Log) {}

  /* ----------------------------------------------------------- projects */

  openProject(path: string, agentId?: string, options: { exportDir?: string } = {}): Project {
    const abs = resolve(path)
    if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new ChengyingError('not-found', `workspace directory does not exist: ${path}`)
    if (this.config.allowedRoots.length > 0 && !this.config.allowedRoots.some(r => isInside(abs, resolve(r)))) {
      throw new ChengyingError('permission-denied', `workspace ${abs} is outside the configured allowedRoots`, { allowedRoots: this.config.allowedRoots })
    }
    const id = projectIdFor(abs)
    let p = this.projects.get(id)
    if (p === undefined) {
      p = Project.open(abs, {
        stateRoot: this.config.stateRoot,
        exportDir: options.exportDir ?? this.config.exportDir,
        previewEdge: this.config.previewEdge,
        concurrency: this.config.analysisConcurrency,
      })
      this.projects.set(id, p)
    }
    if (agentId !== undefined) this.current.set(agentId, id)
    this.lastProject = id
    this.rememberRecent(p)
    return p
  }

  private recentFile(): string {
    return join(resolve(this.config.stateRoot ?? defaultStateRoot()), 'recent-projects.json')
  }

  /** Workspaces opened before (survives Harness restarts); the UI offers them for reopening. */
  recent(): Array<{ id: string; root: string; openedAt: string }> {
    try {
      const list = JSON.parse(readFileSync(this.recentFile(), 'utf8')) as Array<{ id: string; root: string; openedAt: string }>
      return Array.isArray(list) ? list.filter(r => typeof r.root === 'string') : []
    } catch {
      return []
    }
  }

  private rememberRecent(p: Project): void {
    try {
      const list = [{ id: p.id, root: p.root, openedAt: nowIso() }, ...this.recent().filter(r => r.id !== p.id)].slice(0, 20)
      const file = this.recentFile()
      mkdirSync(join(file, '..'), { recursive: true })
      writeFileSync(`${file}.tmp`, JSON.stringify(list, null, 1))
      renameSync(`${file}.tmp`, file)
    } catch (error) {
      this.log.warn('chengying: cannot record recent workspace:', errorMessage(error))
    }
  }

  /** Resolve a project from an id, a path, the caller's current project or the last opened one. */
  project(ref: string | undefined, agentId?: string): Project {
    if (ref !== undefined && ref !== '') {
      const byId = this.projects.get(ref)
      if (byId !== undefined) return byId
      if (ref.includes('/') || ref.includes('\\')) return this.openProject(ref, agentId)
      throw new ChengyingError('not-found', `unknown project "${ref}"; open it with photo_workspace_open first`)
    }
    const id = (agentId !== undefined ? this.current.get(agentId) : undefined) ?? this.lastProject
    const p = id === undefined ? undefined : this.projects.get(id)
    if (p === undefined) throw new ChengyingError('not-found', 'no photo workspace is open; call photo_workspace_open with the folder path')
    return p
  }

  bindAgent(agentId: string, projectId: string): void {
    this.current.set(agentId, projectId)
  }

  /* --------------------------------------------------------- activities */

  beginActivity(kind: string, label: string, projectId: string | null): { activity: Activity; signal: AbortSignal; progress: (stage: string, done: number, total: number, message?: string) => void } {
    const activity: Activity = { id: newId('act'), projectId, kind, label, state: 'running', stage: 'starting', done: 0, total: 0, startedAt: nowIso() }
    const ctl = new AbortController()
    this.activities.set(activity.id, activity)
    this.controllers.set(activity.id, ctl)
    // Keep the registry bounded.
    if (this.activities.size > 200) {
      for (const [id, a] of this.activities) { if (a.state !== 'running') { this.activities.delete(id); break } }
    }
    return {
      activity,
      signal: ctl.signal,
      progress: (stage, done, total, message) => {
        activity.stage = stage; activity.done = done; activity.total = total; activity.message = message
      },
    }
  }

  endActivity(a: Activity, outcome: { error?: unknown; result?: unknown; cancelled?: boolean }): void {
    a.finishedAt = nowIso()
    this.controllers.delete(a.id)
    if (outcome.cancelled) a.state = 'cancelled'
    else if (outcome.error !== undefined) { a.state = 'failed'; a.error = errorMessage(outcome.error) }
    else { a.state = 'completed'; a.result = outcome.result }
  }

  /** Start work detached from any agent (UI-initiated); progress is visible through activities. */
  startDetached<T>(kind: string, label: string, projectId: string | null, work: (signal: AbortSignal, progress: (stage: string, done: number, total: number, message?: string) => void) => Promise<T>): Activity {
    const { activity, signal, progress } = this.beginActivity(kind, label, projectId)
    void work(signal, progress).then(
      result => this.endActivity(activity, { result }),
      error => this.endActivity(activity, { error, cancelled: signal.aborted }),
    )
    return activity
  }

  cancelActivity(id: string): boolean {
    const c = this.controllers.get(id)
    if (c === undefined) return false
    c.abort(new ChengyingError('cancelled', 'cancelled by request'))
    return true
  }

  /**
   * Run work either inline (small inputs, or no job service) or as a DSH
   * background job owned by the calling agent; the job settlement notifies
   * the model automatically.
   */
  async runMaybeBackground<T>(exec: ToolRunContext, opts: { kind: string; label: string; projectId: string | null; background: boolean }, work: (signal: AbortSignal, progress: (stage: string, done: number, total: number, message?: string) => void) => Promise<T>, summarize: (r: T) => string): Promise<{ mode: 'inline'; activityId: string; result: T } | { mode: 'background'; activityId: string; jobId: string }> {
    const jobs = this.ctx.get('jobs') as JobsService | undefined
    const { activity, signal, progress } = this.beginActivity(opts.kind, opts.label, opts.projectId)
    if (opts.background && jobs !== undefined && exec.agent !== undefined) {
      let jobId = ''
      try {
        jobId = jobs.start({
          kind: 'chengying',
          label: opts.label,
          owner: exec.agent.id,
          toolCall: { callId: exec.callId, rootCallId: exec.rootCallId ?? exec.callId },
          outputLimitBytes: 16_000,
          run: (job) => {
            let lastLine = ''
            const done = (async () => {
              try {
                const result = await work(signal, (stage, d, t, m) => {
                  progress(stage, d, t, m)
                  const line = `${stage} ${d}/${t}`
                  if (line !== lastLine) { job.updateProgress(line); lastLine = line }
                })
                const text = summarize(result)
                job.append(`${text}\n`, { stream: 'stdout' })
                this.endActivity(activity, { result })
                return { status: 'completed' as const, result: text }
              } catch (error) {
                const cancelled = signal.aborted
                this.endActivity(activity, { error, cancelled })
                job.append(`${errorMessage(error)}\n`, { stream: 'stderr' })
                return { status: cancelled ? 'killed' as const : 'failed' as const, detail: errorMessage(error).slice(0, 200) }
              }
            })()
            return { cancel: () => { this.cancelActivity(activity.id) }, done }
          },
        })
      } catch (error) {
        this.log.warn('chengying: background job unavailable, running inline:', errorMessage(error))
        return await this.runInline(activity, signal, progress, work, exec.signal)
      }
      activity.jobId = jobId
      return { mode: 'background', activityId: activity.id, jobId }
    }
    return await this.runInline(activity, signal, progress, work, exec.signal)
  }

  private async runInline<T>(activity: Activity, signal: AbortSignal, progress: (stage: string, done: number, total: number, message?: string) => void, work: (signal: AbortSignal, progress: (stage: string, done: number, total: number, message?: string) => void) => Promise<T>, outer: AbortSignal): Promise<{ mode: 'inline'; activityId: string; result: T }> {
    const onAbort = (): void => { this.cancelActivity(activity.id) }
    outer.addEventListener('abort', onAbort, { once: true })
    try {
      const result = await work(signal, progress)
      this.endActivity(activity, { result })
      return { mode: 'inline', activityId: activity.id, result }
    } catch (error) {
      this.endActivity(activity, { error, cancelled: signal.aborted })
      throw error
    } finally {
      outer.removeEventListener('abort', onAbort)
    }
  }

  /* ------------------------------------------------------------- images */

  /** Resolve the calling agent's model route. */
  route(agent: AgentLike | undefined): { provider?: string; model?: string } {
    const routed = agent?.session?.requestHeader?.()?.config
    return { provider: routed?.provider ?? agent?.options?.provider, model: routed?.model ?? agent?.options?.model }
  }

  async routeAcceptsImages(provider: string | undefined, model: string | undefined, signal?: AbortSignal): Promise<boolean> {
    const llm = this.ctx.get('llm') as LlmService | undefined
    if (llm === undefined || provider === undefined || model === undefined) return false
    try {
      const info = await llm.resolveModelInfo(provider, model, signal)
      return info.inputModalities?.includes('image') === true
    } catch {
      return false
    }
  }

  /**
   * Store an image as a session attachment for the model. Returns undefined
   * (with a reason) when the route cannot see images, so tools can fall back
   * to text.
   */
  async imageForModel(path: string, exec: ToolRunContext, options: { maxEdge?: number; caption?: string; name?: string } = {}): Promise<{ image?: ToolImage; reason?: string }> {
    const attachments = this.ctx.get('attachments') as AttachmentsService | undefined
    if (attachments === undefined) return { reason: 'no attachment service mounted' }
    const { provider, model } = this.route(exec.agent)
    if (!await this.routeAcceptsImages(provider, model, exec.signal)) {
      return { reason: `model ${model ?? '(unknown)'} does not declare image input; switch to a vision-capable model to see photos` }
    }
    const limit = Math.min(options.maxEdge ?? 1568, attachments.imageLimits.maxImageDimension || 1568)
    const data = await sharp(path).resize({ width: limit, height: limit, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 84 }).toBuffer()
    const ref = await attachments.saveImage({ data: new Uint8Array(data), mediaType: 'image/jpeg', name: options.name ?? 'chengying.jpg' })
    return { image: { ...ref, ...(options.caption === undefined ? {} : { caption: options.caption }) } }
  }

  /* ----------------------------------------------------- vision LLM pass */

  vlmRoute(exec: ToolRunContext | undefined): { provider?: string; model?: string } {
    if (this.config.vlm.provider !== undefined && this.config.vlm.model !== undefined) return { provider: this.config.vlm.provider, model: this.config.vlm.model }
    return this.route(exec?.agent)
  }

  /**
   * Score shots with the vision model in contact-sheet batches. Records every
   * call's token usage. Returns per-shot results and totals.
   */
  async vlmScore(project: Project, shotIds: string[], exec: ToolRunContext | undefined, opts: { purpose?: string; signal?: AbortSignal; progress?: (d: number, t: number) => void } = {}): Promise<{ scored: number; failed: number; batches: number; model: string; usage: { inputTokens: number; outputTokens: number }; errors: string[] }> {
    const llm = this.ctx.get('llm') as LlmService | undefined
    const attachments = this.ctx.get('attachments') as AttachmentsService | undefined
    if (llm === undefined || attachments === undefined) throw new ChengyingError('engine-unavailable', 'vision scoring needs the Harness llm and attachment services')
    const { provider, model } = this.vlmRoute(exec)
    if (provider === undefined || model === undefined) throw new ChengyingError('engine-unavailable', 'no model route for vision scoring; set vlm.provider/vlm.model in the plugin config')
    if (!await this.routeAcceptsImages(provider, model, opts.signal)) {
      throw new ChengyingError('engine-unavailable', `model ${provider}/${model} does not accept images; configure vlm.provider/vlm.model with a vision model, or let the agent review contact sheets with photo_view on a vision-capable route`)
    }
    const shots = shotIds.map(id => project.repo.shot(id)).filter((s): s is Shot => s !== undefined && (s.thumbPath !== null || s.previewPath !== null))
    const batches = chunk(shots, Math.max(1, this.config.vlm.batchSize))
    let scored = 0
    let failed = 0
    let inputTokens = 0
    let outputTokens = 0
    const errors: string[] = []
    let done = 0
    for (const batch of batches) {
      opts.signal?.throwIfAborted()
      const items: VlmItem[] = batch.map((s, i) => ({ label: `#${i + 1}`, shotId: s.id, context: this.shotContext(project, s) }))
      try {
        const sheet = await project.sheet(batch.map(s => s.id), { labels: items.map(i => i.label), cell: this.config.vlm.cell, columns: Math.ceil(Math.sqrt(batch.length)) })
        const data = await sharp(sheet.path).jpeg({ quality: 85 }).toBuffer()
        const ref = await attachments.saveImage({ data: new Uint8Array(data), mediaType: 'image/jpeg', name: 'contact-sheet.jpg' })
        const prompt = buildVlmPrompt(items, { language: this.config.vlm.language, purpose: opts.purpose })
        let text = ''
        let usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
        let failure: string | undefined
        for await (const ch of llm.stream({
          provider, model, maxTokens: this.config.vlm.maxTokens, signal: opts.signal,
          messages: [{ role: 'user', content: [{ type: 'image', attachment: ref }, { type: 'text', text: prompt }] }],
        })) {
          if (ch.type === 'text-delta') text += String(ch.text ?? '')
          else if (ch.type === 'usage') usage = { ...usage, ...(ch.usage as typeof usage) }
          else if (ch.type === 'finish') {
            const reason = ch.reason as { kind?: string; failure?: { message?: string; code?: string } } | undefined
            if (reason?.kind === 'error' || reason?.kind === 'aborted') failure = `${reason.failure?.code ?? reason.kind}: ${reason.failure?.message ?? ''}`
          }
        }
        project.repo.addUsage({ taskId: null, purpose: 'vlm-cull', provider, model, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens: usage.cacheReadTokens ?? 0, cacheWriteTokens: usage.cacheWriteTokens ?? 0, images: 1 })
        inputTokens += usage.inputTokens
        outputTokens += usage.outputTokens
        if (failure !== undefined) throw new Error(failure)
        const parsed = parseVlmResponse(text, items)
        for (const it of items) {
          const sc = parsed.get(it.shotId)
          if (sc === undefined) { failed++; continue }
          project.recordScores(it.shotId, `vlm:${model}`, sc)
          scored++
        }
        if (parsed.size === 0) errors.push(`batch ${batches.indexOf(batch) + 1}: unparseable answer: ${text.slice(0, 200)}`)
      } catch (error) {
        if (opts.signal?.aborted) throw error
        failed += batch.length
        errors.push(errorMessage(error))
      }
      done += batch.length
      opts.progress?.(done, shots.length)
    }
    project.regroup()
    return { scored, failed, batches: batches.length, model: `${provider}/${model}`, usage: { inputTokens, outputTokens }, errors: errors.slice(0, 10) }
  }

  shotContext(project: Project, s: Shot): string {
    const dims = mergeDims(project.repo.scores(s.id))
    const bits = [
      s.captureTime?.replace('T', ' ').slice(0, 16) ?? 'undated',
      s.gps !== null ? `gps ${s.gps.lat.toFixed(3)},${s.gps.lon.toFixed(3)}` : undefined,
      s.camera ?? undefined,
      s.focalLength !== null ? `${round(s.focalLength, 0)}mm` : undefined,
      s.iso !== null ? `ISO${s.iso}` : undefined,
      s.rawFile !== null ? 'RAW' : 'JPEG',
      dims.technical !== undefined ? `tech ${round(dims.technical, 0)}` : undefined,
      dims.issues.length > 0 ? `issues: ${dims.issues.slice(0, 4).join(',')}` : undefined,
    ]
    return bits.filter(Boolean).join(' · ')
  }

  async close(): Promise<void> {
    for (const c of this.controllers.values()) c.abort()
    await Promise.all([...this.projects.values()].map(p => p.close()))
    this.projects.clear()
  }
}
