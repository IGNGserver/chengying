/**
 * Chengying task manager: workspace overview, photo scores and grouping,
 * selection review and manual adjustment, retouch tasks with before/after
 * comparison and agent execution logs, exports with metadata verification,
 * generative-edit authorizations and model usage.
 */
import * as React from 'react'
import { api, imageUrl, renderUrl, type Activity, type EventInfo, type RevisionInfo, type SelectionInfo, type ShotRow, type Summary, type TaskInfo } from './api.ts'
import { STYLES } from './styles.ts'

const { useCallback, useEffect, useMemo, useRef, useState } = React

type Tab = 'overview' | 'photos' | 'selection' | 'tasks' | 'exports' | 'logs'
type Lang = 'zh' | 'en'

const T: Record<Lang, Record<string, string>> = {
  zh: {
    overview: '概览', photos: '照片', selection: '选片', tasks: '修图任务', exports: '导出', logs: '日志与用量',
    open: '打开', workspacePath: '照片文件夹路径', noProject: '还没有打开的工作区。输入照片文件夹路径，或在对话中让 Agent 打开。',
    shots: '张照片', raw: 'RAW', pairs: 'RAW+JPEG', analyzed: '已分析', judged: '视觉评审', selections: '选片方案', exports_: '已导出',
    running: '进行中', none: '无', refresh: '刷新', quickSelect: '用自然语言选片，例如「选30张最好的，按行程讲故事」', select: '选片',
    included: '入选', excluded: '已移除', remove: '移除', restore: '恢复', lock: '锁定', unlock: '解锁', add: '加入当前选片',
    pick: '必选', reject: '排除', clear: '清除标记', reason: '理由', sort: '排序', filterIssue: '问题筛选', all: '全部',
    technical: '技术', aesthetic: '美学', composition: '构图', content: '内容', story: '叙事', potential: '潜力',
    status: '状态', engine: '引擎', attempts: '尝试', pause: '暂停', resume: '恢复', retry: '重试', cancel: '取消',
    revisions: '修订历史', before: '原图', after: '修图后', compare: '对比', steps: '操作步骤', events: '执行记录', usage: '模型用量',
    tokensIn: '输入 tokens', tokensOut: '输出 tokens', calls: '调用', images: '图片', verified: '元数据已验证', notVerified: '元数据未通过',
    authorizations: '生成式修改授权', grant: '授权生成式修改', grantScope: '本工作区 24 小时内最多 10 次', grantConfirm: '允许 AI 对本工作区的照片做生成式修改（会产生非拍摄所得的像素，导出时会标注）？', revoke: '撤销', authNote: '生成式修改会改变照片真实性，只在你明确授权后执行。',
    groups: '分组', duplicates: '近似重复组', scenes: '场景', segments: '行程段落', detail: '详情', close: '关闭', error: '错误',
    runCull: '自动筛图（扫描·预览·评分·分组）', rerunCull: '强制重算', lang: 'EN', emptyTasks: '暂无修图任务。在对话中让 Agent 对选片创建修图任务（edit_tasks_create）。', emptyExports: '暂无导出。',
  },
  en: {
    overview: 'Overview', photos: 'Photos', selection: 'Selection', tasks: 'Retouch tasks', exports: 'Exports', logs: 'Logs & usage',
    open: 'Open', workspacePath: 'Photo folder path', noProject: 'No workspace open. Enter a folder path, or ask the agent to open one.',
    shots: 'shots', raw: 'RAW', pairs: 'RAW+JPEG', analyzed: 'analyzed', judged: 'vision reviewed', selections: 'selections', exports_: 'exported',
    running: 'Running', none: 'None', refresh: 'Refresh', quickSelect: 'Select in natural language, e.g. "pick the best 30, tell the trip story"', select: 'Select',
    included: 'Included', excluded: 'Removed', remove: 'Remove', restore: 'Restore', lock: 'Lock', unlock: 'Unlock', add: 'Add to selection',
    pick: 'Pick', reject: 'Reject', clear: 'Clear', reason: 'Reason', sort: 'Sort', filterIssue: 'Issue', all: 'All',
    technical: 'Technical', aesthetic: 'Aesthetic', composition: 'Composition', content: 'Content', story: 'Story', potential: 'Potential',
    status: 'Status', engine: 'Engine', attempts: 'Attempts', pause: 'Pause', resume: 'Resume', retry: 'Retry', cancel: 'Cancel',
    revisions: 'Revisions', before: 'Original', after: 'Edited', compare: 'Compare', steps: 'Steps', events: 'Execution log', usage: 'Model usage',
    tokensIn: 'Input tokens', tokensOut: 'Output tokens', calls: 'Calls', images: 'Images', verified: 'Metadata verified', notVerified: 'Metadata check failed',
    authorizations: 'Generative-edit authorizations', grant: 'Authorize generative edits', grantScope: 'this workspace, 24 h, up to 10 edits', grantConfirm: 'Allow AI to make generative edits to photos of this workspace (pixels not captured by the camera; exports are labelled)?', revoke: 'Revoke', authNote: 'Generative edits change photo authenticity and run only with your explicit authorization.',
    groups: 'Groups', duplicates: 'Near-duplicate groups', scenes: 'Scenes', segments: 'Trip segments', detail: 'Detail', close: 'Close', error: 'Error',
    runCull: 'Run culling (scan · previews · scores · groups)', rerunCull: 'Recompute', lang: '中', emptyTasks: 'No retouch tasks yet. Ask the agent to create them for a selection (edit_tasks_create).', emptyExports: 'No exports yet.',
  },
}

function usePoll<V>(fn: () => Promise<V>, deps: unknown[], intervalMs = 4000): { data: V | undefined; error: string | undefined; reload: () => void } {
  const [data, setData] = useState<V>()
  const [error, setError] = useState<string>()
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let alive = true
    const run = (): void => {
      fn().then(v => { if (alive) { setData(v); setError(undefined) } }, (e: Error) => { if (alive) setError(e.message) })
    }
    run()
    const t = setInterval(() => { if (document.visibilityState === 'visible') run() }, intervalMs)
    return () => { alive = false; clearInterval(t) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick])
  return { data, error, reload: useCallback(() => setTick(x => x + 1), []) }
}

const fmt = (v: number | undefined): string => (v === undefined || v === null ? '–' : String(Math.round(v)))
const scoreClass = (v: number | undefined): string => (v === undefined ? 'cy-score' : v >= 75 ? 'cy-score cy-good' : v >= 55 ? 'cy-score cy-mid' : 'cy-score cy-low')

function Bar({ done, total }: { done: number; total: number }): React.ReactElement {
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0
  return <div className="cy-bar"><div className="cy-bar-fill" style={{ width: `${pct}%` }} /></div>
}

function Scores({ s, t }: { s: ShotRow['scores']; t: Record<string, string> }): React.ReactElement {
  return (
    <div className="cy-scores">
      {(['technical', 'aesthetic', 'content'] as const).map(k => <span key={k} className={scoreClass(s[k])} title={t[k]}>{(t[k] ?? k).slice(0, 2)} {fmt(s[k])}</span>)}
    </div>
  )
}

export function App(): React.ReactElement {
  const [lang, setLang] = useState<Lang>(() => (navigator.language.startsWith('zh') ? 'zh' : 'en'))
  const t = T[lang]
  const [tab, setTab] = useState<Tab>('overview')
  const [project, setProject] = useState<string>()
  const [path, setPath] = useState('')
  const [msg, setMsg] = useState<string>()
  const projects = usePoll(() => api<{ projects: Summary[]; recent: Array<{ id: string; root: string }> }>('/projects'), [], 5000)
  const activities = usePoll(() => api<{ activities: Activity[] }>('/activities'), [], 2500)
  useEffect(() => {
    if (project === undefined && projects.data?.projects[0] !== undefined) setProject(projects.data.projects[0].projectId)
  }, [projects.data, project])
  const current = projects.data?.projects.find(p => p.projectId === project)

  const open = async (target = path): Promise<void> => {
    try {
      const s = await api<Summary>('/projects/open', { method: 'POST', body: { path: target } })
      setProject(s.projectId)
      projects.reload()
      setMsg(undefined)
    } catch (e) { setMsg((e as Error).message) }
  }

  const running = (activities.data?.activities ?? []).filter(a => a.state === 'running' && (project === undefined || a.projectId === project))

  return (
    <div className="cy-root">
      <style>{STYLES}</style>
      <div className="cy-header">
        <div className="cy-title">澄影 <span className="cy-sub">Chengying</span></div>
        <select className="cy-select" value={project ?? ''} onChange={e => {
          const v = e.target.value
          const recent = projects.data?.recent.find(r => `recent:${r.id}` === v)
          if (recent !== undefined) void open(recent.root)
          else setProject(v || undefined)
        }}>
          {(projects.data?.projects ?? []).map(p => <option key={p.projectId} value={p.projectId}>{p.root.split(/[\\/]/).slice(-2).join('/')}</option>)}
          {(projects.data?.recent ?? []).map(r => <option key={r.id} value={`recent:${r.id}`}>↺ {r.root.split(/[\\/]/).slice(-2).join('/')}</option>)}
        </select>
        <button className="cy-btn cy-ghost" onClick={() => setLang(lang === 'zh' ? 'en' : 'zh')}>{t.lang}</button>
      </div>
      <div className="cy-openrow">
        <input className="cy-input" placeholder={t.workspacePath} value={path} onChange={e => setPath(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void open() }} />
        <button className="cy-btn" disabled={path.trim() === ''} onClick={() => void open()}>{t.open}</button>
      </div>
      {msg !== undefined && <div className="cy-error">{msg}</div>}
      {running.length > 0 && (
        <div className="cy-activities">
          {running.map(a => (
            <div key={a.id} className="cy-activity">
              <div className="cy-row"><span>{a.label}</span><span className="cy-muted">{a.stage} {a.done}/{a.total}</span>
                <button className="cy-link" onClick={() => void api(`/activities/${a.id}/cancel`, { method: 'POST' })}>{t.cancel}</button></div>
              <Bar done={a.done} total={a.total} />
            </div>
          ))}
        </div>
      )}
      <div className="cy-tabs">
        {(['overview', 'photos', 'selection', 'tasks', 'exports', 'logs'] as Tab[]).map(k => (
          <button key={k} className={`cy-tab${tab === k ? ' cy-active' : ''}`} onClick={() => setTab(k)}>{t[k]}</button>
        ))}
      </div>
      <div className="cy-body">
        {current === undefined ? <div className="cy-empty">{t.noProject}</div>
          : tab === 'overview' ? <Overview s={current} t={t} activities={(activities.data?.activities ?? []).filter(a => a.projectId === current.projectId)} />
          : tab === 'photos' ? <Photos pid={current.projectId} t={t} />
          : tab === 'selection' ? <Selection pid={current.projectId} t={t} />
          : tab === 'tasks' ? <Tasks pid={current.projectId} t={t} />
          : tab === 'exports' ? <Exports pid={current.projectId} t={t} />
          : <Logs pid={current.projectId} s={current} t={t} />}
      </div>
    </div>
  )
}

function Overview({ s, t, activities }: { s: Summary; t: Record<string, string>; activities: Activity[] }): React.ReactElement {
  const [err, setErr] = useState<string>()
  const cull = async (force: boolean): Promise<void> => {
    try { setErr(undefined); await api(`/p/${s.projectId}/cull`, { method: 'POST', body: { force } }) } catch (e) { setErr((e as Error).message) }
  }
  const stat = (label: string, v: number | string): React.ReactElement => <div className="cy-stat"><div className="cy-stat-v">{v}</div><div className="cy-muted">{label}</div></div>
  const tasks = Object.entries(s.tasks)
  return (
    <div>
      <div className="cy-path" title={s.root}>{s.root}</div>
      <div className="cy-actions">
        <button className="cy-btn" onClick={() => void cull(false)}>{t.runCull}</button>
        <button className="cy-btn cy-ghost" onClick={() => void cull(true)}>{t.rerunCull}</button>
      </div>
      {err !== undefined && <div className="cy-error">{err}</div>}
      <div className="cy-stats">
        {stat(t.shots ?? '', s.shots)}{stat(t.raw ?? '', s.raw)}{stat(t.pairs ?? '', s.pairs)}{stat(t.analyzed ?? '', s.analyzed)}
        {stat(t.judged ?? '', s.judged)}{stat(t.selections ?? '', s.selections)}{stat(t.exports_ ?? '', s.exports)}
      </div>
      <h4>{t.groups}</h4>
      <div className="cy-stats">
        {stat(t.duplicates ?? '', s.groups.near ?? 0)}{stat(t.scenes ?? '', s.groups.scene ?? 0)}{stat(t.segments ?? '', s.groups.segment ?? 0)}
      </div>
      <h4>{t.tasks}</h4>
      {tasks.length === 0 ? <div className="cy-muted">{t.none}</div> : <div className="cy-chips">{tasks.map(([k, v]) => <span key={k} className={`cy-chip cy-st-${k}`}>{k} {v}</span>)}</div>}
      <h4>{t.events}</h4>
      {activities.slice(-6).reverse().map(a => (
        <div key={a.id} className="cy-row cy-small"><span className={`cy-dot cy-st-${a.state}`} />{a.label}<span className="cy-muted">{a.state}{a.error ? ` · ${a.error}` : ''}</span></div>
      ))}
    </div>
  )
}

function ShotDetail({ pid, shot, t, onClose, selection }: { pid: string; shot: string; t: Record<string, string>; onClose: () => void; selection?: string }): React.ReactElement {
  const d = usePoll(() => api<ShotRow & { scoresBySource: Record<string, Record<string, unknown>>; groups: Array<{ id: string; kind: string; label: string; size: number }>; detail?: { reasons?: Record<string, string> } }>(`/p/${pid}/shot/${shot}`), [pid, shot], 15000)
  const flag = async (f: 'pick' | 'reject' | null): Promise<void> => { await api(`/p/${pid}/flag`, { method: 'POST', body: { shots: [shot], flag: f } }); d.reload() }
  const add = async (): Promise<void> => { if (selection) await api(`/p/${pid}/selection/${selection}/adjust`, { method: 'POST', body: { add: [shot] } }) }
  const x = d.data
  return (
    <div className="cy-drawer">
      <div className="cy-row"><b>{shot}</b><button className="cy-link" onClick={onClose}>{t.close}</button></div>
      <img className="cy-preview" src={imageUrl(pid, shot, 'preview')} alt={shot} />
      {x !== undefined && <>
        <div className="cy-small cy-muted">{x.time?.replace('T', ' ')} · {x.camera} {x.raw ? '· RAW' : ''}</div>
        {x.caption && <div className="cy-small">{x.caption}</div>}
        <table className="cy-table"><tbody>
          {(['technical', 'aesthetic', 'composition', 'content', 'story', 'potential'] as const).map(k => <tr key={k}><td>{t[k]}</td><td className={scoreClass(x.scores[k])}>{fmt(x.scores[k])}</td></tr>)}
        </tbody></table>
        {x.issues.length > 0 && <div className="cy-chips">{x.issues.map(i => <span key={i} className="cy-chip cy-warn">{i}</span>)}</div>}
        {x.tags.length > 0 && <div className="cy-chips">{x.tags.map(i => <span key={i} className="cy-chip">{i}</span>)}</div>}
        {x.detail?.reasons && <div className="cy-small cy-muted">{Object.values(x.detail.reasons).join(' · ')}</div>}
        <div className="cy-small cy-muted">{x.groups.map(g => g.label).join(' · ')}</div>
        <div className="cy-actions">
          <button className="cy-btn" onClick={() => void flag('pick')}>{t.pick}</button>
          <button className="cy-btn" onClick={() => void flag('reject')}>{t.reject}</button>
          <button className="cy-btn cy-ghost" onClick={() => void flag(null)}>{t.clear}</button>
          {selection && <button className="cy-btn" onClick={() => void add()}>{t.add}</button>}
        </div>
      </>}
    </div>
  )
}

function Photos({ pid, t }: { pid: string; t: Record<string, string> }): React.ReactElement {
  const [sort, setSort] = useState('time')
  const [issue, setIssue] = useState('')
  const [detail, setDetail] = useState<string>()
  const [limit, setLimit] = useState(120)
  const sels = usePoll(() => api<{ selections: SelectionInfo[] }>(`/p/${pid}/selections`), [pid], 10000)
  const rows = usePoll(() => api<{ total: number; shots: ShotRow[] }>(`/p/${pid}/shots?sort=${sort}&limit=${limit}${issue ? `&issue=${issue}` : ''}`), [pid, sort, issue, limit], 8000)
  const latest = sels.data?.selections[0]?.id
  return (
    <div>
      <div className="cy-toolbar">
        <label>{t.sort} <select className="cy-select" value={sort} onChange={e => setSort(e.target.value)}>
          {['time', 'technical', 'aesthetic', 'content', 'potential'].map(k => <option key={k} value={k}>{t[k] ?? k}</option>)}
        </select></label>
        <label>{t.filterIssue} <select className="cy-select" value={issue} onChange={e => setIssue(e.target.value)}>
          <option value="">{t.all}</option>
          {['out-of-focus', 'motion-blur', 'highlight-clipping', 'underexposed', 'overexposed', 'noisy', 'tilted-horizon', 'color-cast', 'flat'].map(i => <option key={i} value={i}>{i}</option>)}
        </select></label>
        <span className="cy-muted">{rows.data?.total ?? 0}</span>
      </div>
      <div className="cy-grid">
        {(rows.data?.shots ?? []).map(s => (
          <div key={s.id} className={`cy-cell${s.flag === 'reject' ? ' cy-rejected' : ''}${s.flag === 'pick' ? ' cy-picked' : ''}`} onClick={() => setDetail(s.id)}>
            <img loading="lazy" src={imageUrl(pid, s.id, 'thumb')} alt={s.id} />
            <Scores s={s.scores} t={t} />
            {s.issues.length > 0 && <div className="cy-issue" title={s.issues.join(', ')}>⚠ {s.issues[0]}</div>}
          </div>
        ))}
      </div>
      {(rows.data?.total ?? 0) > limit && <button className="cy-btn cy-ghost" onClick={() => setLimit(limit + 120)}>+120</button>}
      {detail !== undefined && <ShotDetail pid={pid} shot={detail} t={t} selection={latest} onClose={() => setDetail(undefined)} />}
    </div>
  )
}

function Selection({ pid, t }: { pid: string; t: Record<string, string> }): React.ReactElement {
  const sels = usePoll(() => api<{ selections: SelectionInfo[] }>(`/p/${pid}/selections`), [pid], 6000)
  const [sel, setSel] = useState<string>()
  const [request, setRequest] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string>()
  const active = sel ?? sels.data?.selections[0]?.id
  const rows = usePoll(() => active === undefined ? Promise.resolve({ total: 0, shots: [] as ShotRow[] }) : api<{ total: number; shots: ShotRow[] }>(`/p/${pid}/shots?selection=${active}&only=all&limit=500&sort=time`), [pid, active], 6000)
  const [detail, setDetail] = useState<string>()
  const items = (rows.data?.shots ?? []).filter(s => s.selection !== undefined).sort((a, b) => Number(b.selection?.included) - Number(a.selection?.included) || (a.selection?.rank ?? 0) - (b.selection?.rank ?? 0))
  const adjust = async (body: Record<string, string[]>): Promise<void> => {
    if (active === undefined) return
    await api(`/p/${pid}/selection/${active}/adjust`, { method: 'POST', body })
    rows.reload()
  }
  const run = async (): Promise<void> => {
    setBusy(true); setErr(undefined)
    try {
      const r = await api<{ selectionId: string }>(`/p/${pid}/select`, { method: 'POST', body: { request, base: active } })
      setSel(r.selectionId); sels.reload()
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }
  const cur = sels.data?.selections.find(s => s.id === active)
  return (
    <div>
      <div className="cy-openrow">
        <input className="cy-input" placeholder={t.quickSelect} value={request} onChange={e => setRequest(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && request.trim()) void run() }} />
        <button className="cy-btn" disabled={busy || request.trim() === ''} onClick={() => void run()}>{t.select}</button>
      </div>
      {err && <div className="cy-error">{err}</div>}
      <div className="cy-toolbar">
        <select className="cy-select" value={active ?? ''} onChange={e => setSel(e.target.value)}>
          {(sels.data?.selections ?? []).map(s => <option key={s.id} value={s.id}>{s.name} · {s.count}</option>)}
        </select>
        {cur && <span className="cy-muted cy-small">{String(cur.stats.mode ?? '')} · {String(cur.stats.selected ?? '')}/{String(cur.stats.totalShots ?? '')} · ⌀{String(cur.stats.meanScore ?? '')} · {String(cur.stats.segmentsCovered ?? '')}/{String(cur.stats.segmentsTotal ?? '')} {t.segments}</span>}
      </div>
      <div className="cy-list">
        {items.map(s => (
          <div key={s.id} className={`cy-item${s.selection?.included ? '' : ' cy-dim'}`}>
            <img src={imageUrl(pid, s.id, 'thumb')} alt={s.id} onClick={() => setDetail(s.id)} />
            <div className="cy-item-body">
              <div className="cy-row"><b>#{s.selection?.rank}</b><Scores s={s.scores} t={t} />{s.selection?.locked && <span className="cy-chip">🔒</span>}{s.selection?.source === 'user' && <span className="cy-chip">user</span>}</div>
              <div className="cy-small cy-muted">{s.selection?.reason}</div>
              <div className="cy-actions">
                {s.selection?.included
                  ? <button className="cy-btn cy-ghost" onClick={() => void adjust({ remove: [s.id] })}>{t.remove}</button>
                  : <button className="cy-btn cy-ghost" onClick={() => void adjust({ add: [s.id] })}>{t.restore}</button>}
                {s.selection?.locked
                  ? <button className="cy-btn cy-ghost" onClick={() => void adjust({ unlock: [s.id] })}>{t.unlock}</button>
                  : <button className="cy-btn cy-ghost" onClick={() => void adjust({ lock: [s.id] })}>{t.lock}</button>}
              </div>
            </div>
          </div>
        ))}
      </div>
      {detail !== undefined && <ShotDetail pid={pid} shot={detail} t={t} selection={active} onClose={() => setDetail(undefined)} />}
    </div>
  )
}

function Compare({ before, after }: { before: string; after: string }): React.ReactElement {
  const [pos, setPos] = useState(50)
  const ref = useRef<HTMLDivElement>(null)
  const move = (clientX: number): void => {
    const r = ref.current?.getBoundingClientRect()
    if (r) setPos(Math.max(0, Math.min(100, ((clientX - r.left) / r.width) * 100)))
  }
  return (
    <div className="cy-compare" ref={ref} onMouseMove={e => { if (e.buttons === 1) move(e.clientX) }} onClick={e => move(e.clientX)}
      onTouchMove={e => { const tt = e.touches[0]; if (tt) move(tt.clientX) }}>
      <img className="cy-compare-after" src={after} alt="after" />
      <img className="cy-compare-before" src={before} alt="before" style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }} />
      <div className="cy-compare-handle" style={{ left: `${pos}%` }} />
    </div>
  )
}

function Tasks({ pid, t }: { pid: string; t: Record<string, string> }): React.ReactElement {
  const [status, setStatus] = useState('')
  const list = usePoll(() => api<{ tasks: TaskInfo[] }>(`/p/${pid}/tasks${status ? `?status=${status}` : ''}`).catch(() => ({ tasks: [] as TaskInfo[] })), [pid, status], 3000)
  const [open, setOpen] = useState<string>()
  const tasks = list.data?.tasks ?? []
  const counts = useMemo(() => tasks.reduce<Record<string, number>>((a, x) => { a[x.status] = (a[x.status] ?? 0) + 1; return a }, {}), [tasks])
  const control = async (id: string, action: string): Promise<void> => { await api(`/p/${pid}/task/${id}/control`, { method: 'POST', body: { action } }); list.reload() }
  if (tasks.length === 0 && status === '') return <div className="cy-empty">{t.emptyTasks}</div>
  return (
    <div>
      <div className="cy-toolbar">
        <select className="cy-select" value={status} onChange={e => setStatus(e.target.value)}>
          <option value="">{t.all}</option>
          {['queued', 'running', 'paused', 'failed', 'succeeded', 'cancelled', 'waiting-authorization'].map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <div className="cy-chips">{Object.entries(counts).map(([k, v]) => <span key={k} className={`cy-chip cy-st-${k}`}>{k} {v}</span>)}</div>
      </div>
      <div className="cy-list">
        {tasks.map(x => (
          <div key={x.id} className="cy-item">
            <img src={imageUrl(pid, x.shotId, 'thumb')} alt={x.shotId} onClick={() => setOpen(x.id)} />
            <div className="cy-item-body">
              <div className="cy-row"><span className={`cy-dot cy-st-${x.status}`} /><b>{x.status}</b><span className="cy-muted cy-small">{x.engine ?? ''} · {t.attempts} {x.attempts}/{x.maxAttempts} · {x.usage.inputTokens + x.usage.outputTokens} tok</span></div>
              <div className="cy-small cy-muted cy-ellipsis">{x.instructions}</div>
              {x.error && <div className="cy-error cy-small">{x.error}</div>}
              <div className="cy-actions">
                <button className="cy-btn cy-ghost" onClick={() => setOpen(x.id)}>{t.detail}</button>
                {(x.status === 'queued' || x.status === 'running') && <button className="cy-btn cy-ghost" onClick={() => void control(x.id, 'pause')}>{t.pause}</button>}
                {x.status === 'paused' && <button className="cy-btn cy-ghost" onClick={() => void control(x.id, 'resume')}>{t.resume}</button>}
                {(x.status === 'failed' || x.status === 'cancelled') && <button className="cy-btn cy-ghost" onClick={() => void control(x.id, 'retry')}>{t.retry}</button>}
                {x.status !== 'succeeded' && x.status !== 'cancelled' && <button className="cy-btn cy-ghost" onClick={() => void control(x.id, 'cancel')}>{t.cancel}</button>}
              </div>
            </div>
          </div>
        ))}
      </div>
      {open !== undefined && <TaskDetail pid={pid} id={open} t={t} onClose={() => setOpen(undefined)} />}
    </div>
  )
}

function TaskDetail({ pid, id, t, onClose }: { pid: string; id: string; t: Record<string, string>; onClose: () => void }): React.ReactElement {
  const d = usePoll(() => api<{ task: TaskInfo; revisions: RevisionInfo[]; events: EventInfo[] }>(`/p/${pid}/task/${id}`), [pid, id], 3000)
  const [rev, setRev] = useState<string>()
  const task = d.data?.task
  const revs = d.data?.revisions ?? []
  const shown = revs.find(r => r.id === (rev ?? task?.headRevision)) ?? revs[revs.length - 1]
  return (
    <div className="cy-drawer cy-wide">
      <div className="cy-row"><b>{task?.shotId}</b><span className="cy-muted">{task?.status}</span><button className="cy-link" onClick={onClose}>{t.close}</button></div>
      {task !== undefined && shown !== undefined && (shown.previewPath !== null || shown.doc.stages.some(st => st.steps.length > 0))
        ? <Compare before={imageUrl(pid, task.shotId, 'preview')} after={renderUrl(pid, shown.id)} />
        : task !== undefined && <img className="cy-preview" src={imageUrl(pid, task.shotId, 'preview')} alt="" />}
      <h4>{t.revisions}</h4>
      <div className="cy-revs">
        {revs.map(r => (
          <button key={r.id} className={`cy-rev${shown?.id === r.id ? ' cy-active' : ''}`} onClick={() => setRev(r.id)} title={r.message}>
            #{r.seq} {r.message.slice(0, 40)}{r.doc.provenance?.generative ? ' ✦' : ''}
          </button>
        ))}
      </div>
      {shown !== undefined && <>
        <h4>{t.steps}</h4>
        {shown.doc.stages.map((st, i) => (
          <div key={i} className="cy-small">
            <b>{st.engine}</b>
            <ol className="cy-steps">{st.steps.map(s => <li key={s.id} className={s.enabled ? '' : 'cy-dim'}><code>{s.op}</code>{s.mask ? ' 🎭' : ''} <span className="cy-muted">{JSON.stringify(s.params).slice(0, 160)}</span></li>)}</ol>
          </div>
        ))}
      </>}
      <h4>{t.events}</h4>
      <div className="cy-log">
        {(d.data?.events ?? []).slice(-120).map(e => <div key={e.id} className={`cy-log-${e.level}`}><span className="cy-muted">{e.ts.slice(11, 19)}</span> [{e.type}] {e.message}</div>)}
      </div>
    </div>
  )
}

function Exports({ pid, t }: { pid: string; t: Record<string, string> }): React.ReactElement {
  const ex = usePoll(() => api<{ exports: Array<{ id: string; shotId: string; path: string; format: string; verified: boolean; verify: { mismatched?: unknown[]; missing?: string[] } | null; recipePath: string | null; createdAt: string }> }>(`/p/${pid}/exports`), [pid], 6000)
  const auth = usePoll(() => api<{ authorizations: Array<{ id: string; scope: string; shotId: string | null; note: string; createdAt: string; revoked: boolean; uses: number; maxUses: number | null }> }>(`/p/${pid}/authorizations`).catch(() => ({ authorizations: [] })), [pid], 8000)
  const list = ex.data?.exports ?? []
  return (
    <div>
      {list.length === 0 ? <div className="cy-empty">{t.emptyExports}</div> : (
        <div className="cy-list">
          {list.map(e => (
            <div key={e.id} className="cy-item">
              <img src={imageUrl(pid, e.shotId, 'thumb')} alt="" />
              <div className="cy-item-body">
                <div className="cy-small cy-ellipsis" title={e.path}>{e.path}</div>
                <div className={e.verified ? 'cy-ok cy-small' : 'cy-error cy-small'}>{e.verified ? t.verified : `${t.notVerified}: ${JSON.stringify(e.verify?.mismatched ?? e.verify?.missing ?? '')}`}</div>
                {e.recipePath && <div className="cy-small cy-muted cy-ellipsis" title={e.recipePath}>{e.recipePath}</div>}
              </div>
            </div>
          ))}
        </div>
      )}
      <h4>{t.authorizations}</h4>
      <div className="cy-small cy-muted">{t.authNote}</div>
      <div className="cy-row cy-small">
        <button className="cy-btn" onClick={() => {
          if (!window.confirm(t.grantConfirm)) return
          void api(`/p/${pid}/authorizations`, { method: 'POST', body: { hours: 24, maxUses: 10, note: 'web panel' } }).then(() => auth.reload())
        }}>{t.grant}</button>
        <span className="cy-muted">{t.grantScope}</span>
      </div>
      {(auth.data?.authorizations ?? []).map(a => (
        <div key={a.id} className={`cy-row cy-small${a.revoked ? ' cy-dim' : ''}`}>
          <span>{a.scope}</span><span className="cy-muted">{a.shotId ?? '*'} · {a.note} · {a.uses}/{a.maxUses ?? '∞'}</span>
          {!a.revoked && <button className="cy-link" onClick={() => void api(`/p/${pid}/authorizations/${a.id}/revoke`, { method: 'POST' }).then(() => auth.reload())}>{t.revoke}</button>}
        </div>
      ))}
    </div>
  )
}

function Logs({ pid, s, t }: { pid: string; s: Summary; t: Record<string, string> }): React.ReactElement {
  const ev = usePoll(() => api<{ events: EventInfo[] }>(`/p/${pid}/events?limit=300`), [pid], 4000)
  const totals = s.usage.reduce((a, u) => ({ calls: a.calls + u.calls, i: a.i + u.inputTokens, o: a.o + u.outputTokens, im: a.im + u.images }), { calls: 0, i: 0, o: 0, im: 0 })
  return (
    <div>
      <h4>{t.usage}</h4>
      <table className="cy-table">
        <thead><tr><th /><th>{t.calls}</th><th>{t.tokensIn}</th><th>{t.tokensOut}</th><th>{t.images}</th></tr></thead>
        <tbody>
          {s.usage.map((u, i) => <tr key={i}><td>{u.purpose} <span className="cy-muted">{u.model ?? ''}</span></td><td>{u.calls}</td><td>{u.inputTokens}</td><td>{u.outputTokens}</td><td>{u.images}</td></tr>)}
          <tr><td><b>Σ</b></td><td>{totals.calls}</td><td>{totals.i}</td><td>{totals.o}</td><td>{totals.im}</td></tr>
        </tbody>
      </table>
      <h4>{t.events}</h4>
      <div className="cy-log">
        {(ev.data?.events ?? []).slice().reverse().map(e => <div key={e.id} className={`cy-log-${e.level}`}><span className="cy-muted">{e.ts.slice(5, 19).replace('T', ' ')}</span> [{e.type}] {e.taskId ? `${e.taskId.slice(-6)} ` : ''}{e.message}</div>)}
      </div>
    </div>
  )
}
