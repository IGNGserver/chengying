import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { copyFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { computeFeatures } from '../src/core/analysis/pixels.ts'
import { potentialScore, technicalScore } from '../src/core/analysis/scoring.ts'
import { createModelScorer } from '../src/core/analysis/models.ts'
import { decodeParams, encodeParams, expandCurveSugar, normalizeDarktableParams, paramsSchema, type DtModule } from '../src/core/edit/engines/darktable/codec.ts'
import { RawTherapeeEngine } from '../src/core/edit/engines/rawtherapee/index.ts'
import { BuiltinEngine } from '../src/core/edit/engines/builtin/index.ts'
import { BUILTIN_OPS } from '../src/core/edit/engines/builtin/ops.ts'
import { saveImage, type FImage } from '../src/core/edit/engines/builtin/image.ts'
import { Project } from '../src/core/project.ts'
import type { Catalog } from '../src/core/edit/engine.ts'
import { EngineRegistry } from '../src/core/edit/registry.ts'
import { EditService, imageStats } from '../src/core/edit/service.ts'
import { exportPhotos } from '../src/core/export/exporter.ts'
import { ChengyingRuntime } from '../src/dsh/runtime.ts'
import { resolveConfig } from '../src/dsh/config.ts'
import { selectVlmCandidates, cullTools } from '../src/dsh/tools/cull.ts'
import { taskManagementTools, taskTools } from '../src/dsh/tools/edit.ts'
import { aiTools } from '../src/dsh/tools/ai.ts'
import { buildRouter } from '../src/dsh/http.ts'
import { EditOrchestrator } from '../src/dsh/orchestrator.ts'
import { defaultPlan, writePlan } from '../src/dsh/plan.ts'
import type { HostContext, ToolRunContext } from '../src/dsh/host-types.ts'
import { buildTravelWorkspace, freshDir } from './helpers/fixtures.ts'

function stubCtx(): HostContext {
  return {
    get: () => undefined,
    effect: (fn: () => (() => void) | undefined | void) => fn(),
    inject: () => undefined,
    on: () => () => undefined,
    logger: () => console,
    tools: { register: () => () => undefined, restrict: () => () => undefined },
  } as unknown as HostContext
}

function execFor(ctx: HostContext, name: string, sessionId = 'align-session'): ToolRunContext {
  return {
    callId: 'call_align',
    name,
    arguments: {},
    signal: new AbortController().signal,
    agent: { id: 'agent_align', ctx, options: {}, session: { id: sessionId, requestHeader: () => ({}) } },
  }
}

function portraitSvg(opts: { eyesOpen: boolean; sharpFace?: boolean }): string {
  const eyes = opts.eyesOpen
    ? `<ellipse cx="225" cy="182" rx="16" ry="9" fill="#ffffff"/><circle cx="225" cy="182" r="7" fill="#181818"/><circle cx="223" cy="180" r="2" fill="#ffffff"/>
       <ellipse cx="287" cy="182" rx="16" ry="9" fill="#ffffff"/><circle cx="287" cy="182" r="7" fill="#181818"/><circle cx="285" cy="180" r="2" fill="#ffffff"/>`
    : `<line x1="210" y1="184" x2="240" y2="184" stroke="#b57c60" stroke-width="2"/>
       <line x1="272" y1="184" x2="302" y2="184" stroke="#b57c60" stroke-width="2"/>`
  const faceDetail = `<path d="M250 192 L245 225 L262 225" stroke="#9e6248" stroke-width="3" fill="none"/>
    <path d="M232 248 Q256 262 280 248" stroke="#a94438" stroke-width="4" fill="none"/>
    <rect x="206" y="160" width="36" height="4" fill="#3e2723"/><rect x="270" y="160" width="36" height="4" fill="#3e2723"/>`
  // Rich background grid texture
  let bg = ''
  for (let x = 0; x < 512; x += 16) bg += `<line x1="${x}" y1="0" x2="${x}" y2="512" stroke="#2c3e50" stroke-width="2"/>`
  for (let y = 0; y < 512; y += 16) bg += `<line x1="0" y1="${y}" x2="512" y2="${y}" stroke="#34495e" stroke-width="2"/>`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512">
    <rect width="512" height="512" fill="#1f2d3d"/>${bg}
    <ellipse cx="256" cy="210" rx="82" ry="102" fill="#e0a382" stroke="#8d553a" stroke-width="3"/>
    ${eyes}${faceDetail}
  </svg>`
}

describe('batch 1 · portrait detection, RAW headroom and burst comparison', () => {
  it('detects portrait face regions, suspected closed eyes, and tags people', async () => {
    const openBuf = await sharp(Buffer.from(portraitSvg({ eyesOpen: true }))).removeAlpha().raw().toBuffer({ resolveWithObject: true })
    const closedBuf = await sharp(Buffer.from(portraitSvg({ eyesOpen: false }))).removeAlpha().raw().toBuffer({ resolveWithObject: true })
    const fOpen = computeFeatures({ width: openBuf.info.width, height: openBuf.info.height, data: new Uint8Array(openBuf.data) })
    const fClosed = computeFeatures({ width: closedBuf.info.width, height: closedBuf.info.height, data: new Uint8Array(closedBuf.data) })

    expect(fOpen.subject?.faceRegions).toBeGreaterThanOrEqual(1)
    expect(fOpen.subject?.eyesClosedSuspected).toBe(false)
    expect(fClosed.subject?.faceRegions).toBeGreaterThanOrEqual(1)
    expect(fClosed.subject?.eyesClosedSuspected).toBe(true)

    const tOpen = technicalScore(fOpen, { isRaw: true, iso: 200 })
    const tClosed = technicalScore(fClosed, { isRaw: true, iso: 200 })
    expect(tOpen.tags).toContain('people')
    expect(tClosed.issues).toContain('eyes-closed')
    expect(tOpen.technical!).toBeGreaterThan(tClosed.technical! + 10)
  })

  it('distinguishes recoverable RAW headroom from unrecoverable 3-channel blowout', async () => {
    const dir = await freshDir('headroom')
    const recPath = join(dir, 'single-clip.png')
    const blownPath = join(dir, 'all-blown.png')
    // Single-channel clip (warm sunset highlight: R=255, G=170, B=90) vs all-channel white blowout (255,255,255)
    const w = 128; const h = 128
    const single = Buffer.alloc(w * h * 3)
    const blown = Buffer.alloc(w * h * 3)
    for (let i = 0; i < w * h; i++) {
      const hi = i < w * h * 0.28
      single[i * 3] = hi ? 255 : 110; single[i * 3 + 1] = hi ? 165 : 100; single[i * 3 + 2] = hi ? 85 : 90
      blown[i * 3] = hi ? 255 : 110; blown[i * 3 + 1] = hi ? 255 : 100; blown[i * 3 + 2] = hi ? 255 : 90
    }
    await sharp(single, { raw: { width: w, height: h, channels: 3 } }).png().toFile(recPath)
    await sharp(blown, { raw: { width: w, height: h, channels: 3 } }).png().toFile(blownPath)
    const fSingle = computeFeatures({ width: w, height: h, data: new Uint8Array(single) })
    const fBlown = computeFeatures({ width: w, height: h, data: new Uint8Array(blown) })
    const pSingle = potentialScore(fSingle, technicalScore(fSingle, { isRaw: true, iso: 100, bitsPerSample: 14 }), { isRaw: true, iso: 100, bitsPerSample: 14 })
    const pBlown = potentialScore(fBlown, technicalScore(fBlown, { isRaw: true, iso: 6400, bitsPerSample: 12 }), { isRaw: true, iso: 6400, bitsPerSample: 12 })
    expect(pSingle.detail?.highlightRecoverable).toBe(true)
    expect(pBlown.detail?.allChannelBlowout).toBe(true)
    expect(pSingle.potential!).toBeGreaterThan(pBlown.potential! + 15)

    // Built-in high-res scorer works out of the box with zero external dependencies
    const [scored] = await createModelScorer({ id: 'builtin-portrait', type: 'builtin', maxEdge: 512 }).score([recPath])
    expect(scored?.technical).toBeGreaterThan(0)
  })
})

describe('batches 2, 3 & 4 · sub-agent budgets, darktable curves, privacy & dual-source export', () => {
  let root: string
  let state: string
  let rt: ChengyingRuntime
  let project: Project

  beforeAll(async () => {
    root = await freshDir('align-ws')
    state = await freshDir('align-state')
    await buildTravelWorkspace(root)
    rt = new ChengyingRuntime(stubCtx(), resolveConfig({
      stateRoot: state,
      ui: { enabled: false, basePath: '/api/chengying' },
      engines: { darktable: { enabled: false }, rawtherapee: { enabled: false }, builtin: { enabled: true }, ai: { enabled: true } },
    }), console)
    project = rt.openProject(root, 'agent_align')
    await project.scan()
    await project.buildPreviews()
    await project.analyze()
  }, 120_000)

  afterAll(async () => {
    await rt?.close()
  })

  it('includes top contenders from near-duplicate bursts for VLM comparison and strips GPS for cloud', () => {
    const burst = project.groups('near').find(g => g.members.length >= 2)
    expect(burst).toBeDefined()
    const candidates = selectVlmCandidates(project, 10)
    // Both top-1 and top-2 of the burst are scheduled for VLM comparison
    expect(candidates).toContain(burst!.members[0]!.shotId)
    expect(candidates).toContain(burst!.members[1]!.shotId)

    const shotWithGps = project.repo.shots().find(s => s.gps !== null)!
    const localCtx = rt.shotContext(project, shotWithGps)
    const cloudCtx = rt.shotContext(project, shotWithGps, { forCloud: true })
    expect(localCtx).toMatch(/gps 30\./)
    expect(cloudCtx).not.toMatch(/gps 30\./)
    expect(cloudCtx).toMatch(/loc:|gps:redacted/)
  })

  it('supports scene-level briefs, anchor scheduling, revision budget caps, and status="unchanged"', async () => {
    writePlan(project, defaultPlan(project, 'align-session', root, { goal: 'retouch-deliver', retouch: 'hybrid', checkpoint: 'none' }))
    const scene = project.groups('scene').find(g => g.members.length >= 2)!
    const shotA = scene.members[0]!.shotId
    const shotB = scene.members[1]!.shotId

    const createTool = taskManagementTools(rt).find(t => t.name === 'edit_tasks_create')!
    const created = await createTool.execute({
      shots: [shotA, shotB],
      instructions: 'clean natural travel album',
      scene_instructions: { [scene.id]: 'warm golden sunset consistency' },
      max_revisions: 2,
      engine: 'builtin',
    }, execFor(stubCtx(), 'edit_tasks_create')) as { created: Array<{ id: string; shot: string; sceneAnchor?: boolean }> }

    expect(created.created).toHaveLength(2)
    expect(created.created.some(t => t.sceneAnchor === true)).toBe(true)

    const anchorTask = project.repo.tasks().find(t => t.shotId === shotA || t.shotId === shotB)!
    // Hybrid plan automatically appended the AI stage
    expect(rt.edit(project).head(anchorTask.id).doc.stages.map(s => s.engine)).toEqual(['builtin', 'ai'])

    const bound = taskTools(rt, { projectId: project.id, taskId: anchorTask.id })
    const apply = bound.find(t => t.name === 'edit_apply')!
    const finish = bound.find(t => t.name === 'edit_finish')!

    // Apply 2 revisions (reaching max_revisions: 2), verify 3rd is blocked by budget gate
    await apply.execute({ ops: [{ op: 'add_step', stage: 'builtin', step: { op: 'exposure', params: { ev: 0.3 } } }], preview: false }, execFor(stubCtx(), 'edit_apply'))
    await apply.execute({ ops: [{ op: 'add_step', stage: 'ai', step: { op: 'upscale', params: { scale: 1.5, method: 'auto' } } }], stage: 'ai', preview: true }, execFor(stubCtx(), 'edit_apply')).catch(async () =>
      await apply.execute({ ops: [{ op: 'add_step', stage: 'ai', step: { op: 'upscale', params: { scale: 1.5, method: 'auto' } } }], preview: true }, execFor(stubCtx(), 'edit_apply'))
    )

    await expect(
      apply.execute({ ops: [{ op: 'add_step', stage: 'builtin', step: { op: 'tone', params: { contrast: 10 } } }], preview: false }, execFor(stubCtx(), 'edit_apply')),
    ).rejects.toThrow(/revision budget reached/)

    // Finish anchor as succeeded; check sibling prompt receives scene anchor context + engine cheat sheet + copy_from_task hint
    await finish.execute({ summary: 'warmed golden light' }, execFor(stubCtx(), 'edit_finish'))
    const siblingTask = project.repo.tasks().find(t => t.id !== anchorTask.id && (t.shotId === shotA || t.shotId === shotB))!
    const orch = new EditOrchestrator(rt, stubCtx())
    const siblingPrompt = orch.prompt(project, siblingTask)
    expect(siblingPrompt).toContain('warm golden sunset consistency')
    expect(siblingPrompt).toContain('Scene consistency')
    expect(siblingPrompt).toContain(anchorTask.shotId)
    expect(siblingPrompt).toContain('copy_from_task')
    expect(siblingPrompt).toContain('Core "builtin" operations')

    // Sibling inherits anchor global steps via copy_from_task, then decides original is already optimal -> status="unchanged"
    const siblingBound = taskTools(rt, { projectId: project.id, taskId: siblingTask.id })
    await siblingBound.find(t => t.name === 'edit_apply')!.execute({ ops: [{ op: 'copy_from_task', task_id: anchorTask.id }], preview: false }, execFor(stubCtx(), 'edit_apply'))
    expect(rt.edit(project).head(siblingTask.id).doc.stages[0]?.steps.map(s => s.op)).toContain('exposure')
    const finUnchanged = await siblingBound.find(t => t.name === 'edit_finish')!.execute({ status: 'unchanged', summary: 'original exposure and mood already optimal' }, execFor(stubCtx(), 'edit_finish')) as { status: string; unchanged: boolean }
    expect(finUnchanged).toMatchObject({ status: 'succeeded', unchanged: true })
    expect(rt.edit(project).head(siblingTask.id).doc.stages.every(s => s.steps.length === 0)).toBe(true)
  })

  it('expands darktable spline curve control points into native binary blobs and round-trips cleanly', () => {
    const snap = JSON.parse(readFileSync(join(process.cwd(), 'catalogs/darktable-5.6.1.json'), 'utf8')) as { modules: DtModule[] }
    const tc = snap.modules.find(m => m.operation === 'tonecurve')!
    const schema = paramsSchema(tc)
    expect(schema.properties?.curves).toBeDefined()

    const expanded = expandCurveSugar('tonecurve', {
      curves: { L: [[0, 0], [0.25, 0.18], [0.75, 0.84], [1, 1]] },
    })
    expect((expanded.tonecurve_nodes as number[])).toEqual([4, 2, 2])
    expect((expanded.tonecurve_type as number[])).toEqual([2, 2, 2])

    // Fill remaining scalar defaults via schema and verify binary encode/decode round-trip
    const registry = new EngineRegistry(join(state, 'dt-test'), { darktable: { enabled: false }, rawtherapee: { enabled: false } })
    expect(registry).toBeDefined()
    const fullDefaults = {
      tonecurve_autoscale_ab: 3,
      tonecurve_preset: 0,
      tonecurve_unbound_ab: 1,
      preserve_colors: 0,
      ...expanded,
    }
    const blob = encodeParams(tc, fullDefaults)
    expect(blob.length).toBe(tc.paramsSize)
    const decoded = decodeParams(tc, blob) as { tonecurve_nodes: number[]; tonecurve: Array<Array<{ x: number; y: number }>> }
    expect(decoded.tonecurve_nodes).toEqual([4, 2, 2])
    expect(decoded.tonecurve[0]?.[1]?.x).toBeCloseTo(0.25, 4)
    expect(decoded.tonecurve[0]?.[1]?.y).toBeCloseTo(0.18, 4)
    // Untouched channel 'a' initialized to identity (0,0)->(1,1) instead of flat zeroes
    expect(decoded.tonecurve[1]?.[0]).toEqual({ x: 0, y: 0 })
    expect(decoded.tonecurve[1]?.[1]).toEqual({ x: 1, y: 1 })
  })

  it('fills missing metadata from paired companion files, writes C2PA manifests, and filters HTTP shots by min_score', async () => {
    // Build a synthetic RAW(.dng)+JPEG pair where primary lacks GPS and companion JPEG has GPS
    const pairWs = await freshDir('pair-ws')
    await mkdir(pairWs, { recursive: true })
    const srcJpg = join(root, 'day1', 'DSC_0001.JPG')
    const noGpsPrimary = join(pairWs, 'IMG_9001.DNG')
    const gpsCompanion = join(pairWs, 'IMG_9001.JPG')
    await sharp(srcJpg).tiff().toFile(noGpsPrimary)
    await copyFile(srcJpg, gpsCompanion)
    // Strip GPS from primary DNG while keeping DateTimeOriginal; companion JPG retains GPS
    await project.metadata.exec(['-overwrite_original', '-DateTimeOriginal=2026:05:01 08:10:00', '-GPS:all=', noGpsPrimary])

    const pairProj = Project.open(pairWs, { stateRoot: state })
    try {
      await pairProj.scan()
      await pairProj.buildPreviews()
      await pairProj.analyze()
      expect(pairProj.repo.shots()).toHaveLength(1)
      const shot = pairProj.repo.shots()[0]!
      const svc = new EditService(pairProj, new EngineRegistry(join(state, 'pair-eng'), { darktable: { enabled: false }, rawtherapee: { enabled: false } }))
      const exp = await exportPhotos(pairProj, svc, { shotIds: [shot.id], c2pa: true })
      expect(exp.exported).toBe(1)
      expect(exp.verifiedAll).toBe(true)
      expect(exp.items[0]?.c2paManifest).toBeDefined()
      expect(existsSync(exp.items[0]?.c2paManifest as string)).toBe(true)
      const exportedTags = await pairProj.metadata.read(exp.items[0]?.path as string)
      expect(exportedTags.meta.gps?.lat).toBeCloseTo(30.2475, 4)
    } finally {
      await pairProj.close()
    }

    // Verify HTTP router ?min_score filter
    const router = buildRouter(rt)
    let captured: { total?: number } = {}
    const fakeRes: { headersSent: boolean; writableEnded: boolean; statusCode: number; setHeader(): void; end(body: string): void } = {
      headersSent: false,
      writableEnded: false,
      statusCode: 200,
      setHeader() {},
      end(body: string) { fakeRes.writableEnded = true; captured = JSON.parse(body) },
    }
    await router.dispatch({ method: 'GET', path: ['p', project.id, 'shots'], query: new URLSearchParams('min_score=99'), body: undefined }, fakeRes as unknown as import('node:http').ServerResponse)
    expect(captured.total).toBe(0)
  }, 120_000)

  it('supports selection contact sheets, agent vs user preference isolation, web checkpoint approval, and per-scene style unification', async () => {
    const cTools = cullTools(rt)
    const selectTool = cTools.find(t => t.name === 'photo_select')!
    const selTool = cTools.find(t => t.name === 'photo_selection')!
    const selRes = await selectTool.execute({ count: 3, request: '挑3张' }, execFor(stubCtx(), 'photo_select')) as {
      selectionId: string
      contactSheets?: string[]
      shots: Array<{ id: string; file?: string }>
    }
    expect(selRes.contactSheets?.length).toBeGreaterThanOrEqual(1)
    expect(existsSync(selRes.contactSheets![0]!)).toBe(true)
    expect(selRes.shots[0]?.file).toMatch(/\.JPG$/i)

    // Autonomous agent selection adjustment does not pollute user preference learning
    const beforeExamples = project.profile().examples
    const extraShot = project.repo.shots().find(s => !selRes.shots.some(x => x.id === s.id))!
    await selTool.execute({ action: 'adjust', selection: selRes.selectionId, add: [extraShot.id], by: 'agent' }, execFor(stubCtx(), 'photo_selection'))
    expect(project.profile().examples).toBe(beforeExamples)

    // Web panel approval unlocks after-selection checkpoint without needing confirm=true
    writePlan(project, defaultPlan(project, 'align-session', root, { goal: 'retouch-deliver', retouch: 'engine', checkpoint: 'after-selection' }))
    const createTool = taskManagementTools(rt).find(t => t.name === 'edit_tasks_create')!
    const gated = await createTool.execute({ selection: selRes.selectionId, instructions: 'test gate' }, execFor(stubCtx(), 'edit_tasks_create')) as { needsConfirmation?: boolean }
    expect(gated.needsConfirmation).toBe(true)

    const router = buildRouter(rt)
    const approveRes = { headersSent: false, writableEnded: false, statusCode: 200, setHeader() {}, end() { approveRes.writableEnded = true } }
    await router.dispatch({ method: 'POST', path: ['p', project.id, 'plan', 'approve-selection'], query: new URLSearchParams(), body: {} }, approveRes as unknown as import('node:http').ServerResponse)

    const unlocked = await createTool.execute({ selection: selRes.selectionId, instructions: 'test unlocked', force: true }, execFor(stubCtx(), 'edit_tasks_create')) as { created: Array<{ id: string }> }
    expect(unlocked.created.length).toBeGreaterThanOrEqual(2)

    // Scene-anchor auto unification in edit_unify_style
    const unifyTool = aiTools(rt).find(t => t.name === 'edit_unify_style')!
    const unified = await unifyTool.execute({ selection: selRes.selectionId }, execFor(stubCtx(), 'edit_unify_style')) as { reference: { mode?: string } }
    expect(unified.reference.mode).toBe('scene-anchor')
  }, 120_000)

  it('validates Phase A–D retouching quality fixes: cheat-sheet aliases, tone/heal math, 16-bit stats, darktable defaults & diagnostics', async () => {
    // 1. Built-in per-channel curves, rotate auto_crop alias, sub-box aspect crop, and vignette fraction compatibility
    const builtin = new BuiltinEngine()
    const bCat = await builtin.catalog()
    const curveStep = builtin.validateStep({
      id: 'c1',
      op: 'curve',
      enabled: true,
      params: { points: [[0, 0], [0.5, 0.55], [1, 1]], red: [[0, 0], [0.5, 0.6], [1, 1]], blue: [[0, 0], [0.5, 0.4], [1, 1]] },
    }, bCat)
    expect(curveStep.warnings).toHaveLength(0)

    const rotStep = builtin.validateStep({ id: 'r1', op: 'rotate', enabled: true, params: { angle: 2.5, auto_crop: true } }, bCat)
    expect(rotStep.step.params.auto_crop).toBe(true)

    const cropOp = BUILTIN_OPS.find(o => o.id === 'crop')!
    const testImg: FImage = { width: 200, height: 100, data: new Float32Array(200 * 100 * 3).fill(0.5) }
    const subCrop = cropOp.apply(testImg, { x: 0.1, y: 0.1, w: 0.5, h: 0.5, aspect: '1:1', cx: 0.5, cy: 0.5 }, { readable: x => x, seed: 1 })
    expect(subCrop.width).toBe(50)
    expect(subCrop.height).toBe(50)

    // 2. Built-in tone: pure black stays 0 when lifting shadows, linear >1.0 highlight headroom is recovered when highlights < 0
    const toneOp = BUILTIN_OPS.find(o => o.id === 'tone')!
    const hdrImg: FImage = {
      width: 3,
      height: 1,
      data: new Float32Array([
        0, 0, 0, // pure black pixel
        0.04, 0.04, 0.04, // deep shadow pixel
        1.35, 1.35, 1.35, // over-unity linear highlight from prior exposure step
      ]),
    }
    const toned = toneOp.apply(hdrImg, { contrast: 0, shadows: 60, highlights: -70, whites: 0, blacks: 0, brightness: 0 }, { readable: x => x, seed: 1 })
    expect(toned.data[0]).toBe(0) // pure black never turns into milky fog
    expect(toned.data[3]!).toBeGreaterThan(0.055) // deep shadow lifted
    expect(toned.data[6]!).toBeLessThan(0.98) // linear highlight >1.0 recovered below clipping

    // 3. Built-in heal on a steep gradient: 2D plane matching eliminates crescent boundary seams
    const healOp = BUILTIN_OPS.find(o => o.id === 'heal')!
    const gw = 120; const gh = 120
    const gradData = new Float32Array(gw * gh * 3)
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        const v = 0.15 + 0.6 * (x / gw) + 0.2 * (y / gh)
        const idx = (y * gw + x) * 3
        gradData[idx] = v; gradData[idx + 1] = v; gradData[idx + 2] = v
      }
    }
    const cleanGrad: FImage = { width: gw, height: gh, data: new Float32Array(gradData) }
    // Paint a dark dust spot at (0.5, 0.5)
    for (let y = 55; y <= 65; y++) {
      for (let x = 55; x <= 65; x++) {
        if (Math.hypot(x - 60, y - 60) <= 4.5) {
          const idx = (y * gw + x) * 3
          gradData[idx] = 0.02; gradData[idx + 1] = 0.02; gradData[idx + 2] = 0.02
        }
      }
    }
    const healed = healOp.apply({ width: gw, height: gh, data: gradData }, { spots: [{ x: 0.5, y: 0.5, r: 0.05 }] }, { readable: x => x, seed: 1 })
    let spotErr = 0; let spotN = 0
    for (let y = 54; y <= 66; y++) {
      for (let x = 54; x <= 66; x++) {
        const idx = (y * gw + x) * 3
        spotErr += Math.abs((healed.data[idx] as number) - (cleanGrad.data[idx] as number))
        spotN++
      }
    }
    expect(spotErr / spotN).toBeLessThan(0.01)

    // 4. 16-bit TIFF/PNG imageStats accuracy
    const statDir = await freshDir('stat16')
    const p8 = join(statDir, 'img8.png')
    const p16 = join(statDir, 'img16.tif')
    await saveImage(cleanGrad, p8, 'png', 92, 8)
    await saveImage(cleanGrad, p16, 'tiff', 92, 16)
    const st8 = await imageStats(p8, { faceBox: [0.2, 0.2, 0.3, 0.3] })
    const st16 = await imageStats(p16, { faceBox: [0.2, 0.2, 0.3, 0.3] })
    expect(Math.abs(st16.mean.luma - st8.mean.luma)).toBeLessThan(1.5)
    expect(st16.zones?.midtones).toBeGreaterThan(100)
    expect(st16.faceLuma).toBeDefined()

    // 5. darktable crop aliases (left/top/right/bottom -> cx/cy/cw/ch, cw/ch default=1) & channelmixerrgb identity defaults
    const snap = JSON.parse(readFileSync(join(process.cwd(), 'catalogs/darktable-5.6.1.json'), 'utf8')) as { modules: DtModule[] }
    const dtCrop = snap.modules.find(m => m.operation === 'crop')!
    const dtCropSchema = paramsSchema(dtCrop)
    expect(dtCropSchema.properties?.cw?.default).toBe(1)
    expect(dtCropSchema.properties?.ch?.default).toBe(1)
    const normCrop = normalizeDarktableParams('crop', { left: 0.08, top: 0.12, right: 0.92, bottom: 0.88 })
    expect(normCrop).toEqual({ cx: 0.08, cy: 0.12, cw: 0.92, ch: 0.88 })

    const dtCm = snap.modules.find(m => m.operation === 'channelmixerrgb')!
    const dtCmSchema = paramsSchema(dtCm)
    expect(dtCmSchema.properties?.red?.default).toEqual([1, 0, 0, 0])
    expect(dtCmSchema.properties?.green?.default).toEqual([0, 1, 0, 0])
    expect(dtCmSchema.properties?.blue?.default).toEqual([0, 0, 1, 0])

    // 6. RawTherapee normalized Crop (0..1 -> px), Rotation.Degrees alias & White Balance Auto/Custom
    const rtEng = new RawTherapeeEngine({ workDir: join(state, 'rt-unit') })
    const fakeRtCatalog: Catalog = {
      engine: 'rawtherapee',
      engineVersion: '5.13',
      catalogVersion: 2,
      fingerprint: 'test',
      source: 'profile-dump',
      discoveredAt: '',
      stageOptions: { type: 'object', properties: {} },
      coverage: { operations: 3, parameters: 10, withSchema: 3, extensions: [], unsupported: [] },
      operations: [
        {
          id: 'Crop', title: 'Crop', category: 'geometry', masks: [], multiInstance: false,
          params: { type: 'object', additionalProperties: false, properties: { Enabled: { type: 'boolean', default: false }, FixedRatio: { type: 'boolean', default: true }, X: { type: 'number', default: 0 }, Y: { type: 'number', default: 0 }, W: { type: 'number', default: 4000 }, H: { type: 'number', default: 3000 } } },
        },
        {
          id: 'Rotation', title: 'Rotation', category: 'geometry', masks: [], multiInstance: false,
          params: { type: 'object', additionalProperties: false, properties: { Degree: { type: 'number', minimum: -45, maximum: 45, default: 0 } } },
        },
        {
          id: 'White Balance', title: 'White Balance', category: 'tool', masks: [], multiInstance: false,
          params: { type: 'object', additionalProperties: false, properties: { Setting: { type: 'string', enum: ['Camera', 'autitcgreen', 'Custom'], default: 'Camera' }, Temperature: { type: 'number', default: 5200 }, Green: { type: 'number', default: 1 } } },
        },
      ],
    }
    const pp = rtEng.buildProfile({
      id: 'st_rt',
      engine: 'rawtherapee',
      steps: [
        { id: 's1', op: 'Crop', enabled: true, params: { X: 0.1, Y: 0.2, W: 0.8, H: 0.6 } },
        { id: 's2', op: 'Rotation', enabled: true, params: { Degrees: -1.8 } },
        { id: 's3', op: 'White Balance', enabled: true, params: { Temperature: 5800 } },
      ],
    }, fakeRtCatalog, { width: 4000, height: 3000 })
    expect(pp.get('Crop')?.get('X')).toBe('400')
    expect(pp.get('Crop')?.get('Y')).toBe('600')
    expect(pp.get('Crop')?.get('W')).toBe('3200')
    expect(pp.get('Crop')?.get('H')).toBe('1800')
    expect(pp.get('Crop')?.get('FixedRatio')).toBe('false')
    expect(pp.get('Rotation')?.get('Degree')).toBe('-1.8')
    expect(pp.get('White Balance')?.get('Setting')).toBe('Custom')

    // 7. edit_task_info diagnostics & edit_apply compare=true
    const anyTask = project.repo.tasks()[0]!
    const bound = taskTools(rt, { projectId: project.id, taskId: anyTask.id })
    const infoRes = await bound.find(t => t.name === 'edit_task_info')!.execute({ view: false }, execFor(stubCtx(), 'edit_task_info')) as {
      photo?: { diagnostics?: { exposure?: unknown; geometry?: unknown } }
    }
    expect(infoRes.photo?.diagnostics?.exposure).toBeDefined()
    expect(infoRes.photo?.diagnostics?.geometry).toBeDefined()
  })
})
