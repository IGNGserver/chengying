/**
 * Plugin configuration (cordis.patch.yml `config:`). Every tunable value lives
 * here so deployments change behaviour without code edits.
 */
import Schema from '@deepseek-ai/schemastery'
import { validateModelConfig } from '../core/analysis/models.ts'
import { ChengyingError } from '../core/util/errors.ts'
import type { ModelConfig } from '../core/analysis/models.ts'
import type { GenerativeProvider } from '../core/edit/generative.ts'
import type { AiCommandOp } from '../core/edit/engines/ai/index.ts'

export interface EngineSetting {
  enabled: boolean
  /** Explicit CLI path (darktable-cli / rawtherapee-cli); auto-detected when empty. */
  path?: string
}

export type GenerativeProviderSetting = GenerativeProvider

export interface Config {
  /**
   * auto: Host-only when the deployment has agent presets (tools come from the
   * chengying preset), otherwise both. host/agent/both pin one surface.
   */
  mode: 'auto' | 'host' | 'agent' | 'both'
  stateRoot?: string
  exportDir?: string
  /** When non-empty, workspaces must live under one of these roots. */
  allowedRoots: string[]
  previewEdge: number
  analysisConcurrency: number
  /** Background job threshold: pipelines over this many files run as DSH jobs. */
  backgroundThreshold: number
  /** Chat-attachment intake limits: files copied into the managed inbox per session. */
  intake: { maxFiles: number; maxBytes: number; location: 'workspace' | 'state'; dirName: string }
  /** Workspace scan behaviour for files without a recognised extension. */
  scan: { sniffUnknown: boolean }
  vlm: { enabled: boolean; provider?: string; model?: string; batchSize: number; cell: number; maxShots: number; language: 'zh' | 'en'; maxTokens: number }
  models: ModelConfig[]
  engines: { darktable: EngineSetting; rawtherapee: EngineSetting; builtin: EngineSetting; ai: EngineSetting }
  /** Extra deterministic image operations (external CLIs) exposed in the AI stage. */
  aiOperations: AiCommandOp[]
  defaultEngine: 'auto' | 'darktable' | 'rawtherapee' | 'builtin'
  editing: {
    subagentProvider: string
    maxConcurrent: number
    maxAttempts: number
    maxRevisionsPerTask: number
    maxTokensPerTask: number
    previewEdge: number
    /** Optional model override for editing children (provider/model). */
    childProvider?: string
    childModel?: string
  }
  generative: { providers: GenerativeProviderSetting[]; requireApproval: boolean }
  superResolution: { command?: string; args?: string[]; model?: string; timeoutMs?: number }
  privacy: { stripGpsForCloud: boolean }
  ui: { enabled: boolean; basePath: string }
}

const engine = (enabled = true): Schema<EngineSetting> => Schema.object({
  enabled: Schema.boolean().default(enabled),
  path: Schema.string(),
})

export const Config: Schema<Config> = Schema.object({
  mode: Schema.union(['auto', 'host', 'agent', 'both'] as const).default('auto').description('auto mounts the Host UI/runtime and leaves model tools to the chengying preset when agent presets exist; headless/direct setups keep both.'),
  stateRoot: Schema.string().description('Chengying state directory (database, previews, renders). Defaults to $CHENGYING_HOME or ~/.chengying. Must be on local disk.'),
  exportDir: Schema.string().description('Export directory. Defaults to <workspace>/_chengying_export; chat-attachment intake defaults to <session workspace>/_chengying_export.'),
  allowedRoots: Schema.array(Schema.string()).default([]).description('Restrict workspaces to these roots (empty = any directory the user names).'),
  previewEdge: Schema.natural().default(1600),
  analysisConcurrency: Schema.natural().default(4),
  backgroundThreshold: Schema.natural().default(150),
  intake: Schema.object({
    maxFiles: Schema.natural().default(200),
    maxBytes: Schema.natural().default(4 * 1024 * 1024 * 1024),
    location: Schema.union(['workspace', 'state'] as const).default('workspace').description('Where chat attachments are copied: the session workspace (default, visible next to the conversation) or the Chengying state directory (legacy, hidden).'),
    dirName: Schema.string().default('_chengying_inbox').description('Folder inside the session workspace that receives attachment copies.'),
  }),
  scan: Schema.object({
    sniffUnknown: Schema.boolean().default(true).description('Detect extension-less photos by content while scanning (chat attachments are stored without file names).'),
  }),
  vlm: Schema.object({
    enabled: Schema.boolean().default(true),
    provider: Schema.string().description('Vision model provider route; defaults to the calling agent\'s route.'),
    model: Schema.string(),
    batchSize: Schema.natural().default(9),
    cell: Schema.natural().default(512),
    maxShots: Schema.natural().default(400),
    language: Schema.union(['zh', 'en'] as const).default('zh'),
    maxTokens: Schema.natural().default(4096),
  }),
  models: Schema.array(Schema.any()).default([]).description('Specialised scoring models ({id,type:command|http|onnx,...}).') as unknown as Schema<ModelConfig[]>,
  engines: Schema.object({
    darktable: engine(),
    rawtherapee: engine(),
    builtin: engine(),
    ai: engine(),
  }),
  aiOperations: Schema.array(Schema.any()).default([]).description('External image operations for the AI stage: {id,title,description,command,args:[...{input} {output} {mask} {param.x}],params:<JSON schema>,maskable}.') as unknown as Schema<AiCommandOp[]>,
  defaultEngine: Schema.union(['auto', 'darktable', 'rawtherapee', 'builtin'] as const).default('auto'),
  editing: Schema.object({
    subagentProvider: Schema.string().default('spawn'),
    maxConcurrent: Schema.natural().default(2),
    maxAttempts: Schema.natural().default(3),
    maxRevisionsPerTask: Schema.natural().default(8).description('Max edit_apply revisions per task before the sub-agent must conclude.'),
    maxTokensPerTask: Schema.natural().default(120_000).description('Max total model tokens (input + output) per retouching task (0 disables cap).'),
    previewEdge: Schema.natural().default(1400),
    childProvider: Schema.string(),
    childModel: Schema.string(),
  }),
  generative: Schema.object({
    providers: Schema.array(Schema.any()).default([]).description('Generative providers: {id,type:openai-images|comfyui|command,url,model,apiKeyEnv,command,args,workflow}. API keys are read from the named environment variable only.') as unknown as Schema<GenerativeProviderSetting[]>,
    requireApproval: Schema.boolean().default(true).description('Require an explicit user authorization (panel grant or DSH approval prompt) before any generative edit.'),
  }),
  superResolution: Schema.object({
    command: Schema.string().description('External super-resolution CLI, e.g. realesrgan-ncnn-vulkan'),
    args: Schema.array(Schema.string()),
    model: Schema.string(),
    timeoutMs: Schema.natural(),
  }),
  privacy: Schema.object({
    stripGpsForCloud: Schema.boolean().default(true).description('Omit exact GPS coordinates from cloud VLM prompts and strip metadata from cloud-uploaded previews.'),
  }).default({ stripGpsForCloud: true }),
  ui: Schema.object({
    enabled: Schema.boolean().default(true),
    basePath: Schema.string().default('/api/chengying'),
  }),
})

/** Validate fields whose generic schemas cannot express operational constraints. */
export function validateConfig(config: Config): Config {
  const integer = (value: number, name: string, minimum = 1): void => {
    if (!Number.isSafeInteger(value) || value < minimum) throw new ChengyingError('invalid-argument', `${name} must be an integer >= ${minimum}`)
  }
  integer(config.previewEdge, 'previewEdge'); integer(config.analysisConcurrency, 'analysisConcurrency'); integer(config.backgroundThreshold, 'backgroundThreshold', 0)
  integer(config.intake.maxFiles, 'intake.maxFiles'); integer(config.intake.maxBytes, 'intake.maxBytes')
  integer(config.vlm.batchSize, 'vlm.batchSize'); integer(config.vlm.cell, 'vlm.cell'); integer(config.vlm.maxShots, 'vlm.maxShots'); integer(config.vlm.maxTokens, 'vlm.maxTokens')
  integer(config.editing.maxConcurrent, 'editing.maxConcurrent'); integer(config.editing.maxAttempts, 'editing.maxAttempts'); integer(config.editing.maxRevisionsPerTask, 'editing.maxRevisionsPerTask'); integer(config.editing.maxTokensPerTask, 'editing.maxTokensPerTask', 0); integer(config.editing.previewEdge, 'editing.previewEdge')
  const dirName = config.intake.dirName
  if (dirName.length === 0 || dirName.length > 255 || dirName === '.' || dirName === '..' || /[\\/\0]/.test(dirName)) throw new ChengyingError('invalid-argument', 'intake.dirName must be one safe path segment')
  const basePath = config.ui.basePath.replace(/\/+$/, '')
  if (!basePath.startsWith('/') || basePath === '' || /[?#\0]/.test(basePath) || basePath.split('/').some(part => part === '.' || part === '..')) throw new ChengyingError('invalid-argument', 'ui.basePath must be an absolute URL path without query, fragment or traversal')
  config.ui.basePath = basePath
  const ids = new Set<string>()
  for (const model of config.models) { validateModelConfig(model); if (ids.has(model.id)) throw new ChengyingError('invalid-argument', `duplicate scoring model ${model.id}`); ids.add(model.id) }
  ids.clear()
  for (const operation of config.aiOperations) {
    if (!/^[a-z][a-z0-9_]*$/.test(operation.id) || operation.id.startsWith('gen_') || ids.has(operation.id)) throw new ChengyingError('invalid-argument', `invalid or duplicate AI operation id ${operation.id}`)
    ids.add(operation.id)
    if (typeof operation.command !== 'string' || operation.command.trim() === '' || !Array.isArray(operation.args)) throw new ChengyingError('invalid-argument', `AI operation ${operation.id} needs command and args`)
    const args = operation.args.join('\n')
    if (!args.includes('{input}') || !args.includes('{output}')) throw new ChengyingError('invalid-argument', `AI operation ${operation.id} args must include {input} and {output}`)
    if (operation.timeoutMs !== undefined) integer(operation.timeoutMs, `aiOperations.${operation.id}.timeoutMs`)
    if (operation.scaleParam !== undefined && operation.params?.properties?.[operation.scaleParam] === undefined) throw new ChengyingError('invalid-argument', `AI operation ${operation.id} has an unknown scaleParam`)
  }
  ids.clear()
  for (const provider of config.generative.providers) {
    if (!/^[a-z][a-z0-9_-]*$/.test(provider.id) || ids.has(provider.id)) throw new ChengyingError('invalid-argument', `invalid or duplicate generative provider ${provider.id}`)
    ids.add(provider.id)
    if (provider.timeoutMs !== undefined) integer(provider.timeoutMs, `generative.${provider.id}.timeoutMs`)
    if (provider.type === 'command') {
      if (provider.command === undefined || provider.command.trim() === '') throw new ChengyingError('invalid-argument', `generative provider ${provider.id} needs a command`)
      if (!(provider.args ?? ['{input}', '{mask}', '{output}', '{prompt}']).join('\n').includes('{output}')) throw new ChengyingError('invalid-argument', `generative provider ${provider.id} args must include {output}`)
    } else if (provider.type === 'comfyui') {
      if (provider.workflow === undefined || provider.workflow === '') throw new ChengyingError('invalid-argument', `ComfyUI provider ${provider.id} needs a workflow`)
    } else if (provider.type !== 'openai-images') throw new ChengyingError('invalid-argument', `unknown generative provider type ${provider.type as string}`)
    if (provider.url !== undefined) {
      let url: URL
      try { url = new URL(provider.url) } catch { throw new ChengyingError('invalid-argument', `provider ${provider.id} has an invalid URL`) }
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new ChengyingError('invalid-argument', `provider ${provider.id} URL must use HTTP(S)`)
    }
  }
  if (config.superResolution.timeoutMs !== undefined) integer(config.superResolution.timeoutMs, 'superResolution.timeoutMs')
  const srArgs = config.superResolution.args?.join('\n')
  if (config.superResolution.args !== undefined && config.superResolution.args.length > 0 && (srArgs === undefined || !srArgs.includes('{input}') || !srArgs.includes('{output}'))) throw new ChengyingError('invalid-argument', 'superResolution.args must include {input} and {output}; {scale} is optional for fixed-scale commands')
  return config
}

/** Defaults used when the plugin is driven outside a Loader (tests, CLI). */
export function resolveConfig(partial: Partial<Config> = {}): Config {
  return validateConfig(Config(partial as Config) as Config)
}
