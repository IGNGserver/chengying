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
          ? '等待同组先定好基调…'
          : 'Waiting for key frame…'
        : task.finalStatus === 'unchanged'
          ? this.lang === 'zh'
            ? '保留原片直出'
            : 'Kept Untouched'
          : this.lang === 'zh'
            ? `已完成精修 · ${task.revisionsCount} 步微调`
            : `Graded Cleanly · ${task.revisionsCount} steps`

      return `
        <button
          type="button"
          class="agent-task-card ${isSelected ? 'is-selected' : ''} ${doneInSim ? 'is-done' : 'is-queued'} status-${task.finalStatus}"
          data-agent-task="${task.taskId}"
        >
          <div class="agent-card-top">
            <span class="agent-sub-id">${tText(task.engineLabel, this.lang)}</span>
            ${
              task.isSceneAnchor
                ? `<span class="agent-anchor-pill">${tText(task.roleBadge, this.lang)}</span>`
                : `<span class="agent-engine-pill">${tText(task.roleBadge, this.lang)}</span>`
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
              <span>${statusText}</span>
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

    const labels =
      this.lang === 'zh'
        ? {
            kicker: '单张修图笔记',
            safePill: '仅调配方 · 原片完好不动',
            light: '当时光线',
            goal: '修图打算',
            local: '局部小照顾',
            outcome: '交片状态',
          }
        : {
            kicker: 'Developing Notes',
            safePill: 'Recipe Only · Originals Safe',
            light: 'Scene Light',
            goal: 'Retouch Goal',
            local: 'Local Touch',
            outcome: 'Final Result',
          }

    host.innerHTML = `
      <div class="agent-insp-header">
        <div class="agent-insp-preview">
          <img src="${task.masterSrc}" alt="${tText(task.title, this.lang)}" loading="lazy" decoding="async" />
          <div class="agent-insp-badges">
            <span>${task.fileName}</span>
            <span>${tText(task.engineLabel, this.lang)}</span>
          </div>
        </div>
        <div class="agent-insp-diag">
          <div class="insp-kicker">
            <span>${labels.kicker} · ${tText(task.roleBadge, this.lang)}</span>
            <span class="sandbox-lock">${labels.safePill}</span>
          </div>
          <h3>#${task.shotCode} · ${tText(task.title, this.lang)}</h3>
          <div class="diag-kv-grid">
            <div><label>${labels.light}</label><span>${tText(task.photoSummary.lightFeel, this.lang)}</span></div>
            <div><label>${labels.goal}</label><span>${tText(task.photoSummary.focusGoal, this.lang)}</span></div>
            <div><label>${labels.local}</label><span>${tText(task.photoSummary.localTouch, this.lang)}</span></div>
            <div><label>${labels.outcome}</label><span>${tText(task.photoSummary.outcomeNote, this.lang)}</span></div>
          </div>
        </div>
      </div>

      <ol class="agent-step-timeline">
        ${visibleSteps
          .map(
            (st) => `
          <li class="agent-step-item badge-${st.badge}">
            <div class="step-pass-col">
              <span class="step-pass">${tText(st.stepLabel, this.lang)}</span>
              <strong class="step-tool">${tText(st.actionTag, this.lang)}</strong>
            </div>
            <div class="step-body-col">
              <p>${tText(st.detail, this.lang)}</p>
              <small class="step-mono-out">${tText(st.note, this.lang)}</small>
            </div>
          </li>
        `,
          )
          .join('')}
      </ol>
    `
  }
}
