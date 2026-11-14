import { CULLING_FRAMES } from '../data/expedition-catalog'
import { tText } from '../i18n/copy'
import type { CullingFrame, Lang } from '../types'

export type CullStageMode = 'all' | 'diag' | 'fade' | 'narrative'
export type NlFilterMode = 'narrative' | 'portrait' | 'potential' | 'all'

export class CullingWallController {
  private lang: Lang = 'zh'
  private stageMode: CullStageMode = 'all'
  private nlMode: NlFilterMode = 'all'
  private autoPlayed = false
  private autoTimers: number[] = []
  private userInteracted = false

  private gridEl: HTMLElement | null = null
  private cliOutputEl: HTMLElement | null = null
  private countStatsEl: HTMLElement | null = null
  private modalEl: HTMLElement | null = null

  public mount(lang: Lang): void {
    this.lang = lang
    this.gridEl = document.getElementById('cull-grid')
    this.cliOutputEl = document.getElementById('cull-cli-readout')
    this.countStatsEl = document.getElementById('cull-live-counter')
    this.modalEl = document.getElementById('cull-burst-modal')

    if (!this.gridEl) return

    this.renderGrid()
    this.bindControls()
    this.setupScrollAutoChoreography()
    this.updateStateClasses(false)
  }

  public setLanguage(lang: Lang): void {
    this.lang = lang
    this.renderGrid()
    this.updateStateClasses(false)
    this.renderBurstModalContent()
  }

  private renderGrid(): void {
    if (!this.gridEl) return

    this.gridEl.innerHTML = CULLING_FRAMES.map((frame) => {
      const faceInsetHtml = frame.faceInsetSrc
        ? `<div class="cull-face-inset" title="1:1 Face Zoom Inset (#ffd54f)">
             <img src="${frame.faceInsetSrc}" alt="1:1 face zoom ${frame.frameNo}" loading="lazy" decoding="async" />
             <span>1:1 EYE</span>
           </div>`
        : ''

      return `
        <article
          class="cull-card ${frame.isPick ? 'is-pick-candidate' : 'is-reject-candidate'} span-${frame.narrativeSpan ?? 'standard'}"
          data-frame-id="${frame.id}"
          data-group="${frame.groupCode}"
          data-segment="${frame.segmentId}"
          tabindex="0"
          role="button"
          aria-label="${frame.frameNo} ${frame.fileName} — ${tText(frame.defectBadge, this.lang)}"
        >
          <header class="cull-film-top">
            <span class="cull-frame-no">${frame.frameNo}</span>
            <span class="cull-group-tag">${frame.groupCode} · ${frame.pairedRaw}</span>
            <span class="cull-score-pill ${frame.isPick ? 'is-high' : ''}">${frame.scores.overall.toFixed(1)}</span>
          </header>

          <div class="cull-photo-box">
            <img
              src="${frame.thumbSrc}"
              data-master="${frame.masterSrc ?? frame.thumbSrc}"
              alt="${frame.fileName} ${tText(frame.caption, this.lang)}"
              loading="lazy"
              decoding="async"
            />
            ${faceInsetHtml}
            <div class="cull-diag-badge defect-${frame.defectKind}">
              ${tText(frame.defectBadge, this.lang)}
            </div>
            ${
              !frame.isPick
                ? `<div class="cull-reject-stamp">
                     <span>FLAG: REJECT</span>
                     <small>${this.lang === 'zh' ? '原文件保留 · 0 字节改动' : 'Original Kept · 0 Bytes Altered'}</small>
                   </div>`
                : ''
            }
          </div>

          <footer class="cull-card-foot">
            <div class="cull-meta-row">
              <span class="cull-filename">${frame.fileName}</span>
              <span class="cull-exif">${frame.exifShort}</span>
            </div>
            <div class="cull-mono-diag">${frame.diagnosticMono}</div>
            <p class="cull-narrative-caption">
              <strong>${tText(frame.segmentTitle, this.lang)}</strong> — ${tText(frame.caption, this.lang)}
            </p>
          </footer>
        </article>
      `
    }).join('')

    this.gridEl.querySelectorAll<HTMLElement>('.cull-card').forEach((card) => {
      const open = () => {
        const frame = CULLING_FRAMES.find((f) => f.id === card.dataset.frameId)
        if (frame) this.openBurstModal(frame)
      }
      card.addEventListener('click', open)
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          open()
        }
      })
    })
  }

  private bindControls(): void {
    document.querySelectorAll<HTMLButtonElement>('[data-cull-stage]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.userInteracted = true
        this.clearAutoTimers()
        const mode = btn.dataset.cullStage as CullStageMode
        this.nlMode = mode === 'narrative' ? 'narrative' : 'all'
        this.transitionTo(mode, this.nlMode)
      })
    })

    document.querySelectorAll<HTMLButtonElement>('[data-nl-select]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.userInteracted = true
        this.clearAutoTimers()
        const nl = btn.dataset.nlSelect as NlFilterMode
        if (nl === 'all') {
          this.transitionTo('all', 'all')
        } else {
          this.transitionTo('narrative', nl)
        }
      })
    })

    const openVlmBtn = document.getElementById('cull-open-vlm-btn')
    openVlmBtn?.addEventListener('click', () => {
      const target = CULLING_FRAMES.find((f) => f.id === 'cull-02-pick') ?? CULLING_FRAMES[0]
      this.openBurstModal(target)
    })

    const closeBtn = document.getElementById('cull-modal-close')
    closeBtn?.addEventListener('click', () => this.closeBurstModal())
    this.modalEl?.addEventListener('click', (e) => {
      if (e.target === this.modalEl) this.closeBurstModal()
    })
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.modalEl && !this.modalEl.hidden) {
        this.closeBurstModal()
      }
    })
  }

  private setupScrollAutoChoreography(): void {
    const section = document.getElementById('cull-section')
    if (!section || typeof IntersectionObserver === 'undefined') return

    const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const obs = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && !this.autoPlayed && !this.userInteracted) {
            this.autoPlayed = true
            if (prefersReduced) {
              this.stageMode = 'narrative'
              this.nlMode = 'narrative'
              this.updateStateClasses(false)
              return
            }
            this.autoTimers.push(
              window.setTimeout(() => {
                if (!this.userInteracted) this.transitionTo('diag', 'all')
              }, 700),
              window.setTimeout(() => {
                if (!this.userInteracted) this.transitionTo('fade', 'all')
              }, 1950),
              window.setTimeout(() => {
                if (!this.userInteracted) this.transitionTo('narrative', 'narrative')
              }, 3250),
            )
          }
        }
      },
      { threshold: 0.22 },
    )
    obs.observe(section)
  }

  private clearAutoTimers(): void {
    for (const id of this.autoTimers) clearTimeout(id)
    this.autoTimers = []
  }

  private isFrameIncludedInNl(frame: CullingFrame): boolean {
    if (this.stageMode !== 'narrative') return true
    if (!frame.isPick) return false
    if (this.nlMode === 'portrait') {
      return frame.tags.includes('portrait') || frame.tags.includes('craft')
    }
    if (this.nlMode === 'potential') {
      return frame.tags.includes('landscape') && frame.scores.overall >= 92
    }
    return true
  }

  private transitionTo(stage: CullStageMode, nl: NlFilterMode): void {
    if (!this.gridEl) return

    // Record FIRST positions for FLIP animation
    const cards = Array.from(this.gridEl.querySelectorAll<HTMLElement>('.cull-card'))
    const firstRects = new Map<string, DOMRect>()
    for (const c of cards) {
      if (!c.classList.contains('is-collapsed-out')) {
        firstRects.set(c.dataset.frameId || '', c.getBoundingClientRect())
      }
    }

    this.stageMode = stage
    this.nlMode = nl
    this.updateStateClasses(true)

    // Measure LAST positions & play FLIP transform on surviving visible cards
    requestAnimationFrame(() => {
      for (const c of cards) {
        if (c.classList.contains('is-collapsed-out')) continue
        const prev = firstRects.get(c.dataset.frameId || '')
        if (!prev || prev.width === 0) continue
        const next = c.getBoundingClientRect()
        const dx = prev.left - next.left
        const dy = prev.top - next.top
        const sx = prev.width / Math.max(1, next.width)
        const sy = prev.height / Math.max(1, next.height)

        if (Math.abs(dx) > 1 || Math.abs(dy) > 1 || Math.abs(sx - 1) > 0.02) {
          c.style.transition = 'none'
          c.style.transformOrigin = 'top left'
          c.style.transform = `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px) scale(${sx.toFixed(3)}, ${sy.toFixed(3)})`
          requestAnimationFrame(() => {
            c.style.transition =
              'transform 620ms cubic-bezier(0.22, 1, 0.36, 1), opacity 420ms ease, filter 420ms ease'
            c.style.transform = ''
          })
        }
      }
    })
  }

  private updateStateClasses(upgradeImages: boolean): void {
    if (!this.gridEl) return

    this.gridEl.dataset.stage = this.stageMode
    this.gridEl.classList.toggle('is-narrative-layout', this.stageMode === 'narrative')

    document.querySelectorAll<HTMLButtonElement>('[data-cull-stage]').forEach((btn) => {
      const active = btn.dataset.cullStage === this.stageMode
      btn.classList.toggle('is-active', active)
      btn.setAttribute('aria-pressed', String(active))
    })

    document.querySelectorAll<HTMLButtonElement>('[data-nl-select]').forEach((btn) => {
      const active =
        (this.stageMode === 'all' && btn.dataset.nlSelect === 'all') ||
        (this.stageMode === 'narrative' && btn.dataset.nlSelect === this.nlMode)
      btn.classList.toggle('is-active', active)
    })

    let visibleCount = 0
    let pickCount = 0
    this.gridEl.querySelectorAll<HTMLElement>('.cull-card').forEach((card) => {
      const frame = CULLING_FRAMES.find((f) => f.id === card.dataset.frameId)
      if (!frame) return
      const keep = this.isFrameIncludedInNl(frame)
      card.classList.toggle('is-collapsed-out', this.stageMode === 'narrative' && !keep)
      if (keep) {
        visibleCount++
        if (frame.isPick) pickCount++
      }
      if (upgradeImages && this.stageMode === 'narrative' && keep && frame.masterSrc) {
        const img = card.querySelector<HTMLImageElement>('img[data-master]')
        if (img && img.src !== frame.masterSrc) {
          img.src = frame.masterSrc
        }
      }
    })

    if (this.countStatsEl) {
      this.countStatsEl.textContent =
        this.stageMode === 'narrative'
          ? this.lang === 'zh'
            ? `已从 24 帧连拍原片中叙事精选 ${visibleCount} 帧 · 淘汰帧 0 字节删除`
            : `Curated ${visibleCount} narrative frames from 24 captures · 0 bytes deleted`
          : this.lang === 'zh'
            ? `底片台共 24 帧 (8 组连拍 · 入选候选 ${pickCount} 帧 · 原片 SHA-256 锁定)`
            : `Light table: 24 frames (8 burst groups · ${pickCount} picks · SHA-256 locked)`
    }

    if (this.cliOutputEl) {
      const cmdMap: Record<NlFilterMode, string> = {
        all: 'chengying cull ./2026-expedition  # -> 24 shots, 8 groups (exact/near/scene), originalsIntact=true',
        narrative:
          'photo_select({ request: "按行程叙事选 8 张代表作", diversity: 0.42, narrative: true })  # -> MMR 4 segments, 8 picks',
        portrait:
          'photo_select({ request: "优先人像与手作人文，排除闭眼和糊片", preferTags: ["portrait","craft"] })  # -> 3 picks',
        potential:
          'photo_select({ request: "高动态余量风光，92 分以上", minScore: 92, requireTags: ["landscape"] })  # -> 4 picks',
      }
      const key = this.stageMode === 'narrative' ? this.nlMode : 'all'
      this.cliOutputEl.textContent = cmdMap[key]
    }
  }

  private activeModalGroup = 'G-06'

  private openBurstModal(frame: CullingFrame): void {
    this.activeModalGroup = frame.groupCode
    this.renderBurstModalContent()
    if (this.modalEl) {
      this.modalEl.hidden = false
      document.body.style.overflow = 'hidden'
    }
  }

  private closeBurstModal(): void {
    if (this.modalEl) {
      this.modalEl.hidden = true
      document.body.style.overflow = ''
    }
  }

  private renderBurstModalContent(): void {
    const body = document.getElementById('cull-modal-body')
    const title = document.getElementById('cull-modal-title')
    if (!body || !title) return

    const members = CULLING_FRAMES.filter((f) => f.groupCode === this.activeModalGroup)
    title.textContent =
      this.lang === 'zh'
        ? `连拍组 ${this.activeModalGroup} 同表像素与视觉复核 (${members.length} 帧)`
        : `Burst Group ${this.activeModalGroup} Side-by-Side Pixel & VLM Review (${members.length} frames)`

    body.innerHTML = members
      .map(
        (m) => `
      <div class="burst-compare-card ${m.isPick ? 'is-winner' : 'is-outtake'}">
        <div class="burst-img-wrap">
          <img src="${m.masterSrc ?? m.thumbSrc}" alt="${m.fileName}" />
          ${
            m.faceInsetSrc
              ? `<div class="burst-face-zoom">
                   <img src="${m.faceInsetSrc}" alt="1:1 eye zoom" />
                   <span>1:1 Face Zoom (#ffd54f)</span>
                 </div>`
              : ''
          }
        </div>
        <div class="burst-meta">
          <div class="burst-head">
            <strong>#${m.frameNo} · ${m.fileName}</strong>
            <span class="burst-badge ${m.isPick ? 'win' : 'rej'}">${tText(m.defectBadge, this.lang)}</span>
          </div>
          <code>${m.diagnosticMono} · ${m.exifShort}</code>
          <div class="burst-score-bars">
            <span>Tech ${m.scores.technical}</span>
            <span>Aesth ${m.scores.aesthetic}</span>
            <span>Story ${m.scores.story}</span>
            <span>RAW Pot. ${m.scores.potential}</span>
          </div>
          <p>${tText(m.caption, this.lang)}</p>
        </div>
      </div>
    `,
      )
      .join('')
  }
}
