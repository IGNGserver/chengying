/**
 * Display previews for culling. Raster files decode through libvips (sharp);
 * RAW files use their largest embedded JPEG (fast, no engine needed); a RAW
 * without a usable preview, or a format libvips cannot decode, can fall back
 * to a caller-supplied renderer (an installed RAW engine) or to the platform
 * converter (`sips` on macOS).
 */
import sharp, { type Sharp } from 'sharp'
import { mkdir, rm, rename, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { cpus, platform, tmpdir } from 'node:os'
import { run } from '../util/proc.ts'
import { ChengyingError, errorMessage } from '../util/errors.ts'
import type { MetadataService } from '../meta/exif.ts'

sharp.cache(false)
sharp.concurrency(Math.max(1, Math.min(4, cpus().length)))

export const RAW_EXTENSIONS = new Set([
  'arw', 'srf', 'sr2', 'cr2', 'cr3', 'crw', 'nef', 'nrw', 'orf', 'raf', 'rw2', 'rwl', 'pef', 'ptx', 'dng', 'srw',
  'x3f', '3fr', 'fff', 'iiq', 'erf', 'mef', 'mos', 'kdc', 'dcr', 'mrw', 'raw', 'gpr',
])
export const RASTER_EXTENSIONS = new Set(['jpg', 'jpeg', 'jpe', 'png', 'tif', 'tiff', 'webp', 'heic', 'heif', 'hif', 'avif', 'jxl', 'bmp'])

export type RawFallbackRenderer = (sourcePath: string, dest: string, maxEdge: number) => Promise<boolean>

export interface PreviewResult {
  previewPath: string
  thumbPath: string
  source: 'decoded' | 'embedded' | 'engine' | 'platform'
  width: number
  height: number
}

/** Apply EXIF orientation 1..8 to an image whose pixels ignore it. */
export function orient(img: Sharp, orientation: number | undefined): Sharp {
  switch (orientation) {
    case 2: return img.flop()
    case 3: return img.rotate(180)
    case 4: return img.flip()
    case 5: return img.rotate(90).flop()
    case 6: return img.rotate(90)
    case 7: return img.rotate(270).flop()
    case 8: return img.rotate(270)
    default: return img
  }
}

async function writeVariants(input: Sharp, previewPath: string, thumbPath: string, maxEdge: number, thumbEdge: number): Promise<{ width: number; height: number }> {
  await mkdir(dirname(previewPath), { recursive: true })
  await mkdir(dirname(thumbPath), { recursive: true })
  const tmpPreview = `${previewPath}.part`
  const info = await input
    .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
    .toColourspace('srgb')
    .jpeg({ quality: 86, mozjpeg: false })
    .toFile(tmpPreview)
  await rename(tmpPreview, previewPath)
  await sharp(previewPath).resize({ width: thumbEdge, height: thumbEdge, fit: 'inside' }).jpeg({ quality: 80 }).toFile(`${thumbPath}.part`)
  await rename(`${thumbPath}.part`, thumbPath)
  return { width: info.width, height: info.height }
}

export interface PreviewOptions {
  maxEdge?: number
  thumbEdge?: number
  metadata: MetadataService
  rawFallback?: RawFallbackRenderer
  scratchDir: string
}

export async function makePreview(sourcePath: string, ext: string, orientation: number | undefined, previewPath: string, thumbPath: string, options: PreviewOptions): Promise<PreviewResult> {
  const maxEdge = options.maxEdge ?? 1600
  const thumbEdge = options.thumbEdge ?? 400
  const lower = ext.toLowerCase()
  const errors: string[] = []

  if (!RAW_EXTENSIONS.has(lower)) {
    try {
      // .rotate() with no argument honours the file's own EXIF orientation.
      const img = sharp(sourcePath, { failOn: 'none', limitInputPixels: false }).rotate()
      const dims = await writeVariants(img, previewPath, thumbPath, maxEdge, thumbEdge)
      return { previewPath, thumbPath, source: 'decoded', ...dims }
    } catch (error) {
      errors.push(`libvips: ${errorMessage(error)}`)
    }
  }

  // Embedded JPEG (RAW, and HEIC/TIFF files that carry one).
  await mkdir(options.scratchDir, { recursive: true })
  const embedded = join(options.scratchDir, `emb-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`)
  try {
    const tag = await options.metadata.extractBestPreview(sourcePath, embedded)
    if (tag !== undefined) {
      const meta = await sharp(embedded).metadata()
      // Embedded previews normally carry no orientation of their own; apply the container's.
      const own = meta.orientation
      const img = own !== undefined && own > 1 ? sharp(embedded).rotate() : orient(sharp(embedded), orientation)
      const minEdge = Math.min(meta.width ?? 0, meta.height ?? 0)
      if (minEdge >= 300 || options.rawFallback === undefined) {
        const dims = await writeVariants(img, previewPath, thumbPath, maxEdge, thumbEdge)
        return { previewPath, thumbPath, source: 'embedded', ...dims }
      }
      errors.push(`embedded ${tag} too small (${meta.width}x${meta.height})`)
    } else {
      errors.push('no embedded preview')
    }
  } catch (error) {
    errors.push(`embedded: ${errorMessage(error)}`)
  } finally {
    await rm(embedded, { force: true })
  }

  if (options.rawFallback !== undefined) {
    const rendered = join(options.scratchDir, `eng-${process.pid}-${Date.now()}.jpg`)
    try {
      if (await options.rawFallback(sourcePath, rendered, maxEdge)) {
        const dims = await writeVariants(sharp(rendered), previewPath, thumbPath, maxEdge, thumbEdge)
        return { previewPath, thumbPath, source: 'engine', ...dims }
      }
    } catch (error) {
      errors.push(`engine: ${errorMessage(error)}`)
    } finally {
      await rm(rendered, { force: true })
    }
  }

  // TIFF-based RAW containers (DNG, NEF, ARW, PEF…) often keep a small RGB rendition in IFD0.
  if (RAW_EXTENSIONS.has(lower)) {
    try {
      const meta = await sharp(sourcePath, { failOn: 'none' }).metadata()
      if (Math.min(meta.width ?? 0, meta.height ?? 0) >= 300) {
        const dims = await writeVariants(orient(sharp(sourcePath, { failOn: 'none' }), orientation), previewPath, thumbPath, maxEdge, thumbEdge)
        return { previewPath, thumbPath, source: 'embedded', ...dims }
      }
      errors.push(`ifd0 too small (${meta.width}x${meta.height})`)
    } catch (error) {
      errors.push(`ifd0: ${errorMessage(error)}`)
    }
  }

  if (platform() === 'darwin') {
    const out = join(options.scratchDir.length > 0 ? options.scratchDir : tmpdir(), `sips-${process.pid}-${Date.now()}.jpg`)
    try {
      const r = await run('/usr/bin/sips', ['-s', 'format', 'jpeg', '-Z', String(maxEdge), sourcePath, '--out', out], { timeoutMs: 60_000 })
      if (r.code === 0 && (await stat(out).catch(() => undefined)) !== undefined) {
        const dims = await writeVariants(sharp(out), previewPath, thumbPath, maxEdge, thumbEdge)
        return { previewPath, thumbPath, source: 'platform', ...dims }
      }
      errors.push(`sips exited ${r.code}`)
    } catch (error) {
      errors.push(`sips: ${errorMessage(error)}`)
    } finally {
      await rm(out, { force: true })
    }
  }
  throw new ChengyingError('unsupported', `cannot build a preview for ${sourcePath}: ${errors.join('; ')}`, { sourcePath })
}

/** Decode any preview-able image to a small RGB buffer for analysis. */
export async function loadRgb(path: string, maxEdge = 512): Promise<{ width: number; height: number; data: Uint8Array }> {
  const { data, info } = await sharp(path, { failOn: 'none' })
    .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
    .removeAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true })
  return { width: info.width, height: info.height, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) }
}
