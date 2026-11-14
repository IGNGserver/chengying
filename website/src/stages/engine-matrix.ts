import {
  BUNDLED_SKILLS_LIST,
  ENGINE_COVERAGE_DATA,
  RAW_FORMAT_BADGES,
} from '../data/product-facts'
import { tText, UI_COPY } from '../i18n/copy'
import type { Lang } from '../types'

export class EngineMatrixController {
  private lang: Lang = 'zh'
  private activeEngineId: 'builtin' | 'darktable' | 'rawtherapee' | 'ai' = 'builtin'

  public mount(lang: Lang): void {
    this.lang = lang
    this.renderEngineTabs()
    this.renderEngineDetail()
    this.renderSkillsAndFormats()
    this.bindCopyButtons()
  }

  public setLanguage(lang: Lang): void {
    this.lang = lang
    this.renderEngineTabs()
    this.renderEngineDetail()
    this.renderSkillsAndFormats()
    this.updateCopyButtonLabels()
  }

  private renderEngineTabs(): void {
    const host = document.getElementById('engine-tabs')
    if (!host) return
    host.innerHTML = ENGINE_COVERAGE_DATA.map((eng) => {
      const active = eng.id === this.activeEngineId
      return `
        <button
          type="button"
          class="engine-tab-card ${active ? 'is-active' : ''}"
          data-engine-id="${eng.id}"
          aria-pressed="${active}"
        >
          <div class="eng-tab-top">
            <strong>${tText(eng.name, this.lang)}</strong>
          </div>
          <span class="eng-ver">${tText(eng.badge, this.lang)}</span>
          <p class="eng-tab-sub">${tText(eng.subtitle, this.lang)}</p>
        </button>
      `
    }).join('')

    host.querySelectorAll<HTMLButtonElement>('[data-engine-id]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.activeEngineId = btn.dataset.engineId as typeof this.activeEngineId
        this.renderEngineTabs()
        this.renderEngineDetail()
      })
    })
  }

  private renderEngineDetail(): void {
    const host = document.getElementById('engine-detail-box')
    if (!host) return
    const eng =
      ENGINE_COVERAGE_DATA.find((e) => e.id === this.activeEngineId) ?? ENGINE_COVERAGE_DATA[0]

    host.innerHTML = `
      <div class="eng-detail-head">
        <div>
          <span class="eng-kicker">${tText(eng.badge, this.lang)}</span>
          <h3>${tText(eng.name, this.lang)}</h3>
          <small class="eng-sidecar-sub">${tText(eng.sidecarFormat, this.lang)}</small>
        </div>
      </div>

      <p class="eng-discovery-desc">${tText(eng.summary, this.lang)}</p>

      <ul class="eng-highlight-list">
        ${eng.highlights.map((h) => `<li>${tText(h, this.lang)}</li>`).join('')}
      </ul>

      <div class="eng-ops-cloud">
        ${eng.capabilities.map((cap) => `<span>${tText(cap, this.lang)}</span>`).join('')}
      </div>
    `
  }

  private renderSkillsAndFormats(): void {
    const skillsHost = document.getElementById('bundled-skills-grid')
    if (skillsHost) {
      skillsHost.innerHTML = BUNDLED_SKILLS_LIST.map(
        (sk) => `
        <article class="skill-card">
          <span class="skill-tag">${tText(sk.tag, this.lang)}</span>
          <h4>${tText(sk.title, this.lang)}</h4>
          <p>${tText(sk.desc, this.lang)}</p>
        </article>
      `,
      ).join('')
    }

    const fmtHost = document.getElementById('raw-formats-strip')
    if (fmtHost) {
      fmtHost.innerHTML = RAW_FORMAT_BADGES.map(
        (f) => `
        <div class="raw-fmt-chip">
          <strong>${tText(f.brand, this.lang)}</strong>
          <code>${f.exts}</code>
        </div>
      `,
      ).join('')
    }
  }

  private bindCopyButtons(): void {
    document.querySelectorAll<HTMLButtonElement>('[data-copy-target]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.copyTarget
        const target = id ? document.getElementById(id) : null
        if (!target) return
        const text = target.textContent?.trim() || ''
        try {
          await navigator.clipboard.writeText(text)
          btn.textContent = UI_COPY[this.lang].engines.copiedBtn
          btn.classList.add('is-copied')
          setTimeout(() => {
            btn.textContent = UI_COPY[this.lang].engines.copyBtn
            btn.classList.remove('is-copied')
          }, 1800)
        } catch {
          // Clipboard fallback ignored in restricted frames
        }
      })
    })
  }

  private updateCopyButtonLabels(): void {
    document.querySelectorAll<HTMLButtonElement>('[data-copy-target]').forEach((btn) => {
      if (!btn.classList.contains('is-copied')) {
        btn.textContent = UI_COPY[this.lang].engines.copyBtn
      }
    })
  }
}
