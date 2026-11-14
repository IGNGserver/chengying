import {
  createIdentityCurves,
  createNeutralParams,
  DARKROOM_PHOTOS,
  STYLE_RECIPES_LIST,
} from '../data/expedition-catalog'
import {
  evaluateMonotonicSpline256,
  OpticalShaderRenderer,
  type PhotometricStats,
} from '../gl/darkroom-renderer'
import { tText } from '../i18n/copy'
import type {
  CurveChannel,
  DarkroomParams,
  DarkroomPhoto,
  Lang,
  MaskKind,
  RevisionEntry,
} from '../types'

function cloneParams(p: DarkroomParams): DarkroomParams {
  return {
    ...p,
    curves: {
      master: p.curves.master.map(([x, y]) => [x, y]),
      red: p.curves.red.map(([x, y]) => [x, y]),
      green: p.curves.green.map(([x, y]) => [x, y]),
      blue: p.curves.blue.map(([x, y]) => [x, y]),
    },
    mask: { ...p.mask },
  }
}

export class DigitalDarkroomController {
  private lang: Lang = 'zh'
  private renderer: OpticalShaderRenderer | null = null
  private currentPhoto: DarkroomPhoto = DARKROOM_PHOTOS[0]
  private params: DarkroomParams = createNeutralParams()
  private activeRecipeId = 'warm-portrait'
  private activeChannel: CurveChannel = 'master'
  private recipeFormat: 'json' | 'xmp' | 'pp3' = 'json'

  private splitActive = false
  private showMaskOverlay = false
  private showZebraOverlay = false
  private draggingPointIdx = -1
  private draggingMaskOnCanvas = false

  private revisions: RevisionEntry[] = []
  private activeRevSeq = 0
  private latestStats: PhotometricStats | null = null

  private canvasEl: HTMLCanvasElement | null = null
  private curveCanvas: HTMLCanvasElement | null = null
  private histCanvas: HTMLCanvasElement | null = null

  public mount(lang: Lang): void {
    this.lang = lang
    this.canvasEl = document.getElementById('dr-gl-canvas') as HTMLCanvasElement | null
    this.curveCanvas = document.getElementById('dr-curve-canvas') as HTMLCanvasElement | null
    this.histCanvas = document.getElementById('dr-hist-canvas') as HTMLCanvasElement | null
    if (!this.canvasEl) return

    this.renderer = new OpticalShaderRenderer({
      canvas: this.canvasEl,
      onStats: (st) => {
        this.latestStats = st
        this.renderHistogram(st)
        this.updateStatsReadout(st)
        this.drawCurveEditor()
      },
    })

    this.renderPhotoTabs()
    this.renderRecipeButtons()
    this.bindSlidersAndTools()
    this.bindCurveCanvas()
    this.bindViewportMaskDrag()

    void this.selectPhoto(DARKROOM_PHOTOS[0])
  }

  public setLanguage(lang: Lang): void {
    this.lang = lang
    this.renderPhotoTabs()
    this.renderRecipeButtons()
    this.renderRevisionStrip()
    this.updateGuardrailWarnings()
    this.renderSidecarCode()
  }

  private async selectPhoto(photo: DarkroomPhoto): Promise<void> {
    this.currentPhoto = photo
    const u = photo.ungradedParams
    this.renderer?.setRawBaseline(u.exposure, u.contrast, u.saturation, u.temperature)

    const defaultPreset =
      STYLE_RECIPES_LIST.find((r) => r.id === photo.defaultRecipeId) ?? STYLE_RECIPES_LIST[1]
    this.activeRecipeId = defaultPreset.id

    const defaultMask =
      photo.isPortrait && photo.faceBox
        ? {
            kind: 'ellipse' as MaskKind,
            cx: photo.faceBox[0] + photo.faceBox[2] / 2,
            cy: photo.faceBox[1] + photo.faceBox[3] / 2,
            rx: Math.max(0.11, photo.faceBox[2] * 0.72),
            ry: Math.max(0.15, photo.faceBox[3] * 0.72),
            feather: 0.22,
            ev: 0.18,
            temp: 4,
          }
        : photo.id === 'dr-alpine' || photo.id === 'dr-tea'
          ? {
              kind: 'gradient' as MaskKind,
              cx: 0.5,
              cy: 0.34,
              rx: 0.3,
              ry: 0.26,
              feather: 0.24,
              ev: -0.28,
              temp: -4,
            }
          : {
              kind: 'none' as MaskKind,
              cx: 0.5,
              cy: 0.45,
              rx: 0.24,
              ry: 0.28,
              feather: 0.2,
              ev: 0,
              temp: 0,
            }

    const baseUngraded = cloneParams(photo.ungradedParams)
    const graded = createNeutralParams({
      ...defaultPreset.params,
      curves: defaultPreset.params.curves
        ? {
            master: defaultPreset.params.curves.master.map(([x, y]) => [x, y]),
            red: defaultPreset.params.curves.red.map(([x, y]) => [x, y]),
            green: defaultPreset.params.curves.green.map(([x, y]) => [x, y]),
            blue: defaultPreset.params.curves.blue.map(([x, y]) => [x, y]),
          }
        : createIdentityCurves(),
      mask: defaultMask,
    })

    this.revisions = [
      {
        seq: 0,
        id: 'rev_00',
        label: { zh: 'Rev #0 · 原片线性基线', en: 'Rev #0 · RAW Linear Base' },
        author: 'scanner',
        timestamp: '00:00.0',
        params: baseUngraded,
      },
      {
        seq: 1,
        id: 'rev_01',
        label: {
          zh: `Rev #1 · ${defaultPreset.name.zh}`,
          en: `Rev #1 · ${defaultPreset.name.en}`,
        },
        author: 'agent:8c04',
        timestamp: '00:01.8',
        params: cloneParams(graded),
      },
    ]
    this.activeRevSeq = 1
    this.params = cloneParams(graded)

    const exifEl = document.getElementById('dr-active-exif')
    if (exifEl) {
      exifEl.textContent = `${photo.exif} · shadowEv Ceiling: +${photo.shadowEvCeiling.toFixed(2)} EV`
    }

    this.syncControlsFromParams()
    this.renderPhotoTabs()
    this.renderRecipeButtons()
    this.renderRevisionStrip()
    this.renderer?.setParams(this.params)

    try {
      await this.renderer?.setPhoto(photo.src)
    } catch {
      // Fallback handled inside renderer
    }
  }

  private renderPhotoTabs(): void {
    const host = document.getElementById('dr-photo-tabs')
    if (!host) return
    host.innerHTML = DARKROOM_PHOTOS.map(
      (p) => `
      <button
        type="button"
        class="dr-photo-tab ${p.id === this.currentPhoto.id ? 'is-active' : ''}"
        data-dr-photo="${p.id}"
      >
        <img src="${p.src960}" alt="${tText(p.title, this.lang)}" loading="lazy" decoding="async" />
        <span>${tText(p.title, this.lang)}</span>
      </button>
    `,
    ).join('')

    host.querySelectorAll<HTMLButtonElement>('[data-dr-photo]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const found = DARKROOM_PHOTOS.find((x) => x.id === btn.dataset.drPhoto)
        if (found && found.id !== this.currentPhoto.id) {
          void this.selectPhoto(found)
        }
      })
    })
  }

  private renderRecipeButtons(): void {
    const host = document.getElementById('dr-recipe-pills')
    if (!host) return
    host.innerHTML = STYLE_RECIPES_LIST.map(
      (r) => `
      <button
        type="button"
        class="dr-recipe-pill ${r.id === this.activeRecipeId ? 'is-active' : ''}"
        data-recipe-id="${r.id}"
        title="${tText(r.subtitle, this.lang)} | ${tText(r.forbidNote, this.lang)}"
      >
        <span class="recipe-code">${r.code}</span>
        <strong>${tText(r.name, this.lang)}</strong>
      </button>
    `,
    ).join('')

    host.querySelectorAll<HTMLButtonElement>('[data-recipe-id]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const rec = STYLE_RECIPES_LIST.find((x) => x.id === btn.dataset.recipeId)
        if (!rec) return
        this.activeRecipeId = rec.id
        const keepMask = { ...this.params.mask }
        const merged = createNeutralParams({
          ...rec.params,
          curves: rec.params.curves
            ? {
                master: rec.params.curves.master.map(([x, y]) => [x, y]),
                red: rec.params.curves.red.map(([x, y]) => [x, y]),
                green: rec.params.curves.green.map(([x, y]) => [x, y]),
                blue: rec.params.curves.blue.map(([x, y]) => [x, y]),
              }
            : createIdentityCurves(),
          mask: rec.id === 'raw-linear' ? { ...keepMask, kind: 'none', ev: 0 } : keepMask,
        })
        // Respect portrait clarity red line automatically when applying non-portrait presets
        if (this.currentPhoto.isPortrait && merged.clarity > 0) {
          merged.clarity = 0
        }
        this.params = merged
        this.syncControlsFromParams()
        this.renderRecipeButtons()
        this.renderer?.setParams(this.params)
      })
    })
  }

  private bindSlidersAndTools(): void {
    const sliderKeys: Array<{ id: string; key: keyof DarkroomParams; scale?: number }> = [
      { id: 'dr-sl-exposure', key: 'exposure', scale: 0.01 },
      { id: 'dr-sl-temp', key: 'temperature', scale: 1 },
      { id: 'dr-sl-tint', key: 'tint', scale: 1 },
      { id: 'dr-sl-highlights', key: 'highlights', scale: 1 },
      { id: 'dr-sl-shadows', key: 'shadows', scale: 1 },
      { id: 'dr-sl-contrast', key: 'contrast', scale: 1 },
      { id: 'dr-sl-blacks', key: 'blacks', scale: 1 },
      { id: 'dr-sl-vibrance', key: 'vibrance', scale: 1 },
      { id: 'dr-sl-saturation', key: 'saturation', scale: 1 },
      { id: 'dr-sl-clarity', key: 'clarity', scale: 1 },
      { id: 'dr-sl-dehaze', key: 'dehaze', scale: 1 },
    ]

    for (const item of sliderKeys) {
      const el = document.getElementById(item.id) as HTMLInputElement | null
      if (!el) continue
      el.addEventListener('input', () => {
        const val = Number(el.value) * (item.scale ?? 1)
        ;(this.params[item.key] as number) = val
        this.activeRecipeId = 'custom'
        this.updateSliderLabels()
        this.updateGuardrailWarnings()
        this.renderSidecarCode()
        this.renderer?.setParams(this.params)
      })
      el.addEventListener('dblclick', () => {
        el.value = '0'
        ;(this.params[item.key] as number) = 0
        this.updateSliderLabels()
        this.updateGuardrailWarnings()
        this.renderSidecarCode()
        this.renderer?.setParams(this.params)
      })
    }

    // Mask controls
    document.querySelectorAll<HTMLButtonElement>('[data-mask-kind]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const kind = btn.dataset.maskKind as MaskKind
        this.params.mask.kind = kind
        if (kind === 'ellipse' && this.currentPhoto.faceBox) {
          const fb = this.currentPhoto.faceBox
          this.params.mask.cx = fb[0] + fb[2] / 2
          this.params.mask.cy = fb[1] + fb[3] / 2
          this.params.mask.rx = Math.max(0.11, fb[2] * 0.72)
          this.params.mask.ry = Math.max(0.15, fb[3] * 0.72)
          if (Math.abs(this.params.mask.ev) < 0.02) this.params.mask.ev = 0.20
        } else if (kind === 'gradient') {
          this.params.mask.cx = 0.5
          this.params.mask.cy = 0.35
          this.params.mask.ry = 0.26
          if (Math.abs(this.params.mask.ev) < 0.02) this.params.mask.ev = -0.32
        } else if (kind === 'radial') {
          this.params.mask.cx = 0.5
          this.params.mask.cy = 0.5
          this.params.mask.rx = 0.28
          if (Math.abs(this.params.mask.ev) < 0.02) this.params.mask.ev = 0.25
        }
        this.syncControlsFromParams()
        this.renderer?.setParams(this.params)
      })
    })

    const maskEvEl = document.getElementById('dr-sl-mask-ev') as HTMLInputElement | null
    const maskFeatherEl = document.getElementById('dr-sl-mask-feather') as HTMLInputElement | null
    maskEvEl?.addEventListener('input', () => {
      this.params.mask.ev = Number(maskEvEl.value) / 100
      this.updateSliderLabels()
      this.renderSidecarCode()
      this.renderer?.setParams(this.params)
    })
    maskFeatherEl?.addEventListener('input', () => {
      this.params.mask.feather = Number(maskFeatherEl.value) / 100
      this.updateSliderLabels()
      this.renderSidecarCode()
      this.renderer?.setParams(this.params)
    })

    // Curve channel tabs
    document.querySelectorAll<HTMLButtonElement>('[data-curve-ch]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.activeChannel = btn.dataset.curveCh as CurveChannel
        document.querySelectorAll<HTMLButtonElement>('[data-curve-ch]').forEach((b) => {
          b.classList.toggle('is-active', b.dataset.curveCh === this.activeChannel)
        })
        this.drawCurveEditor()
      })
    })

    const resetCurveBtn = document.getElementById('dr-curve-reset')
    resetCurveBtn?.addEventListener('click', () => {
      const id = createIdentityCurves()
      this.params.curves[this.activeChannel] = id[this.activeChannel]
      this.drawCurveEditor()
      this.renderSidecarCode()
      this.renderer?.setParams(this.params)
    })

    // Viewport tool buttons
    const holdBtn = document.getElementById('dr-btn-hold')
    if (holdBtn) {
      const setHold = (on: boolean) => {
        holdBtn.classList.toggle('is-active', on)
        this.renderer?.setCompareHold(on)
      }
      holdBtn.addEventListener('pointerdown', () => setHold(true))
      holdBtn.addEventListener('pointerup', () => setHold(false))
      holdBtn.addEventListener('pointerleave', () => setHold(false))
      holdBtn.addEventListener('keydown', (e) => {
        if (e.key === ' ' || e.key === 'Enter') setHold(true)
      })
      holdBtn.addEventListener('keyup', () => setHold(false))
    }

    const splitBtn = document.getElementById('dr-btn-split')
    splitBtn?.addEventListener('click', () => {
      this.splitActive = !this.splitActive
      splitBtn.classList.toggle('is-active', this.splitActive)
      splitBtn.setAttribute('aria-pressed', String(this.splitActive))
      this.renderer?.setSplit(this.splitActive ? 0.5 : -1)
    })

    const maskBtn = document.getElementById('dr-btn-mask-overlay')
    maskBtn?.addEventListener('click', () => {
      this.showMaskOverlay = !this.showMaskOverlay
      maskBtn.classList.toggle('is-active', this.showMaskOverlay)
      maskBtn.setAttribute('aria-pressed', String(this.showMaskOverlay))
      if (this.showMaskOverlay && this.params.mask.kind === 'none') {
        this.params.mask.kind = this.currentPhoto.isPortrait ? 'ellipse' : 'gradient'
        this.syncControlsFromParams()
        this.renderer?.setParams(this.params)
      }
      this.renderer?.setOverlays(this.showMaskOverlay, this.showZebraOverlay)
    })

    const zebraBtn = document.getElementById('dr-btn-zebra')
    zebraBtn?.addEventListener('click', () => {
      this.showZebraOverlay = !this.showZebraOverlay
      zebraBtn.classList.toggle('is-active', this.showZebraOverlay)
      zebraBtn.setAttribute('aria-pressed', String(this.showZebraOverlay))
      this.renderer?.setOverlays(this.showMaskOverlay, this.showZebraOverlay)
    })

    // Recipe format switcher
    document.querySelectorAll<HTMLButtonElement>('[data-recipe-fmt]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.recipeFormat = btn.dataset.recipeFmt as 'json' | 'xmp' | 'pp3'
        document.querySelectorAll<HTMLButtonElement>('[data-recipe-fmt]').forEach((b) => {
          b.classList.toggle('is-active', b.dataset.recipeFmt === this.recipeFormat)
        })
        this.renderSidecarCode()
      })
    })

    // Revision commit & revert buttons
    document.getElementById('dr-btn-commit')?.addEventListener('click', () => {
      const nextSeq = this.revisions.length
      this.revisions.push({
        seq: nextSeq,
        id: `rev_0${nextSeq}`,
        label: {
          zh: `Rev #${nextSeq} · 手动精调 (${this.params.exposure >= 0 ? '+' : ''}${this.params.exposure.toFixed(2)} EV)`,
          en: `Rev #${nextSeq} · Custom Grade (${this.params.exposure >= 0 ? '+' : ''}${this.params.exposure.toFixed(2)} EV)`,
        },
        author: 'user (panel)',
        timestamp: `00:0${nextSeq + 1}.4`,
        params: cloneParams(this.params),
      })
      this.activeRevSeq = nextSeq
      this.renderRevisionStrip()
    })

    document.getElementById('dr-btn-revert')?.addEventListener('click', () => {
      const targetSeq = Math.max(0, this.activeRevSeq - 1)
      this.checkoutRevision(targetSeq)
    })

    // Auto-fix guardrail button
    document.getElementById('dr-guardrail-fix')?.addEventListener('click', () => {
      if (this.currentPhoto.isPortrait) {
        if (this.params.clarity > 0) this.params.clarity = 0
        if (this.params.saturation > 8) this.params.saturation = 4
      }
      if (this.params.dehaze > 15) this.params.dehaze = 12
      if (this.params.exposure > this.currentPhoto.shadowEvCeiling) {
        this.params.exposure = Number(this.currentPhoto.shadowEvCeiling.toFixed(2))
      }
      this.syncControlsFromParams()
      this.renderer?.setParams(this.params)
    })
  }

  private checkoutRevision(seq: number): void {
    const rev = this.revisions.find((r) => r.seq === seq)
    if (!rev) return
    this.activeRevSeq = seq
    this.params = cloneParams(rev.params)
    this.syncControlsFromParams()
    this.renderRevisionStrip()
    this.renderer?.setParams(this.params)
  }

  private renderRevisionStrip(): void {
    const host = document.getElementById('dr-revision-list')
    if (!host) return
    host.innerHTML = this.revisions
      .map(
        (r) => `
      <button
        type="button"
        class="dr-rev-chip ${r.seq === this.activeRevSeq ? 'is-active' : ''}"
        data-rev-seq="${r.seq}"
      >
        <span class="rev-dot"></span>
        <span>${tText(r.label, this.lang)}</span>
        <small>${r.author}</small>
      </button>
    `,
      )
      .join('')

    host.querySelectorAll<HTMLButtonElement>('[data-rev-seq]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.checkoutRevision(Number(btn.dataset.revSeq))
      })
    })
  }

  private bindCurveCanvas(): void {
    const c = this.curveCanvas
    if (!c) return

    const toCurveCoords = (clientX: number, clientY: number): [number, number] => {
      const rect = c.getBoundingClientRect()
      const pad = 10
      const x = (clientX - rect.left - pad) / Math.max(1, rect.width - pad * 2)
      const y = 1 - (clientY - rect.top - pad) / Math.max(1, rect.height - pad * 2)
      return [Math.max(0, Math.min(1, x)), Math.max(0, Math.min(1, y))]
    }

    c.addEventListener('pointerdown', (e) => {
      const [x, y] = toCurveCoords(e.clientX, e.clientY)
      const pts = this.params.curves[this.activeChannel]
      let bestIdx = -1
      let bestDist = 0.09
      pts.forEach(([px, py], idx) => {
        const d = Math.hypot(px - x, py - y)
        if (d < bestDist) {
          bestDist = d
          bestIdx = idx
        }
      })

      if (bestIdx === -1 && pts.length < 7) {
        pts.push([Number(x.toFixed(3)), Number(y.toFixed(3))])
        pts.sort((a, b) => a[0] - b[0])
        bestIdx = pts.findIndex(([px]) => Math.abs(px - x) < 0.005)
      }

      if (bestIdx !== -1) {
        this.draggingPointIdx = bestIdx
        c.setPointerCapture(e.pointerId)
      }
    })

    c.addEventListener('pointermove', (e) => {
      if (this.draggingPointIdx < 0) return
      const [x, y] = toCurveCoords(e.clientX, e.clientY)
      const pts = this.params.curves[this.activeChannel]
      const idx = this.draggingPointIdx
      if (idx === 0) {
        pts[0] = [0, Number(y.toFixed(3))]
      } else if (idx === pts.length - 1) {
        pts[idx] = [1, Number(y.toFixed(3))]
      } else {
        const minX = pts[idx - 1][0] + 0.04
        const maxX = pts[idx + 1][0] - 0.04
        pts[idx] = [Number(Math.max(minX, Math.min(maxX, x)).toFixed(3)), Number(y.toFixed(3))]
      }
      this.activeRecipeId = 'custom'
      this.drawCurveEditor()
      this.renderSidecarCode()
      this.renderer?.setParams(this.params)
    })

    const stop = () => {
      this.draggingPointIdx = -1
    }
    c.addEventListener('pointerup', stop)
    c.addEventListener('pointercancel', stop)
  }

  private bindViewportMaskDrag(): void {
    const c = this.canvasEl
    if (!c) return

    c.addEventListener('pointerdown', (e) => {
      if (this.params.mask.kind === 'none' && !this.splitActive) return
      this.draggingMaskOnCanvas = true
      c.setPointerCapture(e.pointerId)
      this.applyViewportDrag(e.clientX, e.clientY)
    })

    c.addEventListener('pointermove', (e) => {
      if (!this.draggingMaskOnCanvas) return
      this.applyViewportDrag(e.clientX, e.clientY)
    })

    const end = () => {
      this.draggingMaskOnCanvas = false
    }
    c.addEventListener('pointerup', end)
    c.addEventListener('pointercancel', end)
  }

  private applyViewportDrag(clientX: number, clientY: number): void {
    if (!this.canvasEl) return
    const rect = this.canvasEl.getBoundingClientRect()
    const ux = Math.max(0.05, Math.min(0.95, (clientX - rect.left) / Math.max(1, rect.width)))
    const uy = Math.max(0.05, Math.min(0.95, (clientY - rect.top) / Math.max(1, rect.height)))

    if (this.splitActive && this.params.mask.kind === 'none') {
      this.renderer?.setSplit(ux)
      return
    }
    if (this.params.mask.kind !== 'none') {
      this.params.mask.cx = Number(ux.toFixed(3))
      this.params.mask.cy = Number(uy.toFixed(3))
      this.renderSidecarCode()
      this.renderer?.setParams(this.params)
    }
  }

  private syncControlsFromParams(): void {
    const setSlider = (id: string, val: number) => {
      const el = document.getElementById(id) as HTMLInputElement | null
      if (el) el.value = String(Math.round(val))
    }
    setSlider('dr-sl-exposure', this.params.exposure * 100)
    setSlider('dr-sl-temp', this.params.temperature)
    setSlider('dr-sl-tint', this.params.tint)
    setSlider('dr-sl-highlights', this.params.highlights)
    setSlider('dr-sl-shadows', this.params.shadows)
    setSlider('dr-sl-contrast', this.params.contrast)
    setSlider('dr-sl-blacks', this.params.blacks)
    setSlider('dr-sl-vibrance', this.params.vibrance)
    setSlider('dr-sl-saturation', this.params.saturation)
    setSlider('dr-sl-clarity', this.params.clarity)
    setSlider('dr-sl-dehaze', this.params.dehaze)
    setSlider('dr-sl-mask-ev', this.params.mask.ev * 100)
    setSlider('dr-sl-mask-feather', this.params.mask.feather * 100)

    document.querySelectorAll<HTMLButtonElement>('[data-mask-kind]').forEach((btn) => {
      const active = btn.dataset.maskKind === this.params.mask.kind
      btn.classList.toggle('is-active', active)
      btn.setAttribute('aria-pressed', String(active))
    })

    const maskControls = document.getElementById('dr-mask-sliders')
    if (maskControls) {
      maskControls.classList.toggle('is-disabled', this.params.mask.kind === 'none')
    }

    this.updateSliderLabels()
    this.updateGuardrailWarnings()
    this.drawCurveEditor()
    this.renderSidecarCode()
  }

  private updateSliderLabels(): void {
    const p = this.params
    const setVal = (id: string, text: string) => {
      const el = document.getElementById(id)
      if (el) el.textContent = text
    }
    const fmtSign = (v: number, digits = 0) => `${v > 0 ? '+' : ''}${v.toFixed(digits)}`
    const kelvin = Math.round(this.currentPhoto.baseTempK + p.temperature * 36)

    setVal('dr-val-exposure', `${fmtSign(p.exposure, 2)} EV`)
    setVal('dr-val-temp', `${kelvin}K (${fmtSign(p.temperature)})`)
    setVal('dr-val-tint', fmtSign(p.tint))
    setVal('dr-val-highlights', fmtSign(p.highlights))
    setVal('dr-val-shadows', fmtSign(p.shadows))
    setVal('dr-val-contrast', fmtSign(p.contrast))
    setVal('dr-val-blacks', fmtSign(p.blacks))
    setVal('dr-val-vibrance', fmtSign(p.vibrance))
    setVal('dr-val-saturation', fmtSign(p.saturation))
    setVal('dr-val-clarity', fmtSign(p.clarity))
    setVal('dr-val-dehaze', fmtSign(p.dehaze))
    setVal('dr-val-mask-ev', `${fmtSign(p.mask.ev, 2)} EV`)
    setVal('dr-val-mask-feather', p.mask.feather.toFixed(2))
  }

  private updateGuardrailWarnings(): void {
    const box = document.getElementById('dr-guardrail-banner')
    const msg = document.getElementById('dr-guardrail-msg')
    if (!box || !msg) return

    const violations: string[] = []
    if (this.currentPhoto.isPortrait && this.params.clarity > 0) {
      violations.push(
        this.lang === 'zh'
          ? `人像红线告警：检测到人像但 clarity=${this.params.clarity} > 0（会锐化毛孔与法令纹）`
          : `Portrait Guardrail: clarity=${this.params.clarity} > 0 accentuates skin pores`,
      )
    }
    if (this.currentPhoto.isPortrait && this.params.saturation > 8) {
      violations.push(
        this.lang === 'zh'
          ? `肤色过饱和红线：人像全局 saturation=${this.params.saturation} > +8（易产生橘子脸，建议用 vibrance）`
          : `Skin Guardrail: portrait saturation=${this.params.saturation} > +8 risks orange cast`,
      )
    }
    if (this.params.dehaze > 15) {
      violations.push(
        this.lang === 'zh'
          ? `去雾滥用红线：dehaze=${this.params.dehaze} 超过 +15 硬上限`
          : `Dehaze Ceiling: dehaze=${this.params.dehaze} exceeds +15 limit`,
      )
    }
    if (this.params.exposure > this.currentPhoto.shadowEvCeiling + 0.05) {
      violations.push(
        this.lang === 'zh'
          ? `噪点预算超限：exposure +${this.params.exposure.toFixed(2)} EV 超出传感器暗部余量 (+${this.currentPhoto.shadowEvCeiling.toFixed(2)} EV)`
          : `Noise Ceiling: exposure +${this.params.exposure.toFixed(2)} EV exceeds shadowEv (+${this.currentPhoto.shadowEvCeiling.toFixed(2)} EV)`,
      )
    }

    if (violations.length > 0) {
      box.hidden = false
      msg.textContent = violations[0]
    } else {
      box.hidden = true
    }
  }

  private drawCurveEditor(): void {
    const c = this.curveCanvas
    if (!c) return
    const ctx = c.getContext('2d')
    if (!ctx) return
    const w = c.width
    const h = c.height
    const pad = 12
    const iw = w - pad * 2
    const ih = h - pad * 2

    ctx.clearRect(0, 0, w, h)

    // Subtle luma histogram backdrop inside curve editor
    if (this.latestStats) {
      const bins = this.latestStats.lumaBins
      let maxB = 1
      for (let i = 2; i < bins.length - 2; i++) if (bins[i] > maxB) maxB = bins[i]
      ctx.beginPath()
      ctx.moveTo(pad, pad + ih)
      for (let i = 0; i < bins.length; i++) {
        const bx = pad + (i / (bins.length - 1)) * iw
        const bh = Math.min(1, Math.pow(bins[i] / maxB, 0.6)) * ih * 0.72
        ctx.lineTo(bx, pad + ih - bh)
      }
      ctx.lineTo(pad + iw, pad + ih)
      ctx.closePath()
      ctx.fillStyle = 'rgba(242, 237, 228, 0.06)'
      ctx.fill()
    }

    // 4x4 Zone System grid + diagonal baseline
    ctx.strokeStyle = 'rgba(242, 237, 228, 0.10)'
    ctx.lineWidth = 1
    for (let i = 0; i <= 4; i++) {
      const gx = pad + (i / 4) * iw
      const gy = pad + (i / 4) * ih
      ctx.beginPath()
      ctx.moveTo(gx, pad)
      ctx.lineTo(gx, pad + ih)
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(pad, gy)
      ctx.lineTo(pad + iw, gy)
      ctx.stroke()
    }

    ctx.setLineDash([4, 4])
    ctx.strokeStyle = 'rgba(242, 237, 228, 0.22)'
    ctx.beginPath()
    ctx.moveTo(pad, pad + ih)
    ctx.lineTo(pad + iw, pad)
    ctx.stroke()
    ctx.setLineDash([])

    // Draw inactive channels faintly
    const chColors: Record<CurveChannel, string> = {
      red: '#e06c65',
      green: '#68b882',
      blue: '#6298e8',
      master: '#f2ede4',
    }
    const order: CurveChannel[] = ['red', 'green', 'blue', 'master']
    for (const ch of order) {
      if (ch === this.activeChannel) continue
      const lut = evaluateMonotonicSpline256(this.params.curves[ch])
      ctx.beginPath()
      for (let i = 0; i < 256; i += 2) {
        const x = pad + (i / 255) * iw
        const y = pad + (1 - lut[i] / 255) * ih
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.strokeStyle = `${chColors[ch]}44`
      ctx.lineWidth = 1.2
      ctx.stroke()
    }

    // Draw active channel curve + draggable control handles
    const activeLut = evaluateMonotonicSpline256(this.params.curves[this.activeChannel])
    ctx.beginPath()
    for (let i = 0; i < 256; i++) {
      const x = pad + (i / 255) * iw
      const y = pad + (1 - activeLut[i] / 255) * ih
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.strokeStyle = chColors[this.activeChannel]
    ctx.lineWidth = 2.2
    ctx.stroke()

    for (const [px, py] of this.params.curves[this.activeChannel]) {
      const cx = pad + px * iw
      const cy = pad + (1 - py) * ih
      ctx.beginPath()
      ctx.arc(cx, cy, 5, 0, Math.PI * 2)
      ctx.fillStyle = '#121216'
      ctx.fill()
      ctx.lineWidth = 2
      ctx.strokeStyle = chColors[this.activeChannel]
      ctx.stroke()
    }
  }

  private renderHistogram(st: PhotometricStats): void {
    const c = this.histCanvas
    if (!c) return
    const ctx = c.getContext('2d')
    if (!ctx) return
    const w = c.width
    const h = c.height
    ctx.clearRect(0, 0, w, h)

    let maxVal = 1
    for (let i = 2; i < st.lumaBins.length - 2; i++) {
      maxVal = Math.max(maxVal, st.rBins[i], st.gBins[i], st.bBins[i])
    }

    const drawChannel = (bins: Uint32Array, fill: string, stroke: string) => {
      ctx.beginPath()
      ctx.moveTo(0, h)
      for (let i = 0; i < bins.length; i++) {
        const x = (i / (bins.length - 1)) * w
        const y = h - Math.min(1, Math.pow(bins[i] / maxVal, 0.62)) * (h - 4) - 1
        ctx.lineTo(x, y)
      }
      ctx.lineTo(w, h)
      ctx.closePath()
      ctx.fillStyle = fill
      ctx.fill()
      ctx.strokeStyle = stroke
      ctx.lineWidth = 1
      ctx.stroke()
    }

    drawChannel(st.rBins, 'rgba(224, 96, 88, 0.18)', 'rgba(224, 96, 88, 0.65)')
    drawChannel(st.gBins, 'rgba(98, 186, 126, 0.16)', 'rgba(98, 186, 126, 0.65)')
    drawChannel(st.bBins, 'rgba(94, 148, 232, 0.18)', 'rgba(94, 148, 232, 0.68)')
    drawChannel(st.lumaBins, 'rgba(242, 237, 228, 0.14)', 'rgba(242, 237, 228, 0.85)')
  }

  private updateStatsReadout(st: PhotometricStats): void {
    const el = document.getElementById('dr-live-photometrics')
    if (!el) return
    const clipWarn = st.clipHighPct > 0.8 ? ' ⚠' : ''
    el.textContent = `p05 ${st.p05} · p50 ${st.p50} · p95 ${st.p95} · clipHigh ${st.clipHighPct.toFixed(2)}%${clipWarn} · clipLow ${st.clipLowPct.toFixed(2)}%`
  }

  private renderSidecarCode(): void {
    const codeEl = document.getElementById('dr-recipe-code')
    if (!codeEl) return
    const p = this.params
    const kelvin = Math.round(this.currentPhoto.baseTempK + p.temperature * 36)
    const fmtPts = (pts: Array<[number, number]>) =>
      `[${pts.map(([x, y]) => `[${x.toFixed(2)},${y.toFixed(2)}]`).join(', ')}]`

    if (this.recipeFormat === 'json') {
      const steps: Array<Record<string, unknown>> = [
        { op: 'exposure', params: { ev: Number(p.exposure.toFixed(2)) } },
        { op: 'white_balance', params: { temperature: p.temperature, tint: p.tint } },
        {
          op: 'tone',
          params: {
            highlights: p.highlights,
            shadows: p.shadows,
            contrast: p.contrast,
            blacks: p.blacks,
          },
        },
        {
          op: 'curve',
          params: {
            points: p.curves.master.map(([x, y]) => [Number(x.toFixed(2)), Number(y.toFixed(2))]),
            blue: p.curves.blue.map(([x, y]) => [Number(x.toFixed(2)), Number(y.toFixed(2))]),
          },
        },
        {
          op: 'saturation',
          params: { vibrance: p.vibrance, saturation: p.saturation },
        },
      ]
      if (p.clarity !== 0) steps.push({ op: 'clarity', params: { amount: p.clarity } })
      if (p.dehaze > 0) steps.push({ op: 'dehaze', params: { amount: p.dehaze } })
      if (p.mask.kind !== 'none') {
        steps.push({
          op: 'exposure',
          label: `local-${p.mask.kind}`,
          params: { ev: Number(p.mask.ev.toFixed(2)) },
          mask: {
            shapes: [
              {
                type: p.mask.kind,
                cx: p.mask.cx,
                cy: p.mask.cy,
                rx: p.mask.rx,
                ry: p.mask.ry,
                feather: p.mask.feather,
              },
            ],
          },
        })
      }
      codeEl.textContent = JSON.stringify(
        {
          schema: 'chengying-recipe/1',
          source: this.currentPhoto.fileName,
          revision: `rev_0${this.activeRevSeq}`,
          stages: [{ engine: 'builtin', pipeline: 'linear-32f', steps }],
        },
        null,
        2,
      )
    } else if (this.recipeFormat === 'xmp') {
      codeEl.textContent = `<?xml version="1.0" encoding="UTF-8"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" xmlns:darktable="http://darktable.sf.net/">
  <rdf:Description darktable:xmp_version="5" darktable:raw_params="0">
    <!-- Scene-Referred 32-bit Linear REC.2020 Stack (verified read-back) -->
    <darktable:history>
      <rdf:Seq>
        <rdf:li darktable:operation="channelmixerrgb" darktable:enabled="1"
          chengying:illuminant_K="${kelvin}" />
        <rdf:li darktable:operation="exposure" darktable:enabled="1"
          chengying:ev="${p.exposure.toFixed(2)}" chengying:black="${(-p.blacks * 0.0008).toFixed(4)}" />
        <rdf:li darktable:operation="sigmoid" darktable:enabled="1"
          chengying:middle_grey_contrast="${(1.35 + p.contrast * 0.008).toFixed(2)}" />
        <rdf:li darktable:operation="colorbalancergb" darktable:enabled="1"
          chengying:vibrance="${(p.vibrance / 100).toFixed(2)}"
          chengying:brilliance_shadows="${(p.shadows / 180).toFixed(2)}"
          chengying:brilliance_highlights="${(p.highlights / 220).toFixed(2)}" />
        <rdf:li darktable:operation="rgbcurve" darktable:enabled="1"
          chengying:master="${fmtPts(p.curves.master)}" />${
            p.mask.kind !== 'none'
              ? `\n        <rdf:li darktable:operation="exposure" darktable:multi_priority="1"
          darktable:blendop_version="14" chengying:drawn_mask="${p.mask.kind}(${p.mask.cx},${p.mask.cy})"
          chengying:local_ev="${p.mask.ev.toFixed(2)}" />`
              : ''
          }
      </rdf:Seq>
    </darktable:history>
  </rdf:Description>
</x:xmpmeta>`
    } else {
      codeEl.textContent = `[Version]
AppVersion=5.13
Version=348

[Exposure]
Auto=false
Compensation=${p.exposure.toFixed(2)}
Contrast=${p.contrast}
HighlightCompr=${Math.max(0, -p.highlights)}
ShadowCompr=${Math.max(0, p.shadows)}
Black=${-p.blacks * 20}

[White Balance]
Setting=Custom
Temperature=${kelvin}
Green=${(1 - p.tint * 0.006).toFixed(3)}

[Vibrance]
Enabled=true
Pastels=${p.vibrance}
Saturated=${p.saturation}
ProtectSkins=${this.currentPhoto.isPortrait ? 'true' : 'false'}${
        p.mask.kind !== 'none'
          ? `\n\n[Locallab]
Enabled=true
Nbspot=1
Name_0=Chengying_${p.mask.kind}
CenterX_0=${Math.round((p.mask.cx - 0.5) * 2000)}
CenterY_0=${Math.round((p.mask.cy - 0.5) * 2000)}
Expcomp_0=${Math.round(p.mask.ev * 60)}`
          : ''
      }`
    }
  }
}
