/**
 * Chengying — DeepSeek Harness plugin entry.
 *
 * Two surfaces share one runtime:
 *  - host: the HTTP panel and the process-wide runtime (always mounted);
 *  - agent: the photo tools and workflow prompt, mounted by the `chengying`
 *    agent preset (and directly in headless/no-preset deployments).
 *
 * The split keeps 30+ photo tool schemas out of unrelated DSH sessions.
 */
import { ChengyingRuntime, type Log } from './runtime.ts'
import { Config as ConfigSchema, type Config as ChengyingConfig } from './config.ts'
import { cullTools } from './tools/cull.ts'
import { engineTools, taskManagementTools, taskTools } from './tools/edit.ts'
import { aiTaskTools, aiTools } from './tools/ai.ts'
import { sessionTools } from './tools/session.ts'
import { EditOrchestrator } from './orchestrator.ts'
import { registerHttpApi } from './http.ts'
import type { HostContext, SystemPromptService, ToolDefinition } from './host-types.ts'
import { errorMessage } from '../core/util/errors.ts'

declare const __CHENGYING_VERSION__: string

export const name = 'chengying'
export const inject = ['tools']
export const Config = ConfigSchema
export type { ChengyingConfig }

const RUNTIME_SERVICE = 'chengyingRuntime'

export const WORKFLOW_PROMPT = `# 澄影 Chengying 摄影后期工作流

你正在澄影模式下工作。澄影处理大批量照片的筛图、专业修图和交付；原图只读，所有修改都是可回退的修订。

开工：先调用 photo_session_start 建立“来源 + 范围 + 交付”计划。
- 来源：用户给了目录路径就传 path；用户直接把图片/文件贴进聊天就留空，工具会读取本会话的附件、按 mediaType/文件头补齐扩展名后复制到 <会话工作区>/_chengying_inbox/；不要在本可直接开始的情况下反复索要路径。
- 交付：附件场景默认交付到 <会话工作区>/_chengying_export/，目录场景是 <照片目录>/_chengying_export/；开工时用一句话把“副本目录 + 交付目录”告诉用户。
- 附件是宿主规范化后的副本（大图会缩放/重编码，EXIF 可能丢失）；用户要 RAW 或原始画质时，提醒改给照片目录或原始文件。
- 范围：goal 为 "cull"（只筛图）或 "retouch-deliver"（修图并交付）；retouch 为 "engine"（darktable / RawTherapee / 内置引擎逐项修）、"generative"（AI 重绘）、"hybrid"（混合）或 "none"。
- 用户已经说清楚时直接按计划执行；范围确实缺失时只问一个简短问题，并给出推荐默认值（全链路 + engine + 输出到 _chengying_export）。
- 计划会按会话保存；改变范围时再次调用 photo_session_start 更新即可。

筛图：photo_cull_run（quality 默认跟随计划：fast 只做传统评分，balanced 加 VLM 候选，thorough 加专用模型和全量 VLM）→ photo_view 看联系表 → photo_select 把用户原话转成数量/阈值/偏好。若计划要求选片后确认，photo_select 会提示 checkpoint：先给用户看选片结果，得到确认后再 edit_tasks_create({confirm:true})。

修图：
- engine / hybrid（推荐需要 RAW 调色 + 局部智能消除/补全/超分时使用 hybrid）：edit_tasks_create（可传 scene_instructions 为不同场景如日落/夜景/人像定制统一风格策略，多图场景会自动先修锚点照片以保持全组色调统一）→ edit_run。每张照片一个子 Agent，用编辑引擎完整参数 schema（含 darktable 曲线的 curves 点对语法与局部蒙版）逐项修改，edit_apply 出预览，edit_revert 可回退；原片已经足够好时子 Agent 可用 edit_finish(status="unchanged") 拒绝过度修图；hybrid 下子 Agent 还可在引擎调色后按需调用 ai 阶段工具或经用户授权的 edit_generate 做局部生成式消除/重绘。
- generative（仅用于整批全图风格化 AI 重绘）：不要走 edit_run；先 gen_authorize({max_uses: 张数}) 让用户一次授权整批，再调 photo_ai_redraw；若计划要求选片后确认，调用时带 confirm:true；导出会带生成内容标记。
- 引擎工具很多：先用 edit_capabilities / edit_describe 查清参数，再 edit_apply；不要猜参数名。

交付：photo_deliver（默认沿用计划中的 outputDir 和 deliverMode）。
- 只筛图：mode="originals"，复制入选原图并写 manifest.json；
- 修图：mode="rendered"，全分辨率渲染、元数据校验、_recipes/ 旁车和 manifest.json；
- 交付目录可以是任意可写目录，工具会把它加入本次任务的可写根；不要把原图目录当成输出目录。

安全：生成式修改必须经用户授权；Agent 不能自行授权。导出含生成图层时会写入 IPTC DigitalSourceType 标记。报告进度要诚实：后台任务完成会通知，用 photo_status 查看活动和计划。`

function resolveMode(ctx: HostContext, configured: ChengyingConfig['mode']): 'host' | 'agent' | 'both' {
  if (configured !== 'auto') return configured
  // The web bundle mounts agent presets; the chengying preset owns the tools.
  // Headless/direct profiles have no preset roster, so the single row must do both.
  // `strict: false` sees a preset registry that is still activating during boot.
  if (ctx.get('agentPresets', false) !== undefined) return 'host'
  // The Web/Desktop surfaces have their own transport rows; headless does not.
  if (ctx.get('webServer', false) !== undefined || ctx.get('connection', false) !== undefined) return 'host'
  const profile = ctx.get('profileContext') as { name?: string } | undefined
  if (profile?.name === 'web' || profile?.name === 'desktop') return 'host'
  return 'both'
}

function ensureRuntime(ctx: HostContext, config: ChengyingConfig, log: Log): { rt: ChengyingRuntime; owned: boolean } {
  const existing = ctx.get(RUNTIME_SERVICE) as ChengyingRuntime | undefined
  if (existing !== undefined) return { rt: existing, owned: false }
  const rt = new ChengyingRuntime(ctx, config, log)
  if (ctx.provide !== undefined) {
    ctx.provide(RUNTIME_SERVICE, rt)
  } else {
    // Structural fallback for small test hosts that predate service provisioning.
    ;(ctx as unknown as Record<string, unknown>)[RUNTIME_SERVICE] = rt
  }
  return { rt, owned: true }
}

function ensureOrchestrator(ctx: HostContext, rt: ChengyingRuntime): void {
  if (rt.orchestrator !== undefined) return
  rt.orchestrator = new EditOrchestrator(rt, ctx)
  rt.orchestrator.childToolFactories.push(child => aiTaskTools(rt, child))
  ctx.effect(() => rt.orchestrator.attach(), 'chengying: editing sub-agents')
}

export function apply(ctx: HostContext, config: ChengyingConfig): void {
  const log: Log = (typeof ctx.logger === 'function' ? ctx.logger('chengying') : undefined) ?? console
  const resolved = ConfigSchema(config ?? {}) as ChengyingConfig
  const mode = resolveMode(ctx, resolved.mode)

  if (mode === 'host' || mode === 'both') {
    const rt = registerHost(ctx, resolved, log)
    if (mode === 'both') registerAgentWithRuntime(ctx, rt, resolved, log)
    return
  }
  registerAgent(ctx, resolved, log)
}

function registerHost(ctx: HostContext, config: ChengyingConfig, log: Log): ChengyingRuntime {
  const { rt, owned } = ensureRuntime(ctx, config, log)
  ensureOrchestrator(ctx, rt)
  if (owned) ctx.effect(() => () => { void rt.close() }, 'chengying: runtime')

  if (config.ui.enabled) {
    ctx.inject(['webServer', 'connection'], (webCtx) => {
      webCtx.effect(() => registerHttpApi(webCtx, rt, config.ui.basePath), 'chengying: http api')
    })
  }
  log.info(`chengying ${typeof __CHENGYING_VERSION__ === 'string' ? __CHENGYING_VERSION__ : 'dev'} host ready`)
  return rt
}

function registerAgent(ctx: HostContext, config: ChengyingConfig, log: Log): void {
  const existing = ctx.get(RUNTIME_SERVICE) as ChengyingRuntime | undefined
  if (existing !== undefined) {
    registerAgentWithRuntime(ctx, existing, config, log)
    return
  }
  // A preset row normally waits for the Host row's service. Direct headless
  // patches have no preset roster, so they own the runtime themselves.
  if (ctx.get('agentPresets', false) === undefined) {
    const { rt, owned } = ensureRuntime(ctx, config, log)
    if (owned) ctx.effect(() => () => { void rt.close() }, 'chengying: runtime')
    registerAgentWithRuntime(ctx, rt, config, log)
    return
  }
  let mounted = false
  ctx.inject([RUNTIME_SERVICE], (injected) => {
    if (mounted) return
    const rt = injected.get(RUNTIME_SERVICE) as ChengyingRuntime | undefined
    if (rt === undefined) {
      log.error('chengying: agent preset mounted without the chengying host runtime; install/enable the bundle host row')
      return
    }
    mounted = true
    registerAgentWithRuntime(injected, rt, config, log)
  })
}

function registerAgentWithRuntime(ctx: HostContext, rt: ChengyingRuntime, config: ChengyingConfig, log: Log): void {
  ensureOrchestrator(ctx, rt)
  const tools: ToolDefinition[] = [
    ...sessionTools(rt),
    ...cullTools(rt),
    ...engineTools(rt),
    ...taskManagementTools(rt),
    ...taskTools(rt),
    ...aiTools(rt),
  ]
  for (const t of tools) ctx.effect(() => ctx.tools.register(t), `chengying: tool ${t.name}`)

  const sp = ctx.get('systemPrompt') as SystemPromptService | undefined
  if (sp !== undefined) {
    try {
      ctx.effect(() => sp.section({ name: 'chengying:workflow', order: 860, text: WORKFLOW_PROMPT, interpolate: false }), 'chengying: workflow prompt')
    } catch (error) {
      log.warn('chengying: cannot add system prompt section:', errorMessage(error))
    }
  }
  log.info(`chengying ${typeof __CHENGYING_VERSION__ === 'string' ? __CHENGYING_VERSION__ : 'dev'} agent ready with ${tools.length} tools`)
}
