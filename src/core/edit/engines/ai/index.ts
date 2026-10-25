/**
 * AI stage engine (raster in → raster out, placed after RAW development and
 * finishing stages):
 *
 *  upscale       super-resolution: Lanczos3 + detail-preserving sharpening, or
 *                an external model CLI (Real-ESRGAN, waifu2x, any tool taking
 *                {input} {output} {scale}) configured in `superResolution`
 *  inpaint       classical object / blemish removal (Telea fast marching) —
 *                propagates surrounding pixels, invents no new content
 *  style_match   cross-photo look unification (Lab colour statistics +
 *                luminance quantile mapping towards a reference fingerprint)
 *  gen_layer     composites pixels produced by a generative provider. The
 *                generation itself happens once, explicitly and with the
 *                user's authorization (EditService.generate); the revision
 *                stores the resulting asset, so renders are deterministic and
 *                previews match exports
 *  <custom>      every entry of `commands` (external deterministic CLIs with
 *                their own parameter schema) is exposed as an operation
 *
 * The catalog is rebuilt from the configuration and probed binaries, so
 * adding a model command makes it callable without code changes.
 */
import sharp from 'sharp'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { EditStage, EditStep } from '../../../types.ts'
import type { Catalog, EngineAdapter, EngineProbe, OperationSpec, RenderRequest, RenderResult, ValidatedStep } from '../../engine.ts'
import { coverageOf, fingerprintOf, validateWithCatalog } from '../../engine.ts'
import type { ParamSchema } from '../../schema.ts'
import { loadImage, saveImage, type FImage } from '../builtin/image.ts'
import { blendWithMask, rasterizeMask } from '../builtin/masks.ts'
import { gaussBlur, luminancePlane, toLinear, toSrgb } from '../builtin/image.ts'
import { applyStyle, inpaintTelea, styleFingerprint, type StyleFingerprint } from './classical.ts'
import { ChengyingError } from '../../../util/errors.ts'
import { nowIso } from '../../../util/misc.ts'
import { run } from '../../../util/proc.ts'

declare const __CHENGYING_VERSION__: string
const VERSION = typeof __CHENGYING_VERSION__ === 'string' ? __CHENGYING_VERSION__ : 'dev'
const CATALOG_VERSION = 1

export interface AiCommandOp {
  /** Operation id exposed to the agent. Must not start with gen_ (generation goes through providers). */
  id: string
  title?: string
  description?: string
  command: string
  /** Arguments with placeholders {input} {output} {mask} {scale} and {param.<name>}. */
  args: string[]
  params?: ParamSchema
  maskable?: boolean
  /** Output dimensions relative to the input (default 1). */
  scaleParam?: string
  timeoutMs?: number
}

export interface AiEngineOptions {
  workDir: string
  superResolution?: { command?: string; args?: string[]; model?: string; timeoutMs?: number }
  commands?: AiCommandOp[]
  /** Configured generative providers (listed in the catalog; generation runs through EditService.generate). */
  providers?: Array<{ id: string; type: string; model?: string }>
}

const num = (min: number, max: number, def: number, description: string): ParamSchema => ({ type: 'number', minimum: min, maximum: max, default: def, description })

const FINGERPRINT: ParamSchema = {
  type: 'object',
  description: 'style fingerprint of the reference photo (from edit_style_reference); mean/std are Lab, quantiles are L* at 0,5,…,100 %',
  properties: {
    mean: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
    std: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
    quantiles: { type: 'array', items: { type: 'number' }, minItems: 21, maxItems: 21 },
  },
  additionalProperties: false,
}

export class AiEngine implements EngineAdapter {
  readonly id = 'ai'
  readonly title = 'Chengying AI stage'
  private cached: Catalog | undefined
  private probed: EngineProbe | undefined
  private srAvailable = false

  constructor(private readonly opts: AiEngineOptions) {}

  async probe(force = false): Promise<EngineProbe> {
    if (this.probed !== undefined && !force) return this.probed
    const binaries: Record<string, string> = {}
    const sr = this.opts.superResolution
    this.srAvailable = false
    if (sr?.command !== undefined && sr.command !== '') {
      binaries.superResolution = sr.command
      this.srAvailable = await commandExists(sr.command)
    }
    for (const c of this.opts.commands ?? []) binaries[c.id] = c.command
    this.probed = {
      id: this.id, available: true, version: VERSION, mode: 'registry', binaries,
      fingerprint: fingerprintOf([VERSION, CATALOG_VERSION, JSON.stringify(this.opts.commands ?? []), sr?.command, String(this.srAvailable), JSON.stringify(this.opts.providers ?? [])]),
      inputs: { raw: false, raster: true },
    }
    return this.probed
  }

  async catalog(options: { refresh?: boolean } = {}): Promise<Catalog> {
    if (this.cached !== undefined && options.refresh !== true) return this.cached
    const probe = await this.probe(options.refresh === true)
    const operations: OperationSpec[] = [
      {
        id: 'upscale', title: 'Super-resolution upscale', category: 'ai/detail', version: 1, masks: [], multiInstance: false, tags: ['non-generative'],
        description: `Enlarge the image by "scale". method "model" runs the configured super-resolution CLI${this.srAvailable ? ` (${this.opts.superResolution?.command})` : ' (not configured on this host)'}; "lanczos" is classical Lanczos3 with edge-aware sharpening; "auto" picks the model when available. Previews are shown at preview size; exports get the full enlarged resolution.`,
        params: { type: 'object', additionalProperties: false, properties: {
          scale: num(1, 4, 2, 'enlargement factor'),
          method: { type: 'string', enum: ['auto', 'lanczos', 'model'], default: 'auto', description: 'upscaling backend' },
          sharpen: num(0, 1, 0.25, 'post-upscale detail recovery (lanczos)'),
          max_megapixels: num(1, 400, 100, 'safety cap for the output size'),
        } },
      },
      {
        id: 'inpaint', title: 'Remove objects (classical inpainting)', category: 'ai/repair', version: 1, masks: ['drawn'], multiInstance: true, tags: ['non-generative'],
        description: 'Fill the masked area from its surroundings (Telea fast-marching). The mask (shapes: circle/ellipse/polygon/brush/rectangle) marks what to remove. Best for wires, sensor dust, small distractions on smooth or textured backgrounds; large areas smear — use a generative layer (with user authorization) for those.',
        params: { type: 'object', additionalProperties: false, properties: {
          radius: { type: 'integer', minimum: 1, maximum: 40, default: 6, description: 'neighbourhood radius in pixels at full resolution (scaled for previews)' },
          grow: num(0, 0.05, 0.003, 'expand the mask (relative to the longer side) to cover halos'),
        } },
      },
      {
        id: 'style_match', title: 'Match look to a reference photo', category: 'ai/color', version: 1, masks: ['drawn', 'parametric'], multiInstance: true, tags: ['non-generative', 'series'],
        description: 'Unify a series: transfer colour balance/saturation statistics and tonal distribution from a reference photo (fingerprint from edit_style_reference, or reference_path). Use strength 0.3–0.7 for natural results.',
        params: { type: 'object', additionalProperties: false, properties: {
          fingerprint: FINGERPRINT,
          reference_path: { type: 'string', description: 'image to take the look from (alternative to fingerprint)' },
          strength: num(0, 1, 0.6, 'blend amount'),
          color: { type: 'boolean', default: true, description: 'match colour (Lab a/b statistics)' },
          tone: { type: 'boolean', default: true, description: 'match tonal distribution (L* quantiles)' },
          max_shift: num(0, 60, 15, 'cap on the colour-cast shift (Lab a*/b* units); raise only for deliberate grading'),
          protect_extremes: { type: 'boolean', default: true, description: 'keep near-white highlights and near-black shadows neutral' },
        } },
      },
      {
        id: 'gen_layer', title: 'Generative layer (authorized)', category: 'ai/generative', version: 1, masks: ['drawn', 'parametric'], multiInstance: true, tags: ['generative'],
        description: 'Pixels created by a generative provider, composited through the mask. Do not add this step directly: call edit_generate, which checks the user\'s authorization, runs the provider once and records the layer.',
        params: { type: 'object', additionalProperties: false, properties: {
          asset: { type: 'string', description: 'generated image (recorded by edit_generate)' },
          kind: { type: 'string', enum: ['remove', 'fill', 'replace', 'enhance', 'expand', 'edit'], default: 'fill' },
          prompt: { type: 'string', default: '' },
          provider: { type: 'string', default: '' },
          authorization: { type: 'string', description: 'authorization id the generation ran under' },
          opacity: num(0, 1, 1, 'layer opacity'),
          feather: num(0, 0.05, 0.004, 'edge feather of the composite'),
        } },
      },
      ...(this.opts.commands ?? []).map((c): OperationSpec => ({
        id: c.id, title: c.title ?? c.id, category: 'ai/extension', version: 1, masks: c.maskable === true ? ['drawn', 'parametric'] : [], multiInstance: true, tags: ['extension', 'non-generative'],
        description: `${c.description ?? 'external image operation'} (command: ${c.command})`,
        params: c.params ?? { type: 'object', properties: {}, additionalProperties: false },
      })),
    ]
    const unsupported: string[] = []
    if (!this.srAvailable) unsupported.push('upscale method "model": no super-resolution CLI configured or found (superResolution.command)')
    if ((this.opts.providers ?? []).length === 0) unsupported.push('generative layers: no generative provider configured (generative.providers)')
    this.cached = {
      engine: this.id,
      engineVersion: VERSION,
      catalogVersion: CATALOG_VERSION,
      fingerprint: probe.fingerprint as string,
      source: 'registry',
      discoveredAt: nowIso(),
      operations,
      stageOptions: { type: 'object', properties: {}, additionalProperties: false },
      maskModel: { drawn: ['circle', 'ellipse', 'rectangle', 'gradient', 'polygon', 'brush'], parametric: ['luminance', 'hue', 'saturation', 'lab_a', 'lab_b'] },
      notes: [
        'authenticity: upscale/inpaint/style_match are non-generative; gen_layer content is generated and only created with the user\'s authorization; exports of generated content carry IPTC DigitalSourceType compositeWithTrainedAlgorithmicMedia',
        `generative providers: ${(this.opts.providers ?? []).map(p => `${p.id} (${p.type}${p.model ? ` ${p.model}` : ''})`).join(', ') || 'none'}`,
      ],
      coverage: coverageOf(operations, ['model-backed super-resolution', 'external command operations'], unsupported),
    }
    return this.cached
  }

  validateStep(step: EditStep, catalog: Catalog): ValidatedStep {
    const v = validateWithCatalog(step, catalog, { fill: true })
    if (v.step.op === 'inpaint' && (step.mask?.shapes === undefined || step.mask.shapes.length === 0)) {
      throw new ChengyingError('invalid-argument', 'inpaint needs a mask with shapes marking what to remove')
    }
    if (v.step.op === 'style_match' && v.step.params.fingerprint === undefined && v.step.params.reference_path === undefined) {
      throw new ChengyingError('invalid-argument', 'style_match needs fingerprint (edit_style_reference) or reference_path')
    }
    if (v.step.op === 'gen_layer' && (typeof v.step.params.asset !== 'string' || typeof v.step.params.authorization !== 'string')) {
      throw new ChengyingError('invalid-argument', 'gen_layer steps are created by edit_generate (asset + authorization)')
    }
    if (v.step.op === 'upscale' && v.step.params.method === 'model' && !this.srAvailable) {
      v.warnings.push('no super-resolution model available; lanczos will be used')
    }
    return v
  }

  async render(req: RenderRequest, catalog: Catalog): Promise<RenderResult> {
    if (req.inputKind === 'raw') throw new ChengyingError('unsupported', 'the AI stage works on developed images; put it after a darktable/RawTherapee/built-in stage')
    const started = Date.now()
    const warnings: string[] = []
    let img = await loadImage(req.input, req.maxEdge)
    // Previews are rendered smaller than the source; spatial parameters given in full-resolution pixels scale with it.
    const previewScale = req.fullEdge !== undefined && req.fullEdge > 0 ? Math.min(1, Math.max(img.width, img.height) / req.fullEdge) : 1
    for (const s of req.stage.steps.filter(x => x.enabled)) {
      req.signal?.throwIfAborted()
      const { step, warnings: w } = this.validateStep(s, catalog)
      warnings.push(...w)
      const p = step.params as Record<string, any>
      switch (step.op) {
        case 'upscale':
          img = await this.upscale(img, p, req, warnings)
          break
        case 'inpaint': {
          const raw = rasterizeMask({ ...(step.mask ?? {}), feather: 0, blur: 0, opacity: 1, invert: false }, img)
          const L = Math.max(img.width, img.height)
          const grown = growMask(raw, img.width, img.height, Math.max(0, Number(p.grow) * L))
          const filled = inpaintRegion(img, grown, Math.max(1, Math.round(Number(p.radius) * previewScale)))
          const area = grown.reduce((a, v) => a + (v > 0.5 ? 1 : 0), 0) / grown.length
          if (area > 0.04) warnings.push(`inpaint area is ${(area * 100).toFixed(1)}% of the image; classical inpainting smears large regions`)
          const soft = gaussBlur(grown, img.width, img.height, Math.max(0.8, L * 0.0015))
          img = blendWithMask(img, filled, soft)
          break
        }
        case 'style_match': {
          let ref = p.fingerprint as StyleFingerprint | undefined
          if (ref === undefined) {
            const path = (req.readable ?? ((x: string) => x))(String(p.reference_path))
            ref = styleFingerprint(await loadImage(path, 1024))
          }
          const after = applyStyle(img, ref, { strength: Number(p.strength), color: p.color !== false, tone: p.tone !== false, maxShift: Number(p.max_shift ?? 15), protectExtremes: p.protect_extremes !== false })
          img = step.mask !== undefined ? blendWithMask(img, after, rasterizeMask(step.mask, img)) : after
          break
        }
        case 'gen_layer': {
          const asset = (req.readable ?? ((x: string) => x))(String(p.asset))
          if (!existsSync(asset)) throw new ChengyingError('not-found', `generated layer ${asset} is missing; regenerate it with edit_generate`)
          const layer = await loadAsset(asset, img.width, img.height)
          const L = Math.max(img.width, img.height)
          let mask = step.mask !== undefined ? rasterizeMask(step.mask, img) : new Float32Array(img.width * img.height).fill(1)
          if (Number(p.feather) > 0 && step.mask !== undefined) mask = gaussBlur(mask, img.width, img.height, Number(p.feather) * L)
          const op = Number(p.opacity ?? 1)
          if (op !== 1) for (let i = 0; i < mask.length; i++) mask[i] = (mask[i] as number) * op
          img = blendWithMask(img, layer, mask)
          break
        }
        default: {
          const cmd = (this.opts.commands ?? []).find(c => c.id === step.op)
          if (cmd === undefined) throw new ChengyingError('invalid-argument', `unknown AI operation ${step.op}`)
          const after = await this.runCommandOp(cmd, img, p, step, req)
          img = step.mask !== undefined && cmd.maskable === true && after.width === img.width && after.height === img.height ? blendWithMask(img, after, rasterizeMask(step.mask, img)) : after
        }
      }
    }
    const ext = req.format === 'tiff' ? 'tif' : req.format === 'png' ? 'png' : 'jpg'
    const out = req.output.endsWith(`.${ext}`) ? req.output : `${req.output}.${ext}`
    await saveImage(img, out, req.format, req.quality ?? 92, req.bitDepth ?? (req.format === 'tiff' ? 16 : 8))
    return { output: out, width: img.width, height: img.height, durationMs: Date.now() - started, warnings }
  }

  async recipe(stage: EditStage): Promise<{ extension: string; text: string }> {
    return { extension: 'chengying.json', text: JSON.stringify({ engine: this.id, version: VERSION, options: stage.options ?? {}, steps: stage.steps }, null, 2) }
  }

  async importRecipe(text: string): Promise<{ steps: EditStep[]; options?: Record<string, unknown>; warnings: string[] }> {
    const parsed = JSON.parse(text) as { steps?: EditStep[]; options?: Record<string, unknown> }
    return { steps: parsed.steps ?? [], options: parsed.options, warnings: [] }
  }

  /* ------------------------------------------------------------ helpers */

  private async upscale(img: FImage, p: Record<string, any>, req: RenderRequest, warnings: string[]): Promise<FImage> {
    const scale = Math.max(1, Math.min(4, Number(p.scale ?? 2)))
    const maxPx = Number(p.max_megapixels ?? 100) * 1e6
    let s = scale
    if (img.width * img.height * s * s > maxPx) { s = Math.sqrt(maxPx / (img.width * img.height)); warnings.push(`upscale limited to ×${s.toFixed(2)} by max_megapixels`) }
    if (s <= 1.0001) return img
    // Previews: the stage receives a downsized image; show the enhancement at preview size.
    const preview = req.previewEdge !== undefined
    const method = p.method === 'model' || (p.method === 'auto' && this.srAvailable) ? (this.srAvailable ? 'model' : 'lanczos') : 'lanczos'
    let out: FImage
    if (method === 'model') {
      out = await this.runSuperResolution(img, s, req)
    } else {
      out = await resizeLanczos(img, Math.round(img.width * s), Math.round(img.height * s))
      const k = Number(p.sharpen ?? 0.25)
      if (k > 0) out = unsharp(out, 1.0 * s / 2, k)
    }
    if (preview) {
      const edge = req.previewEdge as number
      if (Math.max(out.width, out.height) > edge) out = await resizeLanczos(out, Math.round(out.width * edge / Math.max(out.width, out.height)), Math.round(out.height * edge / Math.max(out.width, out.height)))
    }
    return out
  }

  private async runSuperResolution(img: FImage, scale: number, req: RenderRequest): Promise<FImage> {
    const sr = this.opts.superResolution as { command: string; args?: string[]; model?: string; timeoutMs?: number }
    const native = Math.max(2, Math.min(4, Math.ceil(scale - 1e-6)))
    const cacheDir = join(this.opts.workDir, 'cache')
    mkdirSync(cacheDir, { recursive: true })
    const input = join(req.scratchDir, `sr-in-${Date.now()}.png`)
    await saveImage(img, input, 'png', 92, 8)
    const key = createHash('sha1').update(readFileSync(input)).update(`${sr.command}|${JSON.stringify(sr.args)}|${sr.model}|${native}`).digest('hex')
    const cached = join(cacheDir, `${key}.png`)
    if (!existsSync(cached)) {
      const output = join(req.scratchDir, `sr-out-${Date.now()}.png`)
      const args = (sr.args ?? ['-i', '{input}', '-o', '{output}', '-s', '{scale}']).map(a => a.replaceAll('{input}', input).replaceAll('{output}', output).replaceAll('{scale}', String(native)).replaceAll('{model}', sr.model ?? ''))
      const r = await run(sr.command, args, { timeoutMs: sr.timeoutMs ?? 600_000, signal: req.signal })
      if (r.code !== 0 || !existsSync(output)) throw new ChengyingError('engine-failed', `super-resolution failed (${r.code}): ${r.stderr.slice(-800) || r.stdout.slice(-800)}`)
      copyFileSync(output, cached)
    }
    const target = { w: Math.round(img.width * scale), h: Math.round(img.height * scale) }
    return await loadAsset(cached, target.w, target.h)
  }

  private async runCommandOp(cmd: AiCommandOp, img: FImage, p: Record<string, unknown>, step: EditStep, req: RenderRequest): Promise<FImage> {
    const input = join(req.scratchDir, `${cmd.id}-in-${Date.now()}.png`)
    const output = join(req.scratchDir, `${cmd.id}-out-${Date.now()}.png`)
    await saveImage(img, input, 'png', 92, 16)
    let maskPath = ''
    if (step.mask !== undefined) {
      maskPath = join(req.scratchDir, `${cmd.id}-mask-${Date.now()}.png`)
      await writeMaskPng(rasterizeMask(step.mask, img), img.width, img.height, maskPath)
    }
    const args = cmd.args.map(a => a.replaceAll('{input}', input).replaceAll('{output}', output).replaceAll('{mask}', maskPath).replaceAll('{scale}', String(p[cmd.scaleParam ?? 'scale'] ?? 1)).replace(/\{param\.([A-Za-z0-9_]+)\}/g, (_, k: string) => String(p[k] ?? '')))
    const r = await run(cmd.command, args, { timeoutMs: cmd.timeoutMs ?? 600_000, signal: req.signal })
    if (r.code !== 0 || !existsSync(output)) throw new ChengyingError('engine-failed', `${cmd.id} failed (${r.code}): ${r.stderr.slice(-800) || r.stdout.slice(-800)}`)
    return await loadImage(output)
  }
}

/* ------------------------------------------------------------- utilities */

async function commandExists(command: string): Promise<boolean> {
  if (command.includes('/')) return existsSync(command) && statSync(command).isFile()
  try {
    const r = await run('/bin/sh', ['-c', `command -v "${command.replaceAll('"', '')}"`], { timeoutMs: 5000 })
    return r.code === 0 && r.stdout.trim() !== ''
  } catch { return false }
}

async function resizeLanczos(img: FImage, w: number, h: number): Promise<FImage> {
  const u16 = new Uint16Array(img.width * img.height * 3)
  for (let i = 0; i < u16.length; i++) u16[i] = Math.round(toSrgb(img.data[i] as number) * 65535)
  const { data } = await sharp(u16, { raw: { width: img.width, height: img.height, channels: 3 }, limitInputPixels: false })
    .toColourspace('rgb16').resize({ width: w, height: h, fit: 'fill', kernel: 'lanczos3' }).raw({ depth: 'ushort' }).toBuffer({ resolveWithObject: true })
  const src = new Uint16Array(data.buffer, data.byteOffset, data.byteLength / 2)
  const out = new Float32Array(w * h * 3)
  for (let i = 0; i < out.length; i++) out[i] = toLinear((src[i] as number) / 65535)
  return { width: w, height: h, data: out }
}

/** Luminance unsharp mask (edge-aware enough for post-upscale detail recovery). */
function unsharp(img: FImage, sigma: number, amount: number): FImage {
  const Y = luminancePlane(img)
  const B = gaussBlur(Y, img.width, img.height, Math.max(0.6, sigma))
  const out = new Float32Array(img.data.length)
  for (let i = 0, j = 0; i < Y.length; i++, j += 3) {
    const y = Y[i] as number
    const detail = y - (B[i] as number)
    const k = y > 1e-5 ? Math.max(0, (y + detail * amount * 1.5) / y) : 1
    out[j] = (img.data[j] as number) * k; out[j + 1] = (img.data[j + 1] as number) * k; out[j + 2] = (img.data[j + 2] as number) * k
  }
  return { width: img.width, height: img.height, data: out }
}

/** Load an image resized to exactly w×h (cover). */
export async function loadAsset(path: string, w: number, h: number): Promise<FImage> {
  const meta = await sharp(path).metadata()
  if (meta.width === w && meta.height === h) return await loadImage(path)
  const { data } = await sharp(path, { limitInputPixels: false }).rotate().removeAlpha().resize({ width: w, height: h, fit: 'cover', kernel: 'lanczos3' }).toColourspace('rgb16').raw({ depth: 'ushort' }).toBuffer({ resolveWithObject: true })
  const src = new Uint16Array(data.buffer, data.byteOffset, data.byteLength / 2)
  const out = new Float32Array(w * h * 3)
  for (let i = 0; i < out.length; i++) {
    const v = (src[i] as number) / 65535
    out[i] = v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  return { width: w, height: h, data: out }
}

export async function writeMaskPng(mask: Float32Array, w: number, h: number, path: string): Promise<void> {
  const buf = Buffer.alloc(w * h)
  for (let i = 0; i < buf.length; i++) buf[i] = Math.round(Math.min(1, Math.max(0, mask[i] as number)) * 255)
  await sharp(buf, { raw: { width: w, height: h, channels: 1 } }).png().toFile(path)
}

function growMask(mask: Float32Array, w: number, h: number, px: number): Float32Array {
  const bin = new Float32Array(mask.length)
  for (let i = 0; i < mask.length; i++) bin[i] = (mask[i] as number) > 0.5 ? 1 : 0
  if (px < 0.5) return bin
  const blurred = gaussBlur(bin, w, h, px)
  for (let i = 0; i < bin.length; i++) bin[i] = (blurred[i] as number) > 0.08 ? 1 : 0
  return bin
}

/** Inpaint only the bounding box of the mask (plus margin) for speed. */
function inpaintRegion(img: FImage, mask: Float32Array, radius: number): FImage {
  const { width: w, height: h } = img
  let x0 = w; let y0 = h; let x1 = -1; let y1 = -1
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if ((mask[y * w + x] as number) > 0.5) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y }
  if (x1 < 0) return img
  const m = radius * 3 + 2
  x0 = Math.max(0, x0 - m); y0 = Math.max(0, y0 - m); x1 = Math.min(w - 1, x1 + m); y1 = Math.min(h - 1, y1 + m)
  const cw = x1 - x0 + 1; const ch = y1 - y0 + 1
  const sub = new Float32Array(cw * ch * 3); const subMask = new Float32Array(cw * ch)
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const si = (y + y0) * w + (x + x0)
      subMask[y * cw + x] = mask[si] as number
      for (let c = 0; c < 3; c++) sub[(y * cw + x) * 3 + c] = img.data[si * 3 + c] as number
    }
  }
  const filled = inpaintTelea({ width: cw, height: ch, data: sub }, subMask, radius)
  const out = new Float32Array(img.data)
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const si = (y + y0) * w + (x + x0)
    for (let c = 0; c < 3; c++) out[si * 3 + c] = filled.data[(y * cw + x) * 3 + c] as number
  }
  return { width: w, height: h, data: out }
}

export { styleFingerprint }
