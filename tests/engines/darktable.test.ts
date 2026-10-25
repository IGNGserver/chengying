import { beforeAll, describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { join } from 'node:path'
import { DarktableEngine } from '../../src/core/edit/engines/darktable/index.ts'
import type { Catalog } from '../../src/core/edit/engine.ts'
import type { EditStage, EditStep } from '../../src/core/types.ts'
import { freshDir, rawFixture } from '../helpers/fixtures.ts'

const engine = new DarktableEngine({ workDir: join(process.cwd(), '.test-tmp', 'dt-engine'), cli: process.env.CHENGYING_DARKTABLE_CLI })
const raw = rawFixture('20170902_0047.NEF')
let available = false
let catalog: Catalog
let dir: string

beforeAll(async () => {
  available = (await engine.probe()).available && raw !== undefined
  if (!available) return
  catalog = await engine.catalog({ refresh: true })
  dir = await freshDir('dt-render')
})

const stage = (steps: EditStep[], options: Record<string, unknown> = {}): EditStage => ({ id: 'st', engine: 'darktable', steps, options })
const step = (op: string, params: Record<string, unknown>, extra: Partial<EditStep> = {}): EditStep => ({ id: `${op}-${Math.random()}`, op, params, enabled: true, ...extra })

async function render(name: string, s: EditStage, maxEdge = 600): Promise<{ path: string; region: (x: number, y: number, w: number, h: number) => Promise<number> }> {
  const r = await engine.render({ input: raw as string, inputKind: 'raw', stage: s, output: join(dir, name), format: 'jpeg', maxEdge, scratchDir: join(dir, 'scratch') }, catalog)
  const meta = await sharp(r.output).metadata()
  return {
    path: r.output,
    region: async (x, y, w, h) => {
      const W = meta.width ?? 1
      const H = meta.height ?? 1
      const { data } = await sharp(r.output).extract({ left: Math.floor(x * W), top: Math.floor(y * H), width: Math.max(1, Math.floor(w * W)), height: Math.max(1, Math.floor(h * H)) }).greyscale().raw().toBuffer({ resolveWithObject: true })
      let s = 0
      for (const v of data) s += v
      return s / data.length
    },
  }
}

describe.skipIf(!process.env.CHENGYING_DARKTABLE_CLI && !process.env.CI_DARKTABLE)('darktable engine (real binaries)', () => {
  it('discovers every module with schemas from the installed binaries', () => {
    if (!available) return
    expect(catalog.operations.length).toBeGreaterThanOrEqual(80)
    expect(catalog.coverage.parameters).toBeGreaterThan(500)
    const exposure = catalog.operations.find(o => o.id === 'exposure')
    expect(exposure?.params.properties?.exposure).toMatchObject({ type: 'number', minimum: -18, maximum: 18 })
    expect(exposure?.params.properties?.mode?.enum).toContain('EXPOSURE_MODE_MANUAL')
    expect(exposure?.masks).toContain('drawn')
    const cb = catalog.operations.find(o => o.id === 'colorbalancergb')
    expect(Object.keys(cb?.params.properties ?? {}).length).toBeGreaterThan(25)
    expect(catalog.maskModel?.supported).toBe(true)
  })

  it('renders exposure changes', async () => {
    if (!available) return
    const base = await render('base', stage([]))
    const bright = await render('bright', stage([step('exposure', { exposure: 2 })]))
    expect(await bright.region(0, 0, 1, 1)).toBeGreaterThan(await base.region(0, 0, 1, 1) + 15)
  })

  it('places a drawn circle mask where requested', async () => {
    if (!available) return
    const base = await render('mask-base', stage([]))
    const masked = await render('mask-circle', stage([step('exposure', { exposure: 3 }, { mask: { shapes: [{ type: 'circle', cx: 0.25, cy: 0.5, r: 0.12, feather: 0.01 }] } })]))
    const inside = (await masked.region(0.23, 0.48, 0.04, 0.04)) - (await base.region(0.23, 0.48, 0.04, 0.04))
    const outside = (await masked.region(0.7, 0.46, 0.08, 0.08)) - (await base.region(0.7, 0.46, 0.08, 0.08))
    expect(inside).toBeGreaterThan(20)
    expect(Math.abs(outside)).toBeLessThan(4)
  })

  it('applies parametric (luminance) masks', async () => {
    if (!available) return
    const base = await render('par-base', stage([]))
    const shadows = await render('par-shadows', stage([step('exposure', { exposure: 2.5 }, { mask: { parametric: [{ channel: 'luminance', from: 0, to: 0.08, softness: 0.04 }] } })]))
    const full = await render('par-full', stage([step('exposure', { exposure: 2.5 })]))
    const b = await base.region(0, 0, 1, 1)
    const s = await shadows.region(0, 0, 1, 1)
    const f = await full.region(0, 0, 1, 1)
    expect(s).toBeGreaterThan(b + 1)
    expect(s).toBeLessThan(f - 3)
  })

  it('supports multiple instances of one module', async () => {
    if (!available) return
    const one = await render('inst-one', stage([step('exposure', { exposure: 1 })]))
    const two = await render('inst-two', stage([step('exposure', { exposure: 1 }), step('exposure', { exposure: 1 }, { instance: 1, label: 'second' })]))
    expect(await two.region(0, 0, 1, 1)).toBeGreaterThan(await one.region(0, 0, 1, 1) + 8)
  })

  it('round-trips recipes through XMP import', async () => {
    if (!available) return
    const s = stage([step('exposure', { exposure: 1.25, black: 0.01 }), step('colorbalancergb', { saturation_global: 0.2, contrast: 0.1 })])
    const rec = await engine.recipe(s, catalog, { kind: 'raw' })
    expect(rec.text).toContain('darktable:operation="colorbalancergb"')
    const imported = await engine.importRecipe(rec.text, catalog)
    expect(imported.steps.map(x => x.op)).toEqual(['exposure', 'colorbalancergb'])
    expect(imported.steps[0]?.params.exposure).toBeCloseTo(1.25, 5)
    expect(imported.steps[1]?.params.saturation_global).toBeCloseTo(0.2, 5)
  })

  it('rejects unknown parameters with the valid names', () => {
    if (!available) return
    expect(() => engine.validateStep(step('exposure', { exposur: 1 }), catalog)).toThrow(/valid: .*exposure/)
    expect(() => engine.validateStep(step('nosuchmodule', {}), catalog)).toThrow(/unknown darktable operation|unknown darktable module/)
    const v = engine.validateStep(step('exposure', { exposure: 40, mode: 'manual' }), catalog)
    expect(v.step.params.exposure).toBe(18)
    expect(v.step.params.mode).toBe('EXPOSURE_MODE_MANUAL')
    expect(v.warnings.join()).toMatch(/clamped/)
  })
})
