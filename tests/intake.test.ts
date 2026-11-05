import { afterEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import sharp from 'sharp'
import { ChengyingRuntime } from '../src/dsh/runtime.ts'
import { resolveConfig, type Config } from '../src/dsh/config.ts'
import { sessionTools } from '../src/dsh/tools/session.ts'
import { Project } from '../src/core/project.ts'
import { detectImageFormat } from '../src/core/image/format.ts'
import type { HostContext, ToolRunContext } from '../src/dsh/host-types.ts'
import { deliverOriginals } from '../src/core/export/deliver.ts'
import { freshDir } from './helpers/fixtures.ts'

/** The shape of a Host attachment object: a bare sha256 with no extension. */
const HOST_OBJECT = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

const runtimes: ChengyingRuntime[] = []

afterEach(async () => {
  while (runtimes.length > 0) await runtimes.pop()?.close()
})

function stubCtx(services: Record<string, unknown> = {}): HostContext {
  return {
    get: (name: string) => services[name],
    effect: (fn: () => (() => void) | undefined | void) => fn(),
    inject: () => undefined,
    on: () => () => undefined,
    logger: () => console,
    tools: { register: () => () => undefined, restrict: () => () => undefined },
  } as unknown as HostContext
}

function execFor(ctx: HostContext, name: string, sessionId: string, cwd?: string): ToolRunContext {
  return {
    callId: 'call_1',
    name,
    arguments: {},
    signal: new AbortController().signal,
    agent: {
      id: 'agent_1',
      ctx,
      options: {},
      session: { id: sessionId, requestHeader: () => ({ cwd }) },
    },
  }
}

async function makeJpeg(file: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  await sharp({ create: { width: 96, height: 64, channels: 3, background: { r: 30, g: 90, b: 150 } } }).jpeg({ quality: 90 }).toFile(file)
}

function attachmentCtx(objectPath: string, mediaType = 'image/jpeg'): HostContext {
  const sessions = {
    get: () => ({
      header: {},
      snapshotEvents: () => [{
        type: 'user/message',
        data: {
          source: { kind: 'user' },
          content: [{ type: 'image', attachment: { attachmentId: `sha256:${HOST_OBJECT}`, mediaType, bytes: 3, width: 96, height: 64 } }],
        },
      }],
    }),
  }
  const attachments = {
    imageHostPath: () => objectPath,
    saveImage: async () => ({ attachmentId: 'x', mediaType, bytes: 1, width: 1, height: 1 }),
    imageLimits: { mediaTypes: ['image/jpeg'], maxImageBytes: 1, maxMessageImageBytes: 1, maxImageDimension: 1, maxImagePixels: 1 },
  }
  return stubCtx({ sessions, attachments })
}

function config(partial: Partial<Config>): Config {
  return resolveConfig({ ui: { enabled: false, basePath: '/api/chengying' }, ...partial })
}

describe('attachment intake', () => {
  it('restores the extension of an extension-less Host object and lands in the session workspace', async () => {
    const cwd = await freshDir('intake-cwd')
    const state = await freshDir('intake-state')
    const objectPath = join(state, 'attachment-store', HOST_OBJECT)
    await makeJpeg(objectPath)

    const ctx = attachmentCtx(objectPath)
    const rt = new ChengyingRuntime(ctx, config({ stateRoot: state }), console)
    runtimes.push(rt)
    const tool = sessionTools(rt).find(t => t.name === 'photo_session_start')
    expect(tool).toBeDefined()
    const result = await tool?.execute({ goal: 'cull' }, execFor(ctx, 'photo_session_start', 's-intake', cwd)) as {
      plan: { source: string; outputDir: string }
      project: { root: string }
      workspace: string
      deliveryDir: string
      notes: string[]
    }

    expect(result.plan.source).toMatch(/^attachments:1/)
    expect(result.workspace).toBe(result.project.root)
    expect(result.workspace.startsWith(join(cwd, '_chengying_inbox'))).toBe(true)
    expect(result.deliveryDir).toBe(join(cwd, '_chengying_export'))
    expect(result.plan.outputDir).toBe(join(cwd, '_chengying_export'))
    expect(result.notes.join(' ')).toContain('_chengying_inbox')

    const names = await readdir(result.workspace)
    expect(names).toHaveLength(1)
    expect(names[0]).toMatch(/^pasted-[0-9a-f]{8}\.jpg$/)
    expect(existsSync(join(result.workspace, names[0] as string))).toBe(true)

    const project = rt.project(undefined, 'agent_1')
    const scan = await project.scan()
    expect(scan.files).toBe(1)
    expect(scan.skipped).toBe(0)
    expect(project.repo.shotCount()).toBe(1)
    expect(project.repo.files()[0]?.ext).toBe('jpg')

    // Opening the surrounding workspace must not re-ingest the managed folders.
    const outer = Project.open(cwd, { stateRoot: state })
    try {
      expect((await outer.scan()).files).toBe(0)
    } finally {
      await outer.close()
    }
  })

  it('keeps explicit output_dir and accepts a declared client name', async () => {
    const cwd = await freshDir('intake-named')
    const state = await freshDir('intake-named-state')
    const objectPath = join(state, 'attachment-store', HOST_OBJECT)
    await makeJpeg(objectPath)
    const ctx = stubCtx({
      sessions: {
        get: () => ({
          header: {},
          snapshotEvents: () => [{
            type: 'user/message',
            data: {
              source: { kind: 'user' },
              content: [{ type: 'image', attachment: { attachmentId: `sha256:${HOST_OBJECT}`, mediaType: 'image/jpeg', name: 'sunset.jpg', bytes: 3, width: 96, height: 64 } }],
            },
          }],
        }),
      },
      attachments: { imageHostPath: () => objectPath, imageLimits: { mediaTypes: ['image/jpeg'], maxImageBytes: 1, maxMessageImageBytes: 1, maxImageDimension: 1, maxImagePixels: 1 } },
    })
    const rt = new ChengyingRuntime(ctx, config({ stateRoot: state }), console)
    runtimes.push(rt)
    const out = join(cwd, 'delivered')
    const tool = sessionTools(rt).find(t => t.name === 'photo_session_start')
    const result = await tool?.execute({ goal: 'cull', output_dir: out }, execFor(ctx, 'photo_session_start', 's-named', cwd)) as { workspace: string; deliveryDir: string }
    expect(result.deliveryDir).toBe(out)
    expect(await readdir(result.workspace)).toEqual(['sunset.jpg'])
  })

  it('falls back to the state inbox when the session has no workspace, and honours intake.location=state', async () => {
    const state = await freshDir('intake-fallback-state')
    const objectPath = join(state, 'attachment-store', HOST_OBJECT)
    await makeJpeg(objectPath)

    const headlessCtx = attachmentCtx(objectPath)
    const headless = new ChengyingRuntime(headlessCtx, config({ stateRoot: state }), console)
    runtimes.push(headless)
    const headlessTool = sessionTools(headless).find(t => t.name === 'photo_session_start')
    const headlessResult = await headlessTool?.execute({ goal: 'cull' }, execFor(headlessCtx, 'photo_session_start', 's-headless')) as { workspace: string; deliveryDir: string }
    expect(headlessResult.workspace.startsWith(join(state, 'inbox'))).toBe(true)
    expect(headlessResult.deliveryDir.startsWith(headlessResult.workspace)).toBe(true)

    const cwd = await freshDir('intake-state-cwd')
    const legacyCtx = attachmentCtx(objectPath)
    const legacy = new ChengyingRuntime(legacyCtx, config({ stateRoot: state, intake: { maxFiles: 200, maxBytes: 4 * 1024 ** 3, location: 'state', dirName: '_chengying_inbox' } }), console)
    runtimes.push(legacy)
    const legacyTool = sessionTools(legacy).find(t => t.name === 'photo_session_start')
    const legacyResult = await legacyTool?.execute({ goal: 'cull' }, execFor(legacyCtx, 'photo_session_start', 's-legacy', cwd)) as { workspace: string }
    expect(legacyResult.workspace.startsWith(join(state, 'inbox'))).toBe(true)
  })

  it('rejects an extension-less image attachment it cannot decode, but copies verbatim files as-is', async () => {
    const cwd = await freshDir('intake-bad')
    const state = await freshDir('intake-bad-state')
    const objectPath = join(cwd, 'no-extension-object')
    await writeFile(objectPath, 'not an image')
    const rt = new ChengyingRuntime(stubCtx(), config({ stateRoot: state }), console)
    runtimes.push(rt)
    await expect(rt.importFiles([{ path: objectPath, kind: 'image' }], { cwd })).rejects.toThrow(/cannot determine the image format/)

    const brief = join(cwd, 'brief.md')
    await writeFile(brief, '# brief')
    const project = await rt.importFiles([{ path: brief, kind: 'file', name: 'brief.md' }], { cwd })
    expect(await readdir(project.root)).toContain('brief.md')
  })
})

describe('scan fallback for extension-less photos', () => {
  it('indexes an extension-less image by content and counts skipped files', async () => {
    const dir = await freshDir('scan-noext')
    const state = await freshDir('scan-noext-state')
    await makeJpeg(join(dir, 'day1', HOST_OBJECT))
    await writeFile(join(dir, 'notes.txt'), 'not an image')

    expect((await detectImageFormat(join(dir, 'day1', HOST_OBJECT)))?.ext).toBe('jpg')
    const project = Project.open(dir, { stateRoot: state })
    try {
      const scan = await project.scan()
      expect(scan.files).toBe(1)
      expect(scan.shots).toBe(1)
      expect(scan.skipped).toBe(1)
      expect(project.repo.files()[0]?.ext).toBe('jpg')
      expect(project.repo.files()[0]?.format).toBe('jpg')
    } finally {
      await project.close()
    }

    // The content fallback can be disabled for workspaces with many non-photo files.
    const strict = Project.open(dir, { stateRoot: await freshDir('scan-noext-strict'), sniffUnknown: false })
    try {
      const scan = await strict.scan()
      expect(scan.files).toBe(0)
      expect(scan.skipped).toBe(2)
    } finally {
      await strict.close()
    }
  })

  it('restores the extension when delivering originals', async () => {
    const dir = await freshDir('deliver-noext')
    const state = await freshDir('deliver-noext-state')
    await makeJpeg(join(dir, HOST_OBJECT))
    const project = Project.open(dir, { stateRoot: state })
    try {
      await project.scan()
      const shotId = project.repo.shots()[0]?.id as string
      const out = await freshDir('deliver-noext-out')
      const delivery = deliverOriginals(project, { shotIds: [shotId], dir: out })
      expect(delivery.failed).toBe(0)
      const delivered = delivery.items[0]?.path as string
      expect(delivered.endsWith(`${HOST_OBJECT}.jpg`)).toBe(true)
      expect(existsSync(delivered)).toBe(true)
      expect(relative(out, delivered)).toBe(`${HOST_OBJECT}.jpg`)
    } finally {
      await project.close()
    }
  })
})
