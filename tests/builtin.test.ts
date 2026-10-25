import { beforeAll, describe, expect, it } from 'vitest'
import sharp, { type Metadata, type Stats } from 'sharp'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { BuiltinEngine } from '../src/core/edit/engines/builtin/index.ts'
import type { Catalog } from '../src/core/edit/engine.ts'
import type { EditStep } from '../src/core/types.ts'
import { freshDir, renderScene } from './helpers/fixtures.ts'

const engine = new BuiltinEngine()
let catalog: Catalog
let dir: string
let input: string

async function render(name: string, steps: EditStep[], maxEdge = 600): Promise<{ path: string; stats: Stats; meta: Metadata; hf: number }> {
  const r = await engine.render({ input, inputKind: 'raster', stage: { id: 's', engine: 'builtin', steps }, output: join(dir, name), format: 'jpeg', maxEdge, scratchDir: dir, readable: p => p }, catalog)
  const { data, info } = await sharp(r.output).greyscale().raw().toBuffer({ resolveWithObject: true })
  let hf = 0
  for (let i = 1; i < info.width * info.height - 1; i++) hf += Math.abs(2 * (data[i] as number) - (data[i - 1] as number) - (data[i + 1] as number))
  return { path: r.output, stats: await sharp(r.output).stats(), meta: await sharp(r.output).metadata(), hf: hf / (info.width * info.height) }
}
const st = (op: string, params: Record<string, unknown>, extra: Partial<EditStep> = {}): EditStep => ({ id: `${op}${Math.random()}`, op, params, enabled: true, ...extra })
const mean = (s: Stats): number => s.channels.slice(0, 3).reduce((a, c) => a + c.mean, 0) / 3

async function regionMean(path: string, x: number, y: number, w: number, h: number): Promise<number> {
  const m = await sharp(path).metadata()
  const { data } = await sharp(path).extract({ left: Math.floor(x * (m.width ?? 1)), top: Math.floor(y * (m.height ?? 1)), width: Math.max(1, Math.floor(w * (m.width ?? 1))), height: Math.max(1, Math.floor(h * (m.height ?? 1))) }).greyscale().raw().toBuffer({ resolveWithObject: true })
  return data.reduce((a, b) => a + b, 0) / data.length
}

beforeAll(async () => {
  dir = await freshDir('builtin')
  input = join(dir, 'in.jpg')
  await renderScene({ sky: ['#4a78b8', '#c9d8ee'], ground: '#4b6b2f', sun: { x: 0.75, y: 0.25, r: 0.05, color: '#fff3c4' }, seed: 11 }, input)
  catalog = await engine.catalog()
})

describe('built-in engine', () => {
  it('publishes a schema for every operator', () => {
    expect(catalog.operations.length).toBeGreaterThanOrEqual(20)
    for (const op of catalog.operations) expect(op.params.type).toBe('object')
    expect(catalog.coverage.parameters).toBeGreaterThan(60)
  })

  it('renders every operator at its defaults and with a non-trivial setting', async () => {
    const base = await render('base', [])
    const variants: Record<string, Record<string, unknown>> = {
      exposure: { ev: 1 }, white_balance: { temperature: 40 }, tone: { contrast: 40, shadows: 30 }, curve: { points: [[0, 0], [0.5, 0.65], [1, 1]] },
      levels: { black: 0.1, gamma: 1.3 }, saturation: { saturation: 40, vibrance: 30 }, hsl: { blue: { hue: 0, saturation: 50, luminance: -30 } },
      color_grading: { shadows: { hue: 200, saturation: 40 }, highlights: { hue: 40, saturation: 40 } }, channel_mixer: { matrix: [[0.9, 0.1, 0], [0, 1, 0], [0, 0.2, 0.8]] },
      black_white: {}, clarity: { amount: 60 }, dehaze: { amount: 50 }, denoise: { luminance: 50, chroma: 50 }, sharpen: { amount: 150 },
      vignette: { amount: -60 }, grain: { amount: 50 }, auto_tone: { strength: 80 }, heal: { spots: [{ x: 0.75, y: 0.25, r: 0.04 }] },
      rotate: { angle: 5 }, perspective: { vertical: 30 }, crop: { aspect: '1:1' }, flip: { horizontal: true, quarter_turns: 1 },
    }
    for (const op of catalog.operations) {
      if (op.id === 'lut3d') continue
      const r = await render(`op-${op.id}`, [st(op.id, variants[op.id] ?? {})])
      expect(r.meta.width, op.id).toBeGreaterThan(50)
      const changed = Math.abs(mean(r.stats) - mean(base.stats)) > 0.3 || r.meta.width !== base.meta.width || r.meta.height !== base.meta.height
        || Math.abs((r.stats.channels[0]?.stdev ?? 0) - (base.stats.channels[0]?.stdev ?? 0)) > 0.3
        || Math.abs(r.hf - base.hf) > 0.3
      if (variants[op.id] !== undefined && op.id !== 'denoise') expect(changed, `${op.id} had no visible effect`).toBe(true)
    }
  }, 300_000)

  it('denoise reduces high-frequency noise', async () => {
    const noisy = join(dir, 'noisy.jpg')
    await renderScene({ sky: ['#4a78b8', '#c9d8ee'], ground: '#4b6b2f', seed: 12 }, noisy, 'noisy')
    const saved = input
    input = noisy
    try {
      const hf = async (p: string): Promise<number> => {
        const { data, info } = await sharp(p).greyscale().raw().toBuffer({ resolveWithObject: true })
        let e = 0
        for (let i = 1; i < info.width * info.height - 1; i++) e += Math.abs(2 * (data[i] as number) - (data[i - 1] as number) - (data[i + 1] as number))
        return e / (info.width * info.height)
      }
      const before = await render('dn-before', [])
      const after = await render('dn-after', [st('denoise', { luminance: 70, chroma: 60 })])
      expect(await hf(after.path)).toBeLessThan((await hf(before.path)) * 0.7)
    } finally {
      input = saved
    }
  })

  it('applies a 3D LUT', async () => {
    const cube = join(dir, 'invert.cube')
    const size = 2
    const lines = ['LUT_3D_SIZE 2']
    for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++) lines.push(`${1 - r} ${1 - g} ${1 - b}`)
    await writeFile(cube, lines.join('\n'))
    const base = await render('lut-base', [])
    const inv = await render('lut-inv', [st('lut3d', { file: cube, strength: 1 })])
    expect(Math.abs(mean(inv.stats) + mean(base.stats) - 255)).toBeLessThan(25)
  })

  it('confines masked edits to drawn and parametric masks', async () => {
    const base = await render('m-base', [])
    const circle = await render('m-circle', [st('exposure', { ev: 2 }, { mask: { shapes: [{ type: 'circle', cx: 0.25, cy: 0.75, r: 0.1, feather: 0.01 }] } })])
    const inDelta = (await regionMean(circle.path, 0.22, 0.72, 0.06, 0.06)) - (await regionMean(base.path, 0.22, 0.72, 0.06, 0.06))
    const outDelta = (await regionMean(circle.path, 0.7, 0.72, 0.06, 0.06)) - (await regionMean(base.path, 0.7, 0.72, 0.06, 0.06))
    expect(inDelta).toBeGreaterThan(20)
    expect(Math.abs(outDelta)).toBeLessThan(2)
    const sky = await render('m-sky', [st('exposure', { ev: -1 }, { mask: { parametric: [{ channel: 'hue', from: 190, to: 250, softness: 10 }, { channel: 'saturation', from: 0.15, to: 1 }] } })])
    expect((await regionMean(sky.path, 0.1, 0.05, 0.2, 0.1)) - (await regionMean(base.path, 0.1, 0.05, 0.2, 0.1))).toBeLessThan(-10)
    const grad = await render('m-grad', [st('exposure', { ev: -1.5 }, { mask: { shapes: [{ type: 'gradient', x0: 0.5, y0: 0, x1: 0.5, y1: 0.5 }] } })])
    expect((await regionMean(grad.path, 0, 0, 1, 0.1)) - (await regionMean(base.path, 0, 0, 1, 0.1))).toBeLessThan(-10)
    expect(Math.abs((await regionMean(grad.path, 0, 0.8, 1, 0.2)) - (await regionMean(base.path, 0, 0.8, 1, 0.2)))).toBeLessThan(2)
  })

  it('validates parameters against the schema', () => {
    expect(() => engine.validateStep(st('exposure', { evv: 1 }), catalog)).toThrow(/unknown parameter/)
    expect(engine.validateStep(st('exposure', { ev: 99 }), catalog).step.params.ev).toBe(6)
    expect(() => engine.validateStep(st('crop', {}, { mask: { shapes: [] } }), catalog)).toThrow(/does not support masks/)
  })
})

describe('float image I/O', () => {
  it('round-trips 16-bit TIFF/PNG and 8-bit JPEG without corrupting pixels', async () => {
    const { saveImage, loadImage } = await import('../src/core/edit/engines/builtin/image.ts')
    const { freshDir } = await import('./helpers/fixtures.ts')
    const dir = await freshDir('io')
    const w = 97; const h = 61
    const data = new Float32Array(w * h * 3)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3
      data[i] = x / w; data[i + 1] = y / h; data[i + 2] = ((x * 7 + y * 3) % 50) / 50
    }
    const img = { width: w, height: h, data }
    for (const [fmt, depth, tol] of [['tiff', 16, 0.001], ['png', 16, 0.001], ['png', 8, 0.01], ['jpeg', 8, 0.06]] as const) {
      const p = `${dir}/io-${fmt}-${depth}.${fmt === 'jpeg' ? 'jpg' : fmt === 'tiff' ? 'tif' : 'png'}`
      await saveImage(img, p, fmt, 95, depth)
      const back = await loadImage(p)
      expect([back.width, back.height]).toEqual([w, h])
      let err = 0
      for (let i = 0; i < data.length; i++) err += Math.abs((back.data[i] as number) - (data[i] as number))
      expect(err / data.length, `${fmt}/${depth}`).toBeLessThan(tol)
    }
  })
})
