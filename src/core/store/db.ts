/**
 * Per-project persistent store on node:sqlite (Node >= 24, no native addon).
 * The database lives in the project's state directory on local disk; it holds
 * every scan record, score, group, selection, task, edit revision, execution
 * event, model-usage row and export record so that work survives restarts.
 */
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const MIGRATIONS: string[] = [
  // v1
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE files (
    id TEXT PRIMARY KEY, shot_id TEXT, path TEXT NOT NULL UNIQUE, rel_path TEXT, dir TEXT, base TEXT, ext TEXT,
    kind TEXT, format TEXT, size INTEGER, mtime_ms INTEGER, sha256 TEXT, status TEXT, error TEXT,
    meta_json TEXT, scanned_at TEXT
  );
  CREATE INDEX files_shot ON files(shot_id);
  CREATE INDEX files_sha ON files(sha256);
  CREATE TABLE shots (
    id TEXT PRIMARY KEY, primary_file TEXT, raw_file TEXT, raster_file TEXT,
    capture_time TEXT, capture_ts REAL, tz_offset TEXT, day TEXT,
    gps_lat REAL, gps_lon REAL, gps_alt REAL,
    camera TEXT, lens TEXT, iso REAL, exposure_time REAL, aperture REAL, focal_length REAL,
    width INTEGER, height INTEGER, orientation INTEGER,
    preview_path TEXT, thumb_path TEXT, preview_source TEXT, preview_error TEXT,
    user_flag TEXT, user_rating INTEGER, note TEXT, tags_json TEXT,
    created_at TEXT, updated_at TEXT
  );
  CREATE INDEX shots_time ON shots(capture_ts);
  CREATE TABLE features (shot_id TEXT PRIMARY KEY, version INTEGER, json TEXT, phash TEXT, dhash TEXT, updated_at TEXT);
  CREATE TABLE scores (shot_id TEXT, source TEXT, version INTEGER, json TEXT, overall REAL, updated_at TEXT, PRIMARY KEY (shot_id, source));
  CREATE TABLE groups (id TEXT PRIMARY KEY, kind TEXT, label TEXT, json TEXT, created_at TEXT);
  CREATE TABLE group_members (group_id TEXT, shot_id TEXT, rank INTEGER, role TEXT, PRIMARY KEY (group_id, shot_id));
  CREATE INDEX group_members_shot ON group_members(shot_id);
  CREATE TABLE selections (id TEXT PRIMARY KEY, name TEXT, request TEXT, spec_json TEXT, stats_json TEXT, status TEXT, created_at TEXT, updated_at TEXT);
  CREATE TABLE selection_items (
    selection_id TEXT, shot_id TEXT, rank INTEGER, score REAL, reason TEXT, source TEXT,
    locked INTEGER DEFAULT 0, included INTEGER DEFAULT 1, PRIMARY KEY (selection_id, shot_id)
  );
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY, kind TEXT, shot_id TEXT, selection_id TEXT, status TEXT, priority INTEGER DEFAULT 0,
    engine TEXT, instructions TEXT, options_json TEXT, attempts INTEGER DEFAULT 0, max_attempts INTEGER DEFAULT 3,
    error TEXT, head_revision TEXT, agent_session TEXT, usage_json TEXT,
    created_at TEXT, updated_at TEXT, started_at TEXT, finished_at TEXT, lease_until TEXT
  );
  CREATE INDEX tasks_status ON tasks(status);
  CREATE TABLE revisions (
    id TEXT PRIMARY KEY, task_id TEXT, parent_id TEXT, seq INTEGER, doc_json TEXT, message TEXT, author TEXT,
    created_at TEXT, preview_path TEXT, stats_json TEXT
  );
  CREATE INDEX revisions_task ON revisions(task_id, seq);
  CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, ts TEXT, level TEXT, type TEXT, message TEXT, data_json TEXT);
  CREATE INDEX events_task ON events(task_id, id);
  CREATE TABLE usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, purpose TEXT, provider TEXT, model TEXT,
    input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, cache_read_tokens INTEGER DEFAULT 0,
    cache_write_tokens INTEGER DEFAULT 0, images INTEGER DEFAULT 0, ts TEXT
  );
  CREATE TABLE exports (
    id TEXT PRIMARY KEY, task_id TEXT, shot_id TEXT, revision_id TEXT, path TEXT, format TEXT,
    verified INTEGER, verify_json TEXT, recipe_path TEXT, created_at TEXT
  );
  CREATE TABLE prefs (key TEXT PRIMARY KEY, json TEXT, updated_at TEXT);
  CREATE TABLE authorizations (
    id TEXT PRIMARY KEY, scope TEXT, shot_id TEXT, task_id TEXT, granted_by TEXT, note TEXT,
    created_at TEXT, expires_at TEXT, revoked INTEGER DEFAULT 0, uses INTEGER DEFAULT 0, max_uses INTEGER
  );
  CREATE TABLE feedback (id INTEGER PRIMARY KEY AUTOINCREMENT, shot_id TEXT, selection_id TEXT, label INTEGER, features_json TEXT, ts TEXT);
  `,
]

export type Row = Record<string, SQLInputValue>

export class Db {
  readonly raw: DatabaseSync
  private readonly cache = new Map<string, StatementSync>()

  constructor(readonly path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.raw = new DatabaseSync(path)
    this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
    this.migrate()
  }

  private migrate(): void {
    const row = this.raw.prepare('PRAGMA user_version').get() as { user_version: number }
    let version = row.user_version
    while (version < MIGRATIONS.length) {
      const sql = MIGRATIONS[version] as string
      this.raw.exec('BEGIN')
      try {
        this.raw.exec(sql)
        this.raw.exec(`PRAGMA user_version = ${version + 1}`)
        this.raw.exec('COMMIT')
      } catch (error) {
        this.raw.exec('ROLLBACK')
        throw error
      }
      version++
    }
  }

  stmt(sql: string): StatementSync {
    let s = this.cache.get(sql)
    if (s === undefined) {
      s = this.raw.prepare(sql)
      this.cache.set(sql, s)
    }
    return s
  }

  all<T = Record<string, unknown>>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.stmt(sql).all(...params) as T[]
  }

  get<T = Record<string, unknown>>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.stmt(sql).get(...params) as T | undefined
  }

  run(sql: string, ...params: SQLInputValue[]): { changes: number; lastInsertRowid: number | bigint } {
    const r = this.stmt(sql).run(...params)
    return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid }
  }

  /** Insert or replace a row given as a plain object. */
  upsert(table: string, row: Row, conflict: string[] = ['id']): void {
    const cols = Object.keys(row)
    const updates = cols.filter(c => !conflict.includes(c)).map(c => `${c}=excluded.${c}`).join(', ')
    const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
      + (updates ? ` ON CONFLICT(${conflict.join(', ')}) DO UPDATE SET ${updates}` : ` ON CONFLICT(${conflict.join(', ')}) DO NOTHING`)
    this.stmt(sql).run(...cols.map(c => row[c] as SQLInputValue))
  }

  tx<T>(fn: () => T): T {
    if (this.raw.isTransaction) return fn()
    this.raw.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      this.raw.exec('COMMIT')
      return result
    } catch (error) {
      this.raw.exec('ROLLBACK')
      throw error
    }
  }

  getMeta(key: string): string | undefined {
    return this.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', key)?.value
  }

  setMeta(key: string, value: string): void {
    this.upsert('meta', { key, value }, ['key'])
  }

  close(): void {
    this.cache.clear()
    this.raw.close()
  }
}
