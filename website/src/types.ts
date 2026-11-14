export type Lang = 'zh' | 'en'
export type SurroundMode = 'darkroom' | 'baryta'

export interface Bilingual {
  zh: string
  en: string
}

export interface HeroPlate {
  id: string
  frameNo: string
  fileCode: string
  title: Bilingual
  location: Bilingual
  exif: string
  formatBadge: Bilingual
  originalStatus: Bilingual
  masterSrc: string
  masterSrc960: string
  rawSrc: string
  rawStats: {
    p05: number
    p50: number
    p95: number
    clipHigh: number
    headroomEv: number
    tempK: number
  }
  gradedStats: {
    p05: number
    p50: number
    p95: number
    clipHigh: number
    headroomEv: number
    tempK: number
  }
  recipeSummary: Bilingual
  rawShaderPreset: {
    ev: number
    contrast: number
    saturation: number
    tempShift: number
  }
}

export type CullDefectKind =
  | 'pick'
  | 'eyes-closed'
  | 'motion-blur'
  | 'exact-dup'
  | 'near-dup'
  | 'clip-high'
  | 'underexp-rescue'
  | 'horizon-tilt'
  | 'soft-focus'

export interface CullingFrame {
  id: string
  frameNo: string
  fileName: string
  pairedRaw: string
  groupCode: string
  groupKind: 'exact' | 'near' | 'scene'
  segmentId: 'day1' | 'day3' | 'day5' | 'day8'
  segmentTitle: Bilingual
  thumbSrc: string
  masterSrc?: string
  faceInsetSrc?: string
  isPick: boolean
  isRawRescue?: boolean
  defectKind: CullDefectKind
  defectBadge: Bilingual
  diagnosticNote: Bilingual
  exifShort: string
  scores: {
    overall: number
    technical: number
    aesthetic: number
    story: number
    potential: number
  }
  tags: Array<'landscape' | 'portrait' | 'craft' | 'night' | 'journey'>
  caption: Bilingual
  narrativeSpan?: 'wide' | 'tall' | 'standard'
}

export type CurveChannel = 'master' | 'red' | 'green' | 'blue'
export type MaskKind = 'none' | 'ellipse' | 'gradient' | 'radial'

export interface DarkroomMask {
  kind: MaskKind
  cx: number
  cy: number
  rx: number
  ry: number
  feather: number
  ev: number
  temp: number
}

export interface DarkroomParams {
  exposure: number // -2.0 .. +2.0 EV
  temperature: number // -50 .. +50 (mapped to 3200K .. 8200K)
  tint: number // -50 .. +50
  contrast: number // -50 .. +50
  highlights: number // -100 .. +60
  shadows: number // -60 .. +100
  blacks: number // -50 .. +50
  vibrance: number // -50 .. +60
  saturation: number // -50 .. +50
  clarity: number // -30 .. +40
  dehaze: number // 0 .. +30
  splitShadowHue: number // 0..360
  splitShadowSat: number // 0..40
  splitHighlightHue: number // 0..360
  splitHighlightSat: number // 0..40
  curves: Record<CurveChannel, Array<[number, number]>>
  mask: DarkroomMask
}

export interface DarkroomPhoto {
  id: string
  frameNo: string
  fileName: string
  title: Bilingual
  src: string
  src960: string
  exif: string
  isPortrait: boolean
  shadowEvCeiling: number
  baseTempK: number
  faceBox?: [number, number, number, number]
  defaultRecipeId: string
  ungradedParams: DarkroomParams
}

export interface StyleRecipePreset {
  id: string
  code: string
  name: Bilingual
  subtitle: Bilingual
  forbidNote: Bilingual
  params: Partial<DarkroomParams>
}

export interface RevisionEntry {
  seq: number
  id: string
  label: Bilingual
  author: Bilingual
  timestamp: string
  params: DarkroomParams
}

export interface AgentTaskSim {
  taskId: string
  shotCode: string
  fileName: string
  title: Bilingual
  sceneCluster: Bilingual
  isSceneAnchor: boolean
  roleBadge: Bilingual
  engineLabel: Bilingual
  thumbSrc: string
  masterSrc: string
  finalStatus: 'succeeded' | 'unchanged'
  revisionsCount: number
  photoSummary: {
    lightFeel: Bilingual
    focusGoal: Bilingual
    localTouch: Bilingual
    outcomeNote: Bilingual
  }
  steps: Array<{
    stepLabel: Bilingual
    actionTag: Bilingual
    badge: 'diag' | 'skill' | 'apply' | 'revert' | 'anchor' | 'finish'
    detail: Bilingual
    note: Bilingual
  }>
}
