/**
 * Phase 2 tools. Engine discovery tools expose every operation of every
 * installed engine with its full parameter schema; edit tools mutate a task's
 * revision graph. The same factory produces task-bound variants (no `task`
 * argument) that are registered in an editing sub-agent's own scope.
 */
import type { ChengyingRuntime } from '../runtime.ts'
import type { ToolDefinition, ToolRunContext } from '../host-types.ts'
import { anyJson, arr, bool, defineTool, int, obj, str, strEnum, type ToolImage } from '../tool.ts'
import type { EditOp } from '../../core/edit/service.ts'
import { signature } from '../../core/edit/schema.ts'
import { ChengyingError } from '../../core/util/errors.ts'
import type { Project } from '../../core/project.ts'
import { runDelivery } from '../deliver.ts'
import { photoDiagnostics } from '../orchestrator.ts'

const projectArg = str('Project id or workspace path (default: current workspace).')

const MASK_DOC = 'mask (optional, engine-neutral): {shapes:[{type:"circle",cx,cy,r,feather}|{type:"ellipse",cx,cy,rx,ry,rotation}|{type:"rectangle",x,y,w,h}|{type:"gradient",x0,y0,x1,y1}|{type:"polygon",points:[[x,y]…]}|{type:"brush",strokes:[{points,radius}]}], shapesCombine, parametric:[{channel:"luminance"|"hue"|"saturation"|…,from,to,softness,invert}], combine:"intersection"|"union", invert, feather, opacity, blendMode, native:{…engine blend fields}}; coordinates 0..1 of the oriented image, radii relative to the longer side'

export const EDIT_OPS_DESCRIPTION = `Array of edit operations applied atomically (all validate or none apply), creating one new revision:
- {"op":"add_step","step":{"op":"<operation id>","params":{…},"mask":…,"instance":n,"label":"…"},"stage":<index|engine>,"position":n}
- {"op":"update_step","step_id":"…","params":{…partial…},"replace_params":false,"mask":{…}|null,"enabled":true}
- {"op":"remove_step","step_id":"…"} · {"op":"move_step","step_id":"…","position":n}
- {"op":"add_stage","engine":"builtin|darktable|rawtherapee|ai","position":n} · {"op":"remove_stage","stage":…} · {"op":"set_stage_options","stage":…,"options":{…}}
- {"op":"set_source","source":"raw"|"raster"} · {"op":"import_recipe","stage":…,"text":"…xmp/pp3/dtstyle/json…"} · {"op":"copy_from_task","task_id":"…","include_masks":false,"include_geometry":false} · {"op":"reset"}
${MASK_DOC}`

export function engineTools(rt: ChengyingRuntime): ToolDefinition[] {
  return [
    defineTool<{ refresh?: boolean }>({
      name: 'edit_engines',
      description: 'Installed editing engines (darktable, RawTherapee, built-in, AI) with version, discovery backend, operation/parameter counts and what they accept. Catalogs are discovered from the installed engines themselves and refreshed automatically when an engine changes.',
      parameters: obj({ refresh: bool('Re-probe and rediscover catalogs.') }),
      concurrencySafe: true,
      async run(args, exec) {
        const reg = rt.engines()
        const probes = await reg.probeAll(args.refresh === true)
        const out = []
        for (const p of probes) {
          if (!p.available) { out.push({ id: p.id, available: false, reason: p.reason }); continue }
          const health = await reg.health(p.id, { refresh: args.refresh === true, signal: exec.signal }).catch(error => ({ ok: false, catalog: 'failed' as const, render: 'skipped' as const, reason: (error as Error).message, durationMs: undefined }))
          try {
            const c = await reg.catalog(p.id, args.refresh === true, exec.signal)
            out.push({ id: p.id, available: health.ok, usable: health.ok, version: p.version, discovery: c.source, inputs: p.inputs, health: { catalog: health.catalog, render: health.render, reason: health.reason, durationMs: health.durationMs }, operations: c.coverage.operations, parameters: c.coverage.parameters, categories: [...new Set(c.operations.map(o => o.category))], masks: c.maskModel, extensions: c.coverage.extensions, nativeTools: c.nativeTools?.map(t => t.name), notes: c.notes })
          } catch (error) {
            out.push({ id: p.id, available: false, version: p.version, health: { catalog: health.catalog, render: health.render, reason: health.reason }, catalogError: (error as Error).message })
          }
        }
        return { engines: out, note: 'available=false means the engine cannot be used for editing on this machine; the reason says why.' }
      },
    }),

    defineTool<{ engine: string; query?: string; category?: string; include_hidden?: boolean; offset?: number; limit?: number }>({
      name: 'edit_capabilities',
      description: 'List operations of an engine (id, title, category, mask support, compact parameter signature). Search by keyword. Then call edit_describe for full schemas.',
      parameters: obj({ engine: str('Engine id.'), query: str('Keyword filter over id/title/description/parameter names.'), category: str('Category filter.'), include_hidden: bool('Include deprecated/hidden operations.'), offset: int('Paging offset.'), limit: int('Page size (default 60).') }, ['engine']),
      concurrencySafe: true,
      async run(args, exec) {
        const c = await rt.engines().catalog(args.engine, false, exec.signal)
        const q = args.query?.toLowerCase()
        let ops = c.operations.filter(o => args.include_hidden === true || (!o.hidden && !o.deprecated))
        if (args.category) ops = ops.filter(o => o.category.includes(args.category as string))
        if (q) ops = ops.filter(o => `${o.id} ${o.title} ${o.description ?? ''} ${Object.keys(o.params.properties ?? {}).join(' ')}`.toLowerCase().includes(q))
        const offset = args.offset ?? 0
        return {
          engine: c.engine, version: c.engineVersion, total: ops.length, offset,
          operations: ops.slice(offset, offset + (args.limit ?? 60)).map(o => ({ id: o.id, title: o.title, category: o.category, masks: o.masks, multiInstance: o.multiInstance, deprecated: o.deprecated || undefined, params: signature(o.params, 10) })),
        }
      },
    }),

    defineTool<{ engine: string; operations: string[] }>({
      name: 'edit_describe',
      description: 'Full JSON parameter schemas (types, ranges, defaults, enum values with labels, descriptions) for operations of an engine, plus stage options. Use the exact parameter names from here.',
      parameters: obj({ engine: str('Engine id.'), operations: arr(str('operation id or "stage_options"'), '1-8 operation ids') }, ['engine', 'operations']),
      concurrencySafe: true,
      async run(args, exec) {
        const c = await rt.engines().catalog(args.engine, false, exec.signal)
        const strip = (s: unknown): unknown => JSON.parse(JSON.stringify(s, (k, v) => (k === 'x-native' ? undefined : v)))
        return {
          engine: c.engine,
          operations: args.operations.slice(0, 8).map(id => {
            if (id === 'stage_options') return { id, params: strip(c.stageOptions) }
            const o = c.operations.find(x => x.id === id) ?? c.operations.find(x => x.id.toLowerCase() === id.toLowerCase())
            if (o === undefined) return { id, error: 'unknown operation' }
            return { id: o.id, title: o.title, description: o.description, version: o.version, masks: o.masks, multiInstance: o.multiInstance, docs: o.docsUrl, params: strip(o.params), example: o.native?.example }
          }),
          maskModel: c.maskModel,
        }
      },
    }),

    defineTool<{ engine: string; tool: string; arguments?: Record<string, unknown> }>({
      name: 'edit_native',
      description: 'Call an engine-native tool directly (e.g. darktable-mcp tools such as image_stats, get_metadata, list_styles, decode_params when the installed darktable provides darktable-mcp). File paths are checked: inputs must be readable, outputs land in Chengying\'s scratch/export directories.',
      parameters: obj({ engine: str('Engine id.'), tool: str('Native tool name (see edit_engines nativeTools).'), arguments: anyJson('Native tool arguments.') }, ['engine', 'tool']),
      async run(args, exec) {
        const e = rt.engines().get(args.engine)
        if (e.callNative === undefined) throw new ChengyingError('unsupported', `${args.engine} has no native tools`)
        const project = rt.projectOrUndefined(exec.agent?.id)
        const scratch = project?.path('scratch', 'native') ?? rt.scratchRoot()
        return await e.callNative(args.tool, args.arguments ?? {}, {
          scratchDir: scratch,
          readable: (p: string) => (project === undefined ? p : project.guard.readable(p)),
          writable: (p: string) => (project === undefined ? p : project.guard.writable(p)),
        })
      },
    }),
  ]
}

/** Task-scoped editing tools. With `bound`, the task is fixed and the `task` argument disappears. */
export function taskTools(rt: ChengyingRuntime, bound?: { projectId: string; taskId: string }): ToolDefinition[] {
  const taskParam: Record<string, Record<string, unknown>> = bound === undefined ? { task: str('Task id (from edit_tasks).') } : {}
  const req = bound === undefined ? ['task'] : []
  const resolve = (args: { task?: string; project?: string }, exec: ToolRunContext): { project: Project; taskId: string } => {
    if (bound !== undefined) return { project: rt.project(bound.projectId), taskId: bound.taskId }
    if (args.task === undefined) throw new ChengyingError('invalid-argument', 'task is required')
    const project = rt.projectOfTask(args.task, args.project, exec.agent?.id)
    return { project, taskId: args.task }
  }
  const extra: Record<string, Record<string, unknown>> = bound === undefined ? { project: projectArg } : {}
  return [
    defineTool<{ task?: string; project?: string; view?: boolean }>({
      name: 'edit_task_info',
      description: 'The task: photo metadata and analysis, user instructions and preferences, engines, current recipe (stages and steps with ids) and revision history. With view=true also shows the original photo.',
      parameters: obj({ ...taskParam, ...extra, view: bool('Attach the original preview image.') }, req),
      async run(args, exec) {
        const { project, taskId } = resolve(args, exec)
        const svc = rt.edit(project)
        const info = svc.summary(taskId) as Record<string, unknown>
        const task = project.repo.task(taskId)
        const shot = project.repo.shot(task?.shotId as string)
        const images: ToolImage[] = []
        let note: string | undefined
        let baselineStats: unknown
        if (args.view === true && shot !== undefined) {
          const head = svc.head(taskId)
          const srcFile = project.repo.file(head.doc.sourceFile)
          const firstEngine = head.doc.stages[0]?.engine
          let viewPath = shot.previewPath
          let caption = 'original'
          if (srcFile?.kind === 'raw' && firstEngine !== undefined && firstEngine !== 'builtin' && firstEngine !== 'ai') {
            try {
              viewPath = await svc.renderOriginal(taskId, { maxEdge: rt.config.editing.previewEdge, signal: exec.signal })
              caption = `original (${firstEngine} RAW baseline)`
              const { imageStats } = await import('../../core/edit/service.ts')
              baselineStats = await imageStats(viewPath, { faceBox: project.repo.features(shot.id)?.subject?.faceBox })
            } catch {
              viewPath = shot.previewPath
            }
          }
          if (viewPath) {
            const r = await rt.imageForModel(viewPath, exec, { caption })
            if (r.image) images.push(r.image)
            note = r.reason
          }
        }
        return { ...info, photo: shot === undefined ? undefined : { id: shot.id, context: rt.shotContext(project, shot), width: shot.width, height: shot.height, raw: shot.rawFile !== null, previewSource: shot.previewSource, baselineStats, diagnostics: photoDiagnostics(project, shot.id), scores: project.repo.scores(shot.id).technical?.detail, issues: project.repo.scores(shot.id).technical?.issues }, preferences: project.profile().styleNotes, look: project.profile().look, images, note }
      },
    }),

    defineTool<{ task?: string; project?: string; ops: EditOp[]; message?: string; preview?: boolean; compare?: boolean }>({
      name: 'edit_apply',
      description: `Edit the photo non-destructively. ${EDIT_OPS_DESCRIPTION}\nReturns the new revision, validation warnings (clamped values etc.) and, with preview=true (default), a rendered preview and statistics (pass compare=true for a side-by-side original | edited comparison image).`,
      parameters: obj({ ...taskParam, ...extra, ops: arr(anyJson('edit operation'), 'operations'), message: str('Why (shown in the history).'), preview: bool('Render and show a preview (default true).'), compare: bool('Show side-by-side original | edited comparison image.') }, [...req, 'ops']),
      async run(args, exec) {
        const { project, taskId } = resolve(args, exec)
        const svc = rt.edit(project)
        const taskRec = project.repo.task(taskId)
        const maxRev = typeof taskRec?.options.maxRevisions === 'number' ? taskRec.options.maxRevisions : rt.config.editing.maxRevisionsPerTask
        const { revision, warnings } = await svc.applyOps(taskId, args.ops, { author: exec.agent?.id === undefined ? 'agent' : `agent:${exec.agent.id.slice(0, 8)}`, message: args.message, signal: exec.signal, maxRevisions: maxRev })
        const usedEdits = project.repo.revisions(taskId).filter(r => r.author.startsWith('agent') && !r.message.startsWith('checkout #')).length
        if (maxRev > 0 && usedEdits >= maxRev - 1) warnings.push(`budget notice: ${Math.max(0, maxRev - usedEdits)} edit_apply iteration(s) remaining; finalize with edit_finish soon`)
        const out: Record<string, unknown> = { revision: { id: revision.id, seq: revision.seq, message: revision.message }, warnings, steps: revision.doc.stages.map((s, i) => ({ stage: i, engine: s.engine, steps: s.steps.map(x => ({ id: x.id, op: x.op, params: x.params, mask: x.mask === undefined ? undefined : true, enabled: x.enabled, instance: x.instance })) })) }
        if (args.preview !== false) {
          const r = await svc.render(taskId, { maxEdge: rt.config.editing.previewEdge, signal: exec.signal })
          out.stats = r.stats
          out.renderWarnings = r.warnings
          const imgPath = args.compare === true ? (await svc.compare(taskId, { revisionId: revision.id, signal: exec.signal })).path : r.path
          const img = await rt.imageForModel(imgPath, exec, { caption: args.compare === true ? `original | rev ${revision.seq}` : `rev ${revision.seq}` })
          out.images = img.image ? [img.image] : []
          if (img.reason) out.note = img.reason
        }
        return out
      },
    }),

    defineTool<{ task?: string; project?: string; revision?: string; compare?: boolean; against?: string; size?: number }>({
      name: 'edit_preview',
      description: 'Render a revision (default: current) and look at it with statistics (mean, percentiles, clipping %, 16-bin histogram, saturation). compare=true shows original | edited side by side (or two revisions with against).',
      parameters: obj({ ...taskParam, ...extra, revision: str('Revision id.'), compare: bool('Side-by-side with the original.'), against: str('Compare with this revision instead of the original.'), size: int('Long edge in px (default from config).') }, req),
      async run(args, exec) {
        const { project, taskId } = resolve(args, exec)
        const svc = rt.edit(project)
        const r = await svc.render(taskId, { revisionId: args.revision, maxEdge: args.size ?? rt.config.editing.previewEdge, signal: exec.signal })
        let path = r.path
        if (args.compare === true || args.against !== undefined) path = (await svc.compare(taskId, { revisionId: args.revision, againstRevisionId: args.against, signal: exec.signal })).path
        const img = await rt.imageForModel(path, exec, { caption: args.compare ? 'original | edited' : 'preview' })
        return { stats: r.stats, warnings: r.warnings, stages: r.stages, images: img.image ? [img.image] : [], note: img.reason }
      },
    }),

    defineTool<{ task?: string; project?: string; revision?: string; undo?: boolean }>({
      name: 'edit_revert',
      description: 'Revert non-destructively: undo=true returns to the previous revision, or check out any earlier revision id. History is never deleted.',
      parameters: obj({ ...taskParam, ...extra, revision: str('Revision id to restore.'), undo: bool('Step back one revision.') }, req),
      async run(args, exec) {
        const { project, taskId } = resolve(args, exec)
        const svc = rt.edit(project)
        const rev = args.undo === true || args.revision === undefined ? svc.undo(taskId, 'agent') : svc.checkout(taskId, args.revision, 'agent')
        return { head: { id: rev.id, seq: rev.seq, message: rev.message }, steps: rev.doc.stages.map(s => ({ engine: s.engine, steps: s.steps.map(x => ({ id: x.id, op: x.op })) })) }
      },
    }),

    defineTool<{ task?: string; project?: string; summary: string; status?: string }>({
      name: 'edit_finish',
      description: 'Finish the task: summarize what you changed and why. status="succeeded" (default), status="unchanged" when the original photo is already well-balanced and retouching would harm its natural look (restores empty recipe if needed and keeps original), or status="failed" when the photo is unrecoverable.',
      parameters: obj({ ...taskParam, ...extra, summary: str('What was done (or why kept unchanged) and why.'), status: strEnum(['succeeded', 'unchanged', 'failed'], 'outcome') }, [...req, 'summary']),
      async run(args, exec) {
        const { project, taskId } = resolve(args, exec)
        const svc = rt.edit(project)
        const rawStatus = args.status ?? 'succeeded'
        let head = svc.head(taskId)
        const hasSteps = head.doc.stages.some(s => s.steps.some(st => st.enabled))
        const unchanged = rawStatus === 'unchanged' || (rawStatus === 'succeeded' && !hasSteps)
        if (rawStatus === 'unchanged' && hasSteps) {
          const initial = project.repo.revisions(taskId)[0]
          if (initial !== undefined) head = svc.checkout(taskId, initial.id, 'agent')
        }
        const task = project.repo.task(taskId)
        if (task !== undefined) {
          project.repo.updateTask(taskId, { options: { ...task.options, unchanged } })
        }
        const finalStatus: 'succeeded' | 'failed' = rawStatus === 'failed' ? 'failed' : 'succeeded'
        if (finalStatus === 'succeeded') {
          await svc.render(taskId, { maxEdge: rt.config.editing.previewEdge, signal: exec.signal })
        }
        svc.setStatus(taskId, finalStatus, { message: unchanged ? `[unchanged] ${args.summary}` : args.summary, ...(finalStatus === 'failed' ? { error: args.summary } : { error: null }) })
        project.repo.addEvent(taskId, 'info', unchanged ? 'unchanged' : 'summary', args.summary, { revision: head.id, unchanged })
        return { task: taskId, status: finalStatus, unchanged, revision: head.seq }
      },
    }),
  ]
}

export function taskManagementTools(rt: ChengyingRuntime): ToolDefinition[] {
  return [
    defineTool<{ project?: string; selection?: string; shots?: string[]; instructions: string; scene_instructions?: Record<string, string>; max_revisions?: number; max_tokens?: number; engine?: string; finish_with_builtin?: boolean; ai_stage?: boolean; stage_options?: Record<string, unknown>; force?: boolean; confirm?: boolean }>({
      name: 'edit_tasks_create',
      description: 'Create one resumable retouching task per photo (from a selection and/or shot ids). Each task starts from the best source (RAW when the engine can develop it) with an empty recipe. Supports scene_instructions (mapping scene_xxxx / segment_xxxx / shot id to a scene-specific style brief; multi-photo scenes automatically schedule an anchor photo first so sibling sub-agents stay consistent) and per-task revision/token budgets. When the session plan has an after-selection checkpoint, the first call returns needsConfirmation without creating tasks; call again with confirm=true after the user approves.',
      parameters: obj({
        project: projectArg, selection: str('Selection id (default: latest).'), shots: arr(str('shot id'), 'Explicit shots.'),
        instructions: str('Album-wide retouching brief (style, priorities, constraints).'),
        scene_instructions: anyJson('Optional map of { "<scene_id|segment_id|shot_id>": "<scene-specific style brief>" }, e.g. {"scene_0002":"preserve warm sunset glow, lift foreground shadows gently"}.'),
        max_revisions: int('Optional per-task edit_apply revision limit (overrides editing.maxRevisionsPerTask).'),
        max_tokens: int('Optional per-task token budget cap (overrides editing.maxTokensPerTask).'),
        engine: strEnum(['auto', 'darktable', 'rawtherapee', 'builtin'], 'Engine for development (default auto: darktable → RawTherapee → built-in).'),
        finish_with_builtin: bool('Add a built-in finishing stage after RAW development.'), ai_stage: bool('Add an (initially empty) AI stage at the end (super-resolution, inpainting, style match).'), stage_options: anyJson('Options for the first stage (see edit_describe stage_options).'), force: bool('Create new tasks even when a task exists for a photo.'), confirm: bool('Confirm the selection checkpoint and create tasks now.'),
      }, ['instructions']),
      async run(args, exec) {
        const project = rt.project(args.project, exec.agent?.id)
        const plan = rt.planFor(project, exec)
        if (plan?.goal === 'cull') throw new ChengyingError('conflict', 'the session plan is cull-only; call photo_session_start with goal="retouch-deliver" before creating retouch tasks')
        if (plan?.retouch === 'none') throw new ChengyingError('conflict', 'the session plan disables retouching; update it with photo_session_start')
        if (plan?.retouch === 'generative') throw new ChengyingError('conflict', 'the session plan uses generative retouching; call photo_ai_redraw instead of edit_tasks_create/edit_run')
        const selectionId = args.selection ?? (args.shots === undefined ? project.repo.latestSelectionId() : undefined)
        if (plan?.checkpoint === 'after-selection' && plan.checkpointApproved !== true && args.confirm !== true) {
          const selection = selectionId === undefined ? undefined : project.repo.selection(selectionId)
          return {
            needsConfirmation: true,
            plan,
            selection: selection === undefined ? undefined : { id: selection.id, name: selection.name, count: selection.items.filter(i => i.included).length, stats: selection.stats },
            shots: args.shots,
            note: 'The session plan requires a checkpoint after selection. Show the selection/contact sheet to the user; call edit_tasks_create again with confirm=true only after approval.',
          }
        }
        const includeAiStage = args.ai_stage ?? (plan?.retouch === 'hybrid')
        const r = await rt.edit(project).createTasks({ selectionId, shotIds: args.shots, instructions: args.instructions, sceneInstructions: args.scene_instructions, maxRevisions: args.max_revisions, maxTokens: args.max_tokens, engine: args.engine, stageOptions: args.stage_options, force: args.force, extraStages: [...(args.finish_with_builtin ? [{ engine: 'builtin' }] : []), ...(includeAiStage ? [{ engine: 'ai' }] : [])] })
        rt.updatePlanStage(project, exec, 'retouching')
        return { created: r.created.map(t => ({ id: t.id, shot: t.shotId, engine: t.engine, scene: t.options.sceneId, sceneAnchor: t.options.sceneAnchor === true || undefined })), existing: r.existing.map(t => ({ id: t.id, shot: t.shotId, status: t.status })), next: 'Run edit_run to let editing sub-agents work on queued tasks.' }
      },
    }),

    defineTool<{ project?: string; status?: string[]; selection?: string; limit?: number }>({
      name: 'edit_tasks',
      description: 'List retouching tasks with status, engine, attempts, errors, revision count and model usage.',
      parameters: obj({ project: projectArg, status: arr(strEnum(['queued', 'running', 'paused', 'failed', 'succeeded', 'cancelled', 'waiting-authorization'], 's'), 'Status filter.'), selection: str('Selection filter.'), limit: int('Max rows (default 100).') }),
      concurrencySafe: true,
      async run(args, exec) {
        const project = rt.project(args.project, exec.agent?.id)
        const tasks = project.repo.tasks({ status: args.status as never, selectionId: args.selection })
        const counts: Record<string, number> = {}
        for (const t of tasks) counts[t.status] = (counts[t.status] ?? 0) + 1
        return { counts, tasks: tasks.slice(0, args.limit ?? 100).map(t => ({ id: t.id, shot: t.shotId, status: t.status, engine: t.engine, attempts: `${t.attempts}/${t.maxAttempts}`, error: t.error, revisions: project.repo.revisions(t.id).length, tokens: t.usage.inputTokens + t.usage.outputTokens })) }
      },
    }),

    defineTool<{ project?: string; task: string; action: string }>({
      name: 'edit_task',
      description: 'Control a task: pause (stops its sub-agent, keeps all revisions), resume, retry (failed/cancelled → queued), cancel.',
      parameters: obj({ project: projectArg, task: str('Task id.'), action: strEnum(['pause', 'resume', 'retry', 'cancel'], 'action') }, ['task', 'action']),
      async run(args, exec) {
        const project = rt.projectOfTask(args.task, args.project, exec.agent?.id)
        return await rt.orchestrator.control(project, args.task, args.action as 'pause' | 'resume' | 'retry' | 'cancel')
      },
    }),

    defineTool<{ project?: string; tasks?: string[]; selection?: string; concurrency?: number; background?: boolean }>({
      name: 'edit_run',
      description: 'Run queued retouching tasks: each photo is edited by its own sub-agent with task-bound tools (it can inspect engine capabilities, apply edits, render previews, revert and finish). Concurrency is bounded; runs in the background and notifies you when all tasks settle. Failed tasks are retried up to their attempt limit.',
      parameters: obj({ project: projectArg, tasks: arr(str('task id'), 'Specific tasks (default: all queued).'), selection: str('Only tasks of this selection.'), concurrency: int('Parallel sub-agents (default from config).'), background: bool('Run as a background job (default true).') }),
      async run(args, exec) {
        const project = rt.project(args.project, exec.agent?.id)
        if (exec.agent === undefined) throw new ChengyingError('unsupported', 'edit_run needs a calling agent (sub-agents are its children)')
        const plan = rt.planFor(project, exec)
        if (plan?.goal === 'cull') throw new ChengyingError('conflict', 'the session plan is cull-only; no retouch tasks should run')
        if (plan?.retouch === 'generative') throw new ChengyingError('conflict', 'the session plan uses generative retouching; call photo_ai_redraw instead')
        if (plan?.retouch === 'none') throw new ChengyingError('conflict', 'the session plan disables retouching; update the plan with photo_session_start')
        const r = await rt.runMaybeBackground(exec, { kind: 'edit', label: `chengying retouch · ${project.root}`, projectId: project.id, background: args.background !== false },
          async (signal, progress) => {
            const result = await rt.orchestrator.run(project, exec, { taskIds: args.tasks, selectionId: args.selection, concurrency: args.concurrency, signal, progress })
            rt.updatePlanStage(project, exec, 'retouched')
            return result
          },
          res => `retouching finished: ${JSON.stringify(res.counts)}`)
        return r.mode === 'background' ? { mode: 'background', jobId: r.jobId, activityId: r.activityId } : { mode: 'inline', ...r.result }
      },
    }),

    defineTool<{ project?: string; selection?: string; tasks?: string[]; shots?: string[]; dir?: string; mode?: 'originals' | 'rendered'; format?: string; quality?: number; max_edge?: number; subdir?: string; naming?: string; source?: 'raster' | 'raw' | 'both'; include_raw?: boolean; c2pa?: boolean; manifest?: boolean; overwrite?: boolean; background?: boolean; archive?: boolean }>({
      name: 'export_run',
      description: 'Low-level export: rendered photos (default: latest selection; edited from their latest revision, unedited from the engine default) at full resolution with metadata verification and _recipes/, or originals copied byte-for-byte. Prefer photo_deliver for a plan-driven delivery; export_run supports the same dir/mode/manifest/archive arguments and reports originalsIntact.',
      parameters: obj({
        project: projectArg, selection: str('Selection id.'), tasks: arr(str('task id'), 'Tasks.'), shots: arr(str('shot id'), 'Shots.'),
        dir: str('Delivery directory (absolute or ~/relative to the session workspace).'),
        mode: strEnum(['originals', 'rendered'], 'originals = copy sources; rendered = full-res export. Default rendered.'),
        format: strEnum(['jpeg', 'tiff', 'png'], 'default jpeg'), quality: int('JPEG quality (default 95).'), max_edge: int('Downscale long edge (default full resolution).'),
        subdir: str('Sub-folder inside the export directory.'), naming: strEnum(['original', 'datetime'], 'File naming.'),
        source: strEnum(['raster', 'raw', 'both'], 'For originals: camera JPEG, RAW, or both.'),
        include_raw: bool('Also copy the paired RAW original alongside the rendered export.'),
        c2pa: bool('Write a C2PA content-credentials manifest and sign with c2patool when available.'),
        manifest: bool('Write manifest.json (default true).'), overwrite: bool('Replace this project’s earlier export (default true).'),
        background: bool('Run as background job.'), archive: bool('Also write a store-only .zip next to the delivery directory.'),
      }),
      async run(args, exec) {
        const project = rt.project(args.project, exec.agent?.id)
        const result = await runDelivery(rt, project, exec, {
          selection: args.selection, tasks: args.tasks, shots: args.shots, dir: args.dir ?? project.exportDir, mode: args.mode ?? 'rendered',
          manifest: args.manifest, format: args.format as 'jpeg', quality: args.quality, maxEdge: args.max_edge,
          subdir: args.subdir, naming: args.naming as 'original', source: args.source, includeRaw: args.include_raw, c2pa: args.c2pa, overwrite: args.overwrite, background: args.background, archive: args.archive,
        })
        // Preserve export_run's compact item shape for existing agents.
        if (result.mode === 'inline' && result.deliveryMode === 'rendered' && Array.isArray(result.items)) {
          result.items = (result.items as Array<Record<string, any>>).map(item => ({
            shot: item.shotId, path: item.path, verified: item.verified, error: item.error,
            problems: item.verify === undefined || item.verify.ok ? undefined : { missing: item.verify.missing, mismatched: item.verify.mismatched },
          }))
        }
        return result
      },
    }),
  ]
}
