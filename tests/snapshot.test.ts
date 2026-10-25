import { describe, expect, it } from 'vitest'
import { snapshotFor } from '../src/core/edit/engines/darktable/introspect.ts'

describe('shipped darktable catalog snapshot', () => {
  it('loads the 5.6.1 snapshot used when module introspection is unavailable', () => {
    const snap = snapshotFor('5.6.1')
    expect(snap).toBeDefined()
    expect(snap?.blendVersion).toBe(14)
    expect(snap?.modules.length).toBeGreaterThanOrEqual(90)
    expect(snap?.modules.some(m => m.operation === 'exposure')).toBe(true)
    expect(Object.keys(snap?.iopOrders ?? {}).length).toBeGreaterThan(0)
    expect(snapshotFor('0.0.0')).toBeUndefined()
  })
})
