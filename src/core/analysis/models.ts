/**
 * Specialised scoring models (aesthetic / technical-quality predictors such as
 * NIMA, LAION aesthetic heads, MUSIQ, CLIP-IQA, face/eye detectors…), plugged
 * in through three generic adapters so no model weights ship with the plugin:
 *
 *  - command: run a local program; it receives image paths and prints JSON
 *  - http:    POST images to a model server; it answers JSON
 *  - onnx:    run an ONNX model in-process through onnxruntime-node (optional
 *             dependency, loaded only when configured)
 *
 * Every adapter returns ScoreSets stored under source `model:<id>`.
 */
import { readFile } from 'node:fs/promises'
import sharp from 'sharp'
import { run } from '../util/proc.ts'
import { ChengyingError, errorMessage } from '../util/errors.ts'
import { clamp } from '../util/misc.ts'
import type { ScoreSet } from '../types.ts'

export type ModelConfig =
  | { id: string; type: 'command'; command: string; args?: string[]; batchSize?: number; timeoutMs?: number; dimension?: string }
  | { id: string; type: 'http'; url: string; headers?: Record<string, string>; batchSize?: number; timeoutMs?: number; dimension?: string }
  | {
      id: string
      type: 'onnx'
      model: string
      /** nima: 10-bin distribution → mean ×10; regression: single value mapped from [min,max]; logits-tags: multi-label */
      head: 'nima' | 'regression'
      size?: number
      mean?: [number, number, number]
      std?: [number, number, number]
      range?: [number, number]
      inputName?: string
      outputName?: string
      dimension?: string
    }

export interface ModelScorer {
  readonly id: string
  readonly batchSize: number
  score(paths: string[], signal?: AbortSignal): Promise<ScoreSet[]>
  close?(): Promise<void>
}

/** Map a raw model answer object onto a ScoreSet. Accepts {score}|{aesthetic,...}|number. */
export function toScoreSet(raw: unknown, dimension = 'aesthetic'): ScoreSet {
  if (typeof raw === 'number') return { [dimension]: clamp(raw <= 10 ? raw * 10 : raw, 0, 100), detail: { raw } }
  if (typeof raw !== 'object' || raw === null) return {}
  const r = raw as Record<string, unknown>
  const out: ScoreSet = { detail: r }
  for (const k of ['technical', 'aesthetic', 'composition', 'content', 'story', 'potential'] as const) {
    if (typeof r[k] === 'number') out[k] = clamp(r[k] as number, 0, 100)
  }
  if (typeof r.score === 'number') (out as Record<string, unknown>)[dimension] = clamp((r.score as number) <= 10 ? (r.score as number) * 10 : r.score as number, 0, 100)
  if (Array.isArray(r.tags)) out.tags = r.tags.map(String)
  if (Array.isArray(r.issues)) out.issues = r.issues.map(String)
  return out
}

class CommandScorer implements ModelScorer {
  readonly batchSize: number
  constructor(private readonly cfg: Extract<ModelConfig, { type: 'command' }>) { this.batchSize = cfg.batchSize ?? 16 }
  get id(): string { return this.cfg.id }
  async score(paths: string[], signal?: AbortSignal): Promise<ScoreSet[]> {
    const args = (this.cfg.args ?? ['{paths}']).flatMap(a => (a === '{paths}' ? paths : [a]))
    const r = await run(this.cfg.command, args, { timeoutMs: this.cfg.timeoutMs ?? 300_000, signal })
    if (r.code !== 0) throw new ChengyingError('engine-failed', `model ${this.cfg.id} exited ${r.code}: ${r.stderr.slice(-500)}`)
    // Either a JSON array (same order) or JSON lines with {path,...}.
    const text = r.stdout.trim()
    let rows: unknown[]
    if (text.startsWith('[')) rows = JSON.parse(text) as unknown[]
    else rows = text.split('\n').filter(Boolean).map(l => JSON.parse(l) as unknown)
    const byPath = new Map<string, unknown>()
    for (const row of rows) if (typeof row === 'object' && row !== null && 'path' in row) byPath.set(String((row as { path: unknown }).path), row)
    return paths.map((p, i) => toScoreSet(byPath.get(p) ?? rows[i], this.cfg.dimension))
  }
}

class HttpScorer implements ModelScorer {
  readonly batchSize: number
  constructor(private readonly cfg: Extract<ModelConfig, { type: 'http' }>) { this.batchSize = cfg.batchSize ?? 8 }
  get id(): string { return this.cfg.id }
  async score(paths: string[], signal?: AbortSignal): Promise<ScoreSet[]> {
    const images = await Promise.all(paths.map(async p => ({ path: p, data: (await sharp(p).resize(768, 768, { fit: 'inside' }).jpeg({ quality: 88 }).toBuffer()).toString('base64') })))
    const ctl = AbortSignal.timeout(this.cfg.timeoutMs ?? 120_000)
    const res = await fetch(this.cfg.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(this.cfg.headers ?? {}) },
      body: JSON.stringify({ images }),
      signal: signal === undefined ? ctl : AbortSignal.any([signal, ctl]),
    })
    if (!res.ok) throw new ChengyingError('engine-failed', `model ${this.cfg.id} HTTP ${res.status}`)
    const body = await res.json() as unknown
    const rows = Array.isArray(body) ? body : Array.isArray((body as { results?: unknown[] }).results) ? (body as { results: unknown[] }).results : []
    return paths.map((_, i) => toScoreSet(rows[i], this.cfg.dimension))
  }
}

interface OrtModule {
  InferenceSession: { create(path: string | Uint8Array): Promise<OrtSession> }
  Tensor: new (type: string, data: Float32Array, dims: number[]) => unknown
}
interface OrtSession {
  inputNames: string[]
  outputNames: string[]
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array | number[] }>>
}

class OnnxScorer implements ModelScorer {
  readonly batchSize = 1
  private session: OrtSession | undefined
  private ort: OrtModule | undefined
  constructor(private readonly cfg: Extract<ModelConfig, { type: 'onnx' }>) {}
  get id(): string { return this.cfg.id }

  private async init(): Promise<{ ort: OrtModule; session: OrtSession }> {
    if (this.ort !== undefined && this.session !== undefined) return { ort: this.ort, session: this.session }
    try {
      const name = 'onnxruntime-node'
      this.ort = await import(name) as OrtModule
    } catch (error) {
      throw new ChengyingError('engine-unavailable', `onnx model ${this.cfg.id} needs the optional dependency onnxruntime-node (${errorMessage(error)})`)
    }
    this.session = await this.ort.InferenceSession.create(new Uint8Array(await readFile(this.cfg.model)))
    return { ort: this.ort, session: this.session }
  }

  async score(paths: string[]): Promise<ScoreSet[]> {
    const { ort, session } = await this.init()
    const size = this.cfg.size ?? 224
    const mean = this.cfg.mean ?? [0.485, 0.456, 0.406]
    const std = this.cfg.std ?? [0.229, 0.224, 0.225]
    const out: ScoreSet[] = []
    for (const p of paths) {
      const { data } = await sharp(p).resize(size, size, { fit: 'cover' }).removeAlpha().raw().toBuffer({ resolveWithObject: true })
      const t = new Float32Array(3 * size * size)
      for (let i = 0; i < size * size; i++) {
        for (let c = 0; c < 3; c++) t[c * size * size + i] = ((data[i * 3 + c] as number) / 255 - (mean[c] as number)) / (std[c] as number)
      }
      const input = this.cfg.inputName ?? session.inputNames[0] as string
      const result = await session.run({ [input]: new ort.Tensor('float32', t, [1, 3, size, size]) })
      const output = result[this.cfg.outputName ?? session.outputNames[0] as string]
      const values = Array.from(output?.data ?? [])
      let v: number
      if (this.cfg.head === 'nima') {
        const sum = values.reduce((a, b) => a + b, 0) || 1
        v = values.reduce((a, b, i) => a + (i + 1) * b, 0) / sum * 10
      } else {
        const [lo, hi] = this.cfg.range ?? [0, 1]
        v = ((values[0] ?? 0) - lo) / (hi - lo) * 100
      }
      out.push({ [this.cfg.dimension ?? 'aesthetic']: clamp(v, 0, 100), detail: { raw: values.slice(0, 16) } })
    }
    return out
  }
}

export function createModelScorer(cfg: ModelConfig): ModelScorer {
  switch (cfg.type) {
    case 'command': return new CommandScorer(cfg)
    case 'http': return new HttpScorer(cfg)
    case 'onnx': return new OnnxScorer(cfg)
  }
}
