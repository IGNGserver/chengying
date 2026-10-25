/**
 * Plugin configuration (cordis.patch.yml `config:`). Every tunable value lives
 * here so deployments change behaviour without code edits.
 */
import Schema from '@deepseek-ai/schemastery'
import type { ModelConfig } from '../core/analysis/models.ts'

export interface EngineSetting {
  enabled: boolean
  /** Explicit CLI path (darktable-cli / rawtherapee-cli); auto-detected when empty. */
  path?: string
}

export interface GenerativeProviderSetting {
  id: string
  type: 'openai-images' | 'comfyui' | 'command'
  url?: string
  model?: string
  apiKeyEnv?: string
  command?: string
  args?: string[]
  workflow?: string
}

export interface Config {
  stateRoot?: string
  exportDir?: string
  /** When non-empty, workspaces must live under one of these roots. */
  allowedRoots: string[]
  previewEdge: number
  analysisConcurrency: number
  /** Background job threshold: pipelines over this many files run as DSH jobs. */
  backgroundThreshold: number
  vlm: { enabled: boolean; provider?: string; model?: string; batchSize: number; cell: number; maxShots: number; language: 'zh' | 'en'; maxTokens: number }
  models: ModelConfig[]
  engines: { darktable: EngineSetting; rawtherapee: EngineSetting; builtin: EngineSetting }
  defaultEngine: 'auto' | 'darktable' | 'rawtherapee' | 'builtin'
  editing: {
    subagentProvider: string
    maxConcurrent: number
    maxAttempts: number
    previewEdge: number
    /** Optional model override for editing children (provider/model). */
    childProvider?: string
    childModel?: string
  }
  generative: { providers: GenerativeProviderSetting[]; requireApproval: boolean }
  superResolution: { command?: string; args?: string[]; model?: string }
  ui: { enabled: boolean; basePath: string }
}

const engine = (enabled = true): Schema<EngineSetting> => Schema.object({
  enabled: Schema.boolean().default(enabled),
  path: Schema.string(),
})

export const Config: Schema<Config> = Schema.object({
  stateRoot: Schema.string().description('Chengying state directory (database, previews, renders). Defaults to $CHENGYING_HOME or ~/.chengying. Must be on local disk.'),
  exportDir: Schema.string().description('Export directory. Defaults to <workspace>/_chengying_export.'),
  allowedRoots: Schema.array(Schema.string()).default([]).description('Restrict workspaces to these roots (empty = any directory the user names).'),
  previewEdge: Schema.natural().default(1600),
  analysisConcurrency: Schema.natural().default(4),
  backgroundThreshold: Schema.natural().default(150),
  vlm: Schema.object({
    enabled: Schema.boolean().default(true),
    provider: Schema.string().description('Vision model provider route; defaults to the calling agent\'s route.'),
    model: Schema.string(),
    batchSize: Schema.natural().default(9),
    cell: Schema.natural().default(384),
    maxShots: Schema.natural().default(400),
    language: Schema.union(['zh', 'en'] as const).default('zh'),
    maxTokens: Schema.natural().default(4096),
  }),
  models: Schema.array(Schema.any()).default([]).description('Specialised scoring models ({id,type:command|http|onnx,...}).') as unknown as Schema<ModelConfig[]>,
  engines: Schema.object({
    darktable: engine(),
    rawtherapee: engine(),
    builtin: engine(),
  }),
  defaultEngine: Schema.union(['auto', 'darktable', 'rawtherapee', 'builtin'] as const).default('auto'),
  editing: Schema.object({
    subagentProvider: Schema.string().default('spawn'),
    maxConcurrent: Schema.natural().default(2),
    maxAttempts: Schema.natural().default(3),
    previewEdge: Schema.natural().default(1400),
    childProvider: Schema.string(),
    childModel: Schema.string(),
  }),
  generative: Schema.object({
    providers: Schema.array(Schema.any()).default([]) as unknown as Schema<GenerativeProviderSetting[]>,
    requireApproval: Schema.boolean().default(true),
  }),
  superResolution: Schema.object({
    command: Schema.string().description('External super-resolution CLI, e.g. realesrgan-ncnn-vulkan'),
    args: Schema.array(Schema.string()),
    model: Schema.string(),
  }),
  ui: Schema.object({
    enabled: Schema.boolean().default(true),
    basePath: Schema.string().default('/api/chengying'),
  }),
})

/** Defaults used when the plugin is driven outside a Loader (tests, CLI). */
export function resolveConfig(partial: Partial<Config> = {}): Config {
  return Config(partial as Config) as Config
}
