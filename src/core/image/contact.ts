/**
 * Contact sheets: a labeled grid of thumbnails in one image. Lets a vision
 * model (or the agent itself) judge many frames per request, which cuts image
 * tokens by an order of magnitude compared with one image per photo.
 */
import sharp, { type OverlayOptions } from 'sharp'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface SheetCell {
  label: string
  path: string
  caption?: string
  /** Optional normalized [x, y, w, h] face bounding box (0..1) for a 1:1 eye/expression inset. */
  faceBox?: [number, number, number, number]
}

function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c] as string))
}

export async function contactSheet(cells: SheetCell[], dest: string, options: { columns?: number; cell?: number; gap?: number } = {}): Promise<{ path: string; width: number; height: number; layout: Array<{ label: string; x: number; y: number; w: number; h: number }> }> {
  const columns = options.columns ?? Math.min(4, Math.max(1, Math.ceil(Math.sqrt(cells.length))))
  const cell = options.cell ?? 360
  const gap = options.gap ?? 8
  const labelH = 26
  const rows = Math.ceil(cells.length / columns)
  const width = columns * cell + (columns + 1) * gap
  const height = rows * (cell + labelH) + (rows + 1) * gap
  const composites: OverlayOptions[] = []
  const layout: Array<{ label: string; x: number; y: number; w: number; h: number }> = []
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i] as SheetCell
    const col = i % columns
    const row = Math.floor(i / columns)
    const x = gap + col * (cell + gap)
    const y = gap + row * (cell + labelH + gap)
    const img = await sharp(c.path).resize({ width: cell, height: cell, fit: 'inside' }).jpeg({ quality: 82 }).toBuffer({ resolveWithObject: true })
    const ox = x + Math.floor((cell - img.info.width) / 2)
    const oy = y + labelH + Math.floor((cell - img.info.height) / 2)
    composites.push({ input: img.data, left: ox, top: oy })
    // When a portrait face box is present, overlay a high-res face/eye zoom inset in the bottom-right corner
    // so VLM contact-sheet scoring can inspect open/closed eyes and expressions accurately.
    if (c.faceBox !== undefined && cell >= 280) {
      try {
        const meta = await sharp(c.path).metadata()
        const sw = meta.width ?? 0
        const sh = meta.height ?? 0
        if (sw >= 120 && sh >= 120) {
          const [fx, fy, fw, fh] = c.faceBox
          const padX = fw * 0.15
          const padY = fh * 0.15
          const left = Math.max(0, Math.floor((fx - padX) * sw))
          const top = Math.max(0, Math.floor((fy - padY) * sh))
          const cropW = Math.min(sw - left, Math.max(32, Math.ceil((fw + 2 * padX) * sw)))
          const cropH = Math.min(sh - top, Math.max(32, Math.ceil((fh + 2 * padY) * sh)))
          const insetSize = Math.max(72, Math.min(136, Math.round(cell * 0.28)))
          const inset = await sharp(c.path)
            .extract({ left, top, width: cropW, height: cropH })
            .resize({ width: insetSize - 4, height: insetSize - 4, fit: 'cover' })
            .extend({ top: 2, bottom: 2, left: 2, right: 2, background: '#ffd54f' })
            .jpeg({ quality: 86 })
            .toBuffer()
          composites.push({
            input: inset,
            left: x + cell - insetSize - 4,
            top: y + labelH + cell - insetSize - 4,
          })
        }
      } catch {
        // Ignore inset errors and keep the main cell thumbnail.
      }
    }
    const text = escapeXml(c.caption === undefined ? c.label : `${c.label}  ${c.caption}`)
    const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${cell}" height="${labelH}"><rect width="100%" height="100%" fill="#202124"/><text x="6" y="18" font-family="Helvetica, Arial, sans-serif" font-size="15" font-weight="bold" fill="#ffd54f">${text}</text></svg>`)
    composites.push({ input: svg, left: x, top: y })
    layout.push({ label: c.label, x: ox, y: oy, w: img.info.width, h: img.info.height })
  }
  await mkdir(dirname(dest), { recursive: true })
  await sharp({ create: { width, height, channels: 3, background: '#111111' } }).composite(composites).jpeg({ quality: 85 }).toFile(dest)
  return { path: dest, width, height, layout }
}
