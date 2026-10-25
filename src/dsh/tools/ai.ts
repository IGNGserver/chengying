/**
 * Phase 3 tools: generative layers (authorization-gated), style references
 * and series-wide look unification. The task-bound variants are registered
 * in editing sub-agents next to the phase 2 task tools.
 */
import type { ChengyingRuntime } from '../runtime.ts'
import type { ToolDefinition, ToolRunContext } from '../host-types.ts'
import { anyJson, arr, defineTool, int, num, obj, str, strEnum, type ToolImage } from '../tool.ts'
import { ChengyingError } from '../../core/util/errors.ts'
import type { MaskSpec } from '../../core/types.ts'
import type { Project } from '../../core/project.ts'

const projectArg = str('Project id or workspace path (default: current workspace).')

const GEN_KINDS = ['remove', 'fill', 'replace', 'enhance', 'expand', 'edit']

export function aiTaskTools(rt: ChengyingRuntime, bound?: { projectId: string; taskId: string }): ToolDefinition[] {
  const taskParam: Record<string, Record<string, unknown>> = bound === undefined ? { task: str('Task id.'), project: projectArg } : {}
  const req = bound === undefined ? ['task'] : []
  const resolve = (args: { task?: string; project?: string }, exec: ToolRunContext): { project: Project; taskId: string } => {
    if (bound !== undefined) return { project: rt.project(bound.projectId), taskId: bound.taskId }
    if (args.task === undefined) throw new ChengyingError('invalid-argument', 'task is required')
    return { project: rt.projectOfTask(args.task, args.project, exec.agent?.id), taskId: args.task }
  }
  return [
    defineTool<{ task?: string; project?: string; kind: string; prompt: string; mask?: MaskSpec; provider?: string; size?: number; reason: string }>({
      name: 'edit_generate',
      description: 'GENERATIVE edit (changes photo authenticity): runs a configured generative provider once on the current edit and adds the result as a masked layer in the AI stage (revertible like any step). Requires the user\'s authorization — an existing grant from the Chengying panel, or an approval prompt the user answers; if refused, continue without generative changes. Prefer non-generative tools first (ai:inpaint for small removals, heal, local adjustments). The export is tagged as containing generated content.',
      parameters: obj({
        ...taskParam,
        kind: strEnum(GEN_KINDS, 'remove (object removal with plausible background), fill (fill masked area per prompt), replace, enhance (whole-image generative enhancement), expand, edit (instruction edit)'),
        prompt: str('What to generate; describe the intended result, keep it faithful to the scene.'),
        mask: anyJson('Area to change (same mask model as edit_apply). Omit only for whole-image kinds.'),
        provider: str('Provider id (default: first configured).'),
        size: int('Long edge sent to the provider (default 2048).'),
        reason: str('Why this generative change is needed (shown to the user in the approval prompt).'),
      }, [...req, 'kind', 'prompt', 'reason']),
      async run(args, exec) {
        const { project, taskId } = resolve(args, exec)
        const providers = rt.config.generative.providers
        if (providers.length === 0) throw new ChengyingError('engine-unavailable', 'no generative provider is configured (generative.providers); use non-generative tools')
        const provider = args.provider === undefined ? providers[0] : providers.find(p => p.id === args.provider)
        if (provider === undefined) throw new ChengyingError('invalid-argument', `unknown provider ${args.provider}; configured: ${providers.map(p => p.id).join(', ')}`)
        if (args.mask === undefined && !['enhance', 'edit', 'expand'].includes(args.kind)) throw new ChengyingError('invalid-argument', `${args.kind} needs a mask`)
        const task = project.repo.task(taskId)
        if (task === undefined) throw new ChengyingError('not-found', `no task ${taskId}`)
        const auth = await rt.acquireGenerative(project, task.shotId, exec, `Chengying: generative "${args.kind}" on photo ${task.shotId} — ${args.prompt.slice(0, 160)}. Reason: ${args.reason.slice(0, 300)}`)
        const svc = rt.edit(project)
        const r = await svc.generate(taskId, { provider, kind: args.kind, prompt: args.prompt, mask: args.mask, authorizationId: auth.id, author: exec.agent?.id === undefined ? 'agent' : `agent:${exec.agent.id.slice(0, 8)}`, maxEdge: args.size, signal: exec.signal, message: `generative ${args.kind}: ${args.reason.slice(0, 80)}` })
        const preview = await svc.render(taskId, { maxEdge: rt.config.editing.previewEdge, signal: exec.signal })
        const img = await rt.imageForModel(preview.path, exec, { caption: `rev ${r.revision.seq} (generative)` })
        const images: ToolImage[] = img.image ? [img.image] : []
        return { revision: { id: r.revision.id, seq: r.revision.seq }, authorization: auth, provider: provider.id, warnings: [...r.warnings, ...preview.warnings], stats: preview.stats, images, note: 'Generated content: verify realism; undo with edit_revert if it does not look natural.' }
      },
    }),

    defineTool<{ task?: string; project?: string; shot?: string; reference_task?: string }>({
      name: 'edit_style_reference',
      description: 'Style fingerprint (Lab colour statistics + tonal quantiles) of a reference photo — its edited result when it has a task, else the original — for the ai:style_match operation that unifies the look of a series.',
      parameters: obj({ ...taskParam, shot: str('Reference shot id.'), reference_task: str('Reference task id (its current edit).') }, []),
      concurrencySafe: true,
      async run(args, exec) {
        const project = bound !== undefined ? rt.project(bound.projectId) : args.task !== undefined ? rt.projectOfTask(args.task, args.project, exec.agent?.id) : rt.project(args.project, exec.agent?.id)
        const ref = await rt.edit(project).styleReference({ shotId: args.shot, taskId: args.reference_task }, exec.signal)
        return { ...ref, use: { op: 'add_step', stage: 'ai', step: { op: 'style_match', params: { fingerprint: ref.fingerprint, strength: 0.6 } } }, hint: 'Add an ai stage first ({"op":"add_stage","engine":"ai"}) when the task has none.' }
      },
    }),
  ]
}

export function aiTools(rt: ChengyingRuntime): ToolDefinition[] {
  return [
    ...aiTaskTools(rt),

    defineTool<{ project?: string; reference: string; tasks?: string[]; selection?: string; strength?: number; color?: boolean; tone?: boolean }>({
      name: 'edit_unify_style',
      description: 'Unify the look of a series: take the style fingerprint of a reference photo (shot id or task id) and add/update an ai:style_match step in every listed task (default: all tasks of the latest selection except the reference). Non-generative and revertible per task.',
      parameters: obj({ project: projectArg, reference: str('Reference shot id or task id.'), tasks: arr(str('task id'), 'Target tasks.'), selection: str('Selection id (default latest).'), strength: num('0..1 (default 0.5)'), color: { type: 'boolean', description: 'match colour (default true)' }, tone: { type: 'boolean', description: 'match tones (default true)' } }, ['reference']),
      async run(args, exec) {
        const project = rt.project(args.project, exec.agent?.id)
        const svc = rt.edit(project)
        const isTask = project.repo.task(args.reference) !== undefined
        const ref = await svc.styleReference(isTask ? { taskId: args.reference } : { shotId: args.reference }, exec.signal)
        const selectionId = args.selection ?? project.repo.latestSelectionId()
        const targets = (args.tasks !== undefined ? args.tasks.map(id => project.repo.task(id)).filter(t => t !== undefined) : project.repo.tasks({ selectionId: selectionId ?? undefined }))
          .filter(t => t.shotId !== ref.shotId && t.status !== 'cancelled')
        const results = []
        for (const t of targets) {
          try {
            const head = svc.head(t.id)
            const params = { fingerprint: ref.fingerprint, strength: args.strength ?? 0.5, color: args.color ?? true, tone: args.tone ?? true }
            const existing = head.doc.stages.find(s => s.engine === 'ai')?.steps.find(s => s.op === 'style_match' && s.label === 'series look')
            const ops = existing !== undefined
              ? [{ op: 'update_step' as const, step_id: existing.id, params, replace_params: true }]
              : [...(head.doc.stages.some(s => s.engine === 'ai') ? [] : [{ op: 'add_stage' as const, engine: 'ai' }]), { op: 'add_step' as const, stage: 'ai', step: { op: 'style_match', params, label: 'series look' } }]
            const r = await svc.applyOps(t.id, ops, { author: 'agent', message: `unify look with ${args.reference}`, signal: exec.signal })
            results.push({ task: t.id, shot: t.shotId, revision: r.revision.seq })
          } catch (error) {
            results.push({ task: t.id, shot: t.shotId, error: (error as Error).message })
          }
        }
        return { reference: { id: args.reference, source: ref.source }, updated: results.filter(r => !('error' in r)).length, results }
      },
    }),

    defineTool<{ project?: string; shot?: string; hours?: number; max_uses?: number; reason: string }>({
      name: 'gen_authorize',
      description: 'Ask the USER (approval prompt) to authorize generative edits for one photo or the whole workspace. Only the user can grant this; when no interactive user is available, tell the user to grant it in the Chengying panel. Returns the active grants.',
      parameters: obj({ project: projectArg, shot: str('Limit to one shot (default: whole workspace).'), hours: num('Validity in hours (default 24).'), max_uses: int('Number of generative edits allowed (default 10).'), reason: str('What will be generated and why (shown to the user).') }, ['reason']),
      async run(args, exec) {
        const project = rt.project(args.project, exec.agent?.id)
        const approval = rt.ctx.get('approval') as { request(r: unknown): Promise<string> } | undefined
        if (approval === undefined || exec.agent === undefined) throw new ChengyingError('authorization-required', 'no interactive approval available; ask the user to grant generative edits in the Chengying panel (Exports → Generative authorizations)')
        const text = `Allow Chengying to make GENERATIVE edits (AI-generated pixels) ${args.shot ? `on photo ${args.shot}` : 'on photos of this workspace'} for ${args.hours ?? 24} h, up to ${args.max_uses ?? 10} edits? ${args.reason}`
        const decision = await approval.request({ agent: exec.agent, toolName: exec.name, callId: exec.callId, reason: text, displayReason: text, signal: exec.signal })
        if (decision !== 'allowed-once') return { granted: false, decision, note: 'Keep edits non-generative.' }
        const id = project.repo.addAuthorization({ scope: 'generative', shotId: args.shot ?? null, taskId: null, grantedBy: 'user (DSH approval prompt)', note: args.reason.slice(0, 500), expiresAt: new Date(Date.now() + (args.hours ?? 24) * 3600_000).toISOString(), maxUses: args.max_uses ?? 10 })
        project.repo.addEvent(null, 'info', 'authorization', `generative edits authorized by the user${args.shot ? ` for ${args.shot}` : ''}`, { id })
        return { granted: true, id }
      },
    }),

    defineTool<{ project?: string; revoke?: string }>({
      name: 'gen_authorizations',
      description: 'List generative-edit authorizations (who granted, scope, uses, expiry); optionally revoke one. Agents cannot create grants here.',
      parameters: obj({ project: projectArg, revoke: str('Authorization id to revoke.') }),
      async run(args, exec) {
        const project = rt.project(args.project, exec.agent?.id)
        if (args.revoke !== undefined) project.repo.revokeAuthorization(args.revoke)
        return { requireApproval: rt.config.generative.requireApproval, providers: rt.config.generative.providers.map(p => ({ id: p.id, type: p.type, model: p.model })), authorizations: project.repo.authorizations() }
      },
    }),
  ]
}
