/**
 * Minimal structural types for the DeepSeek Harness services this plugin uses.
 * They mirror the published contracts of the DSH packages (dsh-tools,
 * dsh-subagent, dsh-jobs, dsh-user-approval, dsh-attachment, dsh-llm,
 * dsh-host-webserver) without importing them, so the bundle carries no
 * compile-time dependency on a DSH source checkout. Runtime objects come from
 * the host. Every member used here is exercised by the DSH end-to-end tests.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue }

export interface ImageAttachmentRef {
  attachmentId: string
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  bytes: number
  width: number
  height: number
  name?: string
  originalDimensions?: { width: number; height: number }
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; attachment: ImageAttachmentRef }

export interface AgentLike {
  readonly id: string
  readonly ctx: HostContext
  readonly options: { provider?: string; model?: string; [k: string]: unknown }
  readonly session: { requestHeader(): { config?: { provider?: string; model?: string } } | undefined; id?: string }
  inject?(message: unknown): void
  followup?(message: unknown): unknown
}

export interface ToolRunContext {
  readonly callId: string
  readonly rootCallId?: string
  readonly name: string
  readonly arguments: unknown
  readonly agent?: AgentLike
  readonly signal: AbortSignal
}

export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render(args: unknown, value: unknown): ContentBlock[]
    presentationMeta?(args: unknown, value: unknown): JsonValue
  }
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>
  timeoutMs?: number
  isConcurrencySafe?(args: unknown): boolean
}

export interface ToolsService {
  register(def: ToolDefinition): () => void
  restrict(filter: { allow?: readonly string[]; deny?: readonly string[] }): () => void
}

export interface AttachmentsService {
  saveImage(input: { data: Uint8Array; mediaType: ImageAttachmentRef['mediaType']; name?: string }): Promise<ImageAttachmentRef>
  imageLimits: { mediaTypes: readonly string[]; maxImageBytes: number; maxMessageImageBytes: number; maxImageDimension: number; maxImagePixels: number }
}

export interface LlmChunk {
  type: string
  [k: string]: unknown
}

export interface LlmService {
  stream(options: { provider: string; model: string; messages: unknown[]; system?: unknown; maxTokens?: number; signal?: AbortSignal; [k: string]: unknown }): AsyncIterable<LlmChunk>
  resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<{ inputModalities?: readonly string[]; [k: string]: unknown }>
  listProviders?(): unknown
}

export interface SubagentResult {
  output: readonly ContentBlock[]
  structured?: unknown
  diagnostic?: string
  stopReason: string
}

export interface SubagentActivation {
  childId: string
  messageId?: string
  result: Promise<SubagentResult>
  dispose(): Promise<void>
}

export interface SubagentsService {
  startActivation(spec: {
    provider: string
    label: string
    childId?: string
    request: { prompt: ContentBlock[]; parent: AgentLike; cwd?: string; agentOptions?: Record<string, unknown>; outputSchema?: Record<string, unknown>; maxDepth?: number; agentPreset?: string }
    signal: AbortSignal
    delivery: 'parent' | 'caller'
  }): Promise<SubagentActivation>
}

export interface JobHandle {
  readonly id: string
  append(text: string, options?: { stream?: 'stdout' | 'stderr' | 'log' }): void
  updateProgress(line: string): void
}

export interface JobsService {
  start(spec: {
    kind: string
    label: string
    owner?: string
    toolCall?: { callId: string; rootCallId: string }
    outputLimitBytes?: number
    run(job: JobHandle): { cancel(reason?: string): void; done: Promise<{ status: 'completed' | 'killed' | 'failed'; detail?: string; result?: string }> }
  }): string
}

export interface ApprovalService {
  request(req: { agent: AgentLike; toolName: string; callId?: string; reason?: string; displayReason?: string; signal: AbortSignal }): Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'>
}

export interface WebServerService {
  register(route: { kind: 'exact' | 'prefix'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }): () => void
}

export interface ConnectionService {
  requestRejection(request: { readonly headers: IncomingMessage['headers'] }): 401 | 403 | undefined
}

export interface SystemPromptService {
  section(spec: unknown, content?: unknown): () => void
}

/** The subset of the Cordis Context surface used by the plugin. */
export interface HostContext {
  tools: ToolsService
  get(name: string): unknown
  effect(fn: () => (() => void) | (() => Promise<void>) | undefined | void, label?: string): unknown
  on(event: string, listener: (...args: any[]) => unknown): () => void
  inject(deps: string[], fn: (ctx: HostContext) => void): unknown
  logger?: (name: string) => { info(...a: unknown[]): void; warn(...a: unknown[]): void; error(...a: unknown[]): void; debug(...a: unknown[]): void }
  [k: string]: unknown
}
