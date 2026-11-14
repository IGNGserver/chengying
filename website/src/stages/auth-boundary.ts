import { UI_COPY } from '../i18n/copy'
import type { Lang } from '../types'

export type AuthMode = 'original' | 'inpaint' | 'generative'

export class AuthBoundaryController {
  private lang: Lang = 'zh'
  private mode: AuthMode = 'inpaint'
  private isAuthorized = false
  private authGrantId = 'auth_08f2c91a'

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
    const metaPre = document.getElementById('auth-meta-inspector')
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
            ? '确定性非生成式修补 (ai:inpaint · Telea 2004)：仅将灯柱上方周围真实夜空像素向内行进传播，无虚构内容，无需生成授权。'
            : 'Deterministic Non-Generative Healing (ai:inpaint · Telea 2004): Propagates surrounding real sky pixels to remove utility wires; invents zero content.'
      } else {
        bannerEl.textContent =
          this.lang === 'zh'
            ? '只读原片基线 (FsGuard + originals_baseline)：原始 ARW 文件受路径守卫硬保护，任何工具写入原片路径直接抛出 permission-denied。'
            : 'Read-Only Original Baseline (FsGuard + originals_baseline): Source ARW is write-locked; any attempt to overwrite throws permission-denied.'
      }
    }

    if (badgeEl) {
      if (showGenerativePixels) {
        badgeEl.className = 'auth-pill pill-gen'
        badgeEl.textContent = 'IPTC: compositeWithTrainedAlgorithmicMedia'
      } else {
        badgeEl.className = 'auth-pill pill-pure'
        badgeEl.textContent =
          this.lang === 'zh' ? '纪实摄影真实性完整 · NON-GENERATIVE' : 'DOCUMENTARY AUTHENTIC · NON-GENERATIVE'
      }
    }

    if (metaPre) {
      if (this.mode === 'generative' && !this.isAuthorized) {
        metaPre.textContent = `// EditService.applyOps & acquireGenerative (Fail-Closed v0.8.0)
ChengyingError: authorization-required
  shotId: "shot_29d" (DSC0604.ARW)
  attemptedOp: "ai:gen_layer" (kind: "replace", mask: "upper-sky")
  requireApproval: true
  GENERATIVE_FLOW_SYMBOL: Symbol(authorized-generative-flow) // private lock
  result: BLOCKED — Agent cannot self-grant generative authorizations.`
      } else if (showGenerativePixels) {
        metaPre.textContent = `{
  "deliverySchema": "chengying-delivery/1",
  "file": "DSC0604_rendered.jpg",
  "originalsIntact": true,
  "generative": true,
  "authorization": {
    "id": "${this.authGrantId}",
    "grantedBy": "user (DSH approval prompt)",
    "taskId": "task_29d",
    "maxUses": 1,
    "uses": 1
  },
  "generatedAssetReceipt": {
    "layerFormat": "16-bit PNG masked layer",
    "assetSha256": "e83c49b0...71d2 (verified before render)"
  },
  "xmpWritten": {
    "XMP-iptcExt:DigitalSourceType": "http://cv.iptc.org/newscodes/digitalsourcetype/compositeWithTrainedAlgorithmicMedia",
    "ExifVerifiedTags": "20/20 passed"
  }
}`
      } else {
        metaPre.textContent = `{
  "deliverySchema": "chengying-delivery/1",
  "file": "DSC0604_rendered.jpg",
  "originalsIntact": true,
  "generative": false,
  "stage": "${this.mode === 'inpaint' ? 'ai:inpaint (Telea surrounding-pixel heal)' : 'originals_baseline (read-only)'}",
  "authorizationRequired": false,
  "xmpWritten": {
    "CreatorTool": "Chengying 0.8.0 (DeepSeek Harness)",
    "DigitalSourceType": "(omitted — pure optical/non-generative)",
    "ExifVerifiedTags": "20/20 passed (DateTimeOriginal, SubSec, GPS, Lens)"
  }
}`
      }
    }
  }
}
