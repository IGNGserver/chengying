import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { copyFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { computeFeatures } from '../src/core/analysis/pixels.ts'
import { potentialScore, technicalScore } from '../src/core/analysis/scoring.ts'
import { createModelScorer } from '../src/core/analysis/models.ts'
import { decodeParams, encodeParams, expandCurveSugar, paramsSchema, type DtModule } from '../src/core/edit/engines/darktable/codec.ts'
import { Project } from '../src/core/project.ts'
import { EngineRegistry } from '../src/core/edit/registry.ts'
import { EditService } from '../src/core/edit/service.ts'
import { exportPhotos } from '../src/core/export/exporter.ts'
import { ChengyingRuntime } from '../src/dsh/runtime.ts'
import { resolveConfig } from '../src/dsh/config.ts'
import { selectVlmCandidates } from '../src/dsh/tools/cull.ts'
import { taskManagementTools, taskTools } from '../src/dsh/tools/edit.ts'
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
    const second = await apply.execute({ ops: [{ op: 'add_step', stage: 'builtin', step: { op: 'upscale', params: { scale: 1.5, method: 'auto' } } }], stage: 'ai', preview: true }, execFor(stubCtx(), 'edit_apply')).catch(async () =>
      await apply.execute({ ops: [{ op: 'add_step', stage: 'ai', step: { op: 'upscale', params: { scale: 1.5, method: 'auto' } } }], preview: true }, execFor(stubCtx(), 'edit_apply'))
    ) as { renderWarnings?: string[] }
    expect((second.renderWarnings ?? []).join(' ')).toMatch(/Lanczos3/)

    await expect(
      apply.execute({ ops: [{ op: 'add_step', stage: 'builtin', step: { op: 'tone', params: { contrast: 10 } } }], preview: false }, execFor(stubCtx(), 'edit_apply')),
    ).rejects.toThrow(/revision budget reached/)

    // Finish anchor as succeeded; check sibling prompt receives scene anchor context
    await finish.execute({ summary: 'warmed golden light' }, execFor(stubCtx(), 'edit_finish'))
    const siblingTask = project.repo.tasks().find(t => t.id !== anchorTask.id && (t.shotId === shotA || t.shotId === shotB))!
    const orch = new EditOrchestrator(rt, stubCtx())
    const siblingPrompt = orch.prompt(project, siblingTask)
    expect(siblingPrompt).toContain('warm golden sunset consistency')
    expect(siblingPrompt).toContain('Scene consistency')
    expect(siblingPrompt).toContain(anchorTask.shotId)

    // Sibling decides original is already optimal -> status="unchanged"
    const siblingBound = taskTools(rt, { projectId: project.id, taskId: siblingTask.id })
    await siblingBound.find(t => t.name === 'edit_apply')!.execute({ ops: [{ op: 'add_step', stage: 'builtin', step: { op: 'exposure', params: { ev: 0.2 } } }], preview: false }, execFor(stubCtx(), 'edit_apply'))
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
    const noGpsPrimary = join(pairWs, 'IMG_9001.TIFF')
    const gpsCompanion = join(pairWs, 'IMG_9001.JPG')
    await sharp(srcJpg).tiff().toFile(noGpsPrimary)
    await copyFile(srcJpg, gpsCompanion)
    // Strip GPS from primary TIFF while keeping DateTimeOriginal; companion JPG retains GPS
    await project.metadata.exec(['-overwrite_original', '-DateTimeOriginal=2026:05:01 08:10:00', '-GPS:all=', noGpsPrimary])

    const pairProj = Project.open(pairWs, { stateRoot: state })
    try {
      await pairProj.scan()
      await pairProj.buildPreviews()
      await pairProj.analyze()
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
})
