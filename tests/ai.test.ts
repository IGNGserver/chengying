import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import sharp from 'sharp'
import { ExifTool } from 'exiftool-vendored'
import { Project } from '../src/core/project.ts'
import { EngineRegistry } from '../src/core/edit/registry.ts'
import { EditService } from '../src/core/edit/service.ts'
import { exportPhotos } from '../src/core/export/exporter.ts'
import { inpaintTelea, applyStyle, styleFingerprint } from '../src/core/edit/engines/ai/classical.ts'
import type { FImage } from '../src/core/edit/engines/builtin/image.ts'
import { buildTravelWorkspace, freshDir } from './helpers/fixtures.ts'

/** Smooth gradient with fine texture, 240×160. */
function gradient(w = 240, h = 160): FImage {
  const data = new Float32Array(w * h * 3)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const t = 0.05 * Math.sin(x * 0.7) * Math.sin(y * 0.9)
    const i = (y * w + x) * 3
    data[i] = 0.2 + 0.5 * x / w + t; data[i + 1] = 0.3 + 0.3 * y / h + t; data[i + 2] = 0.4 + t
  }
  return { width: w, height: h, data }
}

describe('classical AI operators', () => {
  it('Telea inpainting fills a blemish from its surroundings', () => {
    const clean = gradient()
    const dirty = { ...clean, data: new Float32Array(clean.data) }
    const mask = new Float32Array(clean.width * clean.height)
    for (let y = 0; y < clean.height; y++) for (let x = 0; x < clean.width; x++) {
      if ((x - 120) ** 2 + (y - 80) ** 2 <= 10 ** 2) {
        mask[y * clean.width + x] = 1
        for (let c = 0; c < 3; c++) dirty.data[(y * clean.width + x) * 3 + c] = 0
      }
    }
    const out = inpaintTelea(dirty, mask, 6)
    let errIn = 0; let errDirty = 0; let n = 0; let errOut = 0; let m = 0
    for (let i = 0; i < mask.length; i++) {
      for (let c = 0; c < 3; c++) {
        const d = Math.abs((out.data[i * 3 + c] as number) - (clean.data[i * 3 + c] as number))
        if ((mask[i] as number) > 0.5) { errIn += d; errDirty += Math.abs((dirty.data[i * 3 + c] as number) - (clean.data[i * 3 + c] as number)); n++ } else { errOut += d; m++ }
      }
    }
    expect(errIn / n).toBeLessThan(0.05)
    expect(errIn / n).toBeLessThan(errDirty / n / 8)
    expect(errOut / m).toBeLessThan(1e-4) // pixels outside the mask are untouched
  })

  it('style match moves colour and tone statistics towards the reference', () => {
    const cool = gradient()
    const warm: FImage = { ...cool, data: cool.data.map((v, i) => (i % 3 === 0 ? v * 1.6 : i % 3 === 2 ? v * 0.5 : v * 1.1)) }
    const ref = styleFingerprint(warm)
    const before = styleFingerprint(cool)
    const after = styleFingerprint(applyStyle(cool, ref, { strength: 1, color: true, tone: true, maxShift: 60 }))
    expect(Math.abs(after.mean[2] - ref.mean[2])).toBeLessThan(Math.abs(before.mean[2] - ref.mean[2]) * 0.3)
    // The default cap keeps unification gentle, and neutral whites stay neutral.
    const gentle = styleFingerprint(applyStyle(cool, ref, { strength: 1, color: true, tone: false }))
    expect(Math.abs(gentle.mean[2] - before.mean[2])).toBeLessThanOrEqual(15.5)
    const white: FImage = { width: 4, height: 1, data: new Float32Array([1, 1, 1, 0.98, 0.98, 0.98, 0.2, 0.3, 0.4, 0.5, 0.2, 0.1]) }
    const w2 = applyStyle(white, ref, { strength: 1, color: true, tone: false, maxShift: 60 })
    expect(Math.abs((w2.data[0] as number) - (w2.data[2] as number))).toBeLessThan(0.02)
    expect(Math.abs((after.quantiles[10] as number) - (ref.quantiles[10] as number))).toBeLessThan(Math.abs((before.quantiles[10] as number) - (ref.quantiles[10] as number)) * 0.3 + 0.5)
    const half = styleFingerprint(applyStyle(cool, ref, { strength: 0.5, color: true, tone: false }))
    expect(half.mean[2]).toBeGreaterThan(before.mean[2])
    expect(half.mean[2]).toBeLessThan(after.mean[2])
  })
})

describe('AI stage in the editing pipeline', () => {
  let root: string
  let state: string
  let project: Project
  let edit: EditService
  let taskA: string
  let taskB: string
  let tool: string
  const et = new ExifTool({ taskTimeoutMillis: 20000 })

  beforeAll(async () => {
    root = await freshDir('ai-ws')
    state = await freshDir('ai-state')
    tool = await freshDir('ai-tools')
    await buildTravelWorkspace(root)
    project = Project.open(root, { stateRoot: state })
    await project.scan()
    await project.buildPreviews()
    await project.analyze()
    const sharpPath = pathToFileURL(createRequire(join(process.cwd(), 'package.json')).resolve('sharp')).href
    // Fake super-resolution CLI (Real-ESRGAN-style arguments): Lanczos ×scale plus a marker pixel row.
    writeFileSync(join(tool, 'fake-sr.mjs'), `import sharp from ${JSON.stringify(sharpPath)}
const a = process.argv.slice(2); const i = a[a.indexOf('-i') + 1]; const o = a[a.indexOf('-o') + 1]; const s = Number(a[a.indexOf('-s') + 1])
const m = await sharp(i).metadata()
await sharp(i).resize(m.width * s, m.height * s, { kernel: 'lanczos3' }).png().toFile(o)
`)
    // Fake generative provider: paints the masked area flat magenta (easy to detect).
    writeFileSync(join(tool, 'fake-gen.mjs'), `import sharp from ${JSON.stringify(sharpPath)}
const [input, mask, output, prompt] = process.argv.slice(2)
if (!prompt) process.exit(3)
const m = await sharp(input).metadata()
await sharp({ create: { width: m.width, height: m.height, channels: 3, background: '#ff00ff' } }).png().toFile(output)
`)
    const registry = new EngineRegistry(join(state, 'engines'), {
      darktable: { enabled: false }, rawtherapee: { enabled: false },
      ai: { superResolution: { command: process.execPath, args: [join(tool, 'fake-sr.mjs'), '-i', '{input}', '-o', '{output}', '-s', '{scale}'] }, providers: [{ id: 'fake', type: 'command' }] },
    })
    edit = new EditService(project, registry)
    edit.authorize = async (engine, step) => {
      if (engine !== 'ai' || !step.op.startsWith('gen_')) return undefined
      return project.repo.authorizations().some(a => a.id === step.params.authorization) ? undefined : 'no authorization'
    }
    const { selectionId } = project.select({ count: 2 })
    const r = await edit.createTasks({ selectionId, instructions: 'ai stage test', extraStages: [{ engine: 'ai' }] })
    taskA = r.created[0]?.id as string
    taskB = r.created[1]?.id as string
  }, 120_000)

  afterAll(async () => { await project?.close(); await et.end() })

  it('exposes a discovered AI catalog with schemas', async () => {
    const cat = await edit.engines.catalog('ai')
    const ids = cat.operations.map(o => o.id)
    expect(ids).toEqual(expect.arrayContaining(['upscale', 'inpaint', 'style_match', 'gen_layer']))
    expect(cat.coverage.unsupported).toHaveLength(0)
    expect(cat.operations.find(o => o.id === 'inpaint')?.masks).toContain('drawn')
  })

  it('upscales with the model CLI on export and caps previews', async () => {
    await edit.applyOps(taskA, [{ op: 'add_step', stage: 'ai', step: { op: 'upscale', params: { scale: 2, method: 'model' } } }], { author: 'test' })
    const preview = await edit.render(taskA, { maxEdge: 600 })
    expect(Math.max(preview.width, preview.height)).toBeLessThanOrEqual(600)
    const full = await edit.render(taskA, { output: project.path('renders', 'sr-full.jpg') })
    const shot = project.repo.shot(project.repo.task(taskA)?.shotId as string)
    expect(full.width).toBe((shot?.width as number) * 2)
    expect(full.height).toBe((shot?.height as number) * 2)
  }, 120_000)

  it('removes a masked distraction non-generatively and keeps the rest', async () => {
    const before = await edit.render(taskB, { maxEdge: 800, format: 'png' })
    await edit.applyOps(taskB, [{ op: 'add_step', stage: 'ai', step: { op: 'inpaint', params: { radius: 5 }, mask: { shapes: [{ type: 'circle', cx: 0.5, cy: 0.5, r: 0.03 }] } } }], { author: 'test' })
    const after = await edit.render(taskB, { maxEdge: 800, format: 'png' })
    const a = await sharp(before.path).raw().toBuffer({ resolveWithObject: true })
    const b = await sharp(after.path).raw().toBuffer({ resolveWithObject: true })
    let far = 0; let n = 0
    const { width: w, height: h, channels: ch } = a.info
    for (let y = 0; y < h; y += 4) for (let x = 0; x < w; x += 4) {
      if (Math.hypot(x / w - 0.5, (y / h - 0.5) * h / w) < 0.1) continue
      const i = (y * w + x) * ch
      far += Math.abs((a.data[i] as number) - (b.data[i] as number)); n++
    }
    expect(far / n).toBeLessThan(1.5)
    await expect(edit.applyOps(taskB, [{ op: 'add_step', stage: 'ai', step: { op: 'inpaint', params: {} } }], { author: 'test' })).rejects.toThrow(/needs a mask/)
  }, 120_000)

  it('records a style reference and applies it as a revertible step', async () => {
    const ref = await edit.styleReference({ taskId: taskA })
    expect(ref.fingerprint.quantiles).toHaveLength(21)
    const r = await edit.applyOps(taskB, [{ op: 'add_step', stage: 'ai', step: { op: 'style_match', params: { fingerprint: ref.fingerprint, strength: 0.5 } } }], { author: 'test' })
    expect(r.revision.doc.stages.at(-1)?.steps.map(s => s.op)).toEqual(['inpaint', 'style_match'])
    const out = await edit.render(taskB, { maxEdge: 400 })
    expect(out.width).toBeGreaterThan(0)
  }, 120_000)

  it('creates generative layers only with an authorization and tags the export', async () => {
    // A forged layer without a real authorization is refused at render time.
    await edit.applyOps(taskB, [{ op: 'add_step', stage: 'ai', step: { op: 'gen_layer', params: { asset: join(state, 'nope.png'), authorization: 'auth_fake' } } }], { author: 'test' })
    await expect(edit.render(taskB, { maxEdge: 300 })).rejects.toThrow(/no authorization/)
    edit.undo(taskB, 'test')

    const shotId = project.repo.task(taskB)?.shotId as string
    const auth = project.repo.addAuthorization({ scope: 'generative', shotId, taskId: null, grantedBy: 'user (test)', note: '', expiresAt: null, maxUses: 1 })
    const provider = { id: 'fake', type: 'command' as const, command: process.execPath, args: [join(tool, 'fake-gen.mjs'), '{input}', '{mask}', '{output}', '{prompt}'] }
    const g = await edit.generate(taskB, { provider, kind: 'fill', prompt: 'clear blue sky', mask: { shapes: [{ type: 'rectangle', x: 0, y: 0, w: 0.25, h: 0.25 }] }, authorizationId: auth, author: 'test', maxEdge: 800 })
    expect(g.revision.doc.provenance?.generative).toBe(true)
    expect(g.revision.doc.provenance?.authorizationIds).toContain(auth)
    const out = await edit.render(taskB, { maxEdge: 800, format: 'png' })
    const px = await sharp(out.path).raw().toBuffer({ resolveWithObject: true })
    const at = (fx: number, fy: number): number[] => { const i = (Math.floor(fy * px.info.height) * px.info.width + Math.floor(fx * px.info.width)) * px.info.channels; return [px.data[i] as number, px.data[i + 1] as number, px.data[i + 2] as number] }
    expect(at(0.1, 0.1)[0]).toBeGreaterThan(200)
    expect(at(0.1, 0.1)[1]).toBeLessThan(60)
    expect(at(0.7, 0.7)[1]).toBeGreaterThan(at(0.1, 0.1)[1] as number) // outside the mask: the photo

    const ex = await exportPhotos(project, edit, { taskIds: [taskA, taskB], subdir: 'ai1', maxEdge: 1200 })
    expect(ex.exported).toBe(2)
    expect(ex.verifiedAll).toBe(true)
    const gen = ex.items.find(i => i.taskId === taskB)
    const plain = ex.items.find(i => i.taskId === taskA)
    expect(gen?.generative).toBe(true)
    expect(plain?.generative).toBe(false)
    const tags = await et.read(gen?.path as string) as Record<string, unknown>
    expect(String(tags.DigitalSourceType)).toContain('compositeWithTrainedAlgorithmicMedia')
    const plainTags = await et.read(plain?.path as string) as Record<string, unknown>
    expect(plainTags.DigitalSourceType).toBeUndefined()

    // Reverting the generative layer removes the generated-content tag.
    edit.undo(taskB, 'test')
    const ex2 = await exportPhotos(project, edit, { taskIds: [taskB], subdir: 'ai2', maxEdge: 600 })
    expect(ex2.items[0]?.generative).toBe(false)
  }, 240_000)
})
