/**
 * Contact sheets: a labeled grid of thumbnails in one image. Lets a vision
 * model (or the agent itself) judge many frames per request, which cuts image
 * tokens by an order of magnitude compared with one image per photo.
 */
import sharp, { type OverlayOptions } from 'sharp'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface SheetCell { label: string; path: string; caption?: string }

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
    const text = escapeXml(c.caption === undefined ? c.label : `${c.label}  ${c.caption}`)
    const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${cell}" height="${labelH}"><rect width="100%" height="100%" fill="#202124"/><text x="6" y="18" font-family="Helvetica, Arial, sans-serif" font-size="15" font-weight="bold" fill="#ffd54f">${text}</text></svg>`)
    composites.push({ input: svg, left: x, top: y })
    layout.push({ label: c.label, x: ox, y: oy, w: img.info.width, h: img.info.height })
  }
  await mkdir(dirname(dest), { recursive: true })
  await sharp({ create: { width, height, channels: 3, background: '#111111' } }).composite(composites).jpeg({ quality: 85 }).toFile(dest)
  return { path: dest, width, height, layout }
}
