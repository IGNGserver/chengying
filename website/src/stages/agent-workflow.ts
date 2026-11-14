import { AGENT_WORKFLOW_TASKS } from '../data/expedition-catalog'
import { tText } from '../i18n/copy'
import type { Lang } from '../types'

export class AgentWorkflowController {
  private lang: Lang = 'zh'
  private activeTaskId = AGENT_WORKFLOW_TASKS[0].taskId
  private playbackStep = 4
  private timerId = 0

  public mount(lang: Lang): void {
    this.lang = lang
    this.renderTaskCards()
    this.renderActiveInspector()
    this.bindControls()
  }

  public setLanguage(lang: Lang): void {
    this.lang = lang
    this.renderTaskCards()
    this.renderActiveInspector()
  }

  private bindControls(): void {
    const playBtn = document.getElementById('agent-replay-btn')
    playBtn?.addEventListener('click', () => {
      this.startPlayback()
    })
  }

  private startPlayback(): void {
    if (this.timerId) clearInterval(this.timerId)
    this.playbackStep = 0
    const container = document.getElementById('agent-pipeline-stage')
    container?.classList.add('is-simulating')
    this.renderTaskCards()
    this.renderActiveInspector()

    this.timerId = window.setInterval(() => {
      this.playbackStep++
      this.renderTaskCards()
      this.renderActiveInspector()
      if (this.playbackStep >= 4) {
        clearInterval(this.timerId)
        this.timerId = 0
        container?.classList.remove('is-simulating')
      }
    }, 680)
  }

  private renderTaskCards(): void {
    const host = document.getElementById('agent-task-cards')
    if (!host) return

    host.innerHTML = AGENT_WORKFLOW_TASKS.map((task, idx) => {
      const isSelected = task.taskId === this.activeTaskId
      const doneInSim = this.playbackStep >= 4 || idx <= this.playbackStep
      const statusText = !doneInSim
        ? this.lang === 'zh'
          ? '等待锚点屏障…'
          : 'Waiting Scene Barrier…'
        : task.finalStatus === 'unchanged'
          ? this.lang === 'zh'
            ? 'UNCHANGED · 原片直出'
            : 'UNCHANGED · Direct'
          : this.lang === 'zh'
            ? `SUCCEEDED · Rev #${task.revisionsCount}`
            : `SUCCEEDED · Rev #${task.revisionsCount}`

      return `
        <button
          type="button"
          class="agent-task-card ${isSelected ? 'is-selected' : ''} ${doneInSim ? 'is-done' : 'is-queued'} status-${task.finalStatus}"
          data-agent-task="${task.taskId}"
        >
          <div class="agent-card-top">
            <span class="agent-sub-id">${task.subagentId}</span>
            ${
              task.isSceneAnchor
                ? `<span class="agent-anchor-pill">${this.lang === 'zh' ? '锚点优先' : 'ANCHOR'}</span>`
                : `<span class="agent-engine-pill">${task.engine}</span>`
            }
          </div>
          <div class="agent-card-media">
            <img src="${task.thumbSrc}" alt="${tText(task.title, this.lang)}" loading="lazy" decoding="async" />
            <span class="agent-frame-tag">#${task.shotCode}</span>
          </div>
          <div class="agent-card-info">
            <strong>${tText(task.title, this.lang)}</strong>
            <small>${tText(task.sceneCluster, this.lang)}</small>
            <div class="agent-status-line">
              <span class="status-dot"></span>
              <code>${statusText}</code>
            </div>
          </div>
        </button>
      `
    }).join('')

    host.querySelectorAll<HTMLButtonElement>('[data-agent-task]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.activeTaskId = btn.dataset.agentTask || AGENT_WORKFLOW_TASKS[0].taskId
        this.renderTaskCards()
        this.renderActiveInspector()
      })
    })
  }

  private renderActiveInspector(): void {
    const host = document.getElementById('agent-inspector-panel')
    if (!host) return

    const task =
      AGENT_WORKFLOW_TASKS.find((t) => t.taskId === this.activeTaskId) ?? AGENT_WORKFLOW_TASKS[0]
    const visibleSteps =
      this.playbackStep >= 4 ? task.steps : task.steps.slice(0, Math.max(1, this.playbackStep + 1))

    host.innerHTML = `
      <div class="agent-insp-header">
        <div class="agent-insp-preview">
          <img src="${task.masterSrc}" alt="${tText(task.title, this.lang)}" loading="lazy" decoding="async" />
          <div class="agent-insp-badges">
            <span>${task.fileName}</span>
            <span>${task.engine}</span>
            <span>Tokens: ${task.tokensUsed}</span>
          </div>
        </div>
        <div class="agent-insp-diag">
          <div class="insp-kicker">
            <code>EditOrchestrator · ${task.subagentId}</code>
            <span class="sandbox-lock">bash/fs: RESTRICTED</span>
          </div>
          <h3>#${task.shotCode} · ${tText(task.title, this.lang)}</h3>
          <div class="diag-kv-grid">
            <div><label>p05 / p50 / p95</label><code>${task.diagnostics.p05} / ${task.diagnostics.p50} / ${task.diagnostics.p95}</code></div>
            <div><label>shadowEv Ceiling</label><code>+${task.diagnostics.shadowEv.toFixed(1)} EV</code></div>
            <div><label>Color / Light</label><code>${task.diagnostics.castNote}</code></div>
            <div><label>Geometry & Mask</label><code>${task.diagnostics.maskNote}</code></div>
          </div>
        </div>
      </div>

      <ol class="agent-step-timeline">
        ${visibleSteps
          .map(
            (st) => `
          <li class="agent-step-item badge-${st.badge}">
            <div class="step-pass-col">
              <span class="step-pass">${st.pass}</span>
              <code class="step-tool">${st.tool}</code>
            </div>
            <div class="step-body-col">
              <p>${tText(st.detail, this.lang)}</p>
              <code class="step-mono-out">${st.mono}</code>
            </div>
          </li>
        `,
          )
          .join('')}
      </ol>
    `
  }
}
