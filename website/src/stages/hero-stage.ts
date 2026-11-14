import { createNeutralParams, HERO_PLATES, STYLE_RECIPES_LIST } from '../data/expedition-catalog'
import { OpticalShaderRenderer } from '../gl/darkroom-renderer'
import { tText } from '../i18n/copy'
import type { HeroPlate, Lang } from '../types'

export class HeroStageController {
  private renderer: OpticalShaderRenderer | null = null
  private currentPlate: HeroPlate = HERO_PLATES[0]
  private targetSplit = 0.44
  private currentSplit = 0.44
  private userLockedSplit = false
  private isDragging = false
  private loupeEnabled = false
  private lang: Lang = 'zh'
  private animFrame = 0

  private stageEl: HTMLElement | null = null
  private viewportEl: HTMLElement | null = null
  private canvasEl: HTMLCanvasElement | null = null
  private fallbackRawWrap: HTMLElement | null = null
  private dividerEl: HTMLElement | null = null
  private sliderInput: HTMLInputElement | null = null
  private waveformCanvas: HTMLCanvasElement | null = null

  public mount(lang: Lang): void {
    this.lang = lang
    this.stageEl = document.getElementById('hero-stage')
    this.viewportEl = document.getElementById('hero-viewport')
    this.canvasEl = document.getElementById('hero-gl-canvas') as HTMLCanvasElement | null
    this.fallbackRawWrap = document.getElementById('hero-raw-clip')
    this.dividerEl = document.getElementById('hero-divider')
    this.sliderInput = document.getElementById('hero-split-range') as HTMLInputElement | null
    this.waveformCanvas = document.getElementById('hero-waveform') as HTMLCanvasElement | null

    if (!this.viewportEl || !this.canvasEl) return

    this.renderer = new OpticalShaderRenderer({
      canvas: this.canvasEl,
      onStats: (stats) => this.drawMiniWaveform(stats.lumaBins),
    })

    this.bindEvents()
    this.renderPlateSwitcher()
    void this.loadPlate(HERO_PLATES[0])
  }

  public setLanguage(lang: Lang): void {
    this.lang = lang
    this.updateTelemetryText()
    this.renderPlateSwitcher()
  }

  private getMasterParamsForPlate(plate: HeroPlate) {
    const recipeId =
      plate.id === 'alpine-dawn'
        ? 'golden-teal-orange'
        : plate.id === 'lantern-portrait'
          ? 'warm-portrait'
          : 'dynamic-landscape'
    const preset = STYLE_RECIPES_LIST.find((r) => r.id === recipeId)
    return createNeutralParams({
      ...(preset?.params ?? {}),
      exposure: 0.08,
      contrast: 4,
      vibrance: 6,
    })
  }

  private async loadPlate(plate: HeroPlate): Promise<void> {
    this.currentPlate = plate
    const lcpMaster = document.getElementById('hero-lcp-master') as HTMLImageElement | null
    const lcpRaw = document.getElementById('hero-lcp-raw') as HTMLImageElement | null
    if (lcpMaster) lcpMaster.src = plate.masterSrc
    if (lcpRaw) lcpRaw.src = plate.rawSrc

    this.updateTelemetryText()
    this.highlightActivePlateButton()

    if (this.renderer) {
      this.renderer.setRawBaseline(
        plate.rawShaderPreset.ev,
        plate.rawShaderPreset.contrast,
        plate.rawShaderPreset.saturation,
        plate.rawShaderPreset.tempShift,
      )
      this.renderer.setParams(this.getMasterParamsForPlate(plate))
      this.renderer.setSplit(this.currentSplit)
      try {
        await this.renderer.setPhoto(plate.masterSrc)
        this.canvasEl?.classList.add('is-ready')
      } catch {
        this.canvasEl?.classList.remove('is-ready')
      }
    }
    this.applySplitDom(this.currentSplit)
  }

  private bindEvents(): void {
    const vp = this.viewportEl!

    const pointerToRatio = (clientX: number, clientY: number) => {
      const rect = vp.getBoundingClientRect()
      const rx = Math.max(0.03, Math.min(0.97, (clientX - rect.left) / Math.max(1, rect.width)))
      const ry = Math.max(0.04, Math.min(0.96, (clientY - rect.top) / Math.max(1, rect.height)))
      return { rx, ry }
    }

    vp.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('button, a')) return
      this.isDragging = true
      this.userLockedSplit = true
      vp.setPointerCapture(e.pointerId)
      const { rx, ry } = pointerToRatio(e.clientX, e.clientY)
      this.setSplitTarget(rx)
      if (this.loupeEnabled) this.renderer?.setLoupe(true, rx, ry)
    })

    vp.addEventListener('pointermove', (e) => {
      const { rx, ry } = pointerToRatio(e.clientX, e.clientY)
      if (this.isDragging) {
        this.setSplitTarget(rx)
      }
      if (this.loupeEnabled) {
        this.renderer?.setLoupe(true, rx, ry)
      }
    })

    const stopDrag = () => {
      this.isDragging = false
    }
    vp.addEventListener('pointerup', stopDrag)
    vp.addEventListener('pointercancel', stopDrag)

    this.sliderInput?.addEventListener('input', () => {
      const val = Number(this.sliderInput!.value) / 100
      this.userLockedSplit = true
      this.setSplitTarget(val)
    })

    const loupeBtn = document.getElementById('hero-loupe-btn')
    loupeBtn?.addEventListener('click', () => {
      this.loupeEnabled = !this.loupeEnabled
      loupeBtn.setAttribute('aria-pressed', String(this.loupeEnabled))
      loupeBtn.classList.toggle('is-active', this.loupeEnabled)
      this.renderer?.setLoupe(this.loupeEnabled, this.currentSplit, 0.48)
    })

    // Subtle scroll-linked optical development sweep when user scrolls past top
    window.addEventListener(
      'scroll',
      () => {
        if (this.userLockedSplit || !this.stageEl) return
        const rect = this.stageEl.getBoundingClientRect()
        const totalScroll = Math.max(240, rect.height * 0.55)
        const scrolled = Math.max(0, -rect.top)
        const progress = Math.min(1, scrolled / totalScroll)
        // Sweep from 0.44 -> 0.14 (revealing more of the developed master as user scrolls!)
        const mapped = 0.44 - progress * 0.30
        this.setSplitTarget(mapped)
      },
      { passive: true },
    )

    window.addEventListener(
      'resize',
      () => {
        this.renderer?.resize()
      },
      { passive: true },
    )
  }

  private setSplitTarget(ratio: number): void {
    this.targetSplit = Math.max(0.03, Math.min(0.97, ratio))
    if (this.animFrame === 0) {
      this.animFrame = requestAnimationFrame(() => this.stepSpring())
    }
  }

  private stepSpring(): void {
    this.animFrame = 0
    const diff = this.targetSplit - this.currentSplit
    if (Math.abs(diff) < 0.0012) {
      this.currentSplit = this.targetSplit
    } else {
      this.currentSplit += diff * 0.28
      this.animFrame = requestAnimationFrame(() => this.stepSpring())
    }
    this.applySplitDom(this.currentSplit)
    this.renderer?.setSplit(this.currentSplit)
  }

  private applySplitDom(split: number): void {
    const pct = (split * 100).toFixed(2)
    if (this.dividerEl) {
      this.dividerEl.style.left = `${pct}%`
    }
    if (this.fallbackRawWrap) {
      this.fallbackRawWrap.style.clipPath = `inset(0 ${(100 - split * 100).toFixed(2)}% 0 0)`
    }
    if (this.sliderInput && document.activeElement !== this.sliderInput) {
      this.sliderInput.value = String(Math.round(split * 100))
    }

    // Update live blended photometric readout based on curtain reveal ratio (1 - split = master share)
    const masterWeight = 1 - split
    const r = this.currentPlate.rawStats
    const g = this.currentPlate.gradedStats
    const p05 = Math.round(r.p05 + (g.p05 - r.p05) * masterWeight)
    const p50 = Math.round(r.p50 + (g.p50 - r.p50) * masterWeight)
    const p95 = Math.round(r.p95 + (g.p95 - r.p95) * masterWeight)
    const tempK = Math.round(r.tempK + (g.tempK - r.tempK) * masterWeight)

    const statsEl = document.getElementById('hero-live-stats')
    if (statsEl) {
      statsEl.textContent = `p05 ${String(p05).padStart(2, '0')} · p50 ${String(p50).padStart(3, '0')} · p95 ${String(p95).padStart(3, '0')} · ${tempK}K · ΔRAW ${(masterWeight * 100).toFixed(0)}%`
    }
  }

  private updateTelemetryText(): void {
    const p = this.currentPlate
    const set = (id: string, text: string) => {
      const el = document.getElementById(id)
      if (el) el.textContent = text
    }
    set('hero-frame-code', `FRAME ${p.frameNo} · ${p.fileCode}`)
    set('hero-plate-title', tText(p.title, this.lang))
    set('hero-plate-loc', tText(p.location, this.lang))
    set('hero-plate-exif', p.exif)
    set('hero-plate-sha', p.sha256Short)
    set('hero-plate-recipe', tText(p.recipeSummary, this.lang))
    this.applySplitDom(this.currentSplit)
  }

  private renderPlateSwitcher(): void {
    const host = document.getElementById('hero-plate-switcher')
    if (!host) return
    host.innerHTML = HERO_PLATES.map(
      (p) => `
      <button
        type="button"
        class="hero-film-thumb ${p.id === this.currentPlate.id ? 'is-active' : ''}"
        data-plate-id="${p.id}"
        aria-label="${tText(p.title, this.lang)}"
      >
        <span class="film-perf">${p.frameNo}</span>
        <img src="${p.masterSrc960}" alt="${tText(p.title, this.lang)}" loading="eager" decoding="async" />
        <span class="film-caption">${tText(p.title, this.lang)}</span>
      </button>
    `,
    ).join('')

    host.querySelectorAll<HTMLButtonElement>('[data-plate-id]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const found = HERO_PLATES.find((item) => item.id === btn.dataset.plateId)
        if (found && found.id !== this.currentPlate.id) {
          void this.loadPlate(found)
        }
      })
    })
  }

  private highlightActivePlateButton(): void {
    document
      .querySelectorAll<HTMLButtonElement>('#hero-plate-switcher [data-plate-id]')
      .forEach((btn) => {
        btn.classList.toggle('is-active', btn.dataset.plateId === this.currentPlate.id)
      })
  }

  private drawMiniWaveform(bins: Uint32Array): void {
    const c = this.waveformCanvas
    if (!c) return
    const ctx = c.getContext('2d')
    if (!ctx) return
    const w = c.width
    const h = c.height
    ctx.clearRect(0, 0, w, h)

    let maxVal = 1
    for (let i = 4; i < bins.length - 2; i++) {
      if (bins[i] > maxVal) maxVal = bins[i]
    }

    ctx.beginPath()
    ctx.moveTo(0, h)
    for (let i = 0; i < bins.length; i++) {
      const x = (i / (bins.length - 1)) * w
      const norm = Math.min(1, Math.pow(bins[i] / maxVal, 0.65))
      const y = h - norm * (h - 4) - 1
      ctx.lineTo(x, y)
    }
    ctx.lineTo(w, h)
    ctx.closePath()
    ctx.fillStyle = 'rgba(212, 155, 84, 0.24)'
    ctx.fill()

    ctx.beginPath()
    for (let i = 0; i < bins.length; i++) {
      const x = (i / (bins.length - 1)) * w
      const norm = Math.min(1, Math.pow(bins[i] / maxVal, 0.65))
      const y = h - norm * (h - 4) - 1
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.strokeStyle = 'rgba(236, 196, 132, 0.85)'
    ctx.lineWidth = 1.25
    ctx.stroke()
  }
}
