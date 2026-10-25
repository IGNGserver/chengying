/**
 * Metadata service built on ExifTool (bundled by exiftool-vendored, so it works
 * out of the box wherever Perl exists — macOS/Linux — and via the bundled exe
 * on Windows).
 *
 * Reads are batched through exiftool-vendored's stay-open process pool; writes
 * and binary extraction spawn ExifTool directly so the exact argument list is
 * auditable. Writes only ever target files the caller has already validated
 * against the FsGuard (exports and scratch), never originals.
 */
import { ExifTool, exiftoolPath } from 'exiftool-vendored'
import { stat } from 'node:fs/promises'
import { run } from '../util/proc.ts'
import { ChengyingError } from '../util/errors.ts'
import type { PhotoMetadata } from '../types.ts'

type RawTags = Record<string, unknown>

/** Tags that define provenance and must survive every export bit-for-bit (or within tolerance). */
export const PRESERVED_TAGS = [
  'DateTimeOriginal',
  'CreateDate',
  'OffsetTimeOriginal',
  'OffsetTime',
  'SubSecTimeOriginal',
  'GPSLatitude',
  'GPSLongitude',
  'GPSAltitude',
  'GPSDateStamp',
  'GPSTimeStamp',
  'Make',
  'Model',
  'LensModel',
  'SerialNumber',
  'ISO',
  'ExposureTime',
  'FNumber',
  'FocalLength',
  'Artist',
  'Copyright',
] as const

const NUMERIC_TOLERANCE: Record<string, number> = {
  GPSLatitude: 1e-6,
  GPSLongitude: 1e-6,
  GPSAltitude: 0.05,
  ExposureTime: 1e-9,
  FNumber: 0.001,
  FocalLength: 0.01,
  ISO: 0.5,
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return undefined
}

function str(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined
  const s = String(v).trim()
  return s === '' ? undefined : s
}

/** "2024:05:01 12:34:56" (+ optional offset) → ISO-ish local and UTC strings. */
export function parseExifDate(value: unknown, offset?: string, subsec?: string): { local?: string; utc?: string } {
  const s = str(value)
  if (s === undefined) return {}
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(\.\d+)?([+-]\d{2}:\d{2}|Z)?/.exec(s)
  if (m === null) return {}
  const frac = m[7] ?? (subsec !== undefined && /^\d+$/.test(subsec) ? `.${subsec}` : '')
  const local = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${frac}`
  if (m[1] === '0000') return {}
  const zone = m[8] ?? (offset !== undefined && /^[+-]\d{2}:\d{2}$/.test(offset) ? offset : undefined)
  if (zone === undefined) return { local }
  const date = new Date(`${local}${zone}`)
  return Number.isNaN(date.getTime()) ? { local } : { local, utc: date.toISOString() }
}

export function normalizeMetadata(tags: RawTags): PhotoMetadata {
  const offset = str(tags.OffsetTimeOriginal) ?? str(tags.OffsetTime) ?? str(tags.TimeZoneOffset)
  const subsec = str(tags.SubSecTimeOriginal)
  const date = parseExifDate(tags.DateTimeOriginal ?? tags.CreateDate ?? tags.DateCreated ?? tags.ModifyDate, offset, subsec)
  const lat = num(tags.GPSLatitude)
  const lon = num(tags.GPSLongitude)
  const alt = num(tags.GPSAltitude)
  const make = str(tags.Make)
  const model = str(tags.Model)
  const camera = make !== undefined && model !== undefined
    ? (model.toLowerCase().startsWith(make.toLowerCase().split(' ')[0] ?? '') ? model : `${make} ${model}`)
    : model ?? make
  const preserved: Record<string, string | number> = {}
  for (const key of PRESERVED_TAGS) {
    const v = tags[key]
    if (typeof v === 'number' || typeof v === 'string') preserved[key] = v
  }
  const meta: PhotoMetadata = {
    captureTime: date.local,
    captureTimeUtc: date.utc,
    tzOffset: offset,
    subSec: subsec,
    gps: lat !== undefined && lon !== undefined && !(lat === 0 && lon === 0) ? { lat, lon, ...(alt === undefined ? {} : { alt }) } : undefined,
    camera,
    cameraSerial: str(tags.SerialNumber) ?? str(tags.InternalSerialNumber),
    lens: str(tags.LensModel) ?? str(tags.LensID) ?? str(tags.Lens),
    iso: num(tags.ISO),
    exposureTime: num(tags.ExposureTime),
    aperture: num(tags.FNumber) ?? num(tags.Aperture),
    focalLength: num(tags.FocalLength),
    width: num(tags.ImageWidth) ?? num(tags.ExifImageWidth),
    height: num(tags.ImageHeight) ?? num(tags.ExifImageHeight),
    orientation: num(tags.Orientation),
    rating: num(tags.Rating),
    mimeType: str(tags.MIMEType),
    hasEmbeddedPreview: tags.PreviewImage !== undefined || tags.JpgFromRaw !== undefined || tags.OtherImage !== undefined,
    preserved,
  }
  for (const k of Object.keys(meta) as Array<keyof PhotoMetadata>) if (meta[k] === undefined) delete meta[k]
  return meta
}

export interface VerifyReport {
  ok: boolean
  checked: number
  missing: string[]
  mismatched: Array<{ tag: string; source: unknown; exported: unknown }>
  details: Record<string, { source: unknown; exported: unknown; ok: boolean }>
}

export class MetadataService {
  private readonly et: ExifTool
  private pathPromise: Promise<string> | undefined

  constructor(options: { maxProcs?: number; taskTimeoutMillis?: number } = {}) {
    this.et = new ExifTool({ maxProcs: options.maxProcs ?? 4, taskTimeoutMillis: options.taskTimeoutMillis ?? 60_000 })
  }

  private exe(): Promise<string> {
    this.pathPromise ??= exiftoolPath()
    return this.pathPromise
  }

  async version(): Promise<string> {
    return await this.et.version()
  }

  async readRawTags(file: string): Promise<RawTags> {
    // -n: numeric values (signed GPS, numeric orientation); composite tags included.
    const tags = await this.et.readRaw(file, { readArgs: ['-n', '-fast', '-api', 'LargeFileSupport=1'] }) as RawTags
    return tags
  }

  async read(file: string): Promise<{ meta: PhotoMetadata; raw: RawTags }> {
    const raw = await this.readRawTags(file)
    return { meta: normalizeMetadata(raw), raw }
  }

  /** Run ExifTool directly with an explicit argument list. */
  async exec(args: string[], signal?: AbortSignal): Promise<{ stdout: string; stderr: string; code: number | null }> {
    const exe = await this.exe()
    const r = await run(exe, ['-charset', 'filename=utf8', ...args], { timeoutMs: 120_000, signal, maxOutputBytes: 64 * 1024 * 1024 })
    return { stdout: r.stdout, stderr: r.stderr, code: r.code }
  }

  /**
   * Extract the largest embedded JPEG from a RAW (or any file with previews).
   * Returns the tag that was used, or undefined when none exists.
   */
  async extractBestPreview(file: string, dest: string): Promise<string | undefined> {
    const raw = await this.et.readRaw(file, { readArgs: ['-n', '-PreviewImage', '-JpgFromRaw', '-OtherImage', '-ThumbnailImage', '-PreviewTIFF'] }) as RawTags
    const sizeOf = (v: unknown): number => {
      if (typeof v === 'string') {
        const m = /(\d+) bytes/.exec(v)
        return m ? Number(m[1]) : 0
      }
      return 0
    }
    const candidates = ['JpgFromRaw', 'PreviewImage', 'OtherImage', 'ThumbnailImage']
      .map(tag => ({ tag, size: sizeOf(raw[tag]) }))
      .filter(c => c.size > 0)
      .sort((a, b) => b.size - a.size)
    for (const c of candidates) {
      try {
        await this.et.extractBinaryTag(c.tag, file, dest, { forceWrite: true, ignoreMinorErrors: true })
      } catch {
        continue
      }
      const s = await stat(dest).catch(() => undefined)
      if (s !== undefined && s.size > 1024) return c.tag
    }
    return undefined
  }

  /**
   * Copy all source metadata into an exported file, reset orientation (pixels
   * are already upright) and stamp processing provenance. The ICC profile of
   * the export is kept because it describes the rendered pixels.
   */
  async copyForExport(source: string, exported: string, provenance: { software: string; recipe?: string; generative?: boolean; history?: string }, signal?: AbortSignal): Promise<void> {
    const args = [
      '-overwrite_original',
      '-m',
      '-TagsFromFile', source,
      '-all:all', '-unsafe',
      '--ICC_Profile:all',
      '--PreviewImage', '--ThumbnailImage', '--JpgFromRaw', '--OtherImage', '--PreviewTIFF', '--ThumbnailTIFF',
      '--StripOffsets', '--StripByteCounts', '--ImageWidth', '--ImageHeight', '--BitsPerSample', '--Compression', '--PhotometricInterpretation',
      '--ExifImageWidth', '--ExifImageHeight',
      // Second pass in the same command: our own provenance tags.
      '-Orientation#=1',
      `-XMP-xmp:CreatorTool=${provenance.software}`,
      `-Software=${provenance.software}`,
    ]
    if (provenance.history !== undefined) args.push(`-XMP-photoshop:History=${provenance.history}`)
    if (provenance.recipe !== undefined) args.push(`-XMP-dc:Source=${provenance.recipe}`)
    if (provenance.generative === true) {
      args.push('-XMP-iptcExt:DigitalSourceType=http://cv.iptc.org/newscodes/digitalsourcetype/compositeWithTrainedAlgorithmicMedia')
    }
    args.push(exported)
    const r = await this.exec(args, signal)
    if (r.code !== 0) {
      throw new ChengyingError('engine-failed', `exiftool metadata copy failed: ${r.stderr.trim() || r.stdout.trim()}`, { source, exported })
    }
  }

  /** Compare provenance tags of the source and an exported file. */
  async verify(source: string, exported: string, sourceTags?: RawTags): Promise<VerifyReport> {
    const src = sourceTags ?? await this.readRawTags(source)
    const dst = await this.readRawTags(exported)
    const details: VerifyReport['details'] = {}
    const missing: string[] = []
    const mismatched: VerifyReport['mismatched'] = []
    let checked = 0
    for (const tag of PRESERVED_TAGS) {
      const a = src[tag]
      if (a === undefined || a === null || a === '') continue
      checked++
      const b = dst[tag]
      let ok: boolean
      if (b === undefined || b === null || b === '') {
        ok = false
        missing.push(tag)
      } else {
        const na = num(a)
        const nb = num(b)
        if (na !== undefined && nb !== undefined) ok = Math.abs(na - nb) <= (NUMERIC_TOLERANCE[tag] ?? 1e-9)
        else ok = String(a).trim() === String(b).trim()
        if (!ok) mismatched.push({ tag, source: a, exported: b })
      }
      details[tag] = { source: a, exported: b, ok }
    }
    const orientation = num(dst.Orientation)
    if (orientation !== undefined && orientation !== 1) {
      mismatched.push({ tag: 'Orientation', source: 1, exported: orientation })
      details.Orientation = { source: 1, exported: orientation, ok: false }
    }
    return { ok: missing.length === 0 && mismatched.length === 0, checked, missing, mismatched, details }
  }

  /** Write tags to a Chengying-owned file (used by tests to build fixtures, and for ratings sidecars). */
  async writeTags(file: string, tags: Record<string, string | number>, signal?: AbortSignal): Promise<void> {
    const args = ['-overwrite_original', '-m']
    for (const [k, v] of Object.entries(tags)) args.push(`-${k}=${v}`)
    args.push(file)
    const r = await this.exec(args, signal)
    if (r.code !== 0) throw new ChengyingError('engine-failed', `exiftool write failed: ${r.stderr.trim()}`, { file })
  }

  async end(): Promise<void> {
    await this.et.end()
  }
}
