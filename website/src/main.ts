import '@fontsource-variable/cormorant'
import '@fontsource-variable/jetbrains-mono'
import '@fontsource-variable/plus-jakarta-sans'

import './styles/tokens.css'
import './styles/base.css'
import './styles/stages.css'
import './styles/responsive.css'

import { initScrollChoreography } from './core/choreography'
import { UI_COPY } from './i18n/copy'
import { AgentWorkflowController } from './stages/agent-workflow'
import { AuthBoundaryController } from './stages/auth-boundary'
import { CullingWallController } from './stages/culling-wall'
import { DigitalDarkroomController } from './stages/digital-darkroom'
import { EngineMatrixController } from './stages/engine-matrix'
import { HeroStageController } from './stages/hero-stage'
import type { Lang, SurroundMode } from './types'

class ChengyingWebsiteApp {
  private lang: Lang = 'zh'
  private surround: SurroundMode = 'darkroom'

  private readonly hero = new HeroStageController()
  private readonly cull = new CullingWallController()
  private readonly darkroom = new DigitalDarkroomController()
  private readonly agents = new AgentWorkflowController()
  private readonly auth = new AuthBoundaryController()
  private readonly engines = new EngineMatrixController()

  public boot(): void {
    document.documentElement.dataset.surround = this.surround

    this.hero.mount(this.lang)
    this.cull.mount(this.lang)
    this.darkroom.mount(this.lang)
    this.agents.mount(this.lang)
    this.auth.mount(this.lang)
    this.engines.mount(this.lang)

    this.bindGlobalControls()
    this.applyStaticCopy()
    initScrollChoreography()
  }

  private bindGlobalControls(): void {
    const surroundBtn = document.getElementById('toggle-surround-btn')
    surroundBtn?.addEventListener('click', () => {
      this.surround = this.surround === 'darkroom' ? 'baryta' : 'darkroom'
      document.documentElement.dataset.surround = this.surround
      this.applyStaticCopy()
    })

    const langBtn = document.getElementById('toggle-lang-btn')
    langBtn?.addEventListener('click', () => {
      this.lang = this.lang === 'zh' ? 'en' : 'zh'
      document.documentElement.lang = this.lang === 'zh' ? 'zh-CN' : 'en'
      this.applyStaticCopy()
      this.hero.setLanguage(this.lang)
      this.cull.setLanguage(this.lang)
      this.darkroom.setLanguage(this.lang)
      this.agents.setLanguage(this.lang)
      this.auth.setLanguage(this.lang)
      this.engines.setLanguage(this.lang)
    })

    // Darkroom keyboard shortcuts when user is not typing in an input
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return
      if (e.key === '\\') {
        document.getElementById('dr-btn-hold')?.dispatchEvent(new PointerEvent('pointerdown'))
      } else if (e.key === 'm' || e.key === 'M') {
        const drSec = document.getElementById('darkroom-section')
        const r = drSec?.getBoundingClientRect()
        if (r && r.top < window.innerHeight * 0.7 && r.bottom > 120) {
          document.getElementById('dr-btn-mask-overlay')?.click()
        }
      } else if (e.key === 'z' || e.key === 'Z') {
        const drSec = document.getElementById('darkroom-section')
        const r = drSec?.getBoundingClientRect()
        if (r && r.top < window.innerHeight * 0.7 && r.bottom > 120) {
          document.getElementById('dr-btn-zebra')?.click()
        }
      }
    })

    window.addEventListener('keyup', (e) => {
      if (e.key === '\\') {
        document.getElementById('dr-btn-hold')?.dispatchEvent(new PointerEvent('pointerup'))
      }
    })
  }

  private applyStaticCopy(): void {
    const dict = UI_COPY[this.lang]
    document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
      const path = (el.dataset.i18n || '').split('.')
      let cur: unknown = dict
      for (const seg of path) {
        if (cur && typeof cur === 'object' && seg in (cur as Record<string, unknown>)) {
          cur = (cur as Record<string, unknown>)[seg]
        } else {
          cur = undefined
          break
        }
      }
      if (typeof cur === 'string') {
        el.textContent = cur
      }
    })

    const surroundBtn = document.getElementById('toggle-surround-btn')
    if (surroundBtn) {
      surroundBtn.textContent =
        this.surround === 'darkroom' ? dict.nav.surroundPaper : dict.nav.surroundDark
    }
    const langBtn = document.getElementById('toggle-lang-btn')
    if (langBtn) {
      langBtn.textContent = this.lang === 'zh' ? 'EN' : '中文'
    }
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => new ChengyingWebsiteApp().boot())
} else {
  new ChengyingWebsiteApp().boot()
}
