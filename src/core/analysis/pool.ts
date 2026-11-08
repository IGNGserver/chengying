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
interface Job { id: number; path: string; maxEdge: number }

export class FeaturePool {
  private readonly workers: Worker[] = []
  private readonly idle: Worker[] = []
  private readonly queue: Job[] = []
  private readonly pending = new Map<number, Pending>()
  private readonly owner = new Map<number, Worker>()
  private readonly fallbackJobs = new Set<Promise<void>>()
  private nextId = 1
  private disabled = false
  private closing = false
  private closePromise: Promise<void> | undefined

  constructor(private readonly size = Math.max(1, Math.min(6, Math.floor(cpus().length / 2))), private readonly workerUrl = defaultWorkerUrl()) {}

  private failWorker(worker: Worker, error: Error): void {
    for (const [id, owner] of this.owner) {
      if (owner !== worker) continue
      this.pending.get(id)?.reject(error)
      this.pending.delete(id)
      this.owner.delete(id)
    }
    const index = this.workers.indexOf(worker)
    if (index >= 0) this.workers.splice(index, 1)
    const idle = this.idle.indexOf(worker)
    if (idle >= 0) this.idle.splice(idle, 1)
    if (!this.closing) this.pump()
  }

  private spawn(): Worker | undefined {
    if (this.disabled || this.closing) return undefined
    try {
      if (!existsSync(fileURLToPath(this.workerUrl))) { this.disabled = true; return undefined }
      const worker = new Worker(this.workerUrl)
      worker.unref()
      worker.on('message', (msg: { id: number; features?: Features; error?: string }) => {
        if (this.owner.get(msg.id) !== worker) return
        const pending = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        this.owner.delete(msg.id)
        if (pending !== undefined) {
          if (msg.features !== undefined) pending.resolve(msg.features)
          else pending.reject(new Error(msg.error ?? 'feature worker failed'))
        }
        if (!this.closing && this.workers.includes(worker)) this.idle.push(worker)
        this.pump()
      })
      worker.on('error', error => {
        this.failWorker(worker, error)
        void worker.terminate()
      })
      worker.on('exit', code => {
        if (this.closing || !this.workers.includes(worker)) return
        this.failWorker(worker, new Error(`feature worker exited unexpectedly (${code})`))
      })
      this.workers.push(worker)
      return worker
    } catch {
      this.disabled = true
      return undefined
    }
  }

  private runFallback(job: Job): void {
    const pending = this.pending.get(job.id)
    const promise = loadRgb(job.path, job.maxEdge)
      .then(image => pending?.resolve(computeFeatures(image)), (error: Error) => pending?.reject(error))
      .catch(() => undefined)
      .finally(() => { if (this.pending.get(job.id) === pending) this.pending.delete(job.id) })
    this.fallbackJobs.add(promise)
    void promise.finally(() => { this.fallbackJobs.delete(promise) })
  }

  private pump(): void {
    if (this.closing) return
    while (this.queue.length > 0 && !this.disabled) {
      let worker = this.idle.pop()
      if (worker === undefined && this.workers.length < this.size) worker = this.spawn()
      if (worker === undefined) break
      const job = this.queue.shift()
      if (job === undefined) { this.idle.push(worker); break }
      this.owner.set(job.id, worker)
      try { worker.postMessage(job) } catch (error) {
        this.owner.delete(job.id)
        this.queue.unshift(job)
        this.failWorker(worker, error instanceof Error ? error : new Error(String(error)))
      }
    }
    if (this.disabled) {
      while (this.queue.length > 0) {
        const job = this.queue.shift()
        if (job !== undefined) this.runFallback(job)
      }
    }
  }

  compute(path: string, maxEdge = 512): Promise<Features> {
    if (this.closing) return Promise.reject(new Error('feature pool is closed'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.queue.push({ id, path, maxEdge })
      this.pump()
    })
  }

  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise
    this.closing = true
    const error = new Error('feature pool closed before analysis completed')
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    this.queue.length = 0
    this.owner.clear()
    this.idle.length = 0
    const workers = [...this.workers]
    this.workers.length = 0
    this.closePromise = (async () => {
      await Promise.allSettled(workers.map(worker => worker.terminate()))
      await Promise.allSettled([...this.fallbackJobs])
    })()
    return this.closePromise
  }
}
