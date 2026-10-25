/** Phase 1 tools: workspace, culling pipeline, review and selection. */
import type { ChengyingRuntime } from '../runtime.ts'
import type { ToolDefinition, ToolRunContext } from '../host-types.ts'
import { arr, bool, defineTool, int, num, obj, str, strEnum, anyJson, type ToolImage } from '../tool.ts'
import { mergeDims } from '../../core/select/selector.ts'
import { parseSelectionRequest } from '../../core/select/nl.ts'
import { createModelScorer } from '../../core/analysis/models.ts'
import { ChengyingError } from '../../core/util/errors.ts'
import { round } from '../../core/util/misc.ts'
import type { Project } from '../../core/project.ts'
import type { ScoreSet, SelectionSpec, Shot } from '../../core/types.ts'

const projectArg = str('Project id or workspace path; defaults to the workspace opened most recently in this session.')

export function shotRow(project: Project, s: Shot, detail = false): Record<string, unknown> {
  const scores = project.repo.scores(s.id)
  const d = mergeDims(scores)
  const files = detail ? project.repo.filesOfShot(s.id).map(f => ({ path: f.relPath, kind: f.kind, format: f.format, size: f.size })) : undefined
  const caption = Object.values(scores).find(x => x.caption !== undefined)?.caption
  return {
    id: s.id,
    time: s.captureTime,
    day: s.day,
    gps: s.gps,
    camera: s.camera,
    lens: detail ? s.lens : undefined,
    raw: s.rawFile !== null,
    flag: s.userFlag,
    rating: s.userRating,
    scores: {
      technical: d.technical === undefined ? undefined : round(d.technical, 1),
      aesthetic: d.aesthetic === undefined ? undefined : round(d.aesthetic, 1),
      composition: d.composition === undefined ? undefined : round(d.composition, 1),
      content: d.content === undefined ? undefined : round(d.content, 1),
      story: d.story === undefined ? undefined : round(d.story, 1),
      potential: d.potential === undefined ? undefined : round(d.potential, 1),
    },
    tags: d.tags.slice(0, 12),
    issues: d.issues,
    caption,
    sources: d.sources,
    files,
    detail: detail ? { technical: scores.technical?.detail, aesthetic: scores.aesthetic?.detail, reasons: { ...scores.technical?.reasons, ...scores.aesthetic?.reasons } } : undefined,
  }
}

export function cullTools(rt: ChengyingRuntime): ToolDefinition[] {
  const P = (args: { project?: string }, exec: ToolRunContext): Project => rt.project(args.project, exec.agent?.id)

  return [
    defineTool<{ path: string; export_dir?: string }>({
      name: 'photo_workspace_open',
      description: 'Open (or re-open) a photo workspace folder for culling and retouching. Originals are never modified; Chengying keeps its database, previews and renders in its own state directory and writes results only to the export directory. Returns the project id and a status summary.',
      parameters: obj({ path: str('Absolute path of the folder containing the photos.'), export_dir: str('Optional export directory (default <workspace>/_chengying_export).') }, ['path']),
      async run(args, exec) {
        const p = rt.openProject(args.path, exec.agent?.id, { exportDir: args.export_dir })
        return p.summary()
      },
    }),

    defineTool<{ project?: string; steps?: string[]; force?: boolean; background?: boolean; vlm_purpose?: string }>({
      name: 'photo_cull_run',
      description: 'Run the automatic culling pipeline: scan (metadata, RAW+JPEG pairing, fingerprints) → previews → analyze (technical/aesthetic/composition/potential scores) → group (exact & near duplicates, scenes, travel segments, locations); optionally "models" (configured specialised scorers) and "vlm" (vision-LLM contact-sheet scoring of content/story). Incremental: unchanged files are skipped unless force=true. Large workspaces run as a background job and you are notified on completion.',
      parameters: obj({
        project: projectArg,
        steps: arr(strEnum(['scan', 'previews', 'analyze', 'models', 'vlm', 'group'], 'step'), 'Steps to run, default ["scan","previews","analyze","group"].'),
        force: bool('Recompute even when cached results exist.'),
        background: bool('Force background (true) or inline (false) execution; default chooses by workspace size.'),
        vlm_purpose: str('What the user is selecting for, passed to the vision model (e.g. "travel album of Hangzhou, prefer people and landmarks").'),
      }),
      async run(args, exec) {
        const project = P(args, exec)
        const steps = args.steps ?? ['scan', 'previews', 'analyze', 'group']
        const files = project.repo.shotCount()
        const background = args.background ?? (files === 0 || files > rt.config.backgroundThreshold)
        const r = await rt.runMaybeBackground(exec, { kind: 'cull', label: `chengying cull ${steps.join('+')} · ${project.root}`, projectId: project.id, background }, async (signal, progress) => {
          const out: Record<string, unknown> = {}
          const onProgress = (pr: { stage: string; done: number; total: number; message?: string }): void => progress(pr.stage, pr.done, pr.total, pr.message)
          if (steps.includes('scan')) out.scan = await project.scan({ signal, onProgress })
          if (steps.includes('previews')) out.previews = await project.buildPreviews({ force: args.force, signal, onProgress })
          if (steps.includes('analyze')) out.analyze = await project.analyze({ force: args.force, signal, onProgress })
          if (steps.includes('models') && rt.config.models.length > 0) out.models = await project.scoreWithModels(rt.config.models, { force: args.force, signal, onProgress })
          if (steps.includes('vlm')) {
            const ids = project.repo.shots().filter(s => args.force === true || !Object.keys(project.repo.scores(s.id)).some(k => k.startsWith('vlm:'))).map(s => s.id).slice(0, rt.config.vlm.maxShots)
            out.vlm = await rt.vlmScore(project, ids, exec, { purpose: args.vlm_purpose, signal, progress: (d, t) => progress('vlm', d, t) })
          }
          if (steps.includes('group') || steps.includes('analyze')) out.groups = project.regroup()
          out.summary = project.summary()
          return out
        }, (res) => `culling finished: ${JSON.stringify(res.summary)}`)
        if (r.mode === 'background') return { mode: 'background', jobId: r.jobId, activityId: r.activityId, note: 'Running in the background; you will be notified when the job settles. Use photo_status for progress.' }
        return { mode: 'inline', ...r.result as object }
      },
    }),

    defineTool<{ project?: string }>({
      name: 'photo_status',
      description: 'Status of a workspace: counts, analysis coverage, groups, selections, editing tasks, model usage and running background activities.',
      parameters: obj({ project: projectArg }),
      concurrencySafe: true,
      async run(args, exec) {
        const project = P(args, exec)
        const activities = [...rt.activities.values()].filter(a => a.projectId === project.id).slice(-10)
          .map(a => ({ id: a.id, kind: a.kind, state: a.state, stage: a.stage, done: a.done, total: a.total, error: a.error, jobId: a.jobId }))
        return { ...project.summary(), activities }
      },
    }),

    defineTool<{ project?: string; ids?: string[]; sort?: string; limit?: number; offset?: number; min_score?: number; tag?: string; issue?: string; day?: string; group?: string; selection?: string; flag?: string; detail?: boolean }>({
      name: 'photo_query',
      description: 'List shots with merged scores (0-100: technical, aesthetic, composition, content, story, potential), tags, issues and metadata. Filter by ids, group, selection, day, tag, issue, flag or minimum score; sort by score, time or any dimension.',
      parameters: obj({
        project: projectArg,
        ids: arr(str('shot id'), 'Exact shot ids.'),
        sort: strEnum(['score', 'time', 'technical', 'aesthetic', 'composition', 'content', 'story', 'potential'], 'Sort key (default score).'),
        limit: int('Max rows (default 40).'),
        offset: int('Offset for paging.'),
        min_score: num('Minimum mean of technical and aesthetic.'),
        tag: str('Only shots carrying this tag (substring).'),
        issue: str('Only shots with this issue (e.g. out-of-focus, highlight-clipping).'),
        day: str('YYYY-MM-DD'),
        group: str('Group id (from photo_groups).'),
        selection: str('Selection id; only included items.'),
        flag: strEnum(['pick', 'reject', 'none'], 'User flag filter.'),
        detail: bool('Include files and per-dimension measurements.'),
      }),
      concurrencySafe: true,
      async run(args, exec) {
        const project = P(args, exec)
        let shots = project.repo.shots()
        if (args.ids !== undefined) { const set = new Set(args.ids); shots = shots.filter(s => set.has(s.id)) }
        if (args.group !== undefined) {
          const g = project.repo.groups().find(x => x.id === args.group)
          if (g === undefined) throw new ChengyingError('not-found', `no group ${args.group}`)
          const ids = new Set(g.members.map(m => m.shotId))
          shots = shots.filter(s => ids.has(s.id))
        }
        if (args.selection !== undefined) {
          const sel = project.repo.selection(args.selection)
          if (sel === undefined) throw new ChengyingError('not-found', `no selection ${args.selection}`)
          const ids = new Set(sel.items.filter(i => i.included).map(i => i.shotId))
          shots = shots.filter(s => ids.has(s.id))
        }
        if (args.day !== undefined) shots = shots.filter(s => s.day === args.day)
        if (args.flag !== undefined) shots = shots.filter(s => (args.flag === 'none' ? s.userFlag === null : s.userFlag === args.flag))
        const rows = shots.map(s => ({ s, d: mergeDims(project.repo.scores(s.id)) }))
          .filter(r => args.tag === undefined || r.d.tags.some(t => t.includes(String(args.tag).toLowerCase())))
          .filter(r => args.issue === undefined || r.d.issues.includes(String(args.issue)))
          .filter(r => args.min_score === undefined || ((r.d.technical ?? 0) + (r.d.aesthetic ?? 0)) / 2 >= (args.min_score as number))
        const key = args.sort ?? 'score'
        const val = (r: { s: Shot; d: ReturnType<typeof mergeDims> }): number => key === 'time' ? -(r.s.captureTs ?? 0) : key === 'score' ? ((r.d.technical ?? 0) + (r.d.aesthetic ?? 0)) / 2 + (r.d.content ?? 0) * 0.3 : (r.d[key as 'technical'] ?? 0)
        rows.sort((a, b) => val(b) - val(a))
        const offset = args.offset ?? 0
        const limit = Math.min(200, args.limit ?? 40)
        return { total: rows.length, offset, shots: rows.slice(offset, offset + limit).map(r => shotRow(project, r.s, args.detail === true)) }
      },
    }),

    defineTool<{ project?: string; kind?: string; limit?: number; offset?: number; min_size?: number }>({
      name: 'photo_groups',
      description: 'List groups: exact (identical files), near (near-duplicates / bursts; first member is the best), scene (consecutive frames of one subject/place), segment (travel-narrative units by day, time gap and location), location (GPS clusters).',
      parameters: obj({ project: projectArg, kind: strEnum(['exact', 'near', 'scene', 'segment', 'location'], 'Group kind (default near).'), limit: int('default 30'), offset: int('paging offset'), min_size: int('Only groups with at least this many members.') }),
      concurrencySafe: true,
      async run(args, exec) {
        const project = P(args, exec)
        const groups = project.groups((args.kind ?? 'near') as 'near').filter(g => g.members.length >= (args.min_size ?? 1))
        const offset = args.offset ?? 0
        return {
          total: groups.length,
          groups: groups.slice(offset, offset + (args.limit ?? 30)).map(g => ({ id: g.id, label: g.label, size: g.members.length, best: g.members[0]?.shotId, members: g.members.slice(0, 24).map(m => m.shotId), info: g.info })),
        }
      },
    }),

    defineTool<{ project?: string; shots: string[]; variant?: string; columns?: number }>({
      name: 'photo_view',
      description: 'Look at photos. Up to 16 shots are composed into one labeled contact sheet (#1, #2 …) so you can compare frames cheaply; a single shot is shown larger. Requires a vision-capable model route; otherwise returns metadata only. Use photo_score to record your judgments.',
      parameters: obj({ project: projectArg, shots: arr(str('shot id'), '1-16 shot ids.'), variant: strEnum(['thumb', 'preview'], 'Cell resolution (preview = larger, more tokens).'), columns: int('Grid columns.') }, ['shots']),
      async run(args, exec) {
        const project = P(args, exec)
        const ids = args.shots.slice(0, 16)
        if (ids.length === 0) throw new ChengyingError('invalid-argument', 'pass at least one shot id')
        const labels = ids.map((_, i) => `#${i + 1}`)
        const legend = ids.map((id, i) => {
          const s = project.repo.shot(id)
          if (s === undefined) throw new ChengyingError('not-found', `no shot ${id}`)
          return { label: labels[i], ...shotRow(project, s) }
        })
        let path: string
        if (ids.length === 1) {
          const s = project.repo.shot(ids[0] as string) as Shot
          path = (args.variant === 'thumb' ? s.thumbPath : s.previewPath) ?? s.previewPath ?? ''
          if (path === '') throw new ChengyingError('not-found', 'shot has no preview yet; run photo_cull_run first')
        } else {
          path = (await project.sheet(ids, { labels, cell: args.variant === 'preview' ? 560 : 360, columns: args.columns })).path
        }
        const { image, reason } = await rt.imageForModel(path, exec, { maxEdge: ids.length === 1 ? 1568 : 2000, caption: ids.length === 1 ? ids[0] : 'contact sheet' })
        return { legend, images: image === undefined ? [] : [image as ToolImage], note: reason }
      },
    }),

    defineTool<{ project?: string; scores: Array<{ shot: string; technical?: number; aesthetic?: number; composition?: number; content?: number; story?: number; potential?: number; tags?: string[]; issues?: string[]; caption?: string; notes?: string }> }>({
      name: 'photo_score',
      description: 'Record your own visual judgment of shots (after photo_view), 0-100 per dimension, plus tags (lowercase English nouns: people, landscape, sunset, food, architecture, street, animal, night, sea, landmark, selfie, detail…), issues (eyes-closed, out-of-focus, tilted…) and a short caption. Stored as the "agent" score source and fused with classical and model scores during selection.',
      parameters: obj({
        project: projectArg,
        scores: arr(obj({
          shot: str('shot id'),
          technical: num('0-100'), aesthetic: num('0-100'), composition: num('0-100'), content: num('0-100'), story: num('0-100'), potential: num('0-100'),
          tags: arr(str('tag'), 'tags'), issues: arr(str('issue'), 'issues'), caption: str('caption'), notes: str('free notes'),
        }, ['shot']), 'One entry per shot.'),
      }, ['scores']),
      async run(args, exec) {
        const project = P(args, exec)
        for (const s of args.scores) {
          const { shot, ...rest } = s
          const clean: ScoreSet = { ...rest, tags: rest.tags?.map(t => t.toLowerCase()), detail: { by: 'agent' } }
          const dims = [clean.technical, clean.aesthetic, clean.composition, clean.content, clean.story].filter((v): v is number => typeof v === 'number')
          clean.overall = dims.length ? dims.reduce((a, b) => a + b, 0) / dims.length : undefined
          project.recordScores(shot, 'agent', clean)
        }
        project.regroup()
        return { recorded: args.scores.length }
      },
    }),

    defineTool<{ project?: string; shots?: string[]; candidates?: number; purpose?: string; background?: boolean }>({
      name: 'photo_vlm_score',
      description: 'Score shots automatically with the configured vision LLM (content, story, aesthetics, tags, issues, captions) using batched contact sheets; token usage is recorded per call. By default scores the best candidate per near-duplicate group that has no vision score yet.',
      parameters: obj({ project: projectArg, shots: arr(str('shot id'), 'Explicit shots.'), candidates: int('How many top candidates to score when shots is omitted (default 120).'), purpose: str('Selection goal context.'), background: bool('Run as background job.') }),
      async run(args, exec) {
        const project = P(args, exec)
        let ids = args.shots
        if (ids === undefined) {
          const near = new Map<string, string>()
          for (const g of project.groups('near')) for (const m of g.members.slice(1)) near.set(m.shotId, g.id)
          ids = project.repo.shots()
            .filter(s => !near.has(s.id) && !Object.keys(project.repo.scores(s.id)).some(k => k.startsWith('vlm:')))
            .map(s => ({ id: s.id, r: project.rankOf(s.id) }))
            .sort((a, b) => b.r - a.r)
            .slice(0, args.candidates ?? 120)
            .map(x => x.id)
        }
        const list = ids
        const r = await rt.runMaybeBackground(exec, { kind: 'vlm', label: `chengying vision scoring (${list.length})`, projectId: project.id, background: args.background ?? list.length > 36 },
          async (signal, progress) => await rt.vlmScore(project, list, exec, { purpose: args.purpose, signal, progress: (d, t) => progress('vlm', d, t) }),
          res => `vision scoring: ${res.scored} scored, ${res.failed} failed, ${res.usage.inputTokens}+${res.usage.outputTokens} tokens`)
        return r.mode === 'background' ? { mode: 'background', jobId: r.jobId, activityId: r.activityId } : { mode: 'inline', ...r.result }
      },
    }),

    defineTool<{ project?: string; request?: string; count?: number; min_score?: number; max_count?: number; diversity?: number; per_scene?: number; narrative?: boolean; prefer_tags?: string[]; avoid_tags?: string[]; require_tags?: string[]; include?: string[]; exclude?: string[]; orientation?: string; raw_only?: boolean; weights?: Record<string, number>; time_from?: string; time_to?: string; name?: string; base_selection?: string; limit?: number }>({
      name: 'photo_select',
      description: 'Create a selection from the user\'s natural-language request. Translate the request into the structured fields (count for an exact number, or min_score for "all good ones" without a limit; preferences, diversity, travel-narrative coverage, tags, orientation, time range). The free text is also parsed as a fallback. Duplicates are collapsed to their best frame; picks are spread across scenes and trip segments. Returns the selection id, stats and the chosen shots with reasons. Pass base_selection to keep the user\'s manual adjustments from an earlier selection.',
      parameters: obj({
        project: projectArg,
        request: str('The user\'s request verbatim (e.g. "选30张最好的，多一些人像，按行程讲故事").'),
        count: int('Exact number of photos.'),
        min_score: num('Quality floor 0-100 (threshold mode when count is omitted; default 70).'),
        max_count: int('Upper bound in threshold mode.'),
        diversity: num('0 = pure quality … 1 = maximum variety (default 0.35).'),
        per_scene: int('Max photos per scene group.'),
        narrative: bool('Spread picks across days/segments/locations (default true).'),
        prefer_tags: arr(str('tag'), 'Boost these tags.'),
        avoid_tags: arr(str('tag'), 'Penalise these tags.'),
        require_tags: arr(str('tag'), 'Only shots with all these tags.'),
        include: arr(str('shot id'), 'Always include.'),
        exclude: arr(str('shot id'), 'Never include.'),
        orientation: strEnum(['landscape', 'portrait', 'square', 'any'], 'Orientation filter.'),
        raw_only: bool('Only shots with a RAW file.'),
        weights: anyJson('Dimension weights, e.g. {"technical":0.3,"aesthetic":0.4,"content":0.2}.'),
        time_from: str('ISO local time lower bound.'),
        time_to: str('ISO local time upper bound.'),
        name: str('Selection name.'),
        base_selection: str('Selection id whose manual adjustments are kept.'),
        limit: int('How many chosen rows to return in the result (default 60).'),
      }),
      async run(args, exec) {
        const project = P(args, exec)
        if (project.repo.shotCount() === 0) throw new ChengyingError('invalid-argument', 'workspace has no analysed shots; run photo_cull_run first')
        const parsed = args.request !== undefined ? parseSelectionRequest(args.request) : {}
        const spec: SelectionSpec = {
          ...parsed,
          ...(args.count !== undefined ? { count: args.count } : {}),
          ...(args.min_score !== undefined ? { minScore: args.min_score } : {}),
          ...(args.max_count !== undefined ? { maxCount: args.max_count } : {}),
          ...(args.diversity !== undefined ? { diversity: args.diversity } : {}),
          ...(args.per_scene !== undefined ? { perScene: args.per_scene } : {}),
          ...(args.narrative !== undefined ? { narrative: args.narrative } : {}),
          ...(args.prefer_tags !== undefined ? { preferTags: args.prefer_tags } : {}),
          ...(args.avoid_tags !== undefined ? { avoidTags: args.avoid_tags } : {}),
          ...(args.require_tags !== undefined ? { requireTags: args.require_tags } : {}),
          ...(args.include !== undefined ? { include: args.include } : {}),
          ...(args.exclude !== undefined ? { exclude: args.exclude } : {}),
          ...(args.orientation !== undefined ? { orientation: args.orientation as SelectionSpec['orientation'] } : {}),
          ...(args.raw_only !== undefined ? { rawOnly: args.raw_only } : {}),
          ...(args.weights !== undefined ? { weights: { ...parsed.weights, ...args.weights } } : {}),
          ...(args.time_from !== undefined || args.time_to !== undefined ? { timeRange: { from: args.time_from, to: args.time_to } } : {}),
          ...(args.name !== undefined ? { name: args.name } : {}),
        }
        if (args.count !== undefined && args.min_score === undefined) delete spec.minScore
        const { selectionId, result } = project.select(spec, { name: args.name, base: args.base_selection })
        const chosen = result.items.filter(i => i.included)
        return {
          selectionId,
          spec,
          stats: result.stats,
          shots: chosen.slice(0, args.limit ?? 60).map(i => ({ id: i.shotId, rank: i.rank, score: i.score, reason: i.reason, time: project.repo.shot(i.shotId)?.captureTime })),
          omitted: Math.max(0, chosen.length - (args.limit ?? 60)),
        }
      },
    }),

    defineTool<{ project?: string; action?: string; selection?: string; add?: string[]; remove?: string[]; lock?: string[]; unlock?: string[] }>({
      name: 'photo_selection',
      description: 'Inspect or adjust selections. action=list (all selections), show (items with reasons), adjust (add/remove/lock/unlock shots; adjustments made on the user\'s behalf are recorded as user feedback and teach the preference profile).',
      parameters: obj({ project: projectArg, action: strEnum(['list', 'show', 'adjust'], 'default show'), selection: str('Selection id (default latest).'), add: arr(str('shot id'), 'add'), remove: arr(str('shot id'), 'remove'), lock: arr(str('shot id'), 'lock'), unlock: arr(str('shot id'), 'unlock') }),
      async run(args, exec) {
        const project = P(args, exec)
        if (args.action === 'list') return { selections: project.repo.selections() }
        const id = args.selection ?? project.repo.latestSelectionId()
        if (id === undefined) throw new ChengyingError('not-found', 'no selection yet; use photo_select')
        if (args.action === 'adjust') {
          const r = project.adjustSelection(id, { add: args.add, remove: args.remove, lock: args.lock, unlock: args.unlock }, 'user')
          return { selectionId: id, ...r }
        }
        const sel = project.repo.selection(id)
        if (sel === undefined) throw new ChengyingError('not-found', `no selection ${id}`)
        return { id: sel.id, name: sel.name, spec: sel.spec, stats: sel.stats, items: sel.items.map(i => ({ id: i.shotId, rank: i.rank, score: i.score, included: i.included, locked: i.locked, source: i.source, reason: i.reason })) }
      },
    }),

    defineTool<{ project?: string; shots: string[]; flag?: string; rating?: number; note?: string; tags?: string[] }>({
      name: 'photo_flag',
      description: 'Set user flags on shots: pick (always selected), reject (never selected), clear; star rating 0-5; note; tags.',
      parameters: obj({ project: projectArg, shots: arr(str('shot id'), 'shots'), flag: strEnum(['pick', 'reject', 'clear'], 'flag'), rating: int('0-5'), note: str('note'), tags: arr(str('tag'), 'tags to add') }, ['shots']),
      async run(args, exec) {
        const project = P(args, exec)
        for (const id of args.shots) {
          const s = project.repo.shot(id)
          if (s === undefined) throw new ChengyingError('not-found', `no shot ${id}`)
          project.repo.updateShot(id, {
            ...(args.flag !== undefined ? { userFlag: args.flag === 'clear' ? null : args.flag as 'pick' | 'reject' } : {}),
            ...(args.rating !== undefined ? { userRating: Math.max(0, Math.min(5, Math.round(args.rating))) } : {}),
            ...(args.note !== undefined ? { note: args.note } : {}),
            ...(args.tags !== undefined ? { tags: [...new Set([...s.tags, ...args.tags.map(t => t.toLowerCase())])] } : {}),
          })
        }
        return { updated: args.shots.length }
      },
    }),

    defineTool<{ project?: string; action?: string; note?: string; look?: Record<string, number>; reference_shots?: string[] }>({
      name: 'photo_preferences',
      description: 'The user\'s aesthetic preference profile, learned from manual selection changes and explicit statements. action=show, note (record a stated preference such as "likes warm film look, dislikes HDR"), look (set editing look targets warmth/contrast/saturation/brightness in -1..1 and reference_shots for style matching).',
      parameters: obj({ project: projectArg, action: strEnum(['show', 'note', 'look'], 'default show'), note: str('Preference statement.'), look: anyJson('{"warmth":0.2,"contrast":-0.1,...}'), reference_shots: arr(str('shot id'), 'Shots whose style the user likes.') }),
      async run(args, exec) {
        const project = P(args, exec)
        const profile = project.profile()
        if (args.action === 'note' && args.note !== undefined) profile.styleNotes = [...profile.styleNotes, args.note].slice(-30)
        if (args.action === 'look') {
          profile.look = { ...profile.look, ...(args.look ?? {}), ...(args.reference_shots !== undefined ? { referenceShots: args.reference_shots } : {}) }
        }
        if (args.action === 'note' || args.action === 'look') project.setProfile(profile)
        return profile
      },
    }),

    defineTool<{ project?: string; force?: boolean }>({
      name: 'photo_models_run',
      description: 'Run the configured specialised scoring models (aesthetic/quality predictors via command, HTTP or ONNX adapters) over all shots. Lists the configured models when none are set up.',
      parameters: obj({ project: projectArg, force: bool('Re-score already scored shots.') }),
      async run(args, exec) {
        const project = P(args, exec)
        if (rt.config.models.length === 0) return { configured: [], note: 'No specialised models configured. Add entries to the plugin config "models" (type command|http|onnx).' }
        for (const m of rt.config.models) createModelScorer(m)
        return await project.scoreWithModels(rt.config.models, { force: args.force, signal: exec.signal })
      },
    }),
  ]
}
