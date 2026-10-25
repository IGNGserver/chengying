/**
 * Generative providers. A provider receives the current render (PNG), an
 * optional edit mask (PNG, white = change) and a prompt, and returns one
 * image. Generation is never part of rendering: EditService.generate runs it
 * once under a user authorization and stores the result as a layer asset.
 *
 *  openai-images   OpenAI-compatible /images/edits (gpt-image-1, dall-e-2 or
 *                  any compatible gateway via `url`)
 *  comfyui         a ComfyUI server running a workflow JSON in API format
 *                  whose text contains {{input}}, {{mask}}, {{prompt}} and
 *                  optionally {{seed}} placeholders
 *  command         any local CLI: args with {input} {mask} {output} {prompt} {kind}
 */
import sharp from 'sharp'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { ChengyingError } from '../util/errors.ts'
import { run } from '../util/proc.ts'

export interface GenerativeProvider {
  id: string
  type: 'openai-images' | 'comfyui' | 'command'
  url?: string
  model?: string
  /** Environment variable holding the API key (never the key itself). */
  apiKeyEnv?: string
  command?: string
  args?: string[]
  /** ComfyUI workflow (API format) file. */
  workflow?: string
  timeoutMs?: number
}

export interface GenerateRequest {
  image: string
  mask?: string
  prompt: string
  kind: string
  width: number
  height: number
  outDir: string
  signal?: AbortSignal
  seed?: number
}

export async function generateWith(provider: GenerativeProvider, req: GenerateRequest): Promise<{ path: string; detail: Record<string, unknown> }> {
  switch (provider.type) {
    case 'command': return await viaCommand(provider, req)
    case 'openai-images': return await viaOpenAi(provider, req)
    case 'comfyui': return await viaComfy(provider, req)
    default: throw new ChengyingError('invalid-argument', `unknown generative provider type ${(provider as { type: string }).type}`)
  }
}

async function viaCommand(p: GenerativeProvider, req: GenerateRequest): Promise<{ path: string; detail: Record<string, unknown> }> {
  if (p.command === undefined) throw new ChengyingError('invalid-argument', `provider ${p.id}: command missing`)
  const output = join(req.outDir, `gen-${Date.now()}.png`)
  const args = (p.args ?? ['{input}', '{mask}', '{output}', '{prompt}']).map(a => a.replaceAll('{input}', req.image).replaceAll('{mask}', req.mask ?? '').replaceAll('{output}', output).replaceAll('{prompt}', req.prompt).replaceAll('{kind}', req.kind).replaceAll('{seed}', String(req.seed ?? 0)))
  const r = await run(p.command, args, { timeoutMs: p.timeoutMs ?? 900_000, signal: req.signal })
  if (r.code !== 0 || !existsSync(output)) throw new ChengyingError('engine-failed', `provider ${p.id} failed (${r.code}): ${r.stderr.slice(-800) || r.stdout.slice(-800)}`)
  return { path: output, detail: { command: p.command } }
}

function apiKey(p: GenerativeProvider): string | undefined {
  const env = p.apiKeyEnv ?? (p.type === 'openai-images' ? 'OPENAI_API_KEY' : undefined)
  return env === undefined ? undefined : process.env[env]
}

async function viaOpenAi(p: GenerativeProvider, req: GenerateRequest): Promise<{ path: string; detail: Record<string, unknown> }> {
  const key = apiKey(p)
  if (key === undefined || key === '') throw new ChengyingError('engine-unavailable', `provider ${p.id}: set ${p.apiKeyEnv ?? 'OPENAI_API_KEY'} in the environment`)
  const base = (p.url ?? 'https://api.openai.com/v1').replace(/\/$/, '')
  // The API expects square-ish PNGs ≤ 4 MB for some models; send ≤ 1536 px.
  const edge = 1536
  const image = await sharp(req.image).resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true }).png().toBuffer()
  const form = new FormData()
  form.set('model', p.model ?? 'gpt-image-1')
  form.set('prompt', req.prompt)
  form.set('n', '1')
  form.set('image', new Blob([new Uint8Array(image)], { type: 'image/png' }), 'image.png')
  if (req.mask !== undefined) {
    // OpenAI masks: fully transparent pixels mark the area to edit.
    const meta = await sharp(image).metadata()
    const m = await sharp(req.mask).resize({ width: meta.width, height: meta.height, fit: 'fill' }).greyscale().negate().raw().toBuffer()
    const rgba = Buffer.alloc((meta.width as number) * (meta.height as number) * 4)
    for (let i = 0; i < m.length; i++) { rgba[i * 4] = 0; rgba[i * 4 + 1] = 0; rgba[i * 4 + 2] = 0; rgba[i * 4 + 3] = m[i] as number }
    const mask = await sharp(rgba, { raw: { width: meta.width as number, height: meta.height as number, channels: 4 } }).png().toBuffer()
    form.set('mask', new Blob([new Uint8Array(mask)], { type: 'image/png' }), 'mask.png')
  }
  const res = await fetch(`${base}/images/edits`, { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: form, signal: req.signal })
  const body = await res.json() as { data?: Array<{ b64_json?: string; url?: string }>; error?: { message?: string } }
  if (!res.ok) throw new ChengyingError('engine-failed', `provider ${p.id}: HTTP ${res.status} ${body.error?.message ?? ''}`)
  const item = body.data?.[0]
  let buf: Buffer
  if (item?.b64_json !== undefined) buf = Buffer.from(item.b64_json, 'base64')
  else if (item?.url !== undefined) buf = Buffer.from(await (await fetch(item.url, { signal: req.signal })).arrayBuffer())
  else throw new ChengyingError('engine-failed', `provider ${p.id}: empty response`)
  const out = join(req.outDir, `gen-${Date.now()}.png`)
  writeFileSync(out, buf)
  return { path: out, detail: { model: p.model ?? 'gpt-image-1', url: base } }
}

async function viaComfy(p: GenerativeProvider, req: GenerateRequest): Promise<{ path: string; detail: Record<string, unknown> }> {
  if (p.url === undefined || p.workflow === undefined) throw new ChengyingError('invalid-argument', `provider ${p.id}: url and workflow are required for comfyui`)
  const base = p.url.replace(/\/$/, '')
  const upload = async (file: string): Promise<string> => {
    const form = new FormData()
    form.set('image', new Blob([new Uint8Array(readFileSync(file))], { type: 'image/png' }), basename(file))
    form.set('overwrite', 'true')
    const r = await fetch(`${base}/upload/image`, { method: 'POST', body: form, signal: req.signal })
    if (!r.ok) throw new ChengyingError('engine-failed', `comfyui upload failed: HTTP ${r.status}`)
    return ((await r.json()) as { name: string }).name
  }
  const input = await upload(req.image)
  const mask = req.mask !== undefined ? await upload(req.mask) : ''
  const text = readFileSync(p.workflow, 'utf8')
    .replaceAll('{{input}}', input).replaceAll('{{mask}}', mask)
    .replaceAll('{{prompt}}', JSON.stringify(req.prompt).slice(1, -1)).replaceAll('{{seed}}', String(req.seed ?? Math.floor(Math.random() * 2 ** 31)))
  const queued = await fetch(`${base}/prompt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: JSON.parse(text) }), signal: req.signal })
  if (!queued.ok) throw new ChengyingError('engine-failed', `comfyui /prompt: HTTP ${queued.status} ${await queued.text()}`)
  const { prompt_id: id } = await queued.json() as { prompt_id: string }
  const deadline = Date.now() + (p.timeoutMs ?? 900_000)
  while (Date.now() < deadline) {
    req.signal?.throwIfAborted()
    await new Promise(r => setTimeout(r, 1500))
    const h = await (await fetch(`${base}/history/${id}`, { signal: req.signal })).json() as Record<string, { outputs?: Record<string, { images?: Array<{ filename: string; subfolder: string; type: string }> }> }>
    const images = Object.values(h[id]?.outputs ?? {}).flatMap(o => o.images ?? [])
    const img = images[0]
    if (img !== undefined) {
      const r = await fetch(`${base}/view?filename=${encodeURIComponent(img.filename)}&subfolder=${encodeURIComponent(img.subfolder)}&type=${encodeURIComponent(img.type)}`, { signal: req.signal })
      const out = join(req.outDir, `gen-${Date.now()}.png`)
      writeFileSync(out, Buffer.from(await r.arrayBuffer()))
      return { path: out, detail: { promptId: id, url: base } }
    }
  }
  throw new ChengyingError('engine-failed', `comfyui prompt ${id} did not finish in time`)
}
