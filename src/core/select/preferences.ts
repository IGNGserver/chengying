/**
 * User aesthetic preference profile, learned online from manual selection
 * adjustments (a photo the user adds is a positive example, one they remove is
 * negative) and from explicit statements recorded by the agent.
 *
 * The model is deliberately small and inspectable: per-dimension weight
 * multipliers, per-tag affinities, and free-text style notes that are injected
 * into editing agents' instructions.
 */
import { clamp, round } from '../util/misc.ts'

export interface PreferenceProfile {
  version: 1
  /** Multipliers applied to selection weights (1 = neutral). */
  weightBias: Record<string, number>
  /** Tag → affinity in [-1, 1]. */
  tagAffinity: Record<string, number>
  /** Free-text notes ("prefers warm, low-contrast film look"). */
  styleNotes: string[]
  /** Editing look preferences used by style transfer / editing agents. */
  look: { warmth?: number; contrast?: number; saturation?: number; brightness?: number; referenceShots?: string[] }
  examples: number
}

export function emptyProfile(): PreferenceProfile {
  return { version: 1, weightBias: {}, tagAffinity: {}, styleNotes: [], look: {}, examples: 0 }
}

export const PREFERENCE_DIMENSIONS = ['technical', 'aesthetic', 'composition', 'content', 'story', 'potential'] as const

/**
 * One online update. `dims` are the example's dimension scores (0..100) and
 * `means` the population means, so the update moves weights toward dimensions
 * in which user-preferred photos stand out.
 */
export function learn(profile: PreferenceProfile, label: 1 | -1, dims: Record<string, number>, means: Record<string, number>, tags: string[]): PreferenceProfile {
  const lr = 0.08 / Math.sqrt(1 + profile.examples / 10)
  const weightBias = { ...profile.weightBias }
  for (const d of PREFERENCE_DIMENSIONS) {
    const v = dims[d]
    const m = means[d]
    if (v === undefined || m === undefined) continue
    const delta = clamp((v - m) / 50, -1, 1) * label * lr
    weightBias[d] = round(clamp((weightBias[d] ?? 1) * (1 + delta), 0.3, 3), 4)
  }
  const tagAffinity = { ...profile.tagAffinity }
  for (const t of tags) tagAffinity[t] = round(clamp((tagAffinity[t] ?? 0) + label * lr * 1.5, -1, 1), 4)
  return { ...profile, weightBias, tagAffinity, examples: profile.examples + 1 }
}

/** Preference dimension (0..100) for one shot. */
export function preferenceScore(profile: PreferenceProfile, tags: readonly string[]): number {
  if (tags.length === 0) return 50
  let acc = 0
  for (const t of tags) acc += profile.tagAffinity[t] ?? 0
  return clamp(50 + 50 * (acc / Math.sqrt(tags.length)), 0, 100)
}
