/**
 * Synthetic travel-shoot fixtures: SVG-rendered scenes with real texture,
 * degraded variants (blur, overexposure, noise), near and exact duplicates,
 * EXIF capture time + GPS + camera written through ExifTool, and optional real
 * RAW samples (downloaded once into the local scratch fixture cache).
 */
import sharp from 'sharp'
import { copyFile, mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { MetadataService } from '../../src/core/meta/exif.ts'

export const TEST_ROOT = resolve(process.env.CHENGYING_TEST_TMP ?? join(process.cwd(), '.test-tmp'))

export async function freshDir(name: string): Promise<string> {
  const dir = join(TEST_ROOT, `${name}-${process.pid}-${Date.now()}`)
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  return dir
}

/** Local cache of real RAW samples (raw.pixls.us, CC0). */
export function rawFixture(name: 'L1030132.DNG' | '20170902_0047.NEF'): string | undefined {
  const dirs = [process.env.CHENGYING_FIXTURES, join(homedir(), '.build', '影视后期插件', '_fixtures')].filter((d): d is string => d !== undefined)
  for (const d of dirs) if (existsSync(join(d, name))) return join(d, name)
  return undefined
}

export interface SceneSpec { sky: [string, string]; ground: string; sun?: { x: number; y: number; r: number; color: string }; seed: number }

function rand(seed: number): () => number {
  let s = seed >>> 0
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 }
}

export function sceneSvg(spec: SceneSpec, w = 1200, h = 800): string {
  const r = rand(spec.seed)
  let shapes = ''
  // Mountains / buildings silhouette
  let path = `M0 ${h * 0.62}`
  for (let x = 0; x <= w; x += 60) path += ` L${x} ${h * (0.42 + r() * 0.22)}`
  path += ` L${w} ${h} L0 ${h} Z`
  shapes += `<path d="${path}" fill="${spec.ground}"/>`
  // Fine texture (grass/stones) so sharpness is measurable
  for (let i = 0; i < 900; i++) {
    const x = r() * w; const y = h * 0.62 + r() * h * 0.38
    shapes += `<line x1="${x.toFixed(1)}" y1="${y.toFixed(1)}" x2="${(x + 2 + r() * 6).toFixed(1)}" y2="${(y - 4 - r() * 10).toFixed(1)}" stroke="rgba(255,255,255,${(0.15 + r() * 0.35).toFixed(2)})" stroke-width="1"/>`
  }
  // A subject: a house-like block at a thirds point
  const sx = w * (0.28 + r() * 0.44); const sy = h * 0.5
  shapes += `<rect x="${sx}" y="${sy}" width="${w * 0.12}" height="${h * 0.16}" fill="#c0392b"/><polygon points="${sx - 10},${sy} ${sx + w * 0.06},${sy - h * 0.09} ${sx + w * 0.12 + 10},${sy}" fill="#5d4037"/>`
  for (let i = 0; i < 6; i++) shapes += `<rect x="${sx + 8 + i * 22}" y="${sy + 18}" width="12" height="16" fill="#fff59d"/>`
  const sun = spec.sun === undefined ? '' : `<circle cx="${spec.sun.x * w}" cy="${spec.sun.y * h}" r="${spec.sun.r * w}" fill="${spec.sun.color}"/>`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${spec.sky[0]}"/><stop offset="1" stop-color="${spec.sky[1]}"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/>${sun}${shapes}</svg>`
}

export async function renderScene(spec: SceneSpec, dest: string, variant: 'clean' | 'blur' | 'over' | 'noisy' | 'near' | 'dark' = 'clean'): Promise<void> {
  let img = sharp(Buffer.from(sceneSvg(spec))).removeAlpha()
  if (variant === 'blur') img = img.blur(5)
  if (variant === 'over') img = img.linear(1.9, 60)
  if (variant === 'dark') img = img.linear(0.22, 0)
  if (variant === 'near') img = img.extract({ left: 12, top: 8, width: 1176, height: 784 }).resize(1200, 800).modulate({ brightness: 1.03 })
  let buf = await img.jpeg({ quality: 92 }).toBuffer()
  if (variant === 'noisy') {
    const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true })
    const r = rand(spec.seed + 99)
    for (let i = 0; i < data.length; i++) data[i] = Math.max(0, Math.min(255, (data[i] as number) + Math.round((r() - 0.5) * 70)))
    buf = await sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } }).jpeg({ quality: 92 }).toBuffer()
  }
  await sharp(buf).toFile(dest)
}

export interface FixtureShot { file: string; scene: number; variant: string; time: string; gps: [number, number] }

const SCENES: SceneSpec[] = [
  { sky: ['#1e88e5', '#bbdefb'], ground: '#2e7d32', sun: { x: 0.8, y: 0.2, r: 0.05, color: '#fff9c4' }, seed: 1 },
  { sky: ['#ff7043', '#ffe0b2'], ground: '#4e342e', sun: { x: 0.3, y: 0.45, r: 0.07, color: '#ffeb3b' }, seed: 2 },
  { sky: ['#263238', '#546e7a'], ground: '#37474f', seed: 3 },
  { sky: ['#8e24aa', '#f8bbd0'], ground: '#1b5e20', sun: { x: 0.6, y: 0.3, r: 0.04, color: '#ffffff' }, seed: 4 },
  { sky: ['#00838f', '#e0f7fa'], ground: '#827717', seed: 5 },
  { sky: ['#f9a825', '#fff8e1'], ground: '#bf360c', sun: { x: 0.15, y: 0.25, r: 0.06, color: '#ffffff' }, seed: 6 },
]

/**
 * Two travel days, three locations. Includes: clean frames, a blurred frame,
 * an overexposed frame, a noisy frame, a near-duplicate burst and an exact
 * duplicate copy. Returns the file list for assertions.
 */
export async function buildTravelWorkspace(root: string, options: { withRaw?: boolean } = {}): Promise<FixtureShot[]> {
  const meta = new MetadataService({ maxProcs: 2 })
  const shots: FixtureShot[] = []
  const plan: Array<{ scene: number; variant: Parameters<typeof renderScene>[2]; time: string; gps: [number, number]; dir: string; name: string }> = [
    { scene: 0, variant: 'clean', time: '2026:05:01 08:10:00', gps: [30.2475, 120.1550], dir: 'day1', name: 'DSC_0001' },
    { scene: 0, variant: 'near', time: '2026:05:01 08:10:03', gps: [30.2475, 120.1550], dir: 'day1', name: 'DSC_0002' },
    { scene: 0, variant: 'blur', time: '2026:05:01 08:10:06', gps: [30.2475, 120.1550], dir: 'day1', name: 'DSC_0003' },
    { scene: 1, variant: 'clean', time: '2026:05:01 10:30:00', gps: [30.2600, 120.1300], dir: 'day1', name: 'DSC_0010' },
    { scene: 1, variant: 'over', time: '2026:05:01 10:31:00', gps: [30.2600, 120.1300], dir: 'day1', name: 'DSC_0011' },
    { scene: 2, variant: 'noisy', time: '2026:05:01 19:40:00', gps: [30.2400, 120.1700], dir: 'day1', name: 'DSC_0020' },
    { scene: 3, variant: 'clean', time: '2026:05:02 07:05:00', gps: [30.1000, 120.0100], dir: 'day2', name: 'DSC_0101' },
    { scene: 4, variant: 'clean', time: '2026:05:02 12:20:00', gps: [30.0900, 120.0200], dir: 'day2', name: 'DSC_0110' },
    { scene: 5, variant: 'clean', time: '2026:05:02 17:50:00', gps: [30.0800, 119.9900], dir: 'day2', name: 'DSC_0120' },
    { scene: 5, variant: 'dark', time: '2026:05:02 17:52:00', gps: [30.0800, 119.9900], dir: 'day2', name: 'DSC_0121' },
  ]
  for (const p of plan) {
    await mkdir(join(root, p.dir), { recursive: true })
    const file = join(root, p.dir, `${p.name}.JPG`)
    await renderScene(SCENES[p.scene] as SceneSpec, file, p.variant)
    await meta.writeTags(file, {
      DateTimeOriginal: p.time, CreateDate: p.time, OffsetTimeOriginal: '+08:00', Make: 'FUJIFILM', Model: 'X-T5', LensModel: 'XF16-55mmF2.8',
      ISO: p.variant === 'noisy' ? 6400 : 200, ExposureTime: '1/250', FNumber: 8, FocalLength: 23,
      GPSLatitude: p.gps[0], GPSLatitudeRef: 'N', GPSLongitude: p.gps[1], GPSLongitudeRef: 'E', GPSAltitude: 12.5, GPSAltitudeRef: 0,
    })
    shots.push({ file, scene: p.scene, variant: p.variant ?? "clean", time: p.time, gps: p.gps })
  }
  // Exact duplicate (backup copy in another folder)
  await mkdir(join(root, 'backup'), { recursive: true })
  await copyFile(join(root, 'day1', 'DSC_0010.JPG'), join(root, 'backup', 'DSC_0010_copy.JPG'))
  shots.push({ file: join(root, 'backup', 'DSC_0010_copy.JPG'), scene: 1, variant: 'copy', time: '2026:05:01 10:30:00', gps: [30.26, 120.13] })
  const nef = rawFixture('20170902_0047.NEF')
  if (options.withRaw === true && nef !== undefined) {
    await mkdir(join(root, 'day2'), { recursive: true })
    const rawPath = join(root, 'day2', 'DSC_0047.NEF')
    await copyFile(nef, rawPath)
    // Camera JPEG of the same capture (RAW+JPEG shooting): the embedded full-size JPEG plus all metadata.
    const twin = join(root, 'day2', 'DSC_0047.JPG')
    await meta.extractBestPreview(nef, twin)
    await meta.exec(['-overwrite_original', '-TagsFromFile', nef, '-all:all', twin])
    shots.push({ file: rawPath, scene: 9, variant: 'raw', time: '', gps: [0, 0] })
    shots.push({ file: twin, scene: 9, variant: 'raw-jpeg', time: '', gps: [0, 0] })
  }
  await meta.end()
  return shots
}
