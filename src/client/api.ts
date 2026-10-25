/** Typed fetch helpers for the Chengying Host API (same origin, Harness session cookie). */
export const API_BASE = '/api/chengying'

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}

export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: init?.method ?? 'GET',
    credentials: 'same-origin',
    headers: init?.body === undefined ? undefined : { 'content-type': 'application/json' },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  })
  const text = await res.text()
  const data = text === '' ? undefined : JSON.parse(text) as unknown
  if (!res.ok) {
    const d = (data ?? {}) as { code?: string; message?: string }
    throw new ApiError(res.status, d.code ?? 'http', d.message ?? `HTTP ${res.status}`)
  }
  return data as T
}

export const imageUrl = (project: string, shot: string, variant: 'thumb' | 'preview'): string => `${API_BASE}/p/${encodeURIComponent(project)}/image/${encodeURIComponent(shot)}/${variant}`
export const renderUrl = (project: string, revision: string): string => `${API_BASE}/p/${encodeURIComponent(project)}/render/${encodeURIComponent(revision)}`
export const exportUrl = (project: string, exportId: string): string => `${API_BASE}/p/${encodeURIComponent(project)}/export-file/${encodeURIComponent(exportId)}`

export interface Summary {
  projectId: string; root: string; stateDir: string; exportDir: string; shots: number; raw: number; pairs: number
  withPreview: number; analyzed: number; judged: number; groups: Record<string, number>; selections: number
  tasks: Record<string, number>; exports: number
  usage: Array<{ purpose: string; provider: string | null; model: string | null; calls: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; images: number }>
}

export interface ShotRow {
  id: string; time: string | null; day: string | null; camera: string | null; raw: boolean; flag: 'pick' | 'reject' | null; rating: number | null
  scores: Record<'technical' | 'aesthetic' | 'composition' | 'content' | 'story' | 'potential', number | undefined>
  tags: string[]; issues: string[]; caption?: string; sources: string[]
  selection?: { included: boolean; rank: number; reason: string; locked: boolean; source: string }
}

export interface Activity { id: string; projectId: string | null; kind: string; label: string; state: string; stage: string; done: number; total: number; error?: string; startedAt: string; finishedAt?: string }

export interface SelectionInfo { id: string; name: string; request: string | null; createdAt: string; count: number; stats: Record<string, unknown> }

export interface TaskInfo {
  id: string; shotId: string; status: string; engine: string | null; instructions: string; attempts: number; maxAttempts: number
  error: string | null; headRevision: string | null; agentSession: string | null; createdAt: string; updatedAt: string
  startedAt: string | null; finishedAt: string | null
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; images: number; calls: number }
}

export interface RevisionInfo { id: string; parentId: string | null; seq: number; message: string; author: string; createdAt: string; previewPath: string | null; doc: { stages: Array<{ engine: string; steps: Array<{ id: string; op: string; enabled: boolean; params: Record<string, unknown>; mask?: unknown; label?: string }> }>; provenance?: { generative?: boolean } } }

export interface EventInfo { id: number; taskId: string | null; ts: string; level: string; type: string; message: string; data: unknown }
