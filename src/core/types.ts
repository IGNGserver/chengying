/** Domain vocabulary shared across culling, editing, export and the DSH layer. */

export type FileKind = 'raw' | 'raster'

export interface FileRecord {
  id: string
  shotId: string | null
  path: string
  relPath: string
  dir: string
  base: string
  ext: string
  kind: FileKind
  format: string
  size: number
  mtimeMs: number
  sha256: string | null
  status: 'ok' | 'error'
  error: string | null
  meta: PhotoMetadata
}

/** Normalized source metadata read from EXIF/XMP/maker notes. */
export interface PhotoMetadata {
  captureTime?: string          // ISO local date-time as written by the camera (no zone)
  captureTimeUtc?: string       // ISO UTC when the zone is known
  tzOffset?: string             // e.g. +08:00
  subSec?: string
  gps?: { lat: number; lon: number; alt?: number }
  camera?: string
  cameraSerial?: string
  lens?: string
  iso?: number
  exposureTime?: number         // seconds
  aperture?: number
  focalLength?: number
  width?: number
  height?: number
  orientation?: number
  rating?: number
  mimeType?: string
  hasEmbeddedPreview?: boolean
  /** Tag names that must survive export (source of truth for verification). */
  preserved?: Record<string, string | number>
}

export interface Shot {
  id: string
  primaryFile: string           // file id of the best source (RAW when present)
  rawFile: string | null
  rasterFile: string | null
  captureTime: string | null
  captureTs: number | null      // epoch seconds (UTC when known, else local-as-UTC)
  tzOffset: string | null
  day: string | null            // YYYY-MM-DD local
  gps: { lat: number; lon: number; alt?: number } | null
  camera: string | null
  lens: string | null
  iso: number | null
  exposureTime: number | null
  aperture: number | null
  focalLength: number | null
  width: number | null
  height: number | null
  orientation: number | null
  previewPath: string | null
  thumbPath: string | null
  previewSource: string | null
  previewError: string | null
  userFlag: 'pick' | 'reject' | null
  userRating: number | null
  note: string | null
  tags: string[]
}

/** Low-level measurements computed from pixels (deterministic, versioned). */
export interface Features {
  version: number
  width: number
  height: number
  phash: string
  dhash: string
  /** 64-bin hue/sat/value histogram, L1 normalized. */
  colorHist: number[]
  /** 8x8 Lab thumbnail flattened (L,a,b) for scene similarity. */
  layout: number[]
  sharpness: { global: number; peak: number; centerWeighted: number; anisotropy: number }
  exposure: { mean: number; median: number; p01: number; p99: number; clipHigh: number; clipLow: number; entropy: number; dynamicRange: number }
  contrast: number
  noise: number
  color: { colorfulness: number; saturation: number; castA: number; castB: number; warmth: number }
  composition: {
    saliencyCentroid: [number, number]
    saliencySpread: number
    thirds: number
    balance: number
    tiltDeg: number
    tiltConfidence: number
    symmetry: number
    borderClutter: number
    subjectContrast: number
  }
}

/** Score dimensions on a 0..100 scale. */
export interface ScoreSet {
  technical?: number
  aesthetic?: number
  composition?: number
  content?: number
  story?: number
  potential?: number
  overall?: number
  tags?: string[]
  issues?: string[]
  caption?: string
  notes?: string
  /** Per-dimension explanations. */
  reasons?: Record<string, string>
  /** Additional raw detail from the scorer (sub-scores, model outputs). */
  detail?: Record<string, unknown>
}

export type ScoreSource = 'technical' | 'aesthetic' | `model:${string}` | `vlm:${string}` | 'agent' | 'user'

export type GroupKind = 'exact' | 'near' | 'scene' | 'segment' | 'day' | 'location'

export interface Group {
  id: string
  kind: GroupKind
  label: string
  members: Array<{ shotId: string; rank: number; role: 'best' | 'member' }>
  info: Record<string, unknown>
}

export interface SelectionSpec {
  /** Original natural-language request, kept for traceability. */
  request?: string
  /** Exact number of photos; omit for quality-threshold mode. */
  count?: number
  /** Minimum combined score (0..100) in threshold mode; also a floor in count mode. */
  minScore?: number
  maxCount?: number
  weights?: Partial<Record<'technical' | 'aesthetic' | 'composition' | 'content' | 'story' | 'potential' | 'preference', number>>
  /** 0 = pure quality, 1 = maximal variety. */
  diversity?: number
  /** Max photos from one scene group. */
  perScene?: number
  /** Spread picks across days / location / time segments (travel narrative). */
  narrative?: boolean
  preferTags?: string[]
  avoidTags?: string[]
  requireTags?: string[]
  include?: string[]
  exclude?: string[]
  orientation?: 'landscape' | 'portrait' | 'square' | 'any'
  timeRange?: { from?: string; to?: string }
  rawOnly?: boolean
  excludeRejected?: boolean
  name?: string
}

export interface SelectionItem {
  shotId: string
  rank: number
  score: number
  reason: string
  source: 'auto' | 'user'
  locked: boolean
  included: boolean
}

export type TaskStatus = 'queued' | 'running' | 'paused' | 'failed' | 'succeeded' | 'cancelled' | 'waiting-authorization'

export interface TaskRecord {
  id: string
  kind: 'edit'
  shotId: string
  selectionId: string | null
  status: TaskStatus
  priority: number
  engine: string | null
  instructions: string
  options: Record<string, unknown>
  attempts: number
  maxAttempts: number
  error: string | null
  headRevision: string | null
  agentSession: string | null
  usage: UsageTotals
  createdAt: string
  updatedAt: string
  startedAt: string | null
  finishedAt: string | null
}

export interface UsageTotals {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  images: number
  calls: number
}

/* ---------------------------------------------------------------- editing */

/** Engine-neutral geometry in normalized image coordinates (0..1, origin top-left, after orientation). */
export type MaskShape =
  | { type: 'ellipse'; cx: number; cy: number; rx: number; ry: number; rotation?: number; feather?: number; invert?: boolean; opacity?: number }
  | { type: 'circle'; cx: number; cy: number; r: number; feather?: number; invert?: boolean; opacity?: number }
  | { type: 'rectangle'; x: number; y: number; w: number; h: number; feather?: number; invert?: boolean; opacity?: number }
  | { type: 'gradient'; x0: number; y0: number; x1: number; y1: number; invert?: boolean; opacity?: number }
  | { type: 'polygon'; points: Array<[number, number]>; feather?: number; invert?: boolean; opacity?: number }
  | { type: 'brush'; strokes: Array<{ points: Array<[number, number]>; radius: number; hardness?: number }>; invert?: boolean; opacity?: number }

export interface ParametricRange {
  channel: 'luminance' | 'hue' | 'saturation' | 'chroma' | 'red' | 'green' | 'blue' | 'gray' | 'lab_l' | 'lab_a' | 'lab_b' | 'jzazbz_j' | 'value'
  /** Ranges in the channel's natural unit (0..1 for most, hue in degrees 0..360). */
  from: number
  to: number
  /** Soft ramp width at each side. */
  softness?: number
  invert?: boolean
  /** darktable: whether to test the input (false) or output (true) of the module. */
  output?: boolean
}

export interface MaskSpec {
  shapes?: MaskShape[]
  shapesCombine?: 'union' | 'intersection' | 'difference' | 'exclusion'
  parametric?: ParametricRange[]
  /** How drawn and parametric masks combine. */
  combine?: 'intersection' | 'union'
  invert?: boolean
  feather?: number          // px-independent normalized radius (0..0.2)
  blur?: number
  opacity?: number          // 0..1
  blendMode?: string        // engine-specific names accepted
  /** Engine-native blend/mask fields passed through verbatim (e.g. darktable blendop fields). */
  native?: Record<string, unknown>
}

export interface EditStep {
  id: string
  /** Operation id from the engine catalog. */
  op: string
  params: Record<string, unknown>
  enabled: boolean
  /** Multi-instance label/priority (darktable multi_priority, RT spot index…). */
  instance?: number
  label?: string
  mask?: MaskSpec
}

export interface EditStage {
  id: string
  engine: string
  steps: EditStep[]
  /** Engine-level options (e.g. darktable workflow defaults, RT base profile). */
  options?: Record<string, unknown>
}

/** A complete, engine-addressable edit recipe. Immutable per revision. */
export interface EditDocument {
  schema: 1
  sourceFile: string        // file id actually developed (RAW preferred)
  stages: EditStage[]
  output?: { maxEdge?: number; format?: 'jpeg' | 'tiff' | 'png' | 'webp' | 'avif'; quality?: number; bitDepth?: 8 | 16 }
  /** Provenance flags (generative edits etc.). */
  provenance?: { generative?: boolean; authorizationIds?: string[]; notes?: string[] }
}

export interface RevisionRecord {
  id: string
  taskId: string
  parentId: string | null
  seq: number
  doc: EditDocument
  message: string
  author: string
  createdAt: string
  previewPath: string | null
  stats: Record<string, unknown> | null
}
