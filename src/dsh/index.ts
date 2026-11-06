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
import { auditTools } from './tools/audit.ts'
import { EditOrchestrator } from './orchestrator.ts'
import { registerHttpApi } from './http.ts'
import { CHENGYING_SKILLS } from './skills.ts'
import type { HostContext, ShellEnvService, SkillsService, SystemPromptService, ToolDefinition } from './host-types.ts'
import { errorMessage } from '../core/util/errors.ts'

declare const __CHENGYING_VERSION__: string

export const name = 'chengying'
export const inject = ['tools']
export const Config = ConfigSchema
export type { ChengyingConfig }

const RUNTIME_SERVICE = 'chengyingRuntime'

export const WORKFLOW_PROMPT = `# 澄影 Chengying 摄影后期工作流

你正在澄影模式下工作。澄影处理大批量照片的筛图、专业修图和交付；原图只读，所有修改都是可回退的修订。

## 通用工具与自主排查

除了摄影工具，宿主还给你通用工具。插件覆盖不到的问题先自己查清楚，不要直接说“做不到”：
- bash（Windows 为 pwsh）：查环境（command -v darktable-cli、exiftool -ver、ffmpeg -version）、看目录与磁盘、读日志、跑 exiftool/ffmpeg/ImageMagick/vips/rsync/zip、写一次性脚本。命令从会话工作目录启动，传 workdir 而不是 cd。
- job_output / job_list / job_kill：耗时命令用 run_in_background: true 放后台，不要在前台干等。
- subagent / subagent_fork：把读目录、翻错误日志、查资料、批量核验交给子 Agent；需要当前对话上下文时用 subagent_fork。
- present：交付 zip、报告、联系表等最终文件，让用户在界面直接打开。
- skill：需要批量命令配方或引擎排障步骤时先加载技能；goal 用于跨多轮的长期任务。
- shell 里有 DSH_CHENGYING_PROJECT / DSH_CHENGYING_STATE / DSH_CHENGYING_SCRATCH / DSH_CHENGYING_EXPORT 四个托管变量，直接引用，不要自己拼路径。

边界（与摄影工具同等重要）：
- 修图一律走 edit_*：edit_apply 生成不可变修订，可回退、可交付；用 shell 直接改图不会进入修订，也不会被交付系统识别。
- 原图目录只读：不要用 shell 对原图 mv / cp 覆盖 / rm / chmod / 重命名，也不要往原图目录写 XMP sidecar；需要写文件时写工作区、scratch 或交付目录。
- 生成式修改只能走 gen_authorize / edit_generate / photo_ai_redraw；不要用 shell 调外部生成模型绕过授权。
- 交付前如果用过 shell 或怀疑原图被动过，先调用 photo_integrity_check；交付结果里的 originalsIntact=false 必须如实告诉用户。
- 破坏性命令（rm -rf、覆盖写入）先问用户；这不是能力限制，是避免不可逆损失。

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
- 需要打包给用户时，photo_deliver 传 archive=true 会在交付目录旁生成同名 .zip；也可以用 present 声明最终文件。

安全：生成式修改必须经用户授权；Agent 不能自行授权。导出含生成图层时会写入 IPTC DigitalSourceType 标记。原图只读由 FsGuard 约束摄影工具；shell 是宿主能力，photo_integrity_check 用扫描基线校验原图未被改动，交付前会自动做一次快速检查。报告进度要诚实：后台任务完成会通知，用 photo_status 查看活动和计划。`

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
  registerShellEnv(ctx, rt, log)
  registerSkills(ctx, log)

  if (config.ui.enabled) {
    ctx.inject(['webServer', 'connection'], (webCtx) => {
      webCtx.effect(() => registerHttpApi(webCtx, rt, config.ui.basePath), 'chengying: http api')
    })
  }
  log.info(`chengying ${typeof __CHENGYING_VERSION__ === 'string' ? __CHENGYING_VERSION__ : 'dev'} host ready`)
  return rt
}

/**
 * Expose the current workspace to the model's shell as trusted DSH_* facts.
 * shell-env only injects the DSH_* namespace and rebuilds it per call, so the
 * values are resolved from the calling agent's bound workspace, never from
 * ambient process environment.
 */
function registerShellEnv(ctx: HostContext, rt: ChengyingRuntime, log: Log): void {
  const shellEnv = ctx.get('shellEnv', false) as ShellEnvService | undefined
  if (shellEnv === undefined) return
  try {
    ctx.effect(() => shellEnv.register({
      name: 'chengying',
      variables: {
        DSH_CHENGYING_PROJECT: { description: 'Chengying photo workspace (read-only originals).' },
        DSH_CHENGYING_STATE: { description: 'Chengying state directory for the current workspace (previews, renders, scratch).' },
        DSH_CHENGYING_SCRATCH: { description: 'Chengying scratch directory for temporary scripts and intermediates.' },
        DSH_CHENGYING_EXPORT: { description: 'Chengying default delivery directory for the current workspace.' },
      },
      resolve(execution) {
        const project = rt.projectForAgent(execution.agent?.id)
        if (project === undefined) return {}
        return {
          DSH_CHENGYING_PROJECT: project.root,
          DSH_CHENGYING_STATE: project.stateDir,
          DSH_CHENGYING_SCRATCH: project.path('scratch'),
          DSH_CHENGYING_EXPORT: project.exportDir,
        }
      },
    }), 'chengying: shell env')
  } catch (error) {
    log.warn('chengying: cannot register shell environment:', errorMessage(error))
  }
}

/** Contribute the packaged skills to the host skill registry (no path resolution). */
function registerSkills(ctx: HostContext, log: Log): void {
  const skills = ctx.get('skills', false) as SkillsService | undefined
  if (skills === undefined) return
  for (const skill of CHENGYING_SKILLS) {
    try {
      ctx.effect(() => skills.register({ ...skill, source: 'bundled' }), `chengying: skill ${skill.name}`)
    } catch (error) {
      log.warn(`chengying: cannot register skill ${skill.name}:`, errorMessage(error))
    }
  }
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
    ...auditTools(rt),
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
