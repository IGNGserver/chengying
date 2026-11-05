/**
 * Image format detection shared by intake and scanning.
 *
 * The Harness attachment store keeps pasted images as content-addressed
 * objects (`attachments/v1/objects/<xx>/<sha256>`) with no file extension, and
 * every stage after intake (scan whitelist, preview engine, export naming) is
 * keyed by extension. The format therefore has to be recovered from the bytes
 * before a photo can enter the pipeline.
 */
import { open } from 'node:fs/promises'
import { RAW_EXTENSIONS, RASTER_EXTENSIONS } from './preview.ts'

export type ImageKind = 'raw' | 'raster'

export interface ImageFormat {
  /** Canonical lowercase extension (`jpg`, `png`, `tif`, `cr2`, ...). */
  ext: string
  mediaType: string
  kind: ImageKind
  /**
   * Container family detected from the magic bytes. TIFF and ISO-BMFF hold
   * several formats (DNG/CR2/NEF vs HEIC/AVIF), so the scanner refines these
   * with ExifTool `FileTypeExtension` before deciding the extension.
   */
  container?: 'tiff' | 'isobmff'
}

const MEDIA_TYPE_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/pjpeg': 'jpg',
  'image/png': 'png',
  'image/apng': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/tiff': 'tif',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/heic-sequence': 'heic',
  'image/heif-sequence': 'heif',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
}

/** Compatible spellings mapped to the canonical extension Chengying stores. */
const EXT_ALIASES: Record<string, string> = {
  jpeg: 'jpg',
  jpe: 'jpg',
  jfif: 'jpg',
  tiff: 'tif',
  hif: 'heif',
}

const EXT_MEDIA: Record<string, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  tif: 'image/tiff',
  heic: 'image/heic',
  heif: 'image/heif',
  avif: 'image/avif',
  bmp: 'image/bmp',
}

function normalize(value: string): string {
  const lower = value.trim().toLowerCase().replace(/^\./, '')
  return EXT_ALIASES[lower] ?? lower
}

/** Canonical extension when `value` names a supported RAW or raster format. */
export function canonicalExtension(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const ext = normalize(value)
  return RAW_EXTENSIONS.has(ext) || RASTER_EXTENSIONS.has(ext) ? ext : undefined
}

export function isImageExtension(value: string | undefined): boolean {
  return canonicalExtension(value) !== undefined
}

/** Extension declared by an attachment's media type (`image/jpeg` → `jpg`). */
export function extensionForMediaType(mediaType: string | undefined): string | undefined {
  if (mediaType === undefined) return undefined
  return MEDIA_TYPE_EXT[mediaType.trim().toLowerCase()]
}

export function mediaTypeForExtension(ext: string): string {
  return EXT_MEDIA[normalize(ext)] ?? `image/x-${normalize(ext)}`
}

export function formatForExtension(value: string): ImageFormat | undefined {
  const ext = canonicalExtension(value)
  if (ext === undefined) return undefined
  return { ext, mediaType: mediaTypeForExtension(ext), kind: RAW_EXTENSIONS.has(ext) ? 'raw' : 'raster' }
}

function ascii(head: Uint8Array, start: number, end: number): string {
  let text = ''
  for (let i = start; i < end && i < head.length; i++) text += String.fromCharCode(head[i] as number)
  return text
}

function format(ext: string, container?: ImageFormat['container']): ImageFormat {
  return { ext, mediaType: mediaTypeForExtension(ext), kind: RAW_EXTENSIONS.has(ext) ? 'raw' : 'raster', ...(container === undefined ? {} : { container }) }
}

/** Detect a supported image format from the first bytes of a file. */
export function sniffImageFormat(head: Uint8Array): ImageFormat | undefined {
  if (head.length < 12) return undefined
  const b = head
  // JPEG: SOI + first marker.
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return format('jpg')
  // PNG signature.
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return format('png')
  // GIF87a / GIF89a.
  if (ascii(b, 0, 4) === 'GIF8') return format('gif')
  // WebP: RIFF container with WEBP fourcc.
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return format('webp')
  // BMP.
  if (b[0] === 0x42 && b[1] === 0x4d) return format('bmp')
  // TIFF: II*\0 (little endian) or MM\0* (big endian). RAW formats share it.
  if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0x00) || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00 && b[3] === 0x2a)) {
    return format('tif', 'tiff')
  }
  // ISO base media (HEIC/HEIF/AVIF): `ftyp` box at offset 4.
  if (ascii(b, 4, 8) === 'ftyp') {
    const brand = ascii(b, 8, 12).toLowerCase()
    if (brand.startsWith('avif') || brand.startsWith('avis')) return format('avif', 'isobmff')
    if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'].some(p => brand.startsWith(p))) return { ...format('heic', 'isobmff'), mediaType: 'image/heic' }
  }
  return undefined
}

/** Read up to `headBytes` and detect the image format; `undefined` when unsupported. */
export async function detectImageFormat(file: string, headBytes = 64 * 1024): Promise<ImageFormat | undefined> {
  const fh = await open(file, 'r')
  try {
    const buffer = Buffer.alloc(headBytes)
    const { bytesRead } = await fh.read(buffer, 0, headBytes, 0)
    return sniffImageFormat(buffer.subarray(0, bytesRead))
  } finally {
    await fh.close()
  }
}
