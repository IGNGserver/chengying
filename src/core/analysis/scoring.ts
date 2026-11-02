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
  bitsPerSample?: number | null
  exposureBias?: number | null
  hour?: number | null
}

export function inferHeuristicTags(f: Features, ctx: ShotContext): string[] {
  const tags = new Set<string>()
  if (f.subject !== undefined && f.subject.faceRegions >= 1 && f.subject.skinRatio >= 0.025) {
    tags.add('people')
  }
  if (ctx.hour !== null && ctx.hour !== undefined && ((ctx.hour >= 5.5 && ctx.hour <= 8) || (ctx.hour >= 16.5 && ctx.hour <= 19.5)) && f.color.warmth > 8) {
    tags.add('sunset')
  }
  if ((ctx.hour !== null && ctx.hour !== undefined && (ctx.hour >= 20 || ctx.hour <= 4.5)) || (f.exposure.mean < 0.25 && (ctx.iso ?? 0) >= 1600)) {
    tags.add('night')
  }
  if ((f.subject === undefined || f.subject.faceRegions === 0) && f.width >= f.height && (ctx.focalLength == null || ctx.focalLength <= 35) && f.composition.tiltConfidence > 0.2) {
    tags.add('landscape')
  }
  return [...tags]
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

  // Portrait / salient subject focus & blink detection.
  const sub = f.subject
  const hasPortrait = sub !== undefined && sub.faceRegions >= 1 && sub.skinRatio >= 0.02
  if (sub !== undefined && hasPortrait && peakSharp >= 0.45 && sub.subjectSharpnessRatio < 0.25) {
    sharp *= 0.68
    issues.push('subject-out-of-focus')
  }
  if (sub?.eyesClosedSuspected === true) {
    issues.push('eyes-closed')
  }

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

  let technical = 100 * (0.45 * sharp + 0.25 * exposure + 0.13 * noise + 0.1 * contrast + 0.07 * castScore)
  if (sub?.eyesClosedSuspected === true) technical = Math.max(0, technical - 18)
  return {
    technical: round(technical, 1),
    issues,
    tags: inferHeuristicTags(f, ctx),
    detail: {
      sharpness: round(sharp * 100, 1),
      subjectSharpness: sub ? round(lin(Math.log10(sub.subjectSharpness + 1), 1.4, 2.8) * 100, 1) : undefined,
      faceRegions: sub?.faceRegions ?? 0,
      eyesClosedSuspected: sub?.eyesClosedSuspected ?? false,
      exposure: round(exposure * 100, 1),
      noise: round(noise * 100, 1),
      contrast: round(contrast * 100, 1),
      whiteBalance: round(castScore * 100, 1),
      motionBlur,
    },
    reasons: {
      technical: `sharp ${round(sharp * 100)}, exposure ${round(exposure * 100)}, noise ${round(noise * 100)}, contrast ${round(contrast * 100)}${sub?.eyesClosedSuspected ? ', eyes-closed suspected' : ''}`,
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
    tags: inferHeuristicTags(f, ctx),
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

/**
 * Estimate how much a professional edit can lift the frame, grounded in actual
 * sensor/RAW headroom (ISO read-noise floor, bit depth, single-channel vs
 * all-channel highlight clipping, and shadow texture retention) rather than
 * guessing blindly from whether a RAW file exists.
 */
export function potentialScore(f: Features, tech: ScoreSet, ctx: ShotContext): ScoreSet {
  const issues = new Set(tech.issues ?? [])
  const e = f.exposure
  const iso = ctx.iso ?? 200
  const bits = ctx.bitsPerSample ?? (ctx.isRaw ? 14 : 8)
  const isoFactor = clamp(1 - Math.max(0, Math.log2(Math.max(100, iso) / 100)) / 6.5, 0.15, 1)
  const bitFactor = ctx.isRaw ? clamp((bits - 8) / 6, 0.5, 1) : 0.2
  const shadowHeadroom = e.shadowHeadroom ?? (1 - clamp(e.clipLow * 4, 0, 1))
  const singleClip = e.singleChannelClipHigh ?? (e.clipHigh * 0.5)
  const allClip = e.allChannelClipHigh ?? (e.clipHigh * 0.5)

  // Estimated recoverable dynamic range in EV.
  const shadowEv = round((ctx.isRaw ? 2.8 : 0.7) * isoFactor * bitFactor * (0.4 + 0.6 * shadowHeadroom), 2)
  const highlightEv = round(
    ctx.isRaw
      ? Math.max(0, (1.4 - clamp(allClip * 8, 0, 1.4)) * (0.65 + 0.35 * clamp(singleClip * 10, 0, 1)))
      : Math.max(0, 0.25 - clamp(allClip * 4, 0, 0.25)),
    2,
  )
  const headroomEv = round(shadowEv + highlightEv, 2)
  const allChannelBlowout = allClip > 0.18
  const highlightRecoverable = e.clipHigh > 0.01 && !allChannelBlowout && (ctx.isRaw || singleClip > allClip)
  const shadowRecoverable = (issues.has('underexposed') || issues.has('shadow-clipping')) && shadowHeadroom >= 0.35 && iso <= 3200

  let potential = 0.42 + Math.min(0.28, headroomEv / 12)
  const fixable: string[] = []
  if (issues.has('underexposed') || issues.has('shadow-clipping')) {
    if (shadowRecoverable) {
      potential += ctx.isRaw ? 0.12 * isoFactor : 0.04
      fixable.push('shadows')
    } else {
      potential -= 0.08
    }
  }
  if (issues.has('overexposed') || issues.has('highlight-clipping')) {
    if (allChannelBlowout) {
      potential -= ctx.isRaw ? 0.18 : 0.25
    } else if (highlightRecoverable) {
      potential += ctx.isRaw ? 0.1 : 0.03
      fixable.push('highlights')
    }
  }
  for (const k of ['color-cast', 'tilted-horizon', 'flat'] as const) {
    if (issues.has(k)) {
      potential += ctx.isRaw ? 0.05 : 0.035
      fixable.push(k)
    }
  }
  if (issues.has('out-of-focus') || issues.has('motion-blur') || issues.has('subject-out-of-focus')) potential -= 0.35
  if (issues.has('eyes-closed')) potential -= 0.25
  if (issues.has('noisy')) potential -= ctx.isRaw ? 0.04 : 0.12
  potential += 0.08 * lin(e.entropy, 6, 7.6)

  return {
    potential: round(clamp(potential, 0, 1) * 100, 1),
    detail: {
      headroomEv,
      shadowEv,
      highlightEv,
      highlightRecoverable,
      shadowRecoverable,
      allChannelBlowout,
    },
    reasons: {
      potential: `${ctx.isRaw ? `RAW ~${headroomEv}EV headroom (ISO${iso})` : 'raster only'}; recoverable: ${fixable.join(', ') || 'none'}${allChannelBlowout ? '; unrecoverable highlight blowout' : ''}`,
    },
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
