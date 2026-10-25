/**
 * Scripted model server speaking the Anthropic-compatible `/v1/messages` SSE
 * protocol that the shipped DeepSeek adapter uses. A script function receives
 * each parsed request and returns either text or tool calls, so end-to-end
 * tests drive a real Harness agent loop (and its sub-agents) deterministically.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface MockRequest {
  system: string
  messages: Array<{ role: string; content: unknown }>
  tools: Array<{ name: string }>
  raw: Record<string, unknown>
}

export type MockReply =
  | { text: string }
  | { tools: Array<{ name: string; input: Record<string, unknown> }>; text?: string }

export type MockScript = (req: MockRequest, index: number) => MockReply

export interface MockLlm {
  baseUrl: string
  requests: MockRequest[]
  close(): Promise<void>
}

/** Text of every block of a given type in a message list (tool_result contents included). */
export function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((b: any) => {
    if (b?.type === 'text') return String(b.text ?? '')
    if (b?.type === 'tool_result') return textOf(b.content)
    return ''
  }).join('\n')
}

export function toolResults(req: MockRequest): Array<{ id: string; text: string; isError: boolean }> {
  const out: Array<{ id: string; text: string; isError: boolean }> = []
  for (const m of req.messages) {
    if (!Array.isArray(m.content)) continue
    for (const b of m.content as any[]) if (b?.type === 'tool_result') out.push({ id: String(b.tool_use_id), text: textOf(b.content), isError: b.is_error === true })
  }
  return out
}

export function firstUserText(req: MockRequest): string {
  const m = req.messages.find(x => x.role === 'user')
  return m === undefined ? '' : textOf(m.content)
}

function sse(res: ServerResponse, payload: Record<string, unknown>): void {
  res.write(`event: ${String(payload.type)}\ndata: ${JSON.stringify(payload)}\n\n`)
}

let callCounter = 0

function stream(res: ServerResponse, reply: MockReply): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  sse(res, { type: 'message_start', message: { id: `msg-${++callCounter}`, type: 'message', role: 'assistant', model: 'mock-model', content: [], usage: { input_tokens: 120, output_tokens: 0 } } })
  let index = 0
  const text = 'tools' in reply ? reply.text : reply.text
  if (text !== undefined && text !== '') {
    sse(res, { type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
    sse(res, { type: 'content_block_delta', index, delta: { type: 'text_delta', text } })
    sse(res, { type: 'content_block_stop', index })
    index++
  }
  if ('tools' in reply) {
    for (const t of reply.tools) {
      const json = JSON.stringify(t.input)
      sse(res, { type: 'content_block_start', index, content_block: { type: 'tool_use', id: `toolu_${++callCounter}`, name: t.name, input: {} } })
      sse(res, { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json } })
      sse(res, { type: 'content_block_stop', index })
      index++
    }
  }
  sse(res, { type: 'message_delta', delta: { stop_reason: 'tools' in reply ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 42 } })
  sse(res, { type: 'message_stop' })
  res.end()
}

export async function startMockLlm(script: MockScript): Promise<MockLlm> {
  const requests: MockRequest[] = []
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'deepseek-flash' }] })); return }
      let body: Record<string, unknown>
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { res.writeHead(400); res.end('{}'); return }
      const sys = Array.isArray(body.system) ? (body.system as any[]).map(s => s.text ?? '').join('\n') : String(body.system ?? '')
      const mr: MockRequest = { system: sys, messages: (body.messages ?? []) as MockRequest['messages'], tools: (body.tools ?? []) as MockRequest['tools'], raw: body }
      requests.push(mr)
      let reply: MockReply
      try {
        reply = script(mr, requests.length - 1)
      } catch (error) {
        reply = { text: `mock script error: ${error instanceof Error ? error.message : String(error)}` }
      }
      if (body.stream === false) {
        res.writeHead(200, { 'content-type': 'application/json' })
        const content: unknown[] = []
        if ('text' in reply && reply.text) content.push({ type: 'text', text: reply.text })
        if ('tools' in reply) for (const t of reply.tools) content.push({ type: 'tool_use', id: `toolu_${++callCounter}`, name: t.name, input: t.input })
        res.end(JSON.stringify({ id: `msg-${++callCounter}`, type: 'message', role: 'assistant', model: 'mock-model', content, stop_reason: 'tools' in reply ? 'tool_use' : 'end_turn', usage: { input_tokens: 120, output_tokens: 42 } }))
        return
      }
      stream(res, reply)
    })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise<void>(r => server.close(() => r())),
  }
}
