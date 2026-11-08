import { randomBytes } from 'node:crypto'

/** Short sortable id: time prefix + random suffix, e.g. `t_lx3k9a_7f2c1e`. */
export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${randomBytes(4).toString('hex')}`
}

export function nowIso(): string {
  return new Date().toISOString()
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}

export function round(value: number, digits = 2): number {
  const f = 10 ** digits
  return Math.round(value * f) / f
}

export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (text === null || text === undefined || text === '') return fallback
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Deterministic JSON (sorted keys) for hashing and change detection. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** Run `fn` over items with at most `limit` in flight, preserving result order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>, signal?: AbortSignal): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  let failure: unknown
  let failed = false
  const count = items.length === 0 ? 0 : Math.max(1, Math.min(Number.isFinite(limit) ? Math.floor(limit) : 1, items.length))
  const workers = Array.from({ length: count }, async () => {
    while (!failed) {
      try {
        signal?.throwIfAborted()
        const index = next++
        if (index >= items.length) return
        results[index] = await fn(items[index] as T, index)
      } catch (error) {
        if (!failed) { failed = true; failure = error }
        return
      }
    }
  })
  // Wait for every in-flight worker to settle before propagating a failure;
  // callers may then close resources without detached work still using them.
  await Promise.all(workers)
  if (failed) throw failure
  return results
}

/** A counting semaphore whose limit may change at runtime. */
function normalizeLimit(limit: number): number {
  return Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 1
}

export class Semaphore {
  private active = 0
  private readonly waiters: Array<() => void> = []

  constructor(private limitValue: number) { this.limitValue = normalizeLimit(limitValue) }

  get limit(): number { return this.limitValue }
  get inFlight(): number { return this.active }

  setLimit(limit: number): void {
    this.limitValue = normalizeLimit(limit)
    this.drain()
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted()
    if (this.active < this.limitValue) {
      this.active++
      return this.releaser()
    }
    await new Promise<void>((resolve, reject) => {
      const waiter = (): void => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }
      const onAbort = (): void => {
        const i = this.waiters.indexOf(waiter)
        if (i >= 0) this.waiters.splice(i, 1)
        reject(signal?.reason ?? new Error('aborted'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.waiters.push(waiter)
    })
    // drain() reserved the slot, but abort may fire before this continuation.
    // Return that slot instead of leaking capacity to later callers.
    try { signal?.throwIfAborted() } catch (error) {
      this.active--
      this.drain()
      throw error
    }
    return this.releaser()
  }

  private releaser(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      this.active--
      this.drain()
    }
  }

  private drain(): void {
    while (this.active < this.limitValue && this.waiters.length > 0) {
      const w = this.waiters.shift()
      if (w === undefined) break
      this.active++
      w()
    }
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return }
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, ms)
    const onAbort = (): void => { clearTimeout(t); reject(signal?.reason ?? new Error('aborted')) }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isFinite(size) || size < 1) throw new RangeError('chunk size must be positive')
  const stride = Math.floor(size)
  const out: T[][] = []
  for (let i = 0; i < items.length; i += stride) out.push(items.slice(i, i + stride))
  return out
}
