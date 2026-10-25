/**
 * HTTP API for the task-management UI, mounted on the Harness web server.
 * Every request passes the Harness connection fence (Host/Origin check and
 * authenticated browser Peer) before any handler runs. Image responses are
 * served only from Chengying-owned directories (previews, renders, exports).
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname } from 'node:path'
import type { ChengyingRuntime } from './runtime.ts'
import type { ConnectionService, HostContext, WebServerService } from './host-types.ts'
import { shotRow } from './tools/cull.ts'
import { mergeDims } from '../core/select/selector.ts'
import { parseSelectionRequest } from '../core/select/nl.ts'
import { isInside } from '../core/fsguard.ts'
import { ChengyingError, errorMessage, isChengyingError } from '../core/util/errors.ts'
import type { Project } from '../core/project.ts'

export interface ApiRequest {
  method: string
  path: string[]
  query: URLSearchParams
  body: unknown
}

export type ApiHandler = (req: ApiRequest, res: ServerResponse) => Promise<unknown>

interface Route { method: string; pattern: string[]; handler: (params: Record<string, string>, req: ApiRequest, res: ServerResponse) => Promise<unknown> }

const MAX_BODY = 1024 * 1024

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) { reject(new ChengyingError('invalid-argument', 'request body too large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      if (chunks.length === 0) { resolve(undefined); return }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { reject(new ChengyingError('invalid-argument', 'body must be JSON')) }
    })
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.headersSent) return
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

const MIME: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.tif': 'image/tiff', '.tiff': 'image/tiff', '.avif': 'image/avif' }

/** Serve a file only when it lives inside one of the project's Chengying-owned roots. */
export async function sendFile(project: Project, res: ServerResponse, path: string | null | undefined): Promise<void> {
  if (path === null || path === undefined || !existsSync(path)) { sendJson(res, 404, { code: 'not-found' }); return }
  const owned = [project.stateDir, project.exportDir]
  if (!owned.some(root => isInside(path, root))) { sendJson(res, 403, { code: 'permission-denied' }); return }
  const st = statSync(path)
  // Headers go out synchronously so the router never appends a JSON body.
  res.writeHead(200, {
    'content-type': MIME[extname(path).toLowerCase()] ?? 'application/octet-stream',
    'content-length': String(st.size),
    'cache-control': 'private, max-age=60',
  })
  await new Promise<void>((resolve) => {
    const stream = createReadStream(path)
    stream.on('error', () => { res.destroy(); resolve() })
    res.on('close', () => { stream.destroy(); resolve() })
    stream.pipe(res)
  })
}

export class ApiRouter {
  private readonly routes: Route[] = []

  add(method: string, pattern: string, handler: Route['handler']): this {
    this.routes.push({ method, pattern: pattern.split('/').filter(Boolean), handler })
    return this
  }

  async dispatch(req: ApiRequest, res: ServerResponse): Promise<void> {
    for (const r of this.routes) {
      if (r.method !== req.method || r.pattern.length !== req.path.length) continue
      const params: Record<string, string> = {}
      let ok = true
      for (let i = 0; i < r.pattern.length; i++) {
        const p = r.pattern[i] as string
        const v = req.path[i] as string
        if (p.startsWith(':')) params[p.slice(1)] = decodeURIComponent(v)
        else if (p !== v) { ok = false; break }
      }
      if (!ok) continue
      const out = await r.handler(params, req, res)
      if (!res.headersSent && !res.writableEnded) sendJson(res, 200, out ?? { ok: true })
      return
    }
    sendJson(res, 404, { code: 'not-found', message: `no route ${req.method} /${req.path.join('/')}` })
  }
}

export function buildRouter(rt: ChengyingRuntime): ApiRouter {
  const P = (id: string): Project => rt.project(id)
  const router = new ApiRouter()
  router
    .add('GET', '/projects', async () => ({ projects: [...rt.projects.values()].map(p => p.summary()), recent: rt.recent().filter(r => !rt.projects.has(r.id) && existsSync(r.root)) }))
    .add('POST', '/projects/open', async (_p, req) => {
      const body = req.body as { path?: string; exportDir?: string } | undefined
      if (typeof body?.path !== 'string') throw new ChengyingError('invalid-argument', 'path required')
      return rt.openProject(body.path, undefined, { exportDir: body.exportDir }).summary()
    })
    .add('GET', '/activities', async () => ({ activities: [...rt.activities.values()].slice(-50) }))
    .add('POST', '/activities/:id/cancel', async (p) => ({ cancelled: rt.cancelActivity(p.id as string) }))
    .add('GET', '/p/:id/summary', async (p) => P(p.id as string).summary())
    .add('POST', '/p/:id/cull', async (p, req) => {
      const project = P(p.id as string)
      const body = (req.body ?? {}) as { force?: boolean }
      if ([...rt.activities.values()].some(a => a.projectId === project.id && a.kind === 'cull' && a.state === 'running')) {
        throw new ChengyingError('conflict', 'culling is already running for this workspace')
      }
      const a = rt.startDetached('cull', `cull · ${project.root}`, project.id, async (signal, progress) => {
        const onProgress = (x: { stage: string; done: number; total: number; message?: string }): void => progress(x.stage, x.done, x.total, x.message)
        const scan = await project.scan({ signal, onProgress })
        const previews = await project.buildPreviews({ force: body.force, signal, onProgress })
        const analyze = await project.analyze({ force: body.force, signal, onProgress })
        return { scan, previews: { built: previews.built, failed: previews.failed.length }, analyze: { analyzed: analyze.analyzed, failed: analyze.failed.length } }
      })
      return { activityId: a.id }
    })
    .add('GET', '/p/:id/shots', async (p, req) => {
      const project = P(p.id as string)
      let shots = project.repo.shots()
      const q = req.query
      const sel = q.get('selection')
      let selMap: Map<string, { included: boolean; rank: number; reason: string; locked: boolean }> | undefined
      if (sel) {
        const s = project.repo.selection(sel)
        if (s === undefined) throw new ChengyingError('not-found', `no selection ${sel}`)
        selMap = new Map(s.items.map(i => [i.shotId, i]))
        if (q.get('only') === 'included') shots = shots.filter(x => selMap?.get(x.id)?.included === true)
      }
      const group = q.get('group')
      if (group) {
        const g = project.repo.groups().find(x => x.id === group)
        const ids = new Set(g?.members.map(m => m.shotId) ?? [])
        shots = shots.filter(s => ids.has(s.id))
      }
      const day = q.get('day')
      if (day) shots = shots.filter(s => s.day === day)
      const issue = q.get('issue')
      const rows = shots.map(s => ({ s, d: mergeDims(project.repo.scores(s.id)) })).filter(r => !issue || r.d.issues.includes(issue))
      const sort = q.get('sort') ?? 'time'
      if (sort !== 'time') rows.sort((a, b) => ((b.d[sort as 'technical'] ?? ((b.d.technical ?? 0) + (b.d.aesthetic ?? 0)) / 2) - (a.d[sort as 'technical'] ?? ((a.d.technical ?? 0) + (a.d.aesthetic ?? 0)) / 2)))
      const offset = Number(q.get('offset') ?? 0)
      const limit = Math.min(500, Number(q.get('limit') ?? 120))
      return {
        total: rows.length,
        offset,
        shots: rows.slice(offset, offset + limit).map(r => ({ ...shotRow(project, r.s), selection: selMap?.get(r.s.id) })),
      }
    })
    .add('GET', '/p/:id/shot/:shot', async (p) => {
      const project = P(p.id as string)
      const s = project.repo.shot(p.shot as string)
      if (s === undefined) throw new ChengyingError('not-found', 'no such shot')
      const groups = project.repo.groups().filter(g => g.members.some(m => m.shotId === s.id)).map(g => ({ id: g.id, kind: g.kind, label: g.label, size: g.members.length }))
      return { ...shotRow(project, s, true), scoresBySource: project.repo.scores(s.id), groups, tasks: project.repo.tasks({ shotId: s.id }) }
    })
    .add('GET', '/p/:id/image/:shot/:variant', async (p, _req, res) => {
      const project = P(p.id as string)
      const s = project.repo.shot(p.shot as string)
      await sendFile(project, res, p.variant === 'thumb' ? s?.thumbPath : s?.previewPath)
    })
    .add('GET', '/p/:id/groups', async (p, req) => {
      const project = P(p.id as string)
      const kind = (req.query.get('kind') ?? 'near') as 'near'
      return { groups: project.groups(kind).map(g => ({ id: g.id, label: g.label, size: g.members.length, members: g.members.map(m => m.shotId), info: g.info })) }
    })
    .add('GET', '/p/:id/selections', async (p) => ({ selections: P(p.id as string).repo.selections() }))
    .add('GET', '/p/:id/selection/:sel', async (p) => {
      const s = P(p.id as string).repo.selection(p.sel as string)
      if (s === undefined) throw new ChengyingError('not-found', 'no such selection')
      return s
    })
    .add('POST', '/p/:id/select', async (p, req) => {
      const project = P(p.id as string)
      const body = (req.body ?? {}) as { request?: string; count?: number; minScore?: number; base?: string; name?: string }
      const spec = { ...(body.request ? parseSelectionRequest(body.request) : {}), ...(body.count !== undefined ? { count: body.count } : {}), ...(body.minScore !== undefined ? { minScore: body.minScore } : {}) }
      const { selectionId, result } = project.select(spec, { name: body.name, base: body.base })
      return { selectionId, stats: result.stats, spec }
    })
    .add('POST', '/p/:id/selection/:sel/adjust', async (p, req) => {
      const body = (req.body ?? {}) as { add?: string[]; remove?: string[]; lock?: string[]; unlock?: string[] }
      return P(p.id as string).adjustSelection(p.sel as string, body, 'user')
    })
    .add('POST', '/p/:id/flag', async (p, req) => {
      const project = P(p.id as string)
      const body = (req.body ?? {}) as { shots?: string[]; flag?: 'pick' | 'reject' | null; rating?: number }
      for (const id of body.shots ?? []) {
        project.repo.updateShot(id, {
          ...(body.flag !== undefined ? { userFlag: body.flag } : {}),
          ...(body.rating !== undefined ? { userRating: body.rating } : {}),
        })
      }
      return { updated: body.shots?.length ?? 0 }
    })
    .add('GET', '/p/:id/events', async (p, req) => {
      const after = req.query.get('after')
      return { events: P(p.id as string).repo.events({ taskId: req.query.get('task') ?? undefined, afterId: after ? Number(after) : undefined, limit: Number(req.query.get('limit') ?? 200) }) }
    })
    .add('GET', '/p/:id/usage', async (p) => ({ usage: P(p.id as string).repo.usageSummary() }))
    .add('GET', '/engines', async () => ({ engines: await rt.engines().probeAll() }))
    .add('GET', '/p/:id/tasks', async (p, req) => {
      const status = req.query.get('status')
      return { tasks: P(p.id as string).repo.tasks(status ? { status: [status as never] } : {}) }
    })
    .add('GET', '/p/:id/task/:task', async (p) => {
      const project = P(p.id as string)
      const task = project.repo.task(p.task as string)
      if (task === undefined) throw new ChengyingError('not-found', 'no such task')
      return { task, revisions: project.repo.revisions(task.id), events: project.repo.events({ taskId: task.id, limit: 400 }) }
    })
    .add('POST', '/p/:id/task/:task/control', async (p, req) => {
      const action = (req.body as { action?: string } | undefined)?.action
      if (!['pause', 'resume', 'retry', 'cancel'].includes(String(action))) throw new ChengyingError('invalid-argument', 'action must be pause|resume|retry|cancel')
      return await rt.orchestrator.control(P(p.id as string), p.task as string, action as 'pause')
    })
    .add('GET', '/p/:id/render/:rev', async (p, _req, res) => {
      const project = P(p.id as string)
      const rev = project.repo.revision(p.rev as string)
      if (rev === undefined) throw new ChengyingError('not-found', 'no such revision')
      let path = rev.previewPath
      if (path === null || !existsSync(path)) path = (await rt.edit(project).render(rev.taskId, { revisionId: rev.id, maxEdge: rt.config.editing.previewEdge })).path
      await sendFile(project, res, path)
    })
    .add('GET', '/p/:id/export-file/:exp', async (p, _req, res) => {
      const project = P(p.id as string)
      await sendFile(project, res, project.repo.exports().find(e => e.id === p.exp)?.path)
    })
    .add('GET', '/p/:id/authorizations', async (p) => ({ authorizations: P(p.id as string).repo.authorizations() }))
    .add('POST', '/p/:id/authorizations', async (p, req) => {
      // User-only action: grants come from the browser (authenticated Harness user), never from a tool.
      const body = (req.body ?? {}) as { shotId?: string; note?: string; maxUses?: number; hours?: number }
      const project = P(p.id as string)
      const id = project.repo.addAuthorization({ scope: 'generative', shotId: body.shotId ?? null, taskId: null, grantedBy: 'user (web panel)', note: body.note ?? '', expiresAt: new Date(Date.now() + (body.hours ?? 24) * 3600_000).toISOString(), maxUses: body.maxUses ?? null })
      project.repo.addEvent(null, 'info', 'authorization', `generative edits authorized${body.shotId ? ` for ${body.shotId}` : ''} by the user`, { id })
      return { id }
    })
    .add('POST', '/p/:id/authorizations/:auth/revoke', async (p) => {
      P(p.id as string).repo.revokeAuthorization(p.auth as string)
      return { revoked: true }
    })
    .add('GET', '/p/:id/exports', async (p) => ({ exports: P(p.id as string).repo.exports() }))
  return router
}

export function registerHttpApi(ctx: HostContext, rt: ChengyingRuntime, basePath: string, extend?: (router: ApiRouter) => void): () => void {
  const web = ctx.get('webServer') as WebServerService
  const connection = ctx.get('connection') as ConnectionService
  const router = buildRouter(rt)
  extend?.(router)
  rt.router = router
  const base = basePath.replace(/\/+$/, '')
  return web.register({
    kind: 'prefix',
    path: base,
    handler: async (req, res) => {
      const rejection = connection.requestRejection(req)
      if (rejection !== undefined) { res.statusCode = rejection; res.end(); return }
      try {
        const url = new URL(String(req.url), 'http://localhost')
        const path = url.pathname.slice(base.length).split('/').filter(Boolean)
        const body = req.method === 'POST' ? await readBody(req) : undefined
        await rt.router.dispatch({ method: String(req.method), path, query: url.searchParams, body }, res)
      } catch (error) {
        const status = isChengyingError(error) ? ({ 'not-found': 404, 'invalid-argument': 400, 'permission-denied': 403, 'authorization-required': 403, conflict: 409 } as Record<string, number>)[error.code] ?? 500 : 500
        sendJson(res, status, { code: isChengyingError(error) ? error.code : 'internal', message: errorMessage(error) })
      }
    },
  })
}
