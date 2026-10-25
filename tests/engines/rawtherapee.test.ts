import { beforeAll, describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { join } from 'node:path'
import { RawTherapeeEngine } from '../../src/core/edit/engines/rawtherapee/index.ts'
import type { Catalog } from '../../src/core/edit/engine.ts'
import type { EditStep } from '../../src/core/types.ts'
import { freshDir, rawFixture } from '../helpers/fixtures.ts'

const engine = new RawTherapeeEngine({ workDir: join(process.cwd(), '.test-tmp', 'rt-engine'), cli: process.env.CHENGYING_RAWTHERAPEE_CLI })
const raw = rawFixture('20170902_0047.NEF')
let available = false
let catalog: Catalog
let dir: string

beforeAll(async () => {
  available = (await engine.probe()).available && raw !== undefined
  if (!available) return
  catalog = await engine.catalog({ refresh: true })
  dir = await freshDir('rt-render')
})

const st = (op: string, params: Record<string, unknown>): EditStep => ({ id: `${op}${Math.random()}`, op, params, enabled: true })
async function render(name: string, steps: EditStep[]): Promise<{ path: string; mean: number; width: number; height: number }> {
  const r = await engine.render({ input: raw as string, inputKind: 'raw', stage: { id: 's', engine: 'rawtherapee', steps }, output: join(dir, name), format: 'jpeg', maxEdge: 500, scratchDir: join(dir, 'scratch') }, catalog)
  const s = await sharp(r.output).stats()
  return { path: r.output, mean: s.channels.slice(0, 3).reduce((a, c) => a + c.mean, 0) / 3, width: r.width, height: r.height }
}

describe.skipIf(!process.env.CHENGYING_RAWTHERAPEE_CLI && !process.env.CI_RAWTHERAPEE)('RawTherapee engine (real binary)', () => {
  it('discovers every pp3 section and key, including local adjustment spots', () => {
    if (!available) return
    expect(catalog.operations.length).toBeGreaterThanOrEqual(50)
    expect(catalog.coverage.parameters).toBeGreaterThan(1500)
    const exp = catalog.operations.find(o => o.id === 'Exposure')
    expect(exp?.params.properties?.Compensation).toMatchObject({ type: 'number', minimum: -5, maximum: 12 })
    const spots = catalog.operations.find(o => o.id === 'Locallab')?.params.properties?.spots
    expect(Object.keys(spots?.items?.properties ?? {}).length).toBeGreaterThan(500)
  })

  it('renders global edits', async () => {
    if (!available) return
    const base = await render('base', [])
    const bright = await render('bright', [st('Exposure', { Compensation: 1.5 })])
    expect(bright.mean).toBeGreaterThan(base.mean + 12)
    const bw = await render('bw', [st('Black & White', { Enabled: true })])
    const s = await sharp(bw.path).stats()
    expect(Math.abs((s.channels[0]?.mean ?? 0) - (s.channels[2]?.mean ?? 0))).toBeLessThan(3)
    const crop = await render('crop', [st('Crop', { Enabled: true, X: 0, Y: 0, W: 1000, H: 1000, FixedRatio: false })])
    expect(Math.abs(crop.width - crop.height)).toBeLessThan(3)
  })

  it('applies a local adjustment spot only inside the spot', async () => {
    if (!available) return
    const base = await render('spot-base', [])
    const spot = await render('spot', [st('Locallab', { spots: [{ Shape: 'ELI', SpotMethod: 'norm', CenterX: -500, CenterY: 0, Loc: '200;200;300;300;', Transit: 20, Expexpose: true, Expcomp: 2 }] })])
    const region = async (p: string, x: number): Promise<number> => {
      const m = await sharp(p).metadata()
      const { data } = await sharp(p).extract({ left: Math.floor(x * (m.width ?? 1)), top: Math.floor(0.45 * (m.height ?? 1)), width: 20, height: 20 }).greyscale().raw().toBuffer({ resolveWithObject: true })
      return data.reduce((a, b) => a + b, 0) / data.length
    }
    expect((await region(spot.path, 0.24)) - (await region(base.path, 0.24))).toBeGreaterThan(10)
    expect(Math.abs((await region(spot.path, 0.8)) - (await region(base.path, 0.8)))).toBeLessThan(3)
  })

  it('round-trips pp3 recipes', async () => {
    if (!available) return
    const stage = { id: 's', engine: 'rawtherapee', steps: [st('Exposure', { Compensation: 0.7, Contrast: 15 }), st('Sharpening', { Enabled: true, Amount: 250 })] }
    const rec = await engine.recipe(stage, catalog)
    expect(rec.text).toContain('[Exposure]')
    const back = await engine.importRecipe(rec.text, catalog)
    expect(back.steps.find(s => s.op === 'Exposure')?.params).toMatchObject({ Compensation: 0.7, Contrast: 15 })
    expect(() => engine.validateStep(st('Exposure', { Compensaton: 1 }), catalog)).toThrow(/unknown parameter/)
  })
})
