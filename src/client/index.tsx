/**
 * Browser half of the Chengying bundle: a right-sidebar page ("澄影") reachable
 * from the sidebar guide, rendering the task manager. Registrations are effects
 * so plugin reload removes them.
 */
import * as React from 'react'
import { App } from './app.tsx'

const TAB_ID = 'chengying'
const KIND = 'chengying'

interface ClientCtx {
  effect(fn: () => () => void, label?: string): unknown
  slots: { inject(name: string, fn: () => () => void): () => void; register(opts: Record<string, unknown>, component: unknown): () => void }
  sidebarRightTabs?: { register(def: Record<string, unknown>): () => void }
  sidebarRight?: { openTab(kind: string, options?: Record<string, unknown>): void }
}

const zh = (): boolean => typeof navigator !== 'undefined' && navigator.language.startsWith('zh')

function Icon(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <rect x="3" y="6" width="18" height="13" rx="2.5" />
      <circle cx="12" cy="12.5" r="3.6" />
      <path d="M8 6l1.4-2h5.2L16 6" />
    </svg>
  )
}

function Body(): React.ReactElement {
  return <App />
}

export default {
  inject: ['slots', 'sidebarRightTabs'],
  apply(ctx: ClientCtx): void {
    const tabs = ctx.sidebarRightTabs ?? (ctx as unknown as { get(n: string): ClientCtx['sidebarRightTabs'] }).get?.('sidebarRightTabs')
    if (tabs !== undefined) {
      ctx.effect(() => tabs.register({
        id: TAB_ID,
        kind: KIND,
        priority: 'extension',
        keepMounted: true,
        title: () => (zh() ? '澄影' : 'Chengying'),
        guide: [{
          id: 'workspace',
          order: 40,
          title: () => (zh() ? '澄影 · 照片筛选与修图' : 'Chengying · cull & retouch'),
          description: () => (zh() ? '评分、选片、修图任务、前后对比与导出' : 'Scores, selections, retouch tasks, before/after, exports'),
          icon: Icon,
        }],
      }), 'chengying: sidebar tab type')
    }
    ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, Body)), 'chengying: sidebar tab body')
  },
}
