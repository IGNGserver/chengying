/**
 * Tool definition helper. Tools are registered as raw JSON-Schema
 * ToolDefinitions (the same path MCP-sourced tools take), which lets the
 * editing layer publish schemas discovered at runtime. Canonical values are
 * lossless JSON; image results carry attachment references in the value and
 * the renderer turns them into image blocks.
 */
import type { ContentBlock, ImageAttachmentRef, ToolDefinition, ToolRunContext } from './host-types.ts'
import { errorMessage, isChengyingError } from '../core/util/errors.ts'

export type JsonSchema = Record<string, unknown>

export interface ToolImage extends ImageAttachmentRef { caption?: string }

export interface ToolSpec<A> {
  name: string
  description: string
  parameters: JsonSchema
  run(args: A, exec: ToolRunContext): Promise<unknown>
  /** Model-facing text; defaults to compact JSON of the value (without image refs). */
  summarize?(value: any, args: A): string
  concurrencySafe?: boolean
  timeoutMs?: number
}

const MAX_TEXT = 24_000

/** Strip undefined/NaN/functions so the value is lossless JSON. */
export function toJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_k, v) => {
    if (typeof v === 'number' && !Number.isFinite(v)) return null
    if (typeof v === 'bigint') return Number(v)
    return v
  }) ?? 'null')
}

export function compactJson(value: unknown): string {
  const text = JSON.stringify(value, null, 1)
  if (text === undefined) return 'null'
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n… (truncated ${text.length - MAX_TEXT} chars; narrow the query with limit/offset)` : text
}

export function obj(properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema {
  return { type: 'object', properties, required, additionalProperties: false }
}

export const str = (description: string, extra: JsonSchema = {}): JsonSchema => ({ type: 'string', description, ...extra })
export const num = (description: string): JsonSchema => ({ type: 'number', description })
export const int = (description: string): JsonSchema => ({ type: 'integer', description })
export const bool = (description: string): JsonSchema => ({ type: 'boolean', description })
export const arr = (items: JsonSchema, description: string): JsonSchema => ({ type: 'array', items, description })
export const anyJson = (description: string): JsonSchema => ({ description })
export const strEnum = (values: string[], description: string): JsonSchema => ({ type: 'string', enum: values, description })

export function defineTool<A>(spec: ToolSpec<A>): ToolDefinition {
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    ...(spec.timeoutMs === undefined ? {} : { timeoutMs: spec.timeoutMs }),
    ...(spec.concurrencySafe ? { isConcurrencySafe: () => true } : {}),
    output: {
      schema: { description: `${spec.name} result (JSON)` },
      render(args: unknown, value: unknown): ContentBlock[] {
        const v = value as { images?: ToolImage[] } | null
        const images = v !== null && typeof v === 'object' && Array.isArray(v.images) ? v.images : []
        let text: string
        try {
          text = spec.summarize !== undefined ? spec.summarize(value, args as A) : compactJson(stripImages(value))
        } catch {
          text = compactJson(stripImages(value))
        }
        const blocks: ContentBlock[] = [{ type: 'text', text }]
        for (const img of images) {
          const { caption: _c, ...ref } = img
          blocks.push({ type: 'image', attachment: ref })
        }
        return blocks
      },
    },
    async execute(args: unknown, exec: ToolRunContext): Promise<unknown> {
      try {
        return toJson(await spec.run((args ?? {}) as A, exec))
      } catch (error) {
        if (isChengyingError(error)) {
          const details = error.details === undefined ? '' : ` ${JSON.stringify(error.details).slice(0, 800)}`
          throw new Error(`[${error.code}] ${error.message}${details}`, { cause: error })
        }
        throw new Error(errorMessage(error), { cause: error })
      }
    },
  }
}

function stripImages(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
  const { images, ...rest } = value as Record<string, unknown>
  if (Array.isArray(images)) return { ...rest, images: images.map((i: ToolImage) => ({ attachmentId: i.attachmentId, width: i.width, height: i.height, caption: i.caption })) }
  return rest
}
