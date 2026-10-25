/**
 * Worker pool for feature extraction so the Harness event loop stays
 * responsive while thousands of photos are analysed. Falls back to in-thread
 * computation when workers cannot start (e.g. a sandbox forbids threads).
 */
import { Worker } from 'node:worker_threads'
import { cpus } from 'node:os'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Features } from '../types.ts'
import { loadRgb } from '../image/preview.ts'
import { computeFeatures } from './pixels.ts'

function defaultWorkerUrl(): URL {
  const self = import.meta.url
  if (self.endsWith('.ts')) return new URL('./worker.ts', self)
  return new URL('./analysis-worker.js', self)
}

interface Pending { resolve: (f: Features) => void; reject: (e: Error) => void }

export class FeaturePool {
  private readonly workers: Worker[] = []
  private readonly idle: Worker[] = []
  private readonly queue: Array<{ id: number; path: string; maxEdge: number }> = []
  private readonly pending = new Map<number, Pending>()
  private readonly owner = new Map<number, Worker>()
  private nextId = 1
  private disabled = false

  constructor(private readonly size = Math.max(1, Math.min(6, Math.floor(cpus().length / 2))), private readonly workerUrl = defaultWorkerUrl()) {}

  private spawn(): Worker | undefined {
    if (this.disabled) return undefined
    try {
      if (!existsSync(fileURLToPath(this.workerUrl))) { this.disabled = true; return undefined }
      const w = new Worker(this.workerUrl)
      w.unref()
      w.on('message', (msg: { id: number; features?: Features; error?: string }) => {
        const p = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        this.owner.delete(msg.id)
        if (p !== undefined) {
          if (msg.features !== undefined) p.resolve(msg.features)
          else p.reject(new Error(msg.error ?? 'feature worker failed'))
        }
        this.idle.push(w)
        this.pump()
      })
      w.on('error', (err) => {
        for (const [id, worker] of this.owner) {
          if (worker !== w) continue
          this.pending.get(id)?.reject(err)
          this.pending.delete(id)
          this.owner.delete(id)
        }
        const i = this.workers.indexOf(w)
        if (i >= 0) this.workers.splice(i, 1)
        const j = this.idle.indexOf(w)
        if (j >= 0) this.idle.splice(j, 1)
        this.pump()
      })
      this.workers.push(w)
      return w
    } catch {
      this.disabled = true
      return undefined
    }
  }

  private pump(): void {
    while (this.queue.length > 0) {
      let w = this.idle.pop()
      if (w === undefined && this.workers.length < this.size) w = this.spawn()
      if (w === undefined) break
      const job = this.queue.shift()
      if (job === undefined) { this.idle.push(w); break }
      this.owner.set(job.id, w)
      w.postMessage(job)
    }
    if (this.disabled) {
      // In-thread fallback.
      while (this.queue.length > 0) {
        const job = this.queue.shift()
        if (job === undefined) break
        const p = this.pending.get(job.id)
        this.pending.delete(job.id)
        void loadRgb(job.path, job.maxEdge).then(img => p?.resolve(computeFeatures(img)), (e: Error) => p?.reject(e))
      }
    }
  }

  compute(path: string, maxEdge = 512): Promise<Features> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.queue.push({ id, path, maxEdge })
      this.pump()
    })
  }

  async close(): Promise<void> {
    await Promise.all(this.workers.map(w => w.terminate()))
    this.workers.length = 0
    this.idle.length = 0
  }
}
