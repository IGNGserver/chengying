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
import { clamp, round } from '../util/misc.ts'
import { computeFeatures } from './pixels.ts'
import { aestheticScore, technicalScore } from './scoring.ts'
import type { ScoreSet } from '../types.ts'

export type ScoreScale = 'auto' | '0-1' | '0-10' | '0-100'

export type ModelConfig =
  | { id: string; type: 'builtin'; maxEdge?: number; batchSize?: number; dimension?: string; scale?: ScoreScale }
  | { id: string; type: 'command'; command: string; args?: string[]; batchSize?: number; timeoutMs?: number; dimension?: string; scale?: ScoreScale }
  | { id: string; type: 'http'; url: string; headers?: Record<string, string>; batchSize?: number; timeoutMs?: number; dimension?: string; scale?: ScoreScale }
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

function normalized(value: number, scale: ScoreScale): number | undefined {
  if (!Number.isFinite(value) || value < 0) return undefined
  const maximum = scale === '0-1' ? 1 : scale === '0-10' ? 10 : 100
  if (value > maximum) return undefined
  const multiplier = scale === '0-1' ? 100 : scale === '0-10' ? 10 : scale === '0-100' ? 1 : value <= 1 ? 100 : value <= 10 ? 10 : 1
  return clamp(value * multiplier, 0, 100)
}

/** Map a raw model answer object onto a ScoreSet. Accepts {score}|{aesthetic,...}|number. */
export function toScoreSet(raw: unknown, dimension = 'aesthetic', scale: ScoreScale = 'auto'): ScoreSet {
  if (typeof raw === 'number') {
    const value = normalized(raw, scale)
    return value === undefined ? { detail: { raw } } : { [dimension]: value, detail: { raw } }
  }
  if (typeof raw !== 'object' || raw === null) return {}
  const r = raw as Record<string, unknown>
  const out: ScoreSet = { detail: r }
  for (const k of ['technical', 'aesthetic', 'composition', 'content', 'story', 'potential'] as const) {
    if (typeof r[k] === 'number') out[k] = normalized(r[k] as number, scale)
  }
  if (typeof r.score === 'number' && out[dimension as keyof ScoreSet] === undefined) (out as Record<string, unknown>)[dimension] = normalized(r.score as number, scale)
  if (Array.isArray(r.tags)) out.tags = r.tags.map(String)
  if (Array.isArray(r.issues)) out.issues = r.issues.map(String)
  return out
}

function orderedRows(rows: unknown[], paths: string[], modelId: string): unknown[] {
  const identified = rows.map(row => typeof row === 'object' && row !== null && 'path' in row)
  if (identified.some(Boolean)) {
    if (!identified.every(Boolean)) throw new ChengyingError('engine-failed', `model ${modelId} mixed identified and positional results`)
    const byPath = new Map<string, unknown>()
    for (const row of rows) {
      const path = String((row as { path: unknown }).path)
      if (byPath.has(path)) throw new ChengyingError('engine-failed', `model ${modelId} returned duplicate path ${path}`)
      byPath.set(path, row)
    }
    if (byPath.size !== paths.length || paths.some(path => !byPath.has(path))) throw new ChengyingError('engine-failed', `model ${modelId} results do not match the requested image paths`)
    return paths.map(path => byPath.get(path))
  }
  if (rows.length !== paths.length) throw new ChengyingError('engine-failed', `model ${modelId} returned ${rows.length} results for ${paths.length} images`)
  return rows
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
    const ordered = orderedRows(rows, paths, this.cfg.id)
    return paths.map((_, i) => toScoreSet(ordered[i], this.cfg.dimension, this.cfg.scale))
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
    const ordered = orderedRows(rows, paths, this.cfg.id)
    return paths.map((_, i) => toScoreSet(ordered[i], this.cfg.dimension, this.cfg.scale))
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
        if (values.length !== 10 || values.some(value => !Number.isFinite(value) || value < 0) || values.reduce((a, b) => a + b, 0) <= 0) throw new ChengyingError('engine-failed', `model ${this.cfg.id} NIMA head must return 10 finite non-negative weights with positive mass`)
        const sum = values.reduce((a, b) => a + b, 0)
        v = values.reduce((a, b, i) => a + (i + 1) * b, 0) / sum * 10
      } else {
        const [lo, hi] = this.cfg.range ?? [0, 1]
        if (values.length === 0 || !Number.isFinite(values[0])) throw new ChengyingError('engine-failed', `model ${this.cfg.id} regression head returned no finite value`)
        v = ((values[0] as number) - lo) / (hi - lo) * 100
      }
      out.push({ [this.cfg.dimension ?? 'aesthetic']: clamp(v, 0, 100), detail: { raw: values.slice(0, 16) } })
    }
    return out
  }
}

/**
 * Built-in high-resolution crop scorer: decodes at higher resolution (default
 * 1024 px) to inspect fine portrait focus, eye-band openness and micro-contrast
 * without requiring external binaries or ONNX weights.
 */
class BuiltinScorer implements ModelScorer {
  readonly batchSize: number
  constructor(private readonly cfg: Extract<ModelConfig, { type: 'builtin' }>) { this.batchSize = cfg.batchSize ?? 8 }
  get id(): string { return this.cfg.id }
  async score(paths: string[], signal?: AbortSignal): Promise<ScoreSet[]> {
    const edge = this.cfg.maxEdge ?? 1024
    const out: ScoreSet[] = []
    for (const p of paths) {
      signal?.throwIfAborted()
      const { data, info } = await sharp(p, { failOn: 'none' }).resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true }).removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true })
      const f = computeFeatures({ width: info.width, height: info.height, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) })
      const tech = technicalScore(f, { isRaw: false })
      const aes = aestheticScore(f, { isRaw: false })
      out.push({
        technical: tech.technical,
        aesthetic: aes.aesthetic,
        composition: aes.composition,
        content: f.subject && f.subject.faceRegions > 0 ? round(clamp(65 + f.subject.eyeLineContrast * 30 - (f.subject.eyesClosedSuspected ? 25 : 0), 0, 100), 1) : undefined,
        tags: tech.tags,
        issues: [...new Set([...(tech.issues ?? []), ...(aes.issues ?? [])])],
        detail: { ...tech.detail, highResEdge: Math.max(info.width, info.height) },
      })
    }
    return out
  }
}

export function validateModelConfig(cfg: ModelConfig): void {
  if (cfg.id.trim() === '') throw new ChengyingError('invalid-argument', 'model id must not be empty')
  if ('batchSize' in cfg && cfg.batchSize !== undefined && (!Number.isInteger(cfg.batchSize) || cfg.batchSize < 1)) throw new ChengyingError('invalid-argument', `model ${cfg.id} batchSize must be a positive integer`)
  if ('timeoutMs' in cfg && cfg.timeoutMs !== undefined && (!Number.isFinite(cfg.timeoutMs) || cfg.timeoutMs < 1)) throw new ChengyingError('invalid-argument', `model ${cfg.id} timeoutMs must be positive`)
  if (cfg.type === 'builtin' && cfg.maxEdge !== undefined && (!Number.isInteger(cfg.maxEdge) || cfg.maxEdge < 16)) throw new ChengyingError('invalid-argument', `model ${cfg.id} maxEdge must be an integer ≥ 16`)
  if (cfg.type === 'command' && cfg.command.trim() === '') throw new ChengyingError('invalid-argument', `model ${cfg.id} command must not be empty`)
  if (cfg.type === 'http') {
    const url = new URL(cfg.url)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ChengyingError('invalid-argument', `model ${cfg.id} URL must use HTTP(S)`)
  }
  if (cfg.type === 'onnx') {
    if (cfg.size !== undefined && (!Number.isInteger(cfg.size) || cfg.size < 1)) throw new ChengyingError('invalid-argument', `model ${cfg.id} size must be a positive integer`)
    if (cfg.std?.some(value => !Number.isFinite(value) || value === 0) === true) throw new ChengyingError('invalid-argument', `model ${cfg.id} std values must be finite and nonzero`)
    if (cfg.range !== undefined && (!cfg.range.every(Number.isFinite) || cfg.range[1] <= cfg.range[0])) throw new ChengyingError('invalid-argument', `model ${cfg.id} range must be finite and increasing`)
  }
}

export function createModelScorer(cfg: ModelConfig): ModelScorer {
  validateModelConfig(cfg)
  switch (cfg.type) {
    case 'builtin': return new BuiltinScorer(cfg)
    case 'command': return new CommandScorer(cfg)
    case 'http': return new HttpScorer(cfg)
    case 'onnx': return new OnnxScorer(cfg)
  }
}
