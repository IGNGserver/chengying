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
import { Semaphore } from '../core/util/misc.ts'
import { emptyUsage } from '../core/store/repo.ts'

/** Global tools an editing child may still see (everything else is hidden). */
export const CHILD_GLOBAL_TOOLS = ['edit_engines', 'edit_capabilities', 'edit_describe', 'edit_native']

interface Child { projectId: string; taskId: string }

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
      try {
        const scoped = agent.ctx.tools
        const tools = [...taskTools(this.rt, child), ...this.childToolFactories.flatMap(f => f(child))]
        const disposers = tools.map(t => scoped.register(t))
        const known = this.childGlobalTools
        try { disposers.push(scoped.restrict({ allow: known })) } catch (error) {
          // Unknown names (e.g. a tool family not mounted) — restrict to what exists.
          this.rt.log.warn('chengying: child tool restriction:', errorMessage(error))
        }
        agent.ctx.effect(() => () => { for (const d of disposers) { try { d() } catch { /* already gone */ } } }, 'chengying: child tools')
      } catch (error) {
        this.rt.log.error('chengying: cannot equip editing sub-agent:', errorMessage(error))
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
    })
    return () => { offCreated(); offEvent() }
  }

  prompt(project: Project, task: TaskRecord): string {
    const shot = project.repo.shot(task.shotId)
    const head = this.rt.edit(project).head(task.id)
    const profile = project.profile()
    const resumed = head.doc.stages.some(s => s.steps.length > 0)
    const engines = head.doc.stages.map((s, i) => `${i}:${s.engine}`).join(' → ')
    const tech = project.repo.scores(task.shotId).technical
    return `You are a professional photo retoucher. You work on exactly one photo (task ${task.id}) with tools bound to it.

Photo: ${shot === undefined ? task.shotId : this.rt.shotContext(project, shot)}
Measured issues: ${(tech?.issues ?? []).join(', ') || 'none'}${tech?.detail ? ` · technical detail ${JSON.stringify(tech.detail)}` : ''}
Pipeline stages: ${engines}${resumed ? `\nThis task is being RESUMED: the current recipe already has edits (revision #${head.seq}). Review it with edit_task_info and continue; do not start over unless it is clearly wrong.` : ''}

User brief: ${task.instructions}
${profile.styleNotes.length > 0 ? `User taste (learned/stated): ${profile.styleNotes.join(' · ')}\n` : ''}${Object.keys(profile.look).length > 0 ? `Preferred look targets (−1..1): ${JSON.stringify(profile.look)}\n` : ''}
How to work:
1. edit_task_info (view=true) to see the photo, its recipe and history.
2. Find operations with edit_capabilities and read exact parameter schemas with edit_describe before using them — never guess parameter names or ranges.
3. Edit with edit_apply (it renders a preview and statistics: check histogram/clipping, colour cast, horizon, noise). Typical order: white balance & exposure → tone (highlights/shadows/contrast) → colour → local adjustments with masks → geometry (straighten/crop/perspective) → noise reduction & sharpening.
4. Look at every result; compare with the original (edit_preview compare=true). Revert with edit_revert when a change makes things worse.
5. Keep the photo natural and true to the scene. Optional AI stage (add_stage engine "ai"): ai:upscale (super-resolution), ai:inpaint (remove small distractions/dust/wires with a mask, non-generative), ai:style_match (match a reference look; fingerprint from edit_style_reference). Generative changes only through edit_generate, which asks for the user's authorization; if it is refused or unavailable, continue without them.
6. Finish with edit_finish, summarizing what you changed and why (status failed with a reason if the photo cannot be rescued).`
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

  /** Run queued tasks until none remain (or the signal aborts). */
  async run(project: Project, exec: ToolRunContext, opts: { taskIds?: string[]; selectionId?: string; concurrency?: number; signal: AbortSignal; progress?: (stage: string, done: number, total: number) => void }): Promise<{ counts: Record<string, number>; processed: number }> {
    const subagents = this.ctx.get('subagents') as SubagentsService | undefined
    if (subagents === undefined) throw new ChengyingError('engine-unavailable', 'the Harness subagent service is not mounted; enable @deepseek-ai/dsh-subagent + a spawn provider')
    const parent = exec.agent
    if (parent === undefined) throw new ChengyingError('unsupported', 'no parent agent')
    const sem = new Semaphore(Math.max(1, opts.concurrency ?? this.rt.config.editing.maxConcurrent))
    const wanted = opts.taskIds === undefined ? undefined : new Set(opts.taskIds)
    const pick = (): TaskRecord[] => project.repo.tasks({ status: ['queued'], selectionId: opts.selectionId }).filter(t => (wanted === undefined || wanted.has(t.id)) && !this.active.has(t.id))
    const total = pick().length
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
      this.active.set(next.id, { abort, childId })
      const p = this.runOne(project, next, parent, subagents, childId, abort, opts.signal).finally(() => {
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
    const attempts = task.attempts + 1
    project.repo.updateTask(task.id, { attempts, agentSession: childId })
    svc.setStatus(task.id, 'running', { message: `sub-agent ${childId.slice(0, 8)} (attempt ${attempts}/${task.maxAttempts})` })
    this.children.set(childId, { projectId: project.id, taskId: task.id })
    const signal = AbortSignal.any([abort.signal, outer])
    const agentOptions = this.rt.config.editing.childProvider !== undefined && this.rt.config.editing.childModel !== undefined
      ? { provider: this.rt.config.editing.childProvider, model: this.rt.config.editing.childModel }
      : undefined
    let outcome: { stopReason: string; text: string; diagnostic?: string } | undefined
    try {
      const activation = await subagents.startActivation({
        provider: this.rt.config.editing.subagentProvider,
        label: `retouch ${task.shotId}`,
        childId,
        request: { prompt: [{ type: 'text', text: this.prompt(project, task) }], parent, ...(agentOptions ? { agentOptions } : {}) },
        signal,
        delivery: 'caller',
      })
      const live = this.active.get(task.id)
      if (live !== undefined) live.activation = activation
      const result = await activation.result
      await activation.dispose().catch(() => undefined)
      outcome = { stopReason: result.stopReason, text: result.output.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('\n').slice(0, 2000), diagnostic: result.diagnostic }
    } catch (error) {
      outcome = { stopReason: signal.aborted ? 'aborted' : 'error', text: '', diagnostic: errorMessage(error) }
    }
    const now = project.repo.task(task.id) as TaskRecord
    project.repo.addEvent(task.id, 'info', 'agent-result', `sub-agent ended: ${outcome.stopReason}${outcome.text ? ` — ${outcome.text.slice(0, 300)}` : ''}`, { childId, diagnostic: outcome.diagnostic })
    if (now.status !== 'running') return // finished via edit_finish, or paused/cancelled meanwhile
    const edited = svc.head(task.id).doc.stages.some(s => s.steps.length > 0)
    if (outcome.stopReason === 'completed' && edited) {
      svc.setStatus(task.id, 'succeeded', { message: 'sub-agent completed (no explicit edit_finish)', error: null })
      return
    }
    const reason = outcome.stopReason === 'completed' ? 'sub-agent ended without editing' : `sub-agent ${outcome.stopReason}: ${outcome.diagnostic ?? ''}`.trim()
    if (outer.aborted) { svc.setStatus(task.id, 'queued', { message: 'run cancelled; task kept for later' }); return }
    if (attempts < now.maxAttempts) svc.setStatus(task.id, 'queued', { message: `retrying (${reason})`, error: reason })
    else svc.setStatus(task.id, 'failed', { message: reason, error: reason })
  }
}
