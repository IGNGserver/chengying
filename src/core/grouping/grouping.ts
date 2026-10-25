/**
 * Grouping (never deletes anything):
 *  - exact: identical file content (confirmed full SHA-256)
 *  - near: near-duplicates — pHash Hamming distance plus color/layout distance,
 *    candidates from a capture-time window and from pHash LSH bands (catches
 *    copies and re-exports taken at different times)
 *  - scene: consecutive frames of the same subject/place (time gap, visual
 *    drift, GPS jump)
 *  - segment: travel-narrative units (day → time gap / location change)
 *  - location: GPS clusters (~1 km)
 */
import type { Features, FileRecord, Group, Shot } from '../types.ts'
import { hamming, visualDistance } from '../analysis/pixels.ts'

class UnionFind {
  private readonly parent = new Map<string, string>()
  find(x: string): string {
    let p = this.parent.get(x) ?? x
    if (p !== x) { p = this.find(p); this.parent.set(x, p) }
    return p
  }
  union(a: string, b: string): void {
    const ra = this.find(a); const rb = this.find(b)
    if (ra !== rb) this.parent.set(ra, rb)
  }
}

export function haversineKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371
  const dLat = (b.lat - a.lat) * Math.PI / 180
  const dLon = (b.lon - a.lon) * Math.PI / 180
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)))
}

export interface GroupingInput {
  shots: Shot[]
  files: FileRecord[]
  features: Map<string, Features>
  /** Ranking score per shot (higher is better) used to pick each group's best member. */
  rank: (shotId: string) => number
}

export interface GroupingOptions {
  nearWindowSec: number
  nearHamming: number
  nearVisual: number
  sceneGapSec: number
  sceneVisual: number
  sceneGpsKm: number
  segmentGapMin: number
  segmentGpsKm: number
  locationKm: number
}

export const DEFAULT_GROUPING: GroupingOptions = {
  nearWindowSec: 120,
  nearHamming: 10,
  nearVisual: 0.2,
  sceneGapSec: 240,
  sceneVisual: 0.45,
  sceneGpsKm: 0.6,
  segmentGapMin: 90,
  segmentGpsKm: 3,
  locationKm: 1,
}

function toGroups(kind: Group['kind'], buckets: Map<string, string[]>, rank: (id: string) => number, label: (members: string[], i: number) => string, info?: (members: string[]) => Record<string, unknown>, minSize = 2): Group[] {
  const out: Group[] = []
  let i = 0
  for (const members of buckets.values()) {
    if (members.length < minSize) continue
    const ordered = [...members].sort((a, b) => rank(b) - rank(a))
    out.push({
      id: `${kind}_${(++i).toString().padStart(4, '0')}`,
      kind,
      label: label(members, i),
      members: ordered.map((shotId, r) => ({ shotId, rank: r, role: r === 0 ? 'best' : 'member' })),
      info: info?.(members) ?? {},
    })
  }
  return out
}

export function computeGroups(input: GroupingInput, opts: GroupingOptions = DEFAULT_GROUPING): Record<'exact' | 'near' | 'scene' | 'segment' | 'location', Group[]> {
  const { shots, files, features, rank } = input
  const byTime = [...shots].sort((a, b) => (a.captureTs ?? 0) - (b.captureTs ?? 0))

  // exact
  const exactUf = new UnionFind()
  const byHash = new Map<string, string>()
  for (const f of files) {
    if (f.shotId === null || f.sha256 === null || !f.sha256.startsWith('full:')) continue
    const prev = byHash.get(f.sha256)
    if (prev !== undefined && prev !== f.shotId) exactUf.union(prev, f.shotId)
    else byHash.set(f.sha256, f.shotId)
  }
  const exactBuckets = new Map<string, string[]>()
  for (const s of shots) {
    const r = exactUf.find(s.id)
    exactBuckets.set(r, [...(exactBuckets.get(r) ?? []), s.id])
  }

  // near-duplicates
  const nearUf = new UnionFind()
  for (const [root, members] of exactBuckets) for (const m of members) nearUf.union(m, root)
  const similar = (a: string, b: string): boolean => {
    const fa = features.get(a); const fb = features.get(b)
    if (fa === undefined || fb === undefined) return false
    const hd = hamming(fa.phash, fb.phash)
    if (hd <= 4) return true
    return hd <= opts.nearHamming && visualDistance(fa, fb) <= opts.nearVisual
  }
  for (let i = 0; i < byTime.length; i++) {
    const a = byTime[i] as Shot
    for (let j = i + 1; j < byTime.length; j++) {
      const b = byTime[j] as Shot
      if (a.captureTs !== null && b.captureTs !== null && b.captureTs - a.captureTs > opts.nearWindowSec) break
      if (similar(a.id, b.id)) nearUf.union(a.id, b.id)
    }
  }
  // LSH over pHash bands (4 × 16 bit) for far-apart near duplicates.
  const bands = new Map<string, string[]>()
  for (const s of shots) {
    const f = features.get(s.id)
    if (f === undefined) continue
    for (let b = 0; b < 4; b++) {
      const key = `${b}:${f.phash.slice(b * 4, b * 4 + 4)}`
      bands.set(key, [...(bands.get(key) ?? []), s.id])
    }
  }
  for (const ids of bands.values()) {
    if (ids.length < 2 || ids.length > 200) continue
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = ids[i] as string; const b = ids[j] as string
        if (nearUf.find(a) === nearUf.find(b)) continue
        const fa = features.get(a); const fb = features.get(b)
        if (fa !== undefined && fb !== undefined && hamming(fa.phash, fb.phash) <= 6 && visualDistance(fa, fb) <= opts.nearVisual * 0.8) nearUf.union(a, b)
      }
    }
  }
  const nearBuckets = new Map<string, string[]>()
  for (const s of shots) {
    const r = nearUf.find(s.id)
    nearBuckets.set(r, [...(nearBuckets.get(r) ?? []), s.id])
  }

  // scenes
  const sceneBuckets = new Map<string, string[]>()
  let sceneIndex = 0
  let current: Shot[] = []
  const flush = (): void => {
    if (current.length > 0) sceneBuckets.set(`scene${sceneIndex++}`, current.map(s => s.id))
    current = []
  }
  for (const s of byTime) {
    const last = current[current.length - 1]
    if (last === undefined) { current.push(s); continue }
    const gap = s.captureTs !== null && last.captureTs !== null ? s.captureTs - last.captureTs : 0
    const fs = features.get(s.id)
    const recent = current.slice(-3).map(x => features.get(x.id)).filter((f): f is Features => f !== undefined)
    const drift = fs === undefined || recent.length === 0 ? 0 : Math.min(...recent.map(f => visualDistance(f, fs)))
    const jump = s.gps !== null && last.gps !== null ? haversineKm(s.gps, last.gps) : 0
    if (gap > opts.sceneGapSec || drift > opts.sceneVisual || jump > opts.sceneGpsKm) flush()
    current.push(s)
  }
  flush()

  // segments (travel narrative)
  const segBuckets = new Map<string, string[]>()
  const segInfo = new Map<string, Record<string, unknown>>()
  let seg = 0
  let segMembers: Shot[] = []
  const flushSeg = (): void => {
    if (segMembers.length === 0) return
    const key = `seg${seg++}`
    segBuckets.set(key, segMembers.map(s => s.id))
    const first = segMembers[0] as Shot
    const lastS = segMembers[segMembers.length - 1] as Shot
    const gps = segMembers.filter(s => s.gps !== null).map(s => s.gps as { lat: number; lon: number })
    segInfo.set(key, {
      day: first.day,
      start: first.captureTime,
      end: lastS.captureTime,
      center: gps.length > 0 ? { lat: gps.reduce((a, g) => a + g.lat, 0) / gps.length, lon: gps.reduce((a, g) => a + g.lon, 0) / gps.length } : null,
      size: segMembers.length,
    })
    segMembers = []
  }
  for (const s of byTime) {
    const last = segMembers[segMembers.length - 1]
    if (last !== undefined) {
      const gap = s.captureTs !== null && last.captureTs !== null ? (s.captureTs - last.captureTs) / 60 : 0
      const jump = s.gps !== null && last.gps !== null ? haversineKm(s.gps, last.gps) : 0
      if (s.day !== last.day || gap > opts.segmentGapMin || jump > opts.segmentGpsKm) flushSeg()
    }
    segMembers.push(s)
  }
  flushSeg()

  // locations
  const locBuckets = new Map<string, string[]>()
  const centers: Array<{ key: string; lat: number; lon: number; n: number }> = []
  for (const s of byTime) {
    if (s.gps === null) continue
    let hit = centers.find(c => haversineKm(c, s.gps as { lat: number; lon: number }) <= opts.locationKm)
    if (hit === undefined) {
      hit = { key: `loc${centers.length}`, lat: s.gps.lat, lon: s.gps.lon, n: 0 }
      centers.push(hit)
    }
    hit.lat = (hit.lat * hit.n + s.gps.lat) / (hit.n + 1)
    hit.lon = (hit.lon * hit.n + s.gps.lon) / (hit.n + 1)
    hit.n++
    locBuckets.set(hit.key, [...(locBuckets.get(hit.key) ?? []), s.id])
  }

  const shotById = new Map(shots.map(s => [s.id, s]))
  const timeLabel = (ids: string[]): string => {
    const t = ids.map(id => shotById.get(id)?.captureTime).filter((x): x is string => x !== null && x !== undefined).sort()
    return t.length === 0 ? 'undated' : `${t[0]?.replace('T', ' ').slice(0, 16)}`
  }
  return {
    exact: toGroups('exact', exactBuckets, rank, (m, i) => `exact #${i} (${m.length})`),
    near: toGroups('near', nearBuckets, rank, (m, i) => `near-duplicate #${i} · ${timeLabel(m)} (${m.length})`),
    scene: toGroups('scene', sceneBuckets, rank, (m, i) => `scene ${i} · ${timeLabel(m)} (${m.length})`, undefined, 1),
    segment: toGroups('segment', segBuckets, rank, (m, i) => `segment ${i} · ${timeLabel(m)} (${m.length})`, m => segInfo.get([...segBuckets.entries()].find(([, v]) => v === m)?.[0] ?? '') ?? {}, 1),
    location: toGroups('location', locBuckets, rank, (m, i) => {
      const c = centers.find(x => locBuckets.get(x.key) === m)
      return `location ${i} · ${c ? `${c.lat.toFixed(4)},${c.lon.toFixed(4)}` : ''} (${m.length})`
    }, m => {
      const c = centers.find(x => locBuckets.get(x.key) === m)
      return c ? { lat: c.lat, lon: c.lon } : {}
    }, 1),
  }
}
