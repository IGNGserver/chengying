/**
 * Selection: turn a structured spec (usually produced by the agent from the
 * user's natural-language request) into a ranked, explained selection.
 *
 *  1. merge every score source per shot into dimensions (heuristic, models,
 *     vision LLM, agent, user) — later/stronger sources weigh more
 *  2. filter (rejects, explicit excludes, orientation, time range, tags)
 *  3. collapse exact / near-duplicate groups to their best member
 *  4. count mode: per-segment narrative quotas + MMR diversity with a
 *     per-scene cap; threshold mode: every candidate above the floor, scene
 *     capped and diversity-checked
 *  5. user picks / locked items are always kept
 */
import type { Features, Group, ScoreSet, SelectionItem, SelectionSpec, Shot } from '../types.ts'
import { visualDistance } from '../analysis/pixels.ts'
import { DEFAULT_WEIGHTS, fuseScores } from '../analysis/scoring.ts'
import { preferenceScore, type PreferenceProfile } from './preferences.ts'
import { clamp, round } from '../util/misc.ts'

export interface ShotDims {
  technical?: number
  aesthetic?: number
  composition?: number
  content?: number
  story?: number
  potential?: number
  preference?: number
  tags: string[]
  issues: string[]
  sources: string[]
}

function weightedAvg(parts: Array<[number | undefined, number]>): number | undefined {
  let a = 0; let w = 0
  for (const [v, wt] of parts) if (v !== undefined && !Number.isNaN(v)) { a += v * wt; w += wt }
  return w > 0 ? a / w : undefined
}

export function mergeDims(scores: Record<string, ScoreSet>, profile?: PreferenceProfile): ShotDims {
  const heur = { ...scores.technical, ...scores.aesthetic }
  const learned = Object.entries(scores).filter(([k]) => k.startsWith('model:')).map(([, v]) => v)
  const vlm = Object.entries(scores).filter(([k]) => k.startsWith('vlm:')).map(([, v]) => v)
  const agent = scores.agent
  const user = scores.user
  const judged = [...vlm, ...(agent ? [agent] : []), ...(user ? [user] : [])]
  const avgOf = (list: ScoreSet[], key: keyof ScoreSet): number | undefined => weightedAvg(list.map(s => [s[key] as number | undefined, 1]))
  const tags = [...new Set([...(heur.tags ?? []), ...learned.flatMap(s => s.tags ?? []), ...judged.flatMap(s => s.tags ?? [])])]
  const issues = [...new Set([...(scores.technical?.issues ?? []), ...(scores.aesthetic?.issues ?? []), ...judged.flatMap(s => s.issues ?? [])])]
  const dims: ShotDims = {
    technical: weightedAvg([[scores.technical?.technical, 2], [avgOf(learned, 'technical'), 1], [avgOf(judged, 'technical'), 1]]),
    aesthetic: weightedAvg([[scores.aesthetic?.aesthetic, 1], [avgOf(learned, 'aesthetic'), 2], [avgOf(judged, 'aesthetic'), 2.5]]),
    composition: weightedAvg([[scores.aesthetic?.composition, 1], [avgOf(judged, 'composition'), 2]]),
    content: weightedAvg([[avgOf(learned, 'content'), 1], [avgOf(judged, 'content'), 2]]),
    story: avgOf(judged, 'story'),
    potential: weightedAvg([[scores.technical?.potential ?? scores.aesthetic?.potential ?? scores.potential?.potential, 1], [avgOf(judged, 'potential'), 1]]),
    tags,
    issues,
    sources: Object.keys(scores),
  }
  if (profile !== undefined) dims.preference = preferenceScore(profile, tags)
  return dims
}

export interface SelectorInput {
  shots: Shot[]
  scores: Map<string, Record<string, ScoreSet>>
  features: Map<string, Features>
  groups: { near: Group[]; exact: Group[]; scene: Group[]; segment: Group[] }
  profile?: PreferenceProfile
  /** Previous selection items with user adjustments to keep (locked / user-added). */
  keep?: SelectionItem[]
}

export interface SelectionResult {
  items: SelectionItem[]
  stats: Record<string, unknown>
  candidates: number
}

interface Candidate {
  shot: Shot
  dims: ShotDims
  fused: number
  scene: string | undefined
  segment: string | undefined
  reasonBits: string[]
}

function orientationOf(s: Shot): 'landscape' | 'portrait' | 'square' {
  let w = s.width ?? 0
  let h = s.height ?? 0
  if (s.orientation !== null && s.orientation >= 5) [w, h] = [h, w]
  if (w === 0 || h === 0) return 'landscape'
  const r = w / h
  return r > 1.08 ? 'landscape' : r < 0.92 ? 'portrait' : 'square'
}

export function select(input: SelectorInput, spec: SelectionSpec): SelectionResult {
  const weights = { ...DEFAULT_WEIGHTS, ...(spec.weights ?? {}) } as Record<string, number>
  if (input.profile !== undefined) for (const [k, b] of Object.entries(input.profile.weightBias)) if (weights[k] !== undefined) weights[k] = (weights[k] as number) * b
  const diversity = clamp(spec.diversity ?? 0.35, 0, 1)
  const excluded = new Map<string, string>()
  const groupOf = (groups: Group[]): Map<string, string> => {
    const m = new Map<string, string>()
    for (const g of groups) for (const mem of g.members) m.set(mem.shotId, g.id)
    return m
  }
  const sceneOf = groupOf(input.groups.scene)
  const segmentOf = groupOf(input.groups.segment)
  const include = new Set(spec.include ?? [])
  const exclude = new Set(spec.exclude ?? [])
  const prefer = new Set((spec.preferTags ?? []).map(t => t.toLowerCase()))
  const avoid = new Set((spec.avoidTags ?? []).map(t => t.toLowerCase()))
  const require = (spec.requireTags ?? []).map(t => t.toLowerCase())
  const from = spec.timeRange?.from
  const to = spec.timeRange?.to

  const cands = new Map<string, Candidate>()
  for (const shot of input.shots) {
    const dims = mergeDims(input.scores.get(shot.id) ?? {}, input.profile)
    const tags = dims.tags.map(t => t.toLowerCase())
    const forced = include.has(shot.id) || shot.userFlag === 'pick'
    if (!forced) {
      if (exclude.has(shot.id)) { excluded.set(shot.id, 'excluded by request'); continue }
      if ((spec.excludeRejected ?? true) && shot.userFlag === 'reject') { excluded.set(shot.id, 'rejected by user'); continue }
      if (spec.orientation !== undefined && spec.orientation !== 'any' && orientationOf(shot) !== spec.orientation) { excluded.set(shot.id, 'orientation'); continue }
      if (spec.rawOnly === true && shot.rawFile === null) { excluded.set(shot.id, 'not RAW'); continue }
      if (from !== undefined && (shot.captureTime === null || shot.captureTime < from)) { excluded.set(shot.id, 'before time range'); continue }
      if (to !== undefined && (shot.captureTime === null || shot.captureTime > to)) { excluded.set(shot.id, 'after time range'); continue }
      if (require.length > 0 && !require.every(t => tags.some(x => x.includes(t)))) { excluded.set(shot.id, 'missing required tag'); continue }
    }
    let fused = fuseScores(dims as unknown as Record<string, number>, weights)
    const reasonBits: string[] = []
    const preferHits = tags.filter(t => [...prefer].some(p => t.includes(p)))
    const avoidHits = tags.filter(t => [...avoid].some(p => t.includes(p)))
    if (preferHits.length > 0) { fused += Math.min(16, 8 * preferHits.length); reasonBits.push(`matches ${preferHits.slice(0, 3).join('/')}`) }
    if (avoidHits.length > 0) { fused -= 20; reasonBits.push(`avoid ${avoidHits.slice(0, 2).join('/')}`) }
    if (shot.userRating !== null && shot.userRating > 0) fused += (shot.userRating - 3) * 4
    if (dims.issues.includes('out-of-focus') || dims.issues.includes('motion-blur')) reasonBits.push('soft')
    cands.set(shot.id, { shot, dims, fused: clamp(fused, 0, 100), scene: sceneOf.get(shot.id), segment: segmentOf.get(shot.id), reasonBits })
  }

  // Collapse duplicate groups to their best candidate.
  const collapsed = new Set<string>()
  for (const g of [...input.groups.exact, ...input.groups.near]) {
    const members = g.members.map(m => cands.get(m.shotId)).filter((c): c is Candidate => c !== undefined)
    if (members.length < 2) continue
    members.sort((a, b) => b.fused - a.fused)
    const best = members[0] as Candidate
    best.reasonBits.push(`best of ${members.length} similar`)
    for (const m of members.slice(1)) {
      if (include.has(m.shot.id) || m.shot.userFlag === 'pick') continue
      collapsed.add(m.shot.id)
      excluded.set(m.shot.id, `duplicate of ${best.shot.id}`)
    }
  }
  const pool = [...cands.values()].filter(c => !collapsed.has(c.shot.id))
  const floor = spec.minScore
  const kept = new Map<string, SelectionItem>()
  for (const k of input.keep ?? []) if (k.locked || k.source === 'user') kept.set(k.shotId, k)

  const chosen: Candidate[] = []
  const chosenSet = new Set<string>()
  const sim = (a: Candidate, b: Candidate): number => {
    const fa = input.features.get(a.shot.id); const fb = input.features.get(b.shot.id)
    if (fa === undefined || fb === undefined) return a.scene !== undefined && a.scene === b.scene ? 0.7 : 0
    return 1 - visualDistance(fa, fb)
  }
  const sceneCount = new Map<string, number>()
  const take = (c: Candidate, why: string): void => {
    chosen.push(c)
    chosenSet.add(c.shot.id)
    if (c.scene !== undefined) sceneCount.set(c.scene, (sceneCount.get(c.scene) ?? 0) + 1)
    c.reasonBits.unshift(why)
  }
  // Forced items first.
  for (const c of pool) {
    if (include.has(c.shot.id) || c.shot.userFlag === 'pick' || kept.get(c.shot.id)?.included === true) take(c, include.has(c.shot.id) ? 'requested' : c.shot.userFlag === 'pick' ? 'user pick' : 'kept from previous adjustment')
  }
  for (const [id, k] of kept) if (!k.included) { excluded.set(id, 'removed by user'); chosenSet.add(`removed:${id}`) }
  const eligible = pool.filter(c => !chosenSet.has(c.shot.id) && !chosenSet.has(`removed:${c.shot.id}`) && (floor === undefined || c.fused >= floor))

  const mmrPick = (cands: Candidate[], perScene: number): Candidate | undefined => {
    let best: Candidate | undefined
    let bestGain = -Infinity
    for (const c of cands) {
      if (chosenSet.has(c.shot.id)) continue
      if (c.scene !== undefined && (sceneCount.get(c.scene) ?? 0) >= perScene) continue
      let maxSim = 0
      for (const s of chosen) { const v = sim(c, s); if (v > maxSim) maxSim = v }
      const gain = (1 - diversity) * (c.fused / 100) - diversity * maxSim
      if (gain > bestGain) { bestGain = gain; best = c }
    }
    return best
  }

  if (spec.count !== undefined) {
    const target = Math.max(0, Math.floor(spec.count))
    const perScene = spec.perScene ?? Math.max(1, Math.ceil(target / Math.max(1, input.groups.scene.length) * 1.5))
    const narrative = spec.narrative ?? true
    if (narrative && input.groups.segment.length > 1 && target > chosen.length) {
      // Narrative quotas: weight segments by sqrt(size) × their top quality.
      const segs = input.groups.segment.map(g => {
        const members = eligible.filter(c => c.segment === g.id).sort((a, b) => b.fused - a.fused)
        const top = members.slice(0, 3)
        const q = top.length === 0 ? 0 : top.reduce((a, c) => a + c.fused, 0) / top.length / 100
        return { id: g.id, members, weight: Math.sqrt(g.members.length) * (0.4 + q) }
      }).filter(s => s.members.length > 0)
      const remaining = target - chosen.length
      const totalW = segs.reduce((a, s) => a + s.weight, 0) || 1
      const quotas = segs.map(s => ({ ...s, quota: Math.min(s.members.length, Math.max(remaining >= segs.length ? 1 : 0, Math.floor(remaining * s.weight / totalW))) }))
      for (const s of quotas.sort((a, b) => b.weight - a.weight)) {
        for (let i = 0; i < s.quota && chosen.length < target; i++) {
          const c = mmrPick(s.members, perScene)
          if (c === undefined) break
          take(c, 'narrative coverage')
        }
      }
    }
    while (chosen.length < target) {
      const c = mmrPick(eligible, perScene) ?? mmrPick(eligible, Number.POSITIVE_INFINITY)
      if (c === undefined) break
      take(c, 'quality + diversity')
    }
  } else {
    const minScore = floor ?? 70
    const perScene = spec.perScene ?? 2
    const max = spec.maxCount ?? Number.POSITIVE_INFINITY
    const sorted = eligible.filter(c => c.fused >= minScore).sort((a, b) => b.fused - a.fused)
    for (const c of sorted) {
      if (chosen.length >= max) break
      if (c.scene !== undefined && (sceneCount.get(c.scene) ?? 0) >= perScene) { excluded.set(c.shot.id, 'scene already covered'); continue }
      const tooClose = chosen.some(s => s.scene === c.scene && sim(c, s) > 0.85)
      if (tooClose) { excluded.set(c.shot.id, 'too similar to a selected frame'); continue }
      take(c, `score ≥ ${minScore}`)
    }
  }

  // Narrative order (capture time), rank = position.
  chosen.sort((a, b) => (a.shot.captureTs ?? 0) - (b.shot.captureTs ?? 0))
  const items: SelectionItem[] = chosen.map((c, i) => ({
    shotId: c.shot.id,
    rank: i + 1,
    score: round(c.fused, 1),
    reason: [...new Set(c.reasonBits)].join('; ') + ` · T${round(c.dims.technical ?? 0)} A${round(c.dims.aesthetic ?? 0)}${c.dims.content !== undefined ? ` C${round(c.dims.content)}` : ''}`,
    source: kept.has(c.shot.id) && kept.get(c.shot.id)?.source === 'user' ? 'user' : 'auto',
    locked: kept.get(c.shot.id)?.locked ?? false,
    included: true,
  }))
  // Keep user-removed items as excluded rows so the adjustment survives re-selection.
  for (const [id, k] of kept) if (!k.included) items.push({ ...k, included: false })

  const bySegment: Record<string, number> = {}
  for (const c of chosen) if (c.segment !== undefined) bySegment[c.segment] = (bySegment[c.segment] ?? 0) + 1
  const reasons: Record<string, number> = {}
  for (const r of excluded.values()) {
    const key = r.startsWith('duplicate of') ? 'duplicate' : r
    reasons[key] = (reasons[key] ?? 0) + 1
  }
  return {
    items,
    candidates: pool.length,
    stats: {
      mode: spec.count !== undefined ? 'count' : 'threshold',
      requested: spec.count ?? null,
      selected: chosen.length,
      totalShots: input.shots.length,
      candidates: pool.length,
      meanScore: chosen.length > 0 ? round(chosen.reduce((a, c) => a + c.fused, 0) / chosen.length, 1) : 0,
      segmentsCovered: Object.keys(bySegment).length,
      segmentsTotal: input.groups.segment.length,
      scenesCovered: new Set(chosen.map(c => c.scene)).size,
      scenesTotal: input.groups.scene.length,
      excludedReasons: reasons,
      weights,
      diversity,
    },
  }
}
