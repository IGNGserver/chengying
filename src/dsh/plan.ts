/**
 * Per-session photo work plan. The preset's first tool records what the user
 * wants (cull only vs retouch + deliver, engine vs generative), where the
 * result goes, and whether there is a checkpoint after selection. Later tools
 * enforce the plan instead of relying on prompt obedience alone.
 */
import { newId, nowIso } from '../core/util/misc.ts'
import { resolveUserPath } from '../core/util/path.ts'
import type { Project } from '../core/project.ts'
import type { ToolRunContext } from './host-types.ts'

export type SessionGoal = 'cull' | 'retouch-deliver'
export type RetouchMode = 'none' | 'engine' | 'generative' | 'hybrid'
export type CullQuality = 'fast' | 'balanced' | 'thorough'
export type DeliverMode = 'originals' | 'rendered'
export type PlanStage = 'planned' | 'culled' | 'selected' | 'retouching' | 'retouched' | 'delivered'

export interface SessionPlan {
  id: string
  sessionId: string
  projectId: string
  source: string
  goal: SessionGoal
  retouch: RetouchMode
  cullQuality: CullQuality
  outputDir: string
  deliverMode: DeliverMode
  checkpoint: 'after-selection' | 'none'
  checkpointApproved?: boolean
  brief: string
  stage: PlanStage
  createdAt: string
  updatedAt: string
}

export interface PlanOptions {
  goal?: SessionGoal
  retouch?: RetouchMode
  cullQuality?: CullQuality
  outputDir?: string
  deliverMode?: DeliverMode
  checkpoint?: 'after-selection' | 'none'
  brief?: string
  cwd?: string
  existing?: SessionPlan
}

/** Session identity used as the plan key; children and one-shot runs still get a stable key. */
export function sessionIdOf(exec: ToolRunContext): string {
  return exec.agent?.session.id ?? exec.agent?.id ?? 'default'
}

export function planKey(sessionId: string): string {
  return `sessionPlan:${sessionId}`
}

/** Infer the rough goal from the user's own wording; the Agent can override it. */
export function inferGoal(text: string | undefined): SessionGoal | undefined {
  if (text === undefined || text.trim() === '') return undefined
  if (/(只|仅).{0,4}(筛|选)|只筛图|不要修|不修图|cull only|only cull/i.test(text)) return 'cull'
  if (/修图|后期|retouch|edit|交付|导出|deliver|export/i.test(text)) return 'retouch-deliver'
  if (/筛图|筛选|挑图|选片|选一下|cull/i.test(text)) return 'cull'
  return undefined
}

export function readPlan(project: Project, sessionId: string): SessionPlan | undefined {
  const raw = project.db.getMeta(planKey(sessionId))
  if (raw === undefined) return undefined
  try {
    const value = JSON.parse(raw) as unknown
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
    const plan = value as SessionPlan
    return typeof plan.id === 'string' && typeof plan.projectId === 'string' ? plan : undefined
  } catch {
    return undefined
  }
}

export function writePlan(project: Project, plan: SessionPlan): SessionPlan {
  project.db.setMeta(planKey(plan.sessionId), JSON.stringify(plan))
  return plan
}

export function defaultPlan(project: Project, sessionId: string, source: string, options: PlanOptions = {}): SessionPlan {
  const now = nowIso()
  const goal = options.goal ?? inferGoal(options.brief) ?? 'retouch-deliver'
  const retouch = goal === 'cull' ? 'none' : (options.retouch ?? 'engine')
  const changed = options.goal !== undefined && options.existing !== undefined && options.goal !== options.existing.goal
  const outputDir = resolveUserPath(options.outputDir ?? options.existing?.outputDir ?? project.exportDir, options.cwd)
  const plan: SessionPlan = {
    id: options.existing?.id ?? newId('plan'),
    sessionId,
    projectId: project.id,
    source,
    goal,
    retouch,
    cullQuality: options.cullQuality ?? options.existing?.cullQuality ?? 'balanced',
    outputDir,
    deliverMode: options.deliverMode ?? (changed ? undefined : options.existing?.deliverMode) ?? (goal === 'cull' ? 'originals' : 'rendered'),
    checkpoint: options.checkpoint ?? (changed ? undefined : options.existing?.checkpoint) ?? (goal === 'cull' ? 'none' : 'after-selection'),
    brief: options.brief ?? options.existing?.brief ?? '',
    stage: changed ? 'planned' : (options.existing?.stage ?? 'planned'),
    createdAt: options.existing?.createdAt ?? now,
    updatedAt: now,
  }
  return plan
}

/** Rebuild a plan from a partial update while preserving identity and timestamps. */
export function updatePlan(plan: SessionPlan, patch: Partial<Omit<SessionPlan, 'id' | 'sessionId' | 'projectId' | 'createdAt'>>): SessionPlan {
  return { ...plan, ...patch, updatedAt: nowIso() }
}
