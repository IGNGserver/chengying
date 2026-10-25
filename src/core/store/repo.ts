/** Typed data access over the project database. */
import type { Db } from './db.ts'
import type {
  EditDocument, Features, FileRecord, Group, GroupKind, RevisionRecord, ScoreSet, SelectionItem, SelectionSpec,
  Shot, TaskRecord, TaskStatus, UsageTotals,
} from '../types.ts'
import { newId, nowIso, parseJson } from '../util/misc.ts'

type R = Record<string, unknown>

const s = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))
const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))

export function emptyUsage(): UsageTotals {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, images: 0, calls: 0 }
}

function fileFromRow(r: R): FileRecord {
  return {
    id: String(r.id), shotId: s(r.shot_id), path: String(r.path), relPath: String(r.rel_path), dir: String(r.dir),
    base: String(r.base), ext: String(r.ext), kind: r.kind === 'raw' ? 'raw' : 'raster', format: String(r.format),
    size: Number(r.size), mtimeMs: Number(r.mtime_ms), sha256: s(r.sha256), status: r.status === 'error' ? 'error' : 'ok',
    error: s(r.error), meta: parseJson(s(r.meta_json), {}),
  }
}

function shotFromRow(r: R): Shot {
  const lat = n(r.gps_lat)
  const lon = n(r.gps_lon)
  const alt = n(r.gps_alt)
  return {
    id: String(r.id), primaryFile: String(r.primary_file), rawFile: s(r.raw_file), rasterFile: s(r.raster_file),
    captureTime: s(r.capture_time), captureTs: n(r.capture_ts), tzOffset: s(r.tz_offset), day: s(r.day),
    gps: lat !== null && lon !== null ? { lat, lon, ...(alt === null ? {} : { alt }) } : null,
    camera: s(r.camera), lens: s(r.lens), iso: n(r.iso), exposureTime: n(r.exposure_time), aperture: n(r.aperture),
    focalLength: n(r.focal_length), width: n(r.width), height: n(r.height), orientation: n(r.orientation),
    previewPath: s(r.preview_path), thumbPath: s(r.thumb_path), previewSource: s(r.preview_source), previewError: s(r.preview_error),
    userFlag: r.user_flag === 'pick' || r.user_flag === 'reject' ? r.user_flag : null, userRating: n(r.user_rating),
    note: s(r.note), tags: parseJson<string[]>(s(r.tags_json), []),
  }
}

function taskFromRow(r: R): TaskRecord {
  return {
    id: String(r.id), kind: 'edit', shotId: String(r.shot_id), selectionId: s(r.selection_id), status: String(r.status) as TaskStatus,
    priority: Number(r.priority ?? 0), engine: s(r.engine), instructions: String(r.instructions ?? ''),
    options: parseJson(s(r.options_json), {}), attempts: Number(r.attempts ?? 0), maxAttempts: Number(r.max_attempts ?? 3),
    error: s(r.error), headRevision: s(r.head_revision), agentSession: s(r.agent_session),
    usage: { ...emptyUsage(), ...parseJson(s(r.usage_json), {}) }, createdAt: String(r.created_at), updatedAt: String(r.updated_at),
    startedAt: s(r.started_at), finishedAt: s(r.finished_at),
  }
}

function revisionFromRow(r: R): RevisionRecord {
  return {
    id: String(r.id), taskId: String(r.task_id), parentId: s(r.parent_id), seq: Number(r.seq),
    doc: parseJson<EditDocument>(s(r.doc_json), { schema: 1, sourceFile: '', stages: [] }), message: String(r.message ?? ''),
    author: String(r.author ?? ''), createdAt: String(r.created_at), previewPath: s(r.preview_path),
    stats: parseJson<Record<string, unknown> | null>(s(r.stats_json), null),
  }
}

export interface EventRecord { id: number; taskId: string | null; ts: string; level: string; type: string; message: string; data: unknown }

export class Repo {
  constructor(readonly db: Db) {}

  /* files */
  fileByPath(path: string): FileRecord | undefined {
    const r = this.db.get<R>('SELECT * FROM files WHERE path = ?', path)
    return r === undefined ? undefined : fileFromRow(r)
  }
  file(id: string): FileRecord | undefined {
    const r = this.db.get<R>('SELECT * FROM files WHERE id = ?', id)
    return r === undefined ? undefined : fileFromRow(r)
  }
  files(): FileRecord[] {
    return this.db.all<R>('SELECT * FROM files ORDER BY rel_path').map(fileFromRow)
  }
  filesOfShot(shotId: string): FileRecord[] {
    return this.db.all<R>('SELECT * FROM files WHERE shot_id = ? ORDER BY kind, rel_path', shotId).map(fileFromRow)
  }
  isOriginalPath(path: string): boolean {
    return this.db.get('SELECT 1 FROM files WHERE path = ?', path) !== undefined
  }
  saveFile(f: FileRecord): void {
    this.db.upsert('files', {
      id: f.id, shot_id: f.shotId, path: f.path, rel_path: f.relPath, dir: f.dir, base: f.base, ext: f.ext, kind: f.kind,
      format: f.format, size: f.size, mtime_ms: f.mtimeMs, sha256: f.sha256, status: f.status, error: f.error,
      meta_json: JSON.stringify(f.meta), scanned_at: nowIso(),
    })
  }
  deleteFilesNotIn(paths: Set<string>): number {
    let removed = 0
    for (const f of this.db.all<{ id: string; path: string }>('SELECT id, path FROM files')) {
      if (!paths.has(f.path)) { this.db.run('DELETE FROM files WHERE id = ?', f.id); removed++ }
    }
    return removed
  }

  /* shots */
  shot(id: string): Shot | undefined {
    const r = this.db.get<R>('SELECT * FROM shots WHERE id = ?', id)
    return r === undefined ? undefined : shotFromRow(r)
  }
  shots(): Shot[] {
    return this.db.all<R>('SELECT * FROM shots ORDER BY capture_ts IS NULL, capture_ts, id').map(shotFromRow)
  }
  shotCount(): number {
    return Number(this.db.get<{ c: number }>('SELECT count(*) c FROM shots')?.c ?? 0)
  }
  saveShot(sh: Shot): void {
    const now = nowIso()
    this.db.upsert('shots', {
      id: sh.id, primary_file: sh.primaryFile, raw_file: sh.rawFile, raster_file: sh.rasterFile, capture_time: sh.captureTime,
      capture_ts: sh.captureTs, tz_offset: sh.tzOffset, day: sh.day, gps_lat: sh.gps?.lat ?? null, gps_lon: sh.gps?.lon ?? null,
      gps_alt: sh.gps?.alt ?? null, camera: sh.camera, lens: sh.lens, iso: sh.iso, exposure_time: sh.exposureTime,
      aperture: sh.aperture, focal_length: sh.focalLength, width: sh.width, height: sh.height, orientation: sh.orientation,
      preview_path: sh.previewPath, thumb_path: sh.thumbPath, preview_source: sh.previewSource, preview_error: sh.previewError,
      user_flag: sh.userFlag, user_rating: sh.userRating, note: sh.note, tags_json: JSON.stringify(sh.tags),
      created_at: now, updated_at: now,
    })
  }
  updateShot(id: string, patch: Partial<Pick<Shot, 'previewPath' | 'thumbPath' | 'previewSource' | 'previewError' | 'userFlag' | 'userRating' | 'note' | 'tags' | 'width' | 'height'>>): void {
    const cols: string[] = []
    const vals: Array<string | number | null> = []
    const map: Record<string, string> = {
      previewPath: 'preview_path', thumbPath: 'thumb_path', previewSource: 'preview_source', previewError: 'preview_error',
      userFlag: 'user_flag', userRating: 'user_rating', note: 'note', width: 'width', height: 'height',
    }
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'tags') { cols.push('tags_json = ?'); vals.push(JSON.stringify(v)); continue }
      const col = map[k]
      if (col === undefined) continue
      cols.push(`${col} = ?`)
      vals.push(v as string | number | null)
    }
    if (cols.length === 0) return
    cols.push('updated_at = ?'); vals.push(nowIso())
    this.db.run(`UPDATE shots SET ${cols.join(', ')} WHERE id = ?`, ...vals, id)
  }
  deleteShotsNotIn(ids: Set<string>): number {
    let removed = 0
    for (const r of this.db.all<{ id: string }>('SELECT id FROM shots')) {
      if (!ids.has(r.id)) {
        this.db.run('DELETE FROM shots WHERE id = ?', r.id)
        this.db.run('DELETE FROM features WHERE shot_id = ?', r.id)
        this.db.run('DELETE FROM scores WHERE shot_id = ?', r.id)
        removed++
      }
    }
    return removed
  }

  /* features & scores */
  features(shotId: string): Features | undefined {
    const r = this.db.get<{ json: string }>('SELECT json FROM features WHERE shot_id = ?', shotId)
    return r === undefined ? undefined : parseJson<Features | undefined>(r.json, undefined)
  }
  allFeatures(): Map<string, Features> {
    const m = new Map<string, Features>()
    for (const r of this.db.all<{ shot_id: string; json: string }>('SELECT shot_id, json FROM features')) {
      const f = parseJson<Features | undefined>(r.json, undefined)
      if (f !== undefined) m.set(r.shot_id, f)
    }
    return m
  }
  saveFeatures(shotId: string, f: Features): void {
    this.db.upsert('features', { shot_id: shotId, version: f.version, json: JSON.stringify(f), phash: f.phash, dhash: f.dhash, updated_at: nowIso() }, ['shot_id'])
  }
  saveScore(shotId: string, source: string, score: ScoreSet, version = 1): void {
    this.db.upsert('scores', {
      shot_id: shotId, source, version, json: JSON.stringify(score), overall: score.overall ?? null, updated_at: nowIso(),
    }, ['shot_id', 'source'])
  }
  scores(shotId: string): Record<string, ScoreSet> {
    const out: Record<string, ScoreSet> = {}
    for (const r of this.db.all<{ source: string; json: string }>('SELECT source, json FROM scores WHERE shot_id = ?', shotId)) {
      out[r.source] = parseJson<ScoreSet>(r.json, {})
    }
    return out
  }
  allScores(): Map<string, Record<string, ScoreSet>> {
    const m = new Map<string, Record<string, ScoreSet>>()
    for (const r of this.db.all<{ shot_id: string; source: string; json: string }>('SELECT shot_id, source, json FROM scores')) {
      const entry = m.get(r.shot_id) ?? {}
      entry[r.source] = parseJson<ScoreSet>(r.json, {})
      m.set(r.shot_id, entry)
    }
    return m
  }

  /* groups */
  replaceGroups(kind: GroupKind, groups: Group[]): void {
    this.db.tx(() => {
      for (const g of this.db.all<{ id: string }>('SELECT id FROM groups WHERE kind = ?', kind)) {
        this.db.run('DELETE FROM group_members WHERE group_id = ?', g.id)
      }
      this.db.run('DELETE FROM groups WHERE kind = ?', kind)
      for (const g of groups) {
        this.db.upsert('groups', { id: g.id, kind: g.kind, label: g.label, json: JSON.stringify(g.info), created_at: nowIso() })
        for (const m of g.members) this.db.upsert('group_members', { group_id: g.id, shot_id: m.shotId, rank: m.rank, role: m.role }, ['group_id', 'shot_id'])
      }
    })
  }
  groups(kind?: GroupKind): Group[] {
    const rows = kind === undefined ? this.db.all<R>('SELECT * FROM groups ORDER BY kind, label') : this.db.all<R>('SELECT * FROM groups WHERE kind = ? ORDER BY label', kind)
    return rows.map(r => ({
      id: String(r.id), kind: String(r.kind) as GroupKind, label: String(r.label), info: parseJson(s(r.json), {}),
      members: this.db.all<R>('SELECT * FROM group_members WHERE group_id = ? ORDER BY rank', String(r.id)).map(m => ({
        shotId: String(m.shot_id), rank: Number(m.rank), role: m.role === 'best' ? 'best' as const : 'member' as const,
      })),
    }))
  }
  groupOf(shotId: string, kind: GroupKind): string | undefined {
    return this.db.get<{ id: string }>('SELECT g.id id FROM groups g JOIN group_members m ON m.group_id = g.id WHERE m.shot_id = ? AND g.kind = ?', shotId, kind)?.id
  }

  /* selections */
  createSelection(name: string, spec: SelectionSpec, items: SelectionItem[], stats: Record<string, unknown>): string {
    const id = newId('sel')
    const now = nowIso()
    this.db.tx(() => {
      this.db.upsert('selections', { id, name, request: spec.request ?? null, spec_json: JSON.stringify(spec), stats_json: JSON.stringify(stats), status: 'active', created_at: now, updated_at: now })
      for (const it of items) this.saveSelectionItem(id, it)
    })
    return id
  }
  saveSelectionItem(selectionId: string, it: SelectionItem): void {
    this.db.upsert('selection_items', {
      selection_id: selectionId, shot_id: it.shotId, rank: it.rank, score: it.score, reason: it.reason, source: it.source,
      locked: it.locked ? 1 : 0, included: it.included ? 1 : 0,
    }, ['selection_id', 'shot_id'])
    this.db.run('UPDATE selections SET updated_at = ? WHERE id = ?', nowIso(), selectionId)
  }
  selections(): Array<{ id: string; name: string; request: string | null; spec: SelectionSpec; stats: Record<string, unknown>; createdAt: string; updatedAt: string; count: number }> {
    return this.db.all<R>('SELECT s.*, (SELECT count(*) FROM selection_items i WHERE i.selection_id = s.id AND i.included = 1) cnt FROM selections s ORDER BY created_at DESC').map(r => ({
      id: String(r.id), name: String(r.name), request: s(r.request), spec: parseJson(s(r.spec_json), {}), stats: parseJson(s(r.stats_json), {}),
      createdAt: String(r.created_at), updatedAt: String(r.updated_at), count: Number(r.cnt),
    }))
  }
  selection(id: string): { id: string; name: string; spec: SelectionSpec; stats: Record<string, unknown>; items: SelectionItem[] } | undefined {
    const r = this.db.get<R>('SELECT * FROM selections WHERE id = ?', id)
    if (r === undefined) return undefined
    const items = this.db.all<R>('SELECT * FROM selection_items WHERE selection_id = ? ORDER BY included DESC, rank', id).map(i => ({
      shotId: String(i.shot_id), rank: Number(i.rank), score: Number(i.score), reason: String(i.reason ?? ''),
      source: i.source === 'user' ? 'user' as const : 'auto' as const, locked: Number(i.locked) === 1, included: Number(i.included) === 1,
    }))
    return { id, name: String(r.name), spec: parseJson(s(r.spec_json), {}), stats: parseJson(s(r.stats_json), {}), items }
  }
  latestSelectionId(): string | undefined {
    return this.db.get<{ id: string }>('SELECT id FROM selections ORDER BY created_at DESC LIMIT 1')?.id
  }

  /* tasks */
  createTask(t: Omit<TaskRecord, 'id' | 'createdAt' | 'updatedAt' | 'attempts' | 'usage' | 'startedAt' | 'finishedAt' | 'error' | 'headRevision' | 'agentSession'> & { id?: string }): TaskRecord {
    const id = t.id ?? newId('task')
    const now = nowIso()
    this.db.upsert('tasks', {
      id, kind: t.kind, shot_id: t.shotId, selection_id: t.selectionId, status: t.status, priority: t.priority, engine: t.engine,
      instructions: t.instructions, options_json: JSON.stringify(t.options), attempts: 0, max_attempts: t.maxAttempts,
      error: null, head_revision: null, agent_session: null, usage_json: JSON.stringify(emptyUsage()), created_at: now, updated_at: now,
      started_at: null, finished_at: null, lease_until: null,
    })
    return this.task(id) as TaskRecord
  }
  task(id: string): TaskRecord | undefined {
    const r = this.db.get<R>('SELECT * FROM tasks WHERE id = ?', id)
    return r === undefined ? undefined : taskFromRow(r)
  }
  tasks(filter: { status?: TaskStatus[]; selectionId?: string; shotId?: string } = {}): TaskRecord[] {
    const where: string[] = []
    const params: string[] = []
    if (filter.status !== undefined && filter.status.length > 0) { where.push(`status IN (${filter.status.map(() => '?').join(',')})`); params.push(...filter.status) }
    if (filter.selectionId !== undefined) { where.push('selection_id = ?'); params.push(filter.selectionId) }
    if (filter.shotId !== undefined) { where.push('shot_id = ?'); params.push(filter.shotId) }
    const sql = `SELECT * FROM tasks${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY priority DESC, created_at`
    return this.db.all<R>(sql, ...params).map(taskFromRow)
  }
  updateTask(id: string, patch: Partial<Pick<TaskRecord, 'status' | 'engine' | 'error' | 'headRevision' | 'agentSession' | 'attempts' | 'startedAt' | 'finishedAt' | 'instructions' | 'priority' | 'maxAttempts'>> & { usage?: UsageTotals; options?: Record<string, unknown> }): void {
    const map: Record<string, string> = {
      status: 'status', engine: 'engine', error: 'error', headRevision: 'head_revision', agentSession: 'agent_session', attempts: 'attempts',
      startedAt: 'started_at', finishedAt: 'finished_at', instructions: 'instructions', priority: 'priority', maxAttempts: 'max_attempts',
    }
    const cols: string[] = []
    const vals: Array<string | number | null> = []
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'usage') { cols.push('usage_json = ?'); vals.push(JSON.stringify(v)); continue }
      if (k === 'options') { cols.push('options_json = ?'); vals.push(JSON.stringify(v)); continue }
      const col = map[k]
      if (col === undefined) continue
      cols.push(`${col} = ?`)
      vals.push((v ?? null) as string | number | null)
    }
    cols.push('updated_at = ?'); vals.push(nowIso())
    this.db.run(`UPDATE tasks SET ${cols.join(', ')} WHERE id = ?`, ...vals, id)
  }

  /* revisions */
  addRevision(taskId: string, parentId: string | null, doc: EditDocument, message: string, author: string): RevisionRecord {
    const id = newId('rev')
    const seq = Number(this.db.get<{ m: number | null }>('SELECT max(seq) m FROM revisions WHERE task_id = ?', taskId)?.m ?? 0) + 1
    this.db.tx(() => {
      this.db.upsert('revisions', { id, task_id: taskId, parent_id: parentId, seq, doc_json: JSON.stringify(doc), message, author, created_at: nowIso(), preview_path: null, stats_json: null })
      this.db.run('UPDATE tasks SET head_revision = ?, updated_at = ? WHERE id = ?', id, nowIso(), taskId)
    })
    return this.revision(id) as RevisionRecord
  }
  revision(id: string): RevisionRecord | undefined {
    const r = this.db.get<R>('SELECT * FROM revisions WHERE id = ?', id)
    return r === undefined ? undefined : revisionFromRow(r)
  }
  revisions(taskId: string): RevisionRecord[] {
    return this.db.all<R>('SELECT * FROM revisions WHERE task_id = ? ORDER BY seq', taskId).map(revisionFromRow)
  }
  setRevisionPreview(id: string, previewPath: string, stats: Record<string, unknown> | null): void {
    this.db.run('UPDATE revisions SET preview_path = ?, stats_json = ? WHERE id = ?', previewPath, stats === null ? null : JSON.stringify(stats), id)
  }

  /* events & usage */
  addEvent(taskId: string | null, level: 'info' | 'warn' | 'error' | 'debug', type: string, message: string, data?: unknown): void {
    this.db.run('INSERT INTO events (task_id, ts, level, type, message, data_json) VALUES (?, ?, ?, ?, ?, ?)', taskId, nowIso(), level, type, message, data === undefined ? null : JSON.stringify(data))
  }
  events(filter: { taskId?: string; afterId?: number; limit?: number } = {}): EventRecord[] {
    const where: string[] = []
    const params: Array<string | number> = []
    if (filter.taskId !== undefined) { where.push('task_id = ?'); params.push(filter.taskId) }
    if (filter.afterId !== undefined) { where.push('id > ?'); params.push(filter.afterId) }
    const sql = `SELECT * FROM events${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`
    params.push(filter.limit ?? 200)
    return this.db.all<R>(sql, ...params).map(r => ({
      id: Number(r.id), taskId: s(r.task_id), ts: String(r.ts), level: String(r.level), type: String(r.type), message: String(r.message),
      data: parseJson(s(r.data_json), null),
    })).reverse()
  }
  addUsage(u: { taskId: string | null; purpose: string; provider?: string; model?: string; inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; images?: number }): void {
    this.db.run('INSERT INTO usage (task_id, purpose, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, images, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      u.taskId, u.purpose, u.provider ?? null, u.model ?? null, u.inputTokens ?? 0, u.outputTokens ?? 0, u.cacheReadTokens ?? 0, u.cacheWriteTokens ?? 0, u.images ?? 0, nowIso())
  }
  usageSummary(): Array<{ purpose: string; provider: string | null; model: string | null; calls: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; images: number }> {
    return this.db.all<R>(`SELECT purpose, provider, model, count(*) calls, sum(input_tokens) i, sum(output_tokens) o, sum(cache_read_tokens) cr, sum(cache_write_tokens) cw, sum(images) im
      FROM usage GROUP BY purpose, provider, model ORDER BY purpose`).map(r => ({
      purpose: String(r.purpose), provider: s(r.provider), model: s(r.model), calls: Number(r.calls), inputTokens: Number(r.i ?? 0),
      outputTokens: Number(r.o ?? 0), cacheReadTokens: Number(r.cr ?? 0), cacheWriteTokens: Number(r.cw ?? 0), images: Number(r.im ?? 0),
    }))
  }

  /* exports */
  addExport(e: { taskId: string | null; shotId: string; revisionId: string | null; path: string; format: string; verified: boolean; verify: unknown; recipePath: string | null }): string {
    const id = newId('exp')
    this.db.upsert('exports', { id, task_id: e.taskId, shot_id: e.shotId, revision_id: e.revisionId, path: e.path, format: e.format, verified: e.verified ? 1 : 0, verify_json: JSON.stringify(e.verify), recipe_path: e.recipePath, created_at: nowIso() })
    return id
  }
  exports(): Array<{ id: string; taskId: string | null; shotId: string; revisionId: string | null; path: string; format: string; verified: boolean; verify: unknown; recipePath: string | null; createdAt: string }> {
    return this.db.all<R>('SELECT * FROM exports ORDER BY created_at DESC').map(r => ({
      id: String(r.id), taskId: s(r.task_id), shotId: String(r.shot_id), revisionId: s(r.revision_id), path: String(r.path), format: String(r.format),
      verified: Number(r.verified) === 1, verify: parseJson(s(r.verify_json), null), recipePath: s(r.recipe_path), createdAt: String(r.created_at),
    }))
  }
  isExportPath(path: string): boolean {
    return this.db.get('SELECT 1 FROM exports WHERE path = ?', path) !== undefined
  }

  /* preferences, feedback, authorizations */
  pref<T>(key: string, fallback: T): T {
    return parseJson<T>(this.db.get<{ json: string }>('SELECT json FROM prefs WHERE key = ?', key)?.json, fallback)
  }
  setPref(key: string, value: unknown): void {
    this.db.upsert('prefs', { key, json: JSON.stringify(value), updated_at: nowIso() }, ['key'])
  }
  addFeedback(shotId: string, selectionId: string | null, label: 1 | -1, features: Record<string, number>): void {
    this.db.run('INSERT INTO feedback (shot_id, selection_id, label, features_json, ts) VALUES (?, ?, ?, ?, ?)', shotId, selectionId, label, JSON.stringify(features), nowIso())
  }
  feedback(): Array<{ shotId: string; label: number; features: Record<string, number> }> {
    return this.db.all<R>('SELECT * FROM feedback ORDER BY id').map(r => ({ shotId: String(r.shot_id), label: Number(r.label), features: parseJson(s(r.features_json), {}) }))
  }
  addAuthorization(a: { scope: string; shotId: string | null; taskId: string | null; grantedBy: string; note: string; expiresAt: string | null; maxUses: number | null }): string {
    const id = newId('auth')
    this.db.upsert('authorizations', { id, scope: a.scope, shot_id: a.shotId, task_id: a.taskId, granted_by: a.grantedBy, note: a.note, created_at: nowIso(), expires_at: a.expiresAt, revoked: 0, uses: 0, max_uses: a.maxUses })
    return id
  }
  authorizations(): Array<{ id: string; scope: string; shotId: string | null; taskId: string | null; grantedBy: string; note: string; createdAt: string; expiresAt: string | null; revoked: boolean; uses: number; maxUses: number | null }> {
    return this.db.all<R>('SELECT * FROM authorizations ORDER BY created_at DESC').map(r => ({
      id: String(r.id), scope: String(r.scope), shotId: s(r.shot_id), taskId: s(r.task_id), grantedBy: String(r.granted_by), note: String(r.note ?? ''),
      createdAt: String(r.created_at), expiresAt: s(r.expires_at), revoked: Number(r.revoked) === 1, uses: Number(r.uses), maxUses: n(r.max_uses),
    }))
  }
  consumeAuthorization(id: string): void {
    this.db.run('UPDATE authorizations SET uses = uses + 1 WHERE id = ?', id)
  }
  revokeAuthorization(id: string): void {
    this.db.run('UPDATE authorizations SET revoked = 1 WHERE id = ?', id)
  }
}
