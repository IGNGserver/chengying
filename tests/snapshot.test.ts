import { describe, expect, it } from 'vitest'
import { snapshotFor } from '../src/core/edit/engines/darktable/introspect.ts'

describe('shipped darktable catalog snapshot', () => {
  it('loads the 5.6.1 snapshot used when module introspection is unavailable', () => {
    const snap = snapshotFor('5.6.1')
    expect(snap).toBeDefined()
    expect(snap?.exact).toBe(true)
    expect(snap?.version).toBe('5.6.1')
    expect(snap?.catalog.blendVersion).toBe(14)
    expect(snap?.catalog.modules.length).toBeGreaterThanOrEqual(90)
    expect(snap?.catalog.modules.some(m => m.operation === 'exposure')).toBe(true)
    expect(Object.keys(snap?.catalog.iopOrders ?? {}).length).toBeGreaterThan(0)
    expect(snapshotFor('0.0.0')).toBeUndefined()
  })

  it('accepts a different patch release of a covered minor version, with a warning flag', () => {
    // darktable 5.6.2 shipped after the 5.6.1 snapshot: module layouts are
    // identical within a minor release, so the snapshot stays usable instead of
    // sending the engine down the (Windows-impossible) native path.
    const snap = snapshotFor('5.6.2')
    expect(snap).toBeDefined()
    expect(snap?.exact).toBe(false)
    expect(snap?.version).toBe('5.6.1')
    expect(snap?.catalog.modules.length).toBeGreaterThanOrEqual(90)
  })

  it('does not borrow a snapshot from a different minor version', () => {
    expect(snapshotFor('5.8.0')).toBeUndefined()
    expect(snapshotFor('6.0.0')).toBeUndefined()
  })
})
