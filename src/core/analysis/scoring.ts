/**
 * Interpretable scores (0..100) derived from classical features. These are the
 * always-available baseline; specialised models and the vision LLM add their
 * own score sources, and selection fuses whatever is present.
 */
import type { Features, ScoreSet } from '../types.ts'
import { clamp, round } from '../util/misc.ts'

const lin = (v: number, lo: number, hi: number): number => clamp((v - lo) / (hi - lo), 0, 1)
/** 1 inside [a,b], ramping to 0 at [a-r, b+r]. */
const band = (v: number, a: number, b: number, r: number): number => (v < a ? clamp(1 - (a - v) / r, 0, 1) : v > b ? clamp(1 - (v - b) / r, 0, 1) : 1)

export interface ShotContext {
  isRaw: boolean
  iso?: number | null
  exposureTime?: number | null
  focalLength?: number | null
  hour?: number | null
}

export function technicalScore(f: Features, ctx: ShotContext): ScoreSet {
  const issues: string[] = []
  // Laplacian variance at ~512 px: ≲60 blurry, ≳600 crisp. Log scale.
  const peakSharp = lin(Math.log10(f.sharpness.peak + 1), 1.6, 2.9)
  const globalSharp = lin(Math.log10(f.sharpness.global + 1), 1.2, 2.6)
  let sharp = 0.65 * peakSharp + 0.35 * globalSharp
  const motionBlur = f.sharpness.anisotropy > 0.55 && peakSharp < 0.55
  if (motionBlur) { sharp *= 0.75; issues.push('motion-blur') }
  if (peakSharp < 0.3) issues.push('out-of-focus')

  const e = f.exposure
  let exposure = 1
  if (e.clipHigh > 0.01) { exposure -= Math.min(0.6, (e.clipHigh - 0.01) * (ctx.isRaw ? 4 : 8)); issues.push('highlight-clipping') }
  if (e.clipLow > 0.04) { exposure -= Math.min(0.35, (e.clipLow - 0.04) * 3); issues.push('shadow-clipping') }
  const midOk = band(e.median, 0.18, 0.72, 0.18)
  // No highlights anywhere near white while the midtones sit low: the whole frame is underexposed.
  const lowKeyUnder = e.p99 < 0.55 && e.median < 0.3
  if (midOk < 0.8 || lowKeyUnder) issues.push(e.median < 0.18 || lowKeyUnder ? 'underexposed' : 'overexposed')
  if (lowKeyUnder) exposure -= 0.25
  exposure = clamp(exposure * (0.55 + 0.45 * midOk) * (0.7 + 0.3 * lin(e.entropy, 5, 7.4)), 0, 1)

  const noise = 1 - lin(f.noise, 1.2, 7)
  if (noise < 0.5) issues.push('noisy')
  const contrast = band(f.contrast, 0.13, 0.3, 0.1)
  if (f.contrast < 0.09) issues.push('flat')
  const cast = Math.hypot(f.color.castA, f.color.castB)
  const castScore = 1 - lin(cast, 6, 20)
  if (castScore < 0.6) issues.push('color-cast')

  const technical = 100 * (0.45 * sharp + 0.25 * exposure + 0.13 * noise + 0.1 * contrast + 0.07 * castScore)
  return {
    technical: round(technical, 1),
    issues,
    detail: {
      sharpness: round(sharp * 100, 1),
      exposure: round(exposure * 100, 1),
      noise: round(noise * 100, 1),
      contrast: round(contrast * 100, 1),
      whiteBalance: round(castScore * 100, 1),
      motionBlur,
    },
    reasons: {
      technical: `sharp ${round(sharp * 100)}, exposure ${round(exposure * 100)}, noise ${round(noise * 100)}, contrast ${round(contrast * 100)}`,
    },
  }
}

export function aestheticScore(f: Features, ctx: ShotContext): ScoreSet {
  const c = f.composition
  const tiltPenalty = c.tiltConfidence > 0.35 ? lin(Math.abs(c.tiltDeg), 0.8, 6) : 0
  const centered = 1 - Math.min(1, Math.hypot(c.saliencyCentroid[0] - 0.5, c.saliencyCentroid[1] - 0.5) / 0.15)
  const placement = Math.max(c.thirds, centered * c.symmetry)
  const isolation = lin(c.subjectContrast, 1.3, 3.2)
  const clutter = lin(c.borderClutter, 0.9, 1.6)
  const composition = clamp(0.38 * placement + 0.18 * c.balance + 0.2 * isolation + 0.12 * (1 - clutter) + 0.12 * (1 - tiltPenalty), 0, 1)
  const colorfulness = band(f.color.colorfulness, 30, 95, 35)
  const light = 0.5 * lin(f.exposure.dynamicRange, 0.45, 0.92) + 0.5 * band(f.contrast, 0.15, 0.3, 0.12)
  let golden = 0
  if (ctx.hour !== null && ctx.hour !== undefined) {
    golden = (ctx.hour >= 5.5 && ctx.hour <= 8) || (ctx.hour >= 16.5 && ctx.hour <= 19.5) ? 1 : 0
  }
  const warmLight = golden * lin(f.color.warmth, 2, 18)
  const aesthetic = 100 * clamp(0.42 * composition + 0.24 * colorfulness + 0.24 * light + 0.1 * warmLight, 0, 1)
  return {
    aesthetic: round(aesthetic, 1),
    composition: round(composition * 100, 1),
    detail: {
      placement: round(placement * 100, 1),
      thirds: round(c.thirds * 100, 1),
      symmetry: round(c.symmetry * 100, 1),
      balance: round(c.balance * 100, 1),
      isolation: round(isolation * 100, 1),
      clutter: round(clutter * 100, 1),
      tiltDeg: round(c.tiltDeg, 2),
      tiltConfidence: round(c.tiltConfidence, 2),
      colorfulness: round(colorfulness * 100, 1),
      light: round(light * 100, 1),
      goldenHour: golden === 1,
    },
    issues: tiltPenalty > 0.3 ? ['tilted-horizon'] : [],
    reasons: {
      aesthetic: `composition ${round(composition * 100)}, color ${round(colorfulness * 100)}, light ${round(light * 100)}${golden ? ', golden hour' : ''}`,
    },
  }
}

/** How much a skilled edit can still lift the frame (recoverable faults, RAW headroom). */
export function potentialScore(f: Features, tech: ScoreSet, ctx: ShotContext): ScoreSet {
  const issues = new Set(tech.issues ?? [])
  let potential = 0.45
  if (ctx.isRaw) potential += 0.25
  const fixable = ['underexposed', 'overexposed', 'color-cast', 'tilted-horizon', 'flat', 'shadow-clipping']
  for (const i of fixable) if (issues.has(i)) potential += ctx.isRaw ? 0.06 : 0.03
  if (issues.has('out-of-focus') || issues.has('motion-blur')) potential -= 0.35
  if (issues.has('highlight-clipping') && !ctx.isRaw) potential -= 0.15
  if (issues.has('noisy')) potential -= ctx.isRaw ? 0.03 : 0.1
  potential += 0.1 * lin(f.exposure.entropy, 6, 7.6)
  return {
    potential: round(clamp(potential, 0, 1) * 100, 1),
    reasons: { potential: `${ctx.isRaw ? 'RAW headroom' : 'raster only'}; fixable: ${fixable.filter(i => issues.has(i)).join(', ') || 'none'}` },
  }
}

/** Weighted fusion of the available score dimensions (missing dimensions renormalize). */
export function fuseScores(dims: Partial<Record<string, number | undefined>>, weights: Partial<Record<string, number>>): number {
  let acc = 0
  let wsum = 0
  for (const [k, w] of Object.entries(weights)) {
    const v = dims[k]
    if (w === undefined || w <= 0 || v === undefined || Number.isNaN(v)) continue
    acc += v * w
    wsum += w
  }
  return wsum > 0 ? acc / wsum : 0
}

export const DEFAULT_WEIGHTS = {
  technical: 0.3,
  aesthetic: 0.25,
  composition: 0.1,
  content: 0.15,
  story: 0.08,
  potential: 0.07,
  preference: 0.05,
} as const
