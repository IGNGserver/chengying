/**
 * Built-in engine: always available (libvips decode/encode + JS float
 * pipeline). Works on raster inputs (camera JPEG, TIFF, PNG, HEIF via libvips)
 * and on renders of other engines, so it also serves as the finishing stage
 * of multi-engine pipelines.
 */
import type { EditStage, EditStep } from '../../../types.ts'
import type { Catalog, EngineAdapter, EngineProbe, OperationSpec, RenderRequest, RenderResult, ValidatedStep } from '../../engine.ts'
import { coverageOf, fingerprintOf, validateWithCatalog } from '../../engine.ts'
import { normalizeParams, type ParamSchema } from '../../schema.ts'
import { BUILTIN_OPS, type OpContext } from './ops.ts'
import { loadImage, saveImage } from './image.ts'
import { blendWithMask, rasterizeMask } from './masks.ts'
import { ChengyingError } from '../../../util/errors.ts'
import { nowIso } from '../../../util/misc.ts'

declare const __CHENGYING_VERSION__: string
const VERSION = typeof __CHENGYING_VERSION__ === 'string' ? __CHENGYING_VERSION__ : 'dev'
const CATALOG_VERSION = 2

const STAGE_OPTIONS: ParamSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    seed: { type: 'integer', minimum: 0, maximum: 1_000_000, default: 1, description: 'seed for stochastic operators (grain)' },
  },
}

export class BuiltinEngine implements EngineAdapter {
  readonly id = 'builtin'
  readonly title = 'Chengying built-in'
  private cached: Catalog | undefined

  async probe(): Promise<EngineProbe> {
    return { id: this.id, available: true, version: VERSION, mode: 'registry', binaries: {}, fingerprint: fingerprintOf([VERSION, CATALOG_VERSION]), inputs: { raw: false, raster: true } }
  }

  async catalog(): Promise<Catalog> {
    if (this.cached !== undefined) return this.cached
    const operations: OperationSpec[] = BUILTIN_OPS.map(o => ({
      id: o.id,
      title: o.title,
      description: o.description + (o.geometry ? ' (geometry: applied after tone/color operators, in step order)' : ''),
      category: o.category,
      version: 1,
      params: o.params,
      masks: o.maskable ? ['parametric', 'drawn'] : [],
      multiInstance: true,
      tags: o.geometry ? ['geometry'] : [],
    }))
    this.cached = {
      engine: this.id,
      engineVersion: VERSION,
      catalogVersion: CATALOG_VERSION,
      fingerprint: (await this.probe()).fingerprint as string,
      source: 'registry',
      discoveredAt: nowIso(),
      operations,
      stageOptions: STAGE_OPTIONS,
      maskModel: {
        drawn: ['circle', 'ellipse', 'rectangle', 'gradient', 'polygon', 'brush'],
        parametric: ['luminance', 'hue', 'saturation', 'value', 'red', 'green', 'blue', 'lab_a', 'lab_b'],
        combine: 'drawn × parametric (intersection) or union; feather/blur/invert/opacity on the result',
      },
      notes: ['raster input only: RAW sources are developed by darktable/RawTherapee first, or fall back to the camera JPEG / embedded preview'],
      coverage: coverageOf(operations, ['masks on every non-geometry operator'], []),
    }
    return this.cached
  }

  validateStep(step: EditStep, catalog: Catalog): ValidatedStep {
    return validateWithCatalog(step, catalog, { fill: true })
  }

  validateStageOptions(options: Record<string, unknown> | undefined): { options: Record<string, unknown>; warnings: string[] } {
    const r = normalizeParams(STAGE_OPTIONS, options ?? {}, true)
    return { options: r.value, warnings: r.warnings }
  }

  async render(req: RenderRequest, catalog: Catalog): Promise<RenderResult> {
    if (req.inputKind === 'raw') throw new ChengyingError('unsupported', 'the built-in engine cannot decode RAW; develop it with darktable/RawTherapee first or use the camera JPEG')
    const started = Date.now()
    const warnings: string[] = []
    const opts = this.validateStageOptions(req.stage.options).options
    let img = await loadImage(req.input, req.maxEdge)
    const ctx: OpContext = { readable: req.readable ?? ((p: string) => p), seed: Number(opts.seed ?? 1) }
    const steps = req.stage.steps.filter(s => s.enabled)
    const ops = new Map(BUILTIN_OPS.map(o => [o.id, o]))
    const ordered = [...steps.filter(s => !ops.get(s.op)?.geometry), ...steps.filter(s => ops.get(s.op)?.geometry)]
    for (const s of ordered) {
      req.signal?.throwIfAborted()
      const { step, warnings: w } = this.validateStep(s, catalog)
      warnings.push(...w)
      const op = ops.get(step.op)
      if (op === undefined) throw new ChengyingError('invalid-argument', `unknown builtin operation ${step.op}`)
      const after = op.apply(img, step.params, ctx)
      img = step.mask !== undefined && op.maskable ? blendWithMask(img, after, rasterizeMask(step.mask, img)) : after
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
}
