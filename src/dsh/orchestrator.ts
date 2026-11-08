/**
 * Editing sub-agent orchestration.
 *
 * Each queued task is handed to its own DSH sub-agent (provider "spawn" by
 * default) with a reserved child id. When the child agent is created, the
 * orchestrator registers task-bound editing tools in the child's own scope and
 * restricts its global tools to the read-only engine discovery tools — the
 * child cannot run shell commands or touch files outside Chengying's guarded
 * tools. Concurrency is bounded; token usage of the child's model calls is
 * attributed to the task. Pause/cancel dispose the child; all revisions stay,
 * so resume/retry continue from the latest revision.
 */
import { randomUUID } from 'node:crypto'
import type { ChengyingRuntime } from './runtime.ts'
import type { AgentLike, HostContext, SubagentActivation, SubagentsService, ToolRunContext } from './host-types.ts'
import { taskTools } from './tools/edit.ts'
import type { Project } from '../core/project.ts'
import type { TaskRecord } from '../core/types.ts'
import { ChengyingError, errorMessage } from '../core/util/errors.ts'
import { round, Semaphore } from '../core/util/misc.ts'
import { emptyUsage } from '../core/store/repo.ts'

/** Global tools an editing child may still see (everything else is hidden). */
export const CHILD_GLOBAL_TOOLS = ['edit_engines', 'edit_capabilities', 'edit_describe', 'edit_native', 'skill']

interface Child { projectId: string; taskId: string; setupError?: string; ready?: boolean }

/** Extract actionable pixel-level measurements from culling features so sub-agents do not guess angles, casts or mask coordinates. */
export function photoDiagnostics(project: Project, shotId: string): Record<string, unknown> | undefined {
  const f = project.repo.features(shotId)
  if (f === undefined) return undefined
  const castMag = Math.hypot(f.color.castA, f.color.castB)
  const wbHint = castMag >= 6
    ? `neutral cast detected (Lab a*=${round(f.color.castA, 1)}, b*=${round(f.color.castB, 1)}): consider white_balance temperature ${f.color.castB > 0 ? 'cooler (−)' : 'warmer (+)'}${Math.abs(f.color.castA) >= 4 ? `, tint ${f.color.castA > 0 ? 'greener (−)' : 'magenta (+)'}` : ''}`
    : undefined
  const tiltHint = f.composition.tiltConfidence >= 0.35 && Math.abs(f.composition.tiltDeg) >= 0.8
    ? `measured horizon/vertical tilt ${round(f.composition.tiltDeg, 2)}° (confidence ${round(f.composition.tiltConfidence, 2)}): use rotate angle=${round(f.composition.tiltDeg, 2)} (or ashift/Rotation)`
    : undefined
  const fb = f.subject?.faceBox
  const suggestedFaceMask = fb !== undefined
    ? {
        type: 'ellipse',
        cx: round(fb[0] + fb[2] / 2, 3),
        cy: round(fb[1] + fb[3] / 2, 3),
        rx: round(Math.max(0.05, fb[2] * 0.65), 3),
        ry: round(Math.max(0.05, fb[3] * 0.65), 3),
        feather: 0.06,
      }
    : undefined
  return {
    exposure: {
      medianLuma255: round(f.exposure.median * 255, 1),
      p01Luma255: round(f.exposure.p01 * 255, 1),
      p99Luma255: round(f.exposure.p99 * 255, 1),
      clipHighPct: round(f.exposure.clipHigh * 100, 2),
      clipLowPct: round(f.exposure.clipLow * 100, 2),
      shadowHeadroomPct: round((f.exposure.shadowHeadroom ?? 1) * 100, 1),
    },
    whiteBalance: {
      castA: round(f.color.castA, 2),
      castB: round(f.color.castB, 2),
      warmth: round(f.color.warmth, 2),
      ...(wbHint ? { hint: wbHint } : {}),
    },
    geometry: {
      tiltDeg: round(f.composition.tiltDeg, 2),
      tiltConfidence: round(f.composition.tiltConfidence, 2),
      ...(tiltHint ? { hint: tiltHint } : {}),
    },
    subject: {
      saliencyCentroid: [round(f.composition.saliencyCentroid[0], 3), round(f.composition.saliencyCentroid[1], 3)],
      faceRegions: f.subject?.faceRegions ?? 0,
      ...(fb ? { faceBox: fb, suggestedFaceMask } : {}),
    },
  }
}

export function engineCheatSheet(engines: readonly string[]): string {
  const unique = [...new Set(engines)]
  const blocks: string[] = []
  if (unique.includes('builtin')) {
    blocks.push(
      `Core "builtin" operations (exact schemas & aesthetic safe ranges — use directly in edit_apply without calling edit_describe):
  - exposure: { ev: -6..6 (default 0, typical step ±0.15..0.8, strictly bounded by shadowEv headroom) } (maskable)
  - white_balance: { temperature: -100..100 (0, typical ±3..15, +warmer), tint: -100..100 (0, typical ±2..8, +magenta) } (maskable)
  - tone: { contrast: -100..100 (0, typical -12..+16), highlights: -100..100 (0, typical -45..-15 to recover), shadows: -100..100 (0, typical +10..+30), whites: -100..100 (0, typical -8..+12), blacks: -100..100 (0, typical -15..+10), brightness?: -100..100 (0) } (maskable)
  - curve: { points?: [[x,y],...], channel?: "luma"|"rgb"|"red"|"green"|"blue", red?: [[x,y],...], green?: [[x,y],...], blue?: [[x,y],...] } (x,y in 0..1; primary tool for film roll-off and split-toning: e.g. blue [[0,0.02],[0.25,0.28],[0.75,0.73],[1,0.97]] + red [[0,0],[0.25,0.23],[0.75,0.77],[1,1]]) (maskable)
  - saturation: { saturation: -100..100 (0, typical -6..+4; NEVER > +8 on portraits), vibrance: -100..100 (0, typical +5..+18, protects skin) } (maskable)
  - hsl: { red|orange|yellow|green|aqua|blue|purple|magenta: { hue?: -100..100, saturation?: -100..100, luminance?: -100..100 } } (portrait skin: orange luminance +6..+12, saturation -4..-10; foliage cleanup: yellow/green saturation -15..-35, green hue +8..+20) (maskable)
  - color_grading: { shadows?: { hue: 0..360, saturation: 0..100 }, midtones?: { hue: 0..360, saturation: 0..100 }, highlights?: { hue: 0..360, saturation: 0..100 }, balance?: -100..100 } (keep saturation 8..20 for subtle split-toning) (maskable)
  - clarity: { amount: -100..100 (0, typical +8..+15 on landscape/urban; NEVER > 0 on portraits, use -5..-10 for soft light), radius?: 2..200 (30) } · dehaze: { amount: -100..100 (0, typical +5..+12 on hazy landscapes; NEVER > +15 or on overcast/indoors/portraits) } (maskable)
  - denoise: { luminance?: 0..100 (0, use 20..35 on high ISO), chroma?: 0..100 (25), detail?: 0..100 (50) } · sharpen: { amount?: 0..300 (60), radius?: 0.3..5 (1), threshold?: 0..50 (2), masking?: 0..100 (40) } (maskable)
  - vignette: { amount: -100..100 (0, typical -8..-18), midpoint?: 0..100 (50), roundness?: -100..100 (0), feather?: 0..100 (55) } (maskable)
  - heal: { spots: [{ x: 0..1, y: 0..1, r: 0.001..0.2 (0.01), src_x?: 0..1, src_y?: 0..1 }] } (spot blemish/dust removal, no mask)
  - rotate: { angle: -45..45 (deg, +clockwise), crop?: true } · crop: { x?: 0..0.95, y?: 0..0.95, w?: 0.01..1, h?: 0.01..1, aspect?: "free"|"original"|"1:1"|"3:2"|"2:3"|"4:3"|"3:4"|"4:5"|"16:9"|"9:16", cx?: 0..1, cy?: 0..1 } · perspective: { vertical?: -100..100, horizontal?: -100..100, scale?: 50..150, crop?: true } (geometry ops: applied in step order, no mask; do NOT rotate/crop unless measured tilt or edge distraction requires it)`,
    )
  }
  if (unique.includes('darktable')) {
    blocks.push(
      `Core "darktable" operations (scene-referred workflow — prefer these modern modules; avoid legacy basecurve/levels/shadhi/tonecurve on top of darktable-default):
  - exposure: { exposure: -4..4 (EV, default 0, typical ±0.15..0.8), black?: -0.1..0.1 (0, typical -0.01..0.01) } (maskable)
  - colorbalancergb: { chroma_global?: -1..1 (0, typical 0.02..0.12), vibrance?: -1..1 (0, typical 0.05..0.15), contrast?: -1..1 (0, typical -0.08..0.12), saturation_global?: -1..1 (0), brilliance_shadows?: -1..1 (0, typical 0.06..0.22), brilliance_midtones?: -1..1 (0), brilliance_highlights?: -1..1 (0, typical -0.18..-0.05) } (maskable)
  - channelmixerrgb: { temperature?: 1667..25000 (5003, K), illuminant?: "DT_ILLUMINANT_D"|"DT_ILLUMINANT_BB"|"DT_ILLUMINANT_CAMERA", gamut?: 0..12 (1) } (scene-referred color calibration / white balance, maskable)
  - toneequal: { blacks?: -2..2 (0), shadows?: -2..2 (0), midtones?: -2..2 (0), highlights?: -2..2 (0), whites?: -2..2 (0) } (zone exposure recovery, maskable)
  - rgbcurve: { curves: { master?: [[0,0],...,[1,1]], r?: [...], g?: [...], b?: [...] } } (high-level spline points in 0..1 for subtle S-curve or R/B split-toning, maskable)
  - colorzones: { curves: { lightness?: [[x,y],...], saturation?: [[x,y],...], hue?: [[x,y],...] } } (targeted HSL spline in 0..1, maskable)
  - sigmoid: { middle_grey_contrast?: 0.1..10 (1.5, typical 1.25..1.6), contrast_skewness?: -1..1 (0; keep 0 on portraits) }
  - denoiseprofile: { strength?: 0.001..10 (1), shadows?: 0..1.8 (1) } · diffuse: { iterations?: 1..16 (1), sharpness?: -1..1 (0), radius?: 0..2048 (8) } (maskable)
  - crop: { cx: 0..1 (0, left), cy: 0..1 (0, top), cw: 0..1 (1, right), ch: 0..1 (1, bottom) } (no mask)
  - ashift: { rotation: -45..45 (deg), lensshift_v?: -1..1 (0), lensshift_h?: -1..1 (0) }`,
    )
  }
  if (unique.includes('rawtherapee')) {
    blocks.push(
      `Core "rawtherapee" operations (pp3 sections — partial params merge over the base profile; local edits MUST use "Locallab" spots[], never step.mask):
  - Exposure: { Auto?: false, Compensation?: -5..5 (EV, typical ±0.15..0.8), Brightness?: -100..100, Contrast?: -100..100 (typical -10..+18), Saturation?: -100..100, HighlightCompr?: 0..100 (typical 20..45), ShadowCompr?: 0..100 (typical 15..35) }
  - White Balance: { Setting?: "Camera"|"Auto"|"Custom", Temperature?: 1500..60000, Green?: 0.02..10 }
  - Shadows & Highlights: { Enabled: true, Highlights?: 0..100 (typical 15..35), Shadows?: 0..100 (typical 15..35) }
  - Vibrance: { Enabled: true, Pastels?: -100..100 (typical 8..20), Saturated?: -100..100 (typical 0..10), ProtectSkins?: true }
  - Crop: { Enabled: true, X: 0..1, Y: 0..1, W: 0..1, H: 0..1 } · Rotation: { Degrees: -45..45 }`,
    )
  }
  if (unique.includes('ai')) {
    blocks.push(
      `Core "ai" stage operations:
  - upscale: { scale?: 1..4 (2), method?: "auto"|"lanczos"|"model" }
  - inpaint: { radius?: 1..40 (6), grow?: 0..0.05 (0.003) } (requires mask.shapes marking wires/dust/small distractions)
  - style_match: { fingerprint: <from edit_style_reference>, strength?: 0..1 (0.35), color?: true, tone?: true, protect_skin?: true }`,
    )
  }
  return blocks.join('\n')
}

export class EditOrchestrator {
  private readonly children = new Map<string, Child>()
  private readonly active = new Map<string, { activation?: SubagentActivation; abort: AbortController; childId: string }>()
  /** Extra task-bound tool factories contributed by later phases (AI tools). */
  readonly childToolFactories: Array<(bound: Child) => ReturnType<typeof taskTools>> = []
  readonly childGlobalTools = [...CHILD_GLOBAL_TOOLS]

  constructor(private readonly rt: ChengyingRuntime, private readonly ctx: HostContext) {}

  /** Wire child-agent hooks; returns a disposer. */
  attach(): () => void {
    const offCreated = this.ctx.on('agent/created', (payload: { agent: AgentLike } | AgentLike) => {
      const agent = 'agent' in payload && payload.agent !== undefined && typeof (payload as { agent: AgentLike }).agent === 'object' ? (payload as { agent: AgentLike }).agent : payload as AgentLike
      const child = this.children.get(String(agent.id))
      if (child === undefined) return
      if (agent.session?.id !== undefined) this.children.set(String(agent.session.id), child)
      const disposers: Array<() => void> = []
      try {
        const scoped = agent.ctx.tools
        const tools = [...taskTools(this.rt, child), ...this.childToolFactories.flatMap(f => f(child))]
        // The Host's real skill tool is inherited when available. Do not invent
        // a browser-global runtime adapter in the Node child process.
        disposers.push(...tools.map(t => scoped.register(t)))
        const known = [...new Set([...this.childGlobalTools, ...tools.map(t => t.name)])]
        // Restriction is a security boundary, not an optional compatibility
        // enhancement. Any failure makes the activation unusable.
        disposers.push(scoped.restrict({ allow: known }))
        agent.ctx.effect(() => () => { for (const d of disposers) { try { d() } catch { /* already gone */ } } }, 'chengying: child tools')
        child.ready = true
      } catch (error) {
        for (const d of disposers) { try { d() } catch { /* best-effort cleanup */ } }
        child.setupError = errorMessage(error)
        try { agent.ctx.tools.restrict({ allow: [] }) } catch { /* activation is disposed by runTask */ }
        this.active.get(child.taskId)?.abort.abort(new ChengyingError('internal', `cannot isolate editing sub-agent: ${child.setupError}`))
        this.rt.log.error('chengying: cannot equip editing sub-agent:', child.setupError)
      }
    })
    const offEvent = this.ctx.on('session/event', (session: { id?: string }, event: { type?: string; data?: { usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number } } }) => {
      if (event?.type !== 'assistant/message') return
      const child = this.children.get(String(session?.id))
      const usage = event.data?.usage
      if (child === undefined || usage === undefined) return
      const project = this.rt.projects.get(child.projectId)
      const task = project?.repo.task(child.taskId)
      if (project === undefined || task === undefined) return
      const u = { ...emptyUsage(), ...task.usage }
      u.inputTokens += usage.inputTokens ?? 0
      u.outputTokens += usage.outputTokens ?? 0
      u.cacheReadTokens += usage.cacheReadTokens ?? 0
      u.cacheWriteTokens += usage.cacheWriteTokens ?? 0
      u.calls += 1
      project.repo.updateTask(task.id, { usage: u })
      const route = this.rt.config.editing.childModel ?? 'session-default'
      project.repo.addUsage({ taskId: task.id, purpose: 'edit-agent', provider: this.rt.config.editing.childProvider, model: route, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens: usage.cacheReadTokens, cacheWriteTokens: usage.cacheWriteTokens })
      const maxTok = typeof task.options.maxTokens === 'number' ? task.options.maxTokens : this.rt.config.editing.maxTokensPerTask
      if (maxTok > 0 && u.inputTokens + u.outputTokens >= maxTok && task.status === 'running') {
        project.repo.updateTask(task.id, { options: { ...task.options, tokenBudgetReached: true } })
        project.repo.addEvent(task.id, 'warn', 'budget', `token budget reached (${u.inputTokens + u.outputTokens} / ${maxTok}); stopping sub-agent`)
        const live = this.active.get(task.id)
        if (live !== undefined) live.abort.abort()
      }
    })
    return () => { offCreated(); offEvent() }
  }

  /** Summarize an already-completed anchor photo in the same scene so sibling sub-agents stay stylistically consistent. */
  sceneAnchorContext(project: Project, task: TaskRecord): string | undefined {
    const sceneId = typeof task.options.sceneId === 'string' ? task.options.sceneId : project.repo.groupOf(task.shotId, 'scene')
    if (sceneId === undefined) return undefined
    const siblings = project.repo.tasks().filter(t => t.id !== task.id && t.status === 'succeeded' && (t.options.sceneId === sceneId || project.repo.groupOf(t.shotId, 'scene') === sceneId))
    const anchor = siblings.sort((a, b) => Number(b.options.sceneAnchor === true) - Number(a.options.sceneAnchor === true))[0]
    if (anchor === undefined || anchor.headRevision === null) return undefined
    const rev = project.repo.revision(anchor.headRevision)
    if (rev === undefined) return undefined
    const stepSummary = rev.doc.stages.flatMap(st => st.steps.filter(s => s.enabled).map(s => `${st.engine}:${s.op}(${JSON.stringify(s.params).slice(0, 120)})`)).slice(0, 8)
    const note = stepSummary.length === 0 ? 'kept unchanged (original look already balanced)' : stepSummary.join(', ')
    const copyHint = stepSummary.length === 0
      ? ''
      : ` You can inherit its global grading steps in one call with edit_apply ops: [{"op":"copy_from_task","task_id":"${anchor.id}"}], then fine-tune only exposure/crop/masks for this frame.`
    return `Scene consistency (${sceneId}): sibling anchor photo ${anchor.shotId} (task ${anchor.id}) finished with [${note}]. Keep colour temperature, contrast and overall mood cohesive with it (you can inspect its style fingerprint via edit_style_reference with shot="${anchor.shotId}") while tailoring exposure, crop and local masks to this specific photo.${copyHint}`
  }

  prompt(project: Project, task: TaskRecord): string {
    const shot = project.repo.shot(task.shotId)
    const head = this.rt.edit(project).head(task.id)
    const profile = project.profile()
    const resumed = head.doc.stages.some(s => s.steps.length > 0)
    const engines = head.doc.stages.map((s, i) => `${i}:${s.engine}`).join(' → ')
    const cheatSheet = engineCheatSheet(head.doc.stages.map(s => s.engine))
    const tech = project.repo.scores(task.shotId).technical
    const diag = photoDiagnostics(project, task.shotId)
    return `You are a professional photo retoucher. You work on exactly one photo (task ${task.id}) with tools bound to it.

Photo: ${shot === undefined ? task.shotId : this.rt.shotContext(project, shot)}
Measured issues: ${(tech?.issues ?? []).join(', ') || 'none'}${tech?.detail ? ` · technical detail ${JSON.stringify(tech.detail)}` : ''}${diag ? `\nPixel diagnostics (use exact coordinates/angles when fixing tilt, cast or local face exposure): ${JSON.stringify(diag)}` : ''}
Pipeline stages: ${engines}${resumed ? `\nThis task is being RESUMED: the current recipe already has edits (revision #${head.seq}). Review it with edit_task_info and continue; do not start over unless it is clearly wrong.` : ''}

User brief: ${task.instructions}
${typeof task.options.sceneBrief === 'string' && task.options.sceneBrief !== '' ? `Scene-specific brief (${String(task.options.sceneId ?? task.options.segmentId ?? 'scene')}): ${task.options.sceneBrief}\n` : ''}${this.sceneAnchorContext(project, task) ? `${this.sceneAnchorContext(project, task)}\n` : ''}${profile.styleNotes.length > 0 ? `User taste (learned/stated): ${profile.styleNotes.join(' · ')}\n` : ''}${Object.keys(profile.look).length > 0 ? `Preferred look targets (−1..1): ${JSON.stringify(profile.look)}\n` : ''}Budget: at most ${typeof task.options.maxRevisions === 'number' ? task.options.maxRevisions : this.rt.config.editing.maxRevisionsPerTask} edit_apply iterations; stop as soon as the photo looks natural.
${cheatSheet ? `\n${cheatSheet}\n` : ''}
How to work:
1. edit_task_info (view=true) to see the photo (for RAW tasks, the engine baseline is shown alongside stats), its recipe and history. If the original photo is ALREADY well-exposed, balanced and atmospheric so any cropping or grading would only degrade it, do NOT force edits — call edit_finish with status="unchanged" explaining why keeping the original is best.
2. For core operations listed above, use their exact parameter schemas directly in edit_apply. Only call edit_capabilities / edit_describe when you need an unlisted module — never guess parameter names or ranges.
3. Edit with edit_apply (it renders a preview and statistics: keep clipHigh < 0.8% unless sky blowout is unrecoverable, keep clipLow < 2.0%, and prefer moderate incremental steps). Typical order: white balance & exposure → tone (highlights/shadows/contrast) → colour → local adjustments with masks → geometry (straighten/crop/perspective) → noise reduction & sharpening.
4. Look at every result; compare with the original (edit_preview compare=true). Revert with edit_revert when a change makes things worse.
5. Keep the photo natural and true to the scene. Optional AI stage (add_stage engine "ai"): ai:upscale (super-resolution), ai:inpaint (remove small distractions/dust/wires with a mask, non-generative), ai:style_match (match a reference look; fingerprint from edit_style_reference). Generative changes only through edit_generate, which asks for the user's authorization; if it is refused or unavailable, continue without them.
6. Finish with edit_finish, summarizing what you changed and why in the language of the user brief (status="unchanged" to keep the original untouched, or status="failed" with a reason if the photo cannot be rescued).`
  }

  async control(project: Project, taskId: string, action: 'pause' | 'resume' | 'retry' | 'cancel'): Promise<Record<string, unknown>> {
    const svc = this.rt.edit(project)
    const task = project.repo.task(taskId)
    if (task === undefined) throw new ChengyingError('not-found', `no task ${taskId}`)
    const live = this.active.get(taskId)
    switch (action) {
      case 'pause':
        if (!['queued', 'running', 'waiting-authorization'].includes(task.status)) throw new ChengyingError('conflict', `cannot pause a ${task.status} task`)
        svc.setStatus(taskId, 'paused', { message: 'paused by request' })
        break
      case 'cancel':
        if (['succeeded', 'cancelled'].includes(task.status)) throw new ChengyingError('conflict', `task already ${task.status}`)
        svc.setStatus(taskId, 'cancelled', { message: 'cancelled by request' })
        break
      case 'resume':
        if (task.status !== 'paused' && task.status !== 'waiting-authorization') throw new ChengyingError('conflict', `only paused tasks resume (task is ${task.status})`)
        svc.setStatus(taskId, 'queued', { message: 'resumed; will continue from the latest revision' })
        break
      case 'retry':
        if (!['failed', 'cancelled', 'succeeded'].includes(task.status)) throw new ChengyingError('conflict', `retry applies to failed/cancelled/succeeded tasks (task is ${task.status})`)
        project.repo.updateTask(taskId, { maxAttempts: Math.max(task.maxAttempts, task.attempts + 1), error: null })
        svc.setStatus(taskId, 'queued', { message: 'retry requested' })
        break
    }
    if ((action === 'pause' || action === 'cancel') && live !== undefined) {
      live.abort.abort()
      await live.activation?.dispose().catch(() => undefined)
    }
    return { task: taskId, status: project.repo.task(taskId)?.status }
  }

  async close(): Promise<void> {
    const activations = [...this.active.values()]
    for (const active of activations) active.abort.abort(new ChengyingError('cancelled', 'editing orchestrator shutting down'))
    await Promise.allSettled(activations.map(async active => { await active.activation?.dispose() }))
    this.active.clear()
    this.children.clear()
  }

  /** Run queued tasks until none remain (or the signal aborts). */
  async run(project: Project, exec: ToolRunContext, opts: { taskIds?: string[]; selectionId?: string; concurrency?: number; signal: AbortSignal; progress?: (stage: string, done: number, total: number) => void }): Promise<{ counts: Record<string, number>; processed: number }> {
    const subagents = this.ctx.get('subagents') as SubagentsService | undefined
    if (subagents === undefined) throw new ChengyingError('engine-unavailable', 'the Harness subagent service is not mounted; enable @deepseek-ai/dsh-subagent + a spawn provider')
    const parent = exec.agent
    if (parent === undefined) throw new ChengyingError('unsupported', 'no parent agent')
    const sem = new Semaphore(Math.max(1, opts.concurrency ?? this.rt.config.editing.maxConcurrent))
    const wanted = opts.taskIds === undefined ? undefined : new Set(opts.taskIds)
    const candidates = (): TaskRecord[] => project.repo.tasks({ status: ['queued'], selectionId: opts.selectionId }).filter(t => (wanted === undefined || wanted.has(t.id)) && !this.active.has(t.id))
    const pick = (): TaskRecord[] => {
      const queued = candidates()
      if (queued.length <= 1) return queued
      // Scene barrier: while a scene's anchor task is still queued or running,
      // hold back follower tasks of the same scene so they can inherit the
      // completed anchor's look once it finishes.
      const pendingAnchorScenes = new Set<string>()
      for (const t of project.repo.tasks({ status: ['queued', 'running'], selectionId: opts.selectionId })) {
        if (wanted !== undefined && !wanted.has(t.id)) continue
        if (t.options.sceneAnchor === true && typeof t.options.sceneId === 'string') {
          pendingAnchorScenes.add(t.options.sceneId)
        }
      }
      if (pendingAnchorScenes.size === 0) return queued
      const unblocked = queued.filter(t => t.options.sceneAnchor === true || typeof t.options.sceneId !== 'string' || !pendingAnchorScenes.has(t.options.sceneId))
      return unblocked.length > 0 ? unblocked : (this.active.size === 0 ? queued : [])
    }
    const total = candidates().length
    let processed = 0
    const running = new Set<Promise<void>>()
    while (!opts.signal.aborted) {
      const next = pick()[0]
      if (next === undefined) {
        if (running.size === 0) break
        await Promise.race(running)
        continue
      }
      const release = await sem.acquire(opts.signal)
      // claim before yielding so the loop does not pick it twice
      const abort = new AbortController()
      const childId = randomUUID()
      const claimed = project.repo.claimQueuedTask(next.id, childId)
      if (claimed === undefined) { release(); continue }
      project.repo.addEvent(next.id, 'info', 'status', `queued → running: sub-agent ${childId.slice(0, 8)} (attempt ${claimed.attempts}/${claimed.maxAttempts})`)
      this.active.set(next.id, { abort, childId })
      const p = this.runOne(project, claimed, parent, subagents, childId, abort, opts.signal).finally(() => {
        release()
        this.active.delete(next.id)
        processed++
        opts.progress?.('retouch', processed, Math.max(total, processed))
        running.delete(p)
      })
      running.add(p)
    }
    await Promise.allSettled([...running])
    const counts: Record<string, number> = {}
    for (const t of project.repo.tasks({ selectionId: opts.selectionId })) if (wanted === undefined || wanted.has(t.id)) counts[t.status] = (counts[t.status] ?? 0) + 1
    return { counts, processed }
  }

  private async runOne(project: Project, task: TaskRecord, parent: AgentLike, subagents: SubagentsService, childId: string, abort: AbortController, outer: AbortSignal): Promise<void> {
    const svc = this.rt.edit(project)
    const attempts = task.attempts
    this.children.set(childId, { projectId: project.id, taskId: task.id })
    const signal = AbortSignal.any([abort.signal, outer])
    const agentOptions = this.rt.config.editing.childProvider !== undefined && this.rt.config.editing.childModel !== undefined
      ? { provider: this.rt.config.editing.childProvider, model: this.rt.config.editing.childModel }
      : undefined
    let outcome: { stopReason: string; text: string; diagnostic?: string } | undefined
    let activation: SubagentActivation | undefined
    try {
      activation = await subagents.startActivation({
        provider: this.rt.config.editing.subagentProvider,
        label: `retouch ${task.shotId}`,
        childId,
        request: { prompt: [{ type: 'text', text: this.prompt(project, task) }], parent, ...(agentOptions ? { agentOptions } : {}) },
        signal,
        delivery: 'caller',
      })
      const live = this.active.get(task.id)
      if (live !== undefined) live.activation = activation
      const setupError = this.children.get(childId)?.setupError
      if (setupError !== undefined) throw new ChengyingError('internal', `cannot isolate editing sub-agent: ${setupError}`)
      const result = await activation.result
      outcome = { stopReason: result.stopReason, text: result.output.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('\n').slice(0, 2000), diagnostic: result.diagnostic }
    } catch (error) {
      outcome = { stopReason: signal.aborted ? 'aborted' : 'error', text: '', diagnostic: errorMessage(error) }
    } finally {
      await activation?.dispose().catch(() => undefined)
      for (const [k, v] of this.children) {
        if (v.taskId === task.id) this.children.delete(k)
      }
    }
    const now = project.repo.task(task.id) as TaskRecord
    project.repo.addEvent(task.id, 'info', 'agent-result', `sub-agent ended: ${outcome.stopReason}${outcome.text ? ` — ${outcome.text.slice(0, 300)}` : ''}`, { childId, diagnostic: outcome.diagnostic })
    if (now.status !== 'running') return // finished via edit_finish, or paused/cancelled meanwhile
    const edited = svc.head(task.id).doc.stages.some(s => s.steps.length > 0)
    if (now.options.tokenBudgetReached === true) {
      if (edited) svc.setStatus(task.id, 'succeeded', { message: 'stopped at token budget cap; kept latest revision', error: null })
      else svc.setStatus(task.id, 'failed', { message: 'token budget exceeded without a valid edit', error: 'token budget exceeded' })
      return
    }
    if (outcome.stopReason === 'completed' && edited) {
      svc.setStatus(task.id, 'succeeded', { message: 'sub-agent completed (no explicit edit_finish)', error: null })
      return
    }
    if (outcome.stopReason === 'completed' && !edited && /\b(unchanged|keep as[- ]is|no edit(?:s|ing)? needed|already well[- ](?:exposed|balanced)|无需修图|保持原[片样图]|原片直出)\b/i.test(outcome.text)) {
      project.repo.updateTask(task.id, { options: { ...now.options, unchanged: true } })
      svc.setStatus(task.id, 'succeeded', { message: `[unchanged] ${outcome.text.slice(0, 240)}`, error: null })
      return
    }
    const reason = outcome.stopReason === 'completed' ? 'sub-agent ended without editing' : `sub-agent ${outcome.stopReason}: ${outcome.diagnostic ?? ''}`.trim()
    if (outer.aborted) { svc.setStatus(task.id, 'queued', { message: 'run cancelled; task kept for later' }); return }
    if (attempts < now.maxAttempts) svc.setStatus(task.id, 'queued', { message: `retrying (${reason})`, error: reason })
    else svc.setStatus(task.id, 'failed', { message: reason, error: reason })
  }
}
