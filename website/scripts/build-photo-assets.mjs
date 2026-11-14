import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'

const WEBSITE_ROOT = path.resolve(import.meta.dirname, '..')
const PUBLIC_DIR = process.env.PHOTO_OUT_DIR || path.join(WEBSITE_ROOT, 'public')
const PHOTOS_DIR = path.join(PUBLIC_DIR, 'photos')
const THUMBS_DIR = path.join(PHOTOS_DIR, 'cull')
const OG_DIR = path.join(PUBLIC_DIR, 'og')

const RAW_DIR =
  process.env.RAW_CAPTURE_DIR ||
  path.join(os.homedir(), '.build', '影视后期插件', 'official-website', 'raw-captures')

const MASTER_SOURCES = [
  { id: '01-alpine-dawn', match: '01_alpine_dawn' },
  { id: '02-lantern-portrait', match: '02_lantern_portrait' },
  { id: '03-plateau-train', match: '03_plateau_train' },
  { id: '04-tea-terraces', match: '04_tea_terraces' },
  { id: '05-canyon-bridge', match: '05_canyon_bridge' },
  { id: '06-artisan-tea-hands', match: '06_artisan_tea_hands' },
  { id: '07-harbor-night-rain', match: '07_harbor_night_rain' },
  { id: '08-basalt-seascape', match: '08_basalt_seascape' },
]

function resolveSourceFile(prefix) {
  if (!fs.existsSync(RAW_DIR)) return null
  const files = fs.readdirSync(RAW_DIR)
  const hit = files.find((name) => name.startsWith(prefix) && /\.(jpe?g|png|webp)$/i.test(name))
  return hit ? path.join(RAW_DIR, hit) : null
}

/**
 * Derive an authentic ungraded "RAW Neutral Sensor Linear Preview" from a master capture:
 * slight protective highlight headroom (-0.65 EV), desaturated flat contrast curve,
 * and subtle cool daylight neutral shift before scene-referred colorbalancergb/sigmoid.
 */
async function buildSensorNeutralRaw(inputPath, outPath, width, height, opts = {}) {
  const { brightness = 0.78, saturation = 0.64, coolBlue = 1.06, warmRed = 0.94, quality = 82 } = opts
  await sharp(inputPath)
    .resize(width, height, { fit: 'cover', position: 'centre' })
    .modulate({ brightness, saturation })
    .linear(
      [warmRed * 0.84, 0.86, coolBlue * 0.88],
      [18, 19, 23],
    )
    .webp({ quality, effort: 5 })
    .toFile(outPath)
}

async function buildOgCard(heroSourcePath) {
  const heroMasterBuf = await sharp(heroSourcePath)
    .resize(1200, 630, { fit: 'cover', position: 'centre' })
    .toBuffer()

  const heroRawHalfBuf = await sharp(heroSourcePath)
    .resize(1200, 630, { fit: 'cover', position: 'centre' })
    .extract({ left: 0, top: 0, width: 460, height: 630 })
    .modulate({ brightness: 0.74, saturation: 0.54 })
    .linear([0.78, 0.84, 0.94], [18, 20, 24])
    .toBuffer()

  const ogOverlaySvg = Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
      <defs>
        <linearGradient id="vignette" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#09090b" stop-opacity="0.58"/>
          <stop offset="46%" stop-color="#09090b" stop-opacity="0.14"/>
          <stop offset="100%" stop-color="#09090b" stop-opacity="0.86"/>
        </linearGradient>
      </defs>
      <rect width="1200" height="630" fill="url(#vignette)"/>
      <line x1="460" y1="0" x2="460" y2="630" stroke="#e8c284" stroke-width="2" stroke-opacity="0.88"/>
      <circle cx="460" cy="315" r="18" fill="#0d0d11" fill-opacity="0.85" stroke="#e8c284" stroke-width="1.6"/>
      <path d="M454 315 L458 311 M454 315 L458 319 M466 315 L462 311 M466 315 L462 319" stroke="#f2ede4" stroke-width="1.5" stroke-linecap="round"/>
      <text x="56" y="54" fill="#c7bfb2" font-family="-apple-system, 'PingFang SC', 'Noto Sans CJK SC', sans-serif" font-size="16" letter-spacing="1.5">拍摄原片 · 完整保留</text>
      <text x="484" y="54" fill="#e8c284" font-family="-apple-system, 'PingFang SC', 'Noto Sans CJK SC', sans-serif" font-size="16" letter-spacing="1.5">澄影精修 · 自然耐看</text>
      <text x="56" y="516" fill="#f5f0e6" font-family="Georgia, 'Songti SC', serif" font-size="54" font-weight="600" letter-spacing="2">澄影 · Chengying</text>
      <text x="56" y="564" fill="#d3cbc0" font-family="-apple-system, 'PingFang SC', 'Noto Sans CJK SC', sans-serif" font-size="24" letter-spacing="1">留下旅途最好的瞬间 · 智能选片与自然光影精修</text>
      <text x="56" y="598" fill="#9d9589" font-family="-apple-system, sans-serif" font-size="14" letter-spacing="1.5">SMART CULLING · NATURAL PHOTO DEVELOPING · UNTOUCHED ORIGINALS</text>
    </svg>
  `)

  await sharp(heroMasterBuf)
    .composite([
      { input: heroRawHalfBuf, left: 0, top: 0 },
      { input: ogOverlaySvg, left: 0, top: 0 },
    ])
    .jpeg({ quality: 88, mozjpeg: true })
    .toFile(path.join(OG_DIR, 'og.jpg'))
}

async function main() {
  fs.mkdirSync(PHOTOS_DIR, { recursive: true })
  fs.mkdirSync(THUMBS_DIR, { recursive: true })
  fs.mkdirSync(OG_DIR, { recursive: true })

  const firstCheck = resolveSourceFile('01_alpine_dawn')
  if (!firstCheck) {
    const existingHero = path.join(PHOTOS_DIR, '01-alpine-dawn.webp')
    if (fs.existsSync(existingHero)) {
      await buildOgCard(existingHero)
      console.log('[assets] Production WebP plates present; regenerated OG card from hero plate.')
      return
    }
    throw new Error(`No source captures found in ${RAW_DIR} and public/photos is empty.`)
  }

  console.log(`[assets] Building gallery WebP plates from ${RAW_DIR} ...`)

  for (const item of MASTER_SOURCES) {
    const src = resolveSourceFile(item.match)
    if (!src) throw new Error(`Missing master source for ${item.match}`)

    // 1600x1067 3:2 Master Plate (WebGL2 & Hero / Darkroom high-res)
    await sharp(src)
      .resize(1600, 1067, { fit: 'cover', position: 'centre' })
      .webp({ quality: 85, effort: 5 })
      .toFile(path.join(PHOTOS_DIR, `${item.id}.webp`))

    // 960x640 responsive plate
    await sharp(src)
      .resize(960, 640, { fit: 'cover', position: 'centre' })
      .webp({ quality: 81, effort: 5 })
      .toFile(path.join(PHOTOS_DIR, `${item.id}-960.webp`))

    // 540x360 crisp contact-sheet pick thumbnail
    await sharp(src)
      .resize(540, 360, { fit: 'cover', position: 'centre' })
      .webp({ quality: 80, effort: 5 })
      .toFile(path.join(THUMBS_DIR, `${item.id}-pick.webp`))
  }

  // Sensor-Linear RAW Neutral companions for Hero 3-plate switcher & no-JS instant comparison
  await buildSensorNeutralRaw(
    resolveSourceFile('01_alpine_dawn'),
    path.join(PHOTOS_DIR, '01-alpine-dawn-raw.webp'),
    1600,
    1067,
    { brightness: 0.76, saturation: 0.56, coolBlue: 1.09, warmRed: 0.91, quality: 82 },
  )
  await buildSensorNeutralRaw(
    resolveSourceFile('02_lantern_portrait'),
    path.join(PHOTOS_DIR, '02-lantern-portrait-raw.webp'),
    1600,
    1067,
    { brightness: 0.80, saturation: 0.66, coolBlue: 1.05, warmRed: 0.95, quality: 82 },
  )
  await buildSensorNeutralRaw(
    resolveSourceFile('08_basalt_seascape'),
    path.join(PHOTOS_DIR, '08-basalt-seascape-raw.webp'),
    1600,
    1067,
    { brightness: 0.77, saturation: 0.58, coolBlue: 1.07, warmRed: 0.93, quality: 82 },
  )

  // Stage 3 / Auth Boundary companion plates for 07-harbor-night-rain
  const inpaintSrc = resolveSourceFile('07_harbor_inpaint_clean')
  const genLayerSrc = resolveSourceFile('07_harbor_gen_layer')
  if (!inpaintSrc || !genLayerSrc) {
    throw new Error('Missing 07_harbor_inpaint_clean or 07_harbor_gen_layer source')
  }
  await sharp(inpaintSrc)
    .resize(1440, 960, { fit: 'cover', position: 'centre' })
    .webp({ quality: 84, effort: 5 })
    .toFile(path.join(PHOTOS_DIR, '07-harbor-inpaint-clean.webp'))

  await sharp(genLayerSrc)
    .resize(1440, 960, { fit: 'cover', position: 'centre' })
    .webp({ quality: 84, effort: 5 })
    .toFile(path.join(PHOTOS_DIR, '07-harbor-gen-layer.webp'))

  // Blink burst outtake + 1:1 Face Zoom Insets (matching src/core/image/contact.ts #ffd54f face inset!)
  const blinkSrc = resolveSourceFile('02_lantern_blink')
  const portraitSrc = resolveSourceFile('02_lantern_portrait')
  if (!blinkSrc || !portraitSrc) {
    throw new Error('Missing 02_lantern_blink or 02_lantern_portrait source')
  }
  await sharp(blinkSrc)
    .resize(540, 360, { fit: 'cover', position: 'centre' })
    .webp({ quality: 80, effort: 5 })
    .toFile(path.join(THUMBS_DIR, '02-lantern-blink.webp'))

  await sharp(blinkSrc)
    .resize(960, 640, { fit: 'cover', position: 'centre' })
    .webp({ quality: 82, effort: 5 })
    .toFile(path.join(PHOTOS_DIR, '02-lantern-blink-960.webp'))

  // Extract 1:1 Face Zoom Insets around the portrait face region (~cx 0.61, cy 0.40)
  const portraitMeta = await sharp(portraitSrc).metadata()
  const pw = portraitMeta.width || 1536
  const ph = portraitMeta.height || 1024
  const cropSize = Math.round(Math.min(pw, ph) * 0.30)
  const cropLeft = Math.max(0, Math.min(pw - cropSize, Math.round(pw * 0.615 - cropSize / 2)))
  const cropTop = Math.max(0, Math.min(ph - cropSize, Math.round(ph * 0.39 - cropSize / 2)))

  await sharp(portraitSrc)
    .extract({ left: cropLeft, top: cropTop, width: cropSize, height: cropSize })
    .resize(280, 280)
    .webp({ quality: 86, effort: 5 })
    .toFile(path.join(THUMBS_DIR, '02-face-open.webp'))

  const blinkMeta = await sharp(blinkSrc).metadata()
  const bw = blinkMeta.width || 1536
  const bh = blinkMeta.height || 1024
  const bCropSize = Math.round(Math.min(bw, bh) * 0.30)
  const bCropLeft = Math.max(0, Math.min(bw - bCropSize, Math.round(bw * 0.615 - bCropSize / 2)))
  const bCropTop = Math.max(0, Math.min(bh - bCropSize, Math.round(bh * 0.39 - bCropSize / 2)))

  await sharp(blinkSrc)
    .extract({ left: bCropLeft, top: bCropTop, width: bCropSize, height: bCropSize })
    .resize(280, 280)
    .webp({ quality: 86, effort: 5 })
    .toFile(path.join(THUMBS_DIR, '02-face-blink.webp'))

  // Generate genuine pixel-altered burst outtakes for the 24-frame Culling Contact Sheet!
  // 1) Directional horizontal motion-blur kernel (9x3) simulating shutter shake
  const row9 = Array(9).fill(1 / 9)
  const zero9 = Array(9).fill(0)
  const motionKernel = {
    width: 9,
    height: 3,
    kernel: [...zero9, ...row9, ...zero9],
  }

  // Outtakes per scene so every rejected card on the 24-frame wall has REAL visual defects:
  const outtakeJobs = [
    // 01 Alpine Dawn: underexposed -1.5 EV RAW bracket + near-duplicate slight crop
    {
      src: resolveSourceFile('01_alpine_dawn'),
      out: '01-alpine-underexp.webp',
      fn: (img) => img.resize(540, 360, { fit: 'cover' }).modulate({ brightness: 0.44, saturation: 0.62 }),
    },
    {
      src: resolveSourceFile('01_alpine_dawn'),
      out: '01-alpine-dup.webp',
      fn: (img) => img.resize(576, 384, { fit: 'cover' }).extract({ left: 18, top: 12, width: 540, height: 360 }).modulate({ brightness: 0.84, saturation: 0.78 }),
    },
    // 02 Lantern Portrait: shutter motion blur outtake (in addition to 02-lantern-blink!)
    {
      src: resolveSourceFile('02_lantern_portrait'),
      out: '02-lantern-motion.webp',
      fn: (img) => img.resize(540, 360, { fit: 'cover' }).convolve(motionKernel).blur(1.1),
    },
    // 03 Plateau Train: window glare overexposed +1.6 EV clipped + soft misfocus
    {
      src: resolveSourceFile('03_plateau_train'),
      out: '03-train-overexp.webp',
      fn: (img) => img.resize(540, 360, { fit: 'cover' }).modulate({ brightness: 1.52, saturation: 0.72 }).linear(1.25, 16),
    },
    {
      src: resolveSourceFile('03_plateau_train'),
      out: '03-train-soft.webp',
      fn: (img) => img.resize(540, 360, { fit: 'cover' }).blur(3.2).modulate({ brightness: 0.92 }),
    },
    // 04 Tea Terraces: flat hazy early test shot + horizon tilt 3.2 deg
    {
      src: resolveSourceFile('04_tea_terraces'),
      out: '04-tea-flat.webp',
      fn: (img) => img.resize(540, 360, { fit: 'cover' }).modulate({ brightness: 0.88, saturation: 0.48 }).linear(0.72, 42),
    },
    {
      src: resolveSourceFile('04_tea_terraces'),
      out: '04-tea-tilt.webp',
      fn: (img) => img.rotate(3.4, { background: '#7d848a' }).resize(600, 400, { fit: 'cover' }).extract({ left: 30, top: 20, width: 540, height: 360 }),
    },
    // 05 Canyon Bridge: handheld motion shake + exact SHA-256 copy
    {
      src: resolveSourceFile('05_canyon_bridge'),
      out: '05-canyon-shake.webp',
      fn: (img) => img.resize(540, 360, { fit: 'cover' }).convolve(motionKernel).blur(1.6),
    },
    {
      src: resolveSourceFile('05_canyon_bridge'),
      out: '05-canyon-under.webp',
      fn: (img) => img.resize(540, 360, { fit: 'cover' }).modulate({ brightness: 0.48, saturation: 0.7 }),
    },
    // 06 Artisan Tea Hands: missed focus blur + warm cast test shot
    {
      src: resolveSourceFile('06_artisan_tea_hands'),
      out: '06-hands-misfocus.webp',
      fn: (img) => img.resize(540, 360, { fit: 'cover' }).blur(3.6),
    },
    {
      src: resolveSourceFile('06_artisan_tea_hands'),
      out: '06-hands-dup.webp',
      fn: (img) => img.resize(572, 382, { fit: 'cover' }).extract({ left: 16, top: 11, width: 540, height: 360 }).modulate({ brightness: 0.78 }),
    },
    // 07 Harbor Night Rain: high-ISO camera motion blur + severe underexposure
    {
      src: resolveSourceFile('07_harbor_night_rain'),
      out: '07-harbor-blur.webp',
      fn: (img) => img.resize(540, 360, { fit: 'cover' }).convolve(motionKernel).blur(1.8),
    },
    {
      src: resolveSourceFile('07_harbor_night_rain'),
      out: '07-harbor-dark.webp',
      fn: (img) => img.resize(540, 360, { fit: 'cover' }).modulate({ brightness: 0.42, saturation: 0.65 }),
    },
    // 08 Basalt Seascape: tilted horizon 3.6 deg + overexposed sky test frame
    {
      src: resolveSourceFile('08_basalt_seascape'),
      out: '08-basalt-tilt.webp',
      fn: (img) => img.rotate(-3.6, { background: '#3a414d' }).resize(604, 402, { fit: 'cover' }).extract({ left: 32, top: 21, width: 540, height: 360 }),
    },
    {
      src: resolveSourceFile('08_basalt_seascape'),
      out: '08-basalt-overexp.webp',
      fn: (img) => img.resize(540, 360, { fit: 'cover' }).modulate({ brightness: 1.48, saturation: 0.65 }).linear(1.22, 18),
    },
  ]

  for (const job of outtakeJobs) {
    await job.fn(sharp(job.src)).webp({ quality: 76, effort: 5 }).toFile(path.join(THUMBS_DIR, job.out))
  }

  // Build Apple Touch Icon (180x180 PNG) from favicon.svg
  const faviconSvg = fs.readFileSync(path.join(PUBLIC_DIR, 'favicon.svg'))
  await sharp(faviconSvg)
    .resize(180, 180)
    .png({ compressionLevel: 9 })
    .toFile(path.join(PUBLIC_DIR, 'apple-touch-icon.png'))

  // Build 1200x630 OpenGraph Gallery Card (og/og.jpg)
  await buildOgCard(resolveSourceFile('01_alpine_dawn'))

  console.log('[assets] Successfully built all gallery WebP plates, contact sheet frames, face insets, and OG imagery.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
