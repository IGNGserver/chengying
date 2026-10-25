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
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      signal?.throwIfAborted()
      const index = next++
      if (index >= items.length) return
      results[index] = await fn(items[index] as T, index)
    }
  })
  await Promise.all(workers)
  return results
}

/** A counting semaphore whose limit may change at runtime. */
export class Semaphore {
  private active = 0
  private readonly waiters: Array<() => void> = []

  constructor(private limitValue: number) {}

  get limit(): number { return this.limitValue }
  get inFlight(): number { return this.active }

  setLimit(limit: number): void {
    this.limitValue = Math.max(1, limit)
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
    // drain() already reserved the slot for this waiter.
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
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}
