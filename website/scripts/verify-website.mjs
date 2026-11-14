import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright-core'

const ROOT_DIR = path.resolve(import.meta.dirname, '..')
const DIST_DIR = path.join(ROOT_DIR, 'dist')
const SHOT_DIR =
  process.env.SCREENSHOT_DIR ||
  path.join(os.homedir(), '.build', '影视后期插件', 'official-website', 'verify-shots')

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
}

function findChromiumExecutable() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
    return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  }
  try {
    const bundled = chromium.executablePath()
    if (bundled && fs.existsSync(bundled)) return bundled
  } catch {
    // Fallback to cache scan below
  }

  const cacheDirs = [
    path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright'),
    path.join(os.homedir(), '.cache', 'ms-playwright'),
    '/ms-playwright',
  ]
  for (const dir of cacheDirs) {
    if (!fs.existsSync(dir)) continue
    const entries = fs
      .readdirSync(dir)
      .filter((n) => n.startsWith('chromium'))
      .sort()
      .reverse()
    for (const entry of entries) {
      const candidates = [
        path.join(
          dir,
          entry,
          'chrome-mac-arm64',
          'Google Chrome for Testing.app',
          'Contents',
          'MacOS',
          'Google Chrome for Testing',
        ),
        path.join(
          dir,
          entry,
          'chrome-mac-x64',
          'Google Chrome for Testing.app',
          'Contents',
          'MacOS',
          'Google Chrome for Testing',
        ),
        path.join(dir, entry, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell'),
        path.join(dir, entry, 'chrome-linux64', 'chrome'),
        path.join(dir, entry, 'chrome-linux', 'chrome'),
      ]
      for (const c of candidates) {
        if (fs.existsSync(c)) return c
      }
    }
  }
  throw new Error('Could not locate a Playwright Chromium binary.')
}

function assertDistIntegrity() {
  const required = [
    'index.html',
    '_headers',
    '404.html',
    'robots.txt',
    'sitemap.xml',
    'favicon.svg',
    'apple-touch-icon.png',
    path.join('og', 'og.jpg'),
    path.join('photos', '01-alpine-dawn.webp'),
    path.join('photos', '02-lantern-portrait.webp'),
    path.join('photos', '07-harbor-inpaint-clean.webp'),
    path.join('photos', '07-harbor-gen-layer.webp'),
    path.join('photos', '08-basalt-seascape.webp'),
    path.join('photos', 'cull', '02-face-open.webp'),
    path.join('photos', 'cull', '02-face-blink.webp'),
  ]
  for (const rel of required) {
    const full = path.join(DIST_DIR, rel)
    assert.ok(fs.existsSync(full), `Missing build artifact: dist/${rel}`)
  }

  const indexHtml = fs.readFileSync(path.join(DIST_DIR, 'index.html'), 'utf8')
  assert.ok(
    !/fonts\.googleapis\.com|fonts\.gstatic\.com|cdn\.jsdelivr\.net|unpkg\.com/.test(indexHtml),
    'index.html must not depend on external CDN fonts or scripts',
  )
  assert.ok(
    indexHtml.includes('https://chengying.igng.net/og/og.jpg'),
    'index.html must include OpenGraph card URL',
  )
  assert.ok(
    indexHtml.includes('name="msvalidate.01"'),
    'index.html must include Bing Webmaster verification tag',
  )

  const headersRaw = fs.readFileSync(path.join(DIST_DIR, '_headers'), 'utf8')
  assert.ok(
    headersRaw.includes('/assets/*') &&
      headersRaw.includes('immutable') &&
      headersRaw.includes('X-Content-Type-Options: nosniff'),
    'dist/_headers must define immutable asset caching and security headers',
  )

  // Check JS & CSS bundle weight budgets
  const assetsDir = path.join(DIST_DIR, 'assets')
  const files = fs.readdirSync(assetsDir)
  let totalJsBytes = 0
  let totalCssBytes = 0
  for (const f of files) {
    const sz = fs.statSync(path.join(assetsDir, f)).size
    if (f.endsWith('.js')) totalJsBytes += sz
    if (f.endsWith('.css')) totalCssBytes += sz
  }
  assert.ok(
    totalJsBytes < 180 * 1024,
    `JS bundle exceeded 180 KiB budget: ${(totalJsBytes / 1024).toFixed(1)} KiB`,
  )
  assert.ok(
    totalCssBytes < 90 * 1024,
    `CSS bundle exceeded 90 KiB budget: ${(totalCssBytes / 1024).toFixed(1)} KiB`,
  )
  return {
    jsKiB: Number((totalJsBytes / 1024).toFixed(1)),
    cssKiB: Number((totalCssBytes / 1024).toFixed(1)),
  }
}

function startStaticServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const reqPath = decodeURIComponent((req.url || '/').split('?')[0])
      const cleanRel = reqPath === '/' ? 'index.html' : reqPath.replace(/^\/+/, '')
      const target = path.resolve(DIST_DIR, cleanRel)
      if (!target.startsWith(DIST_DIR)) {
        res.writeHead(403)
        res.end('Forbidden')
        return
      }
      if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) {
        const notFound = path.join(DIST_DIR, '404.html')
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(fs.existsSync(notFound) ? fs.readFileSync(notFound) : 'Not Found')
        return
      }
      const ext = path.extname(target).toLowerCase()
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
        'Cache-Control': 'public, max-age=3600',
      })
      fs.createReadStream(target).pipe(res)
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      resolve({ server, url: `http://127.0.0.1:${addr.port}/` })
    })
  })
}

async function runVerification() {
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  const bundleStats = assertDistIntegrity()
  console.log(`[verify] Dist integrity OK (JS: ${bundleStats.jsKiB} KiB, CSS: ${bundleStats.cssKiB} KiB)`)

  const { server, url } = await startStaticServer()
  const executablePath = findChromiumExecutable()
  console.log(`[verify] Launching Chromium: ${executablePath}`)

  const launchArgs =
    process.platform === 'linux'
      ? [
          '--use-gl=angle',
          '--use-angle=swiftshader',
          '--enable-unsafe-swiftshader',
          '--enable-webgl',
          '--ignore-gpu-blocklist',
        ]
      : ['--use-gl=angle', '--enable-webgl', '--ignore-gpu-blocklist']

  const browser = await chromium.launch({
    executablePath,
    headless: true,
    args: launchArgs,
  })

  try {
    // 1. Desktop Full Interactive & Performance Suite (1440x900)
    const desktopCtx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
    })
    const page = await desktopCtx.newPage()

    const consoleErrors = []
    const pageErrors = []
    const failedResponses = []

    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text())
    })
    page.on('pageerror', (err) => pageErrors.push(String(err)))
    page.on('response', (res) => {
      if (res.status() >= 400 && !res.url().endsWith('/favicon.ico')) {
        failedResponses.push(`${res.status()} ${res.url()}`)
      }
    })

    await page.goto(url, { waitUntil: 'networkidle' })
    await page.waitForTimeout(350)

    // Measure Navigation & Paint Performance
    const perf = await page.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0]
      const paints = Object.fromEntries(
        performance.getEntriesByType('paint').map((p) => [p.name, Math.round(p.startTime)]),
      )
      const overflowX = document.documentElement.scrollWidth > window.innerWidth
      return {
        domInteractiveMs: Math.round(nav.domInteractive),
        loadEventMs: Math.round(nav.loadEventEnd),
        fcpMs: paints['first-contentful-paint'] ?? 0,
        overflowX,
      }
    })
    console.log('[verify] Desktop performance:', perf)
    assert.equal(perf.overflowX, false, 'Desktop viewport has horizontal overflow!')
    assert.ok(perf.fcpMs < 4000, `Desktop FCP too slow: ${perf.fcpMs}ms`)

    // Capture Hero Screenshot & test plate switching + split slider + loupe
    await page.screenshot({ path: path.join(SHOT_DIR, '01-desktop-hero.png') })
    await page.click('[data-plate-id="lantern-portrait"]')
    await page.waitForTimeout(200)
    const heroTitle = await page.textContent('#hero-plate-title')
    assert.ok(heroTitle?.includes('烟雨长巷'), `Hero plate switch failed: ${heroTitle}`)
    await page.click('#hero-loupe-btn')
    assert.equal(await page.getAttribute('#hero-loupe-btn', 'aria-pressed'), 'true')
    await page.click('[data-plate-id="alpine-dawn"]')
    await page.waitForTimeout(180)

    // 2. Test Dynamic AI Culling Wall (24 -> 8 Narrative FLIP + NL Select + 1:1 Face Zoom Modal)
    await page.locator('#cull-section').scrollIntoViewIfNeeded()
    await page.click('[data-cull-stage="diag"]')
    await page.waitForTimeout(220)
    await page.screenshot({ path: path.join(SHOT_DIR, '02-desktop-culling-diag.png') })

    const totalCards = await page.locator('#cull-grid .cull-card').count()
    assert.equal(totalCards, 24, `Expected 24 total culling cards, got ${totalCards}`)

    await page.click('[data-cull-stage="narrative"]')
    await page.waitForTimeout(740)
    const narrativeVisible = await page
      .locator('#cull-grid .cull-card:not(.is-collapsed-out)')
      .count()
    assert.equal(narrativeVisible, 8, `Expected 8 narrative picks, got ${narrativeVisible}`)
    await page.screenshot({ path: path.join(SHOT_DIR, '03-desktop-culling-narrative.png') })

    // Test NL filter ("优先人像与手作人文" -> 3 picks)
    await page.click('[data-nl-select="portrait"]')
    await page.waitForTimeout(250)
    const portraitVisible = await page
      .locator('#cull-grid .cull-card:not(.is-collapsed-out)')
      .count()
    assert.equal(portraitVisible, 3, `Expected 3 portrait/craft picks, got ${portraitVisible}`)

    // Open VLM Burst Modal & verify 1:1 Face Zoom Inset
    await page.click('#cull-open-vlm-btn')
    await page.waitForTimeout(200)
    assert.equal(await page.locator('#cull-burst-modal').isHidden(), false)
    assert.equal(await page.locator('#cull-modal-body .burst-face-zoom').count(), 2)
    await page.click('#cull-modal-close')
    assert.equal(await page.locator('#cull-burst-modal').isHidden(), true)

    // 3. Test Interactive WebGL2 Digital Darkroom
    await page.locator('#darkroom-section').scrollIntoViewIfNeeded()
    await page.waitForTimeout(250)

    // Trigger portrait clarity guardrail warning (> 0 on 08C portrait)
    await page.locator('#dr-sl-clarity').fill('18')
    await page.locator('#dr-sl-clarity').dispatchEvent('input')
    assert.equal(
      await page.locator('#dr-guardrail-banner').isHidden(),
      false,
      'Portrait clarity guardrail warning must appear when clarity > 0',
    )
    await page.click('#dr-guardrail-fix')
    assert.equal(
      await page.locator('#dr-guardrail-banner').isHidden(),
      true,
      'Guardrail auto-fix must clear violation',
    )

    // Switch style recipe, enable mask overlay, switch sidecar format to darktable XMP, commit & revert
    await page.click('[data-recipe-id="airy-pro400h"]')
    await page.click('#dr-btn-mask-overlay')
    await page.click('[data-recipe-fmt="xmp"]')
    const xmpText = await page.textContent('#dr-recipe-code')
    assert.ok(xmpText?.includes('darktable:xmp_version="5"'), 'XMP sidecar output missing')

    await page.click('#dr-btn-commit')
    assert.equal(await page.locator('#dr-revision-list .dr-rev-chip').count(), 3)
    await page.locator('#dr-gl-canvas').scrollIntoViewIfNeeded()
    await page.waitForTimeout(180)
    await page.screenshot({ path: path.join(SHOT_DIR, '04-desktop-darkroom.png') })
    await page.click('#dr-btn-revert')
    await page.click('#dr-btn-mask-overlay')

    // 4. Test Multi-Agent Orchestration Inspector
    await page.locator('#agents-section').scrollIntoViewIfNeeded()
    await page.waitForTimeout(200)
    await page.click('[data-agent-task="task_24c"]')
    const inspHtml = await page.textContent('#agent-inspector-panel')
    assert.ok(
      inspHtml?.includes('status: "unchanged"'),
      'Task 24C inspector must showcase unchanged restraint principle',
    )
    await page.click('[data-agent-task="task_08c"]')
    await page.waitForTimeout(150)
    await page.screenshot({ path: path.join(SHOT_DIR, '05-desktop-agents.png') })

    // 5. Test Fail-Closed Generative Authorization Boundary
    await page.locator('#boundary-section').scrollIntoViewIfNeeded()
    await page.waitForTimeout(200)
    await page.click('[data-auth-mode="generative"]')
    assert.equal(
      await page.locator('#auth-lock-overlay').isHidden(),
      false,
      'Generative layer must start fail-closed locked before human approval',
    )
    const blockedMeta = await page.textContent('#auth-meta-inspector')
    assert.ok(blockedMeta?.includes('authorization-required'))

    // Grant approval -> unlocks generative sky + writes IPTC compositeWithTrainedAlgorithmicMedia
    await page.click('#auth-grant-btn')
    assert.equal(await page.locator('#auth-lock-overlay').isHidden(), true)
    const grantedMeta = await page.textContent('#auth-meta-inspector')
    assert.ok(grantedMeta?.includes('compositeWithTrainedAlgorithmicMedia'))
    await page.screenshot({ path: path.join(SHOT_DIR, '06-desktop-auth-boundary.png') })

    // Revert generative layer -> restores documentary authenticity
    await page.click('#auth-revoke-btn')
    const revertedPill = await page.textContent('#auth-authenticity-pill')
    assert.ok(revertedPill?.includes('NON-GENERATIVE'))

    // 6. Test Multi-Engine Coverage + Baryta Paper Surround + English Switch
    await page.locator('#engines-section').scrollIntoViewIfNeeded()
    await page.click('[data-engine-id="rawtherapee"]')
    const rtText = await page.textContent('#engine-detail-box')
    assert.ok(rtText?.includes('Locallab'))
    await page.screenshot({ path: path.join(SHOT_DIR, '07-desktop-engines.png') })

    await page.click('#toggle-surround-btn')
    assert.equal(await page.getAttribute('html', 'data-surround'), 'baryta')
    await page.click('#toggle-lang-btn')
    assert.equal(await page.getAttribute('html', 'lang'), 'en')
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }))
    await page.waitForTimeout(220)
    await page.screenshot({ path: path.join(SHOT_DIR, '08-desktop-baryta-en.png') })

    // Verify both WebGL2 contexts remain healthy and un-lost after full interaction stress
    const glHealth = await page.evaluate(() => {
      const heroC = document.getElementById('hero-gl-canvas')
      const drC = document.getElementById('dr-gl-canvas')
      const heroGl = heroC?.getContext('webgl2')
      const drGl = drC?.getContext('webgl2')
      return {
        heroAlive: Boolean(heroGl && !heroGl.isContextLost()),
        drAlive: Boolean(drGl && !drGl.isContextLost()),
      }
    })
    assert.equal(glHealth.heroAlive, true, 'Hero WebGL2 context was lost!')
    assert.equal(glHealth.drAlive, true, 'Darkroom WebGL2 context was lost!')

    // Verify every visible <img> loaded cleanly
    const brokenImages = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('img'))
        .filter((img) => img.complete && img.naturalWidth === 0)
        .map((img) => img.getAttribute('src'))
    })
    assert.deepEqual(brokenImages, [], `Broken images found: ${brokenImages.join(', ')}`)
    assert.deepEqual(consoleErrors, [], `Console errors: ${consoleErrors.join(' | ')}`)
    assert.deepEqual(pageErrors, [], `Page errors: ${pageErrors.join(' | ')}`)
    assert.deepEqual(failedResponses, [], `HTTP failures: ${failedResponses.join(' | ')}`)
    await desktopCtx.close()

    // 7. Tablet (768x1024) & Mobile (390x844) Layout & Touch Verification
    for (const vp of [
      { name: 'tablet', width: 768, height: 1024, isMobile: true },
      { name: 'mobile', width: 390, height: 844, isMobile: true },
    ]) {
      const mCtx = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        isMobile: vp.isMobile,
        hasTouch: true,
        deviceScaleFactor: 2,
      })
      const mPage = await mCtx.newPage()
      const mErrors = []
      mPage.on('pageerror', (e) => mErrors.push(String(e)))

      await mPage.goto(url, { waitUntil: 'networkidle' })
      await mPage.waitForTimeout(250)

      const overflow = await mPage.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      )
      assert.equal(overflow, false, `${vp.name} (${vp.width}px) has horizontal overflow!`)

      if (vp.name === 'mobile') {
        const ghBox = await mPage.locator('.optical-header-tools a[href*="github.com"]').boundingBox()
        assert.ok(
          ghBox && ghBox.x > 0 && ghBox.x + ghBox.width <= vp.width,
          `Mobile GitHub button clipped off-screen: ${JSON.stringify(ghBox)}`,
        )
        await mPage.screenshot({ path: path.join(SHOT_DIR, '09-mobile-hero.png') })
        await mPage.locator('#dr-gl-canvas').scrollIntoViewIfNeeded()
        await mPage.waitForTimeout(220)
        await mPage.screenshot({ path: path.join(SHOT_DIR, '10-mobile-darkroom.png') })
      }

      assert.deepEqual(mErrors, [], `${vp.name} page errors: ${mErrors.join(' | ')}`)
      await mCtx.close()
      console.log(`[verify] ${vp.name} (${vp.width}x${vp.height}) responsive & touch check OK`)
    }

    console.log(`[verify] ALL CHECKS PASSED! Screenshots saved to ${SHOT_DIR}`)
  } finally {
    await browser.close()
    server.close()
  }
}

runVerification().catch((err) => {
  console.error('[verify] FAILED:', err)
  process.exit(1)
})
