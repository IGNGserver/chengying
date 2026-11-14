import { UI_COPY } from '../i18n/copy'
import type { Lang } from '../types'

export type AuthMode = 'original' | 'inpaint' | 'generative'

export class AuthBoundaryController {
  private lang: Lang = 'zh'
  private mode: AuthMode = 'inpaint'
  private isAuthorized = false

  public mount(lang: Lang): void {
    this.lang = lang
    this.bindEvents()
    this.render()
  }

  public setLanguage(lang: Lang): void {
    this.lang = lang
    this.render()
  }

  private bindEvents(): void {
    document.querySelectorAll<HTMLButtonElement>('[data-auth-mode]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.mode = btn.dataset.authMode as AuthMode
        this.render()
      })
    })

    document.getElementById('auth-grant-btn')?.addEventListener('click', () => {
      this.isAuthorized = true
      this.mode = 'generative'
      this.render()
    })

    document.getElementById('auth-revoke-btn')?.addEventListener('click', () => {
      this.isAuthorized = false
      if (this.mode === 'generative') {
        this.mode = 'inpaint'
      }
      this.render()
    })
  }

  private render(): void {
    const copy = UI_COPY[this.lang].boundary
    document.querySelectorAll<HTMLButtonElement>('[data-auth-mode]').forEach((btn) => {
      const active = btn.dataset.authMode === this.mode
      btn.classList.toggle('is-active', active)
      btn.setAttribute('aria-pressed', String(active))
    })

    const imgEl = document.getElementById('auth-stage-img') as HTMLImageElement | null
    const lockOverlay = document.getElementById('auth-lock-overlay')
    const grantBtn = document.getElementById('auth-grant-btn') as HTMLButtonElement | null
    const revokeBtn = document.getElementById('auth-revoke-btn') as HTMLButtonElement | null
    const bannerEl = document.getElementById('auth-status-banner')
    const metaBox = document.getElementById('auth-meta-inspector')
    const badgeEl = document.getElementById('auth-authenticity-pill')

    const showGenerativePixels = this.mode === 'generative' && this.isAuthorized

    if (imgEl) {
      if (this.mode === 'original') {
        imgEl.src = './photos/07-harbor-night-rain.webp'
      } else if (this.mode === 'inpaint' || !showGenerativePixels) {
        imgEl.src = './photos/07-harbor-inpaint-clean.webp'
      } else {
        imgEl.src = './photos/07-harbor-gen-layer.webp'
      }
    }

    if (lockOverlay) {
      lockOverlay.hidden = !(this.mode === 'generative' && !this.isAuthorized)
    }

    if (grantBtn) {
      grantBtn.hidden = this.isAuthorized
      grantBtn.textContent = copy.grantBtn
    }
    if (revokeBtn) {
      revokeBtn.hidden = !this.isAuthorized
      revokeBtn.textContent = copy.revokeBtn
    }

    if (bannerEl) {
      bannerEl.className = `auth-banner ${showGenerativePixels ? 'is-gen-authorized' : this.mode === 'generative' ? 'is-blocked' : 'is-documentary'}`
      if (this.mode === 'generative' && !this.isAuthorized) {
        bannerEl.textContent = copy.lockedBanner
      } else if (showGenerativePixels) {
        bannerEl.textContent = copy.unlockedBanner
      } else if (this.mode === 'inpaint') {
        bannerEl.textContent =
          this.lang === 'zh'
            ? '基于周围夜空像素自然填补：仅轻轻抹除上空杂乱电线，没有添加任何虚拟画面，可顺畅直接完成。'
            : 'Surrounding-pixel cleanup: neatly removes distracting overhead wires using real night sky pixels—no approval hurdle needed.'
      } else {
        bannerEl.textContent =
          this.lang === 'zh'
            ? '保留按下快门那一刻的完整原片：只读保护，不会覆盖或删改原始照片文件。'
            : 'Original capture untouched: read-only protection guarantees your source photo is never overwritten.'
      }
    }

    if (badgeEl) {
      if (showGenerativePixels) {
        badgeEl.className = 'auth-pill pill-gen'
        badgeEl.textContent =
          this.lang === 'zh'
            ? '已含 AI 生成天空 · 导出将如实注明'
            : 'Includes AI Sky Layer · Honestly Noted'
      } else {
        badgeEl.className = 'auth-pill pill-pure'
        badgeEl.textContent =
          this.lang === 'zh'
            ? '100% 现场实拍光影 · 无 AI 生成内容'
            : '100% Real Capture · Non-Generative'
      }
    }

    if (metaBox) {
      const zh = this.lang === 'zh'
      const rows =
        this.mode === 'generative' && !this.isAuthorized
          ? [
              {
                label: zh ? '拍摄原片' : 'Original File',
                val: zh ? 'DSC0604.ARW · 完好保留未动' : 'DSC0604.ARW · Untouched & Safe',
              },
              {
                label: zh ? '当前状态' : 'Status',
                val: zh
                  ? '等待你的确认 — AI 更换天空暂未执行'
                  : 'Waiting for your confirmation — AI sky swap paused',
              },
              {
                label: zh ? '为什么拦住' : 'Why Paused',
                val: zh
                  ? '更换天空会改变实拍画面，必须由你亲自点头'
                  : 'Swapping the sky invents new content and requires your explicit yes',
              },
              {
                label: zh ? '拍摄信息' : 'Camera Info',
                val: zh ? '时间、地点与镜头信息完整随附' : 'Date, location, camera & lens preserved',
              },
            ]
          : showGenerativePixels
            ? [
                {
                  label: zh ? '拍摄原片' : 'Original File',
                  val: zh ? 'DSC0604.ARW · 完好保留，随时可恢复' : 'DSC0604.ARW · Untouched, reversible anytime',
                },
                {
                  label: zh ? '当前处理' : 'Active Edit',
                  val: zh
                    ? 'AI 晚霞天空已保存为独立图层（经你本次确认）'
                    : 'AI sunset sky placed on a separate reversible layer (approved)',
                },
                {
                  label: zh ? '照片真实声明' : 'Truth Tag',
                  val: zh
                    ? '导出照片已自动标注「包含 AI 生成天空」'
                    : 'Export honestly marked as “Includes AI-generated sky”',
                },
                {
                  label: zh ? '拍摄信息' : 'Camera Info',
                  val: zh ? '时间、地点、光圈快门等原片记忆全部留存' : 'Date, GPS, camera & lens metadata preserved',
                },
              ]
            : [
                {
                  label: zh ? '拍摄原片' : 'Original File',
                  val: zh ? 'DSC0604.ARW · 完好保留未作修改' : 'DSC0604.ARW · Read-only & completely safe',
                },
                {
                  label: zh ? '当前处理' : 'Active Edit',
                  val:
                    this.mode === 'inpaint'
                      ? zh
                        ? '使用周围真实夜空像素擦除电线（非 AI 生成）'
                        : 'Wires healed using surrounding real sky pixels (non-generative)'
                      : zh
                        ? '未经修饰的原始拍摄底片'
                        : 'Untouched original camera photo',
                },
                {
                  label: zh ? '照片真实声明' : 'Truth Tag',
                  val: zh
                    ? '纯实拍画面 · 不含任何 AI 生成内容'
                    : 'Pure real capture · Zero AI-generated pixels',
                },
                {
                  label: zh ? '拍摄信息' : 'Camera Info',
                  val: zh ? '时间、地点、相机镜头信息完整留存' : 'Date, location, camera & lens preserved intact',
                },
              ]

      const headerTitle = zh ? '这张照片的真实性与信息档案' : 'Photo Honesty & Metadata Record'
      metaBox.innerHTML = `
        <div class="auth-rec-title">${headerTitle}</div>
        <dl class="auth-rec-list">
          ${rows
            .map(
              (r) => `
            <div class="auth-rec-row">
              <dt>${r.label}</dt>
              <dd>${r.val}</dd>
            </div>
          `,
            )
            .join('')}
        </dl>
      `
    }
  }
}
