/**
 * 澄影 Chengying — DeepSeek Harness Host plugin.
 *
 * Registers the photo culling / retouching tools, the editing sub-agent
 * orchestration, the task-management HTTP API used by the Web UI, and a short
 * workflow section in the system prompt.
 */
import { ChengyingRuntime, type Log } from './runtime.ts'
import { Config as ConfigSchema, type Config as ChengyingConfig } from './config.ts'
import { cullTools } from './tools/cull.ts'
import { engineTools, taskManagementTools, taskTools } from './tools/edit.ts'
import { aiTaskTools, aiTools } from './tools/ai.ts'
import { EditOrchestrator } from './orchestrator.ts'
import { registerHttpApi } from './http.ts'
import type { HostContext, SystemPromptService, ToolDefinition } from './host-types.ts'
import { errorMessage } from '../core/util/errors.ts'

declare const __CHENGYING_VERSION__: string

export const name = 'chengying'
export const inject = ['tools']
export const Config = ConfigSchema
export type { ChengyingConfig }

export const WORKFLOW_PROMPT = `# 澄影 Chengying photo workflow
You can cull and professionally retouch large photo sets (travel shoots, events) with the photo_*/edit_* tools.
- Culling: photo_workspace_open → photo_cull_run (scan, previews, classical scores, duplicate/scene/trip grouping) → optionally photo_vlm_score or review contact sheets yourself with photo_view + photo_score → photo_select (turn the user's wording into count / min_score, preferences, diversity, narrative) → photo_selection to show or adjust. Never delete or modify originals; Chengying only reads them.
- Retouching: edit_engines / edit_capabilities / edit_describe expose every operation of the installed engines (darktable, RawTherapee, built-in) with full parameter schemas — inspect before editing, do not guess parameter names. edit_tasks_create makes one resumable task per selected photo; edit_run delegates them to editing sub-agents with bounded concurrency; edit_task controls pause/resume/retry. Export with export_run (metadata is preserved and verified).
- Advanced (AI stage, engine "ai"): super-resolution (ai:upscale), classical object removal (ai:inpaint), series look unification (edit_unify_style / ai:style_match with edit_style_reference). These are non-generative and allowed.
- Generative changes (edit_generate: generative fill/removal/enhancement) alter photo authenticity: only with the user's explicit authorization — a grant the user made in the Chengying panel or an approval prompt the user answers (gen_authorize). Never claim authorization the user did not give; exports of generated content are tagged as such.
- Report progress honestly: background jobs notify you when they settle; use photo_status for counts and model usage.`

export function apply(ctx: HostContext, config: ChengyingConfig): void {
  const log: Log = (typeof ctx.logger === 'function' ? ctx.logger('chengying') : undefined) ?? console
  const resolved = ConfigSchema(config ?? {}) as ChengyingConfig
  const rt = new ChengyingRuntime(ctx, resolved, log)
  rt.orchestrator = new EditOrchestrator(rt, ctx)
  rt.orchestrator.childToolFactories.push(child => aiTaskTools(rt, child))
  ctx.effect(() => rt.orchestrator.attach(), 'chengying: editing sub-agents')
  const tools: ToolDefinition[] = [...cullTools(rt), ...engineTools(rt), ...taskManagementTools(rt), ...taskTools(rt), ...aiTools(rt)]
  for (const t of tools) ctx.effect(() => ctx.tools.register(t), `chengying: tool ${t.name}`)

  const sp = ctx.get('systemPrompt') as SystemPromptService | undefined
  if (sp !== undefined) {
    try {
      ctx.effect(() => sp.section({ name: 'chengying:workflow', order: 860, text: WORKFLOW_PROMPT, interpolate: false }), 'chengying: workflow prompt')
    } catch (error) {
      log.warn('chengying: cannot add system prompt section:', errorMessage(error))
    }
  }

  if (resolved.ui.enabled) {
    ctx.inject(['webServer', 'connection'], (webCtx) => {
      webCtx.effect(() => registerHttpApi(webCtx, rt, resolved.ui.basePath), 'chengying: http api')
    })
  }

  ctx.effect(() => () => { void rt.close() }, 'chengying: runtime')
  log.info(`chengying ${typeof __CHENGYING_VERSION__ === 'string' ? __CHENGYING_VERSION__ : 'dev'} loaded with ${tools.length} tools`)
}
