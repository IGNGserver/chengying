/** Session intake, scope and delivery tools. */
import { existsSync, statSync } from 'node:fs'
import type { ChengyingRuntime } from '../runtime.ts'
import type { ToolDefinition, ToolRunContext } from '../host-types.ts'
import type { Project } from '../../core/project.ts'
import { defineTool, str, obj, arr, bool, int, num, strEnum } from '../tool.ts'
import { resolveUserPath } from '../../core/util/path.ts'
import { ChengyingError } from '../../core/util/errors.ts'
import { defaultPlan, sessionIdOf, type CullQuality, type DeliverMode, type RetouchMode, type SessionGoal } from '../plan.ts'
import { runDelivery } from '../deliver.ts'

const projectArg = str('Project id or workspace path; defaults to the workspace opened most recently in this session.')

export function sessionTools(rt: ChengyingRuntime): ToolDefinition[] {
  const P = (args: { project?: string }, exec: ToolRunContext): Project => rt.project(args.project, exec.agent?.id)

  return [
    defineTool<{
      project?: string
      path?: string
      files?: string[]
      goal?: SessionGoal
      retouch?: RetouchMode
      cull_quality?: CullQuality
      output_dir?: string
      deliver_mode?: DeliverMode
      checkpoint?: 'after-selection' | 'none'
      brief?: string
    }>({
      name: 'photo_session_start',
      description: 'Start or update a Chengying photo session: open a directory, import chat attachments/files into a managed inbox inside the session workspace, and record the scope (cull only vs retouch + deliver), retouch mode (engine / generative / hybrid), cull quality, output directory and selection checkpoint. Call this first in a Chengying session. If the user already attached photos, omit path/files; the tool reads the session attachments, restores their file extensions from the Host media type, and imports them. Delivery defaults to <session workspace>/_chengying_export while the copies stay in <session workspace>/_chengying_inbox. To change the scope of the current workspace without importing new attachments, pass project explicitly.',
      parameters: obj({
        project: projectArg,
        path: str('Photo folder, or a single image/file path. ~ and relative paths are resolved against the session workspace.'),
        files: arr(str('image/file path'), 'Explicit files to import into a managed inbox (or paths from chat attachments).'),
        goal: strEnum(['cull', 'retouch-deliver'], 'cull = stop after selection; retouch-deliver = cull, retouch and deliver. Inferred from brief when omitted.'),
        retouch: strEnum(['none', 'engine', 'generative', 'hybrid'], 'none for cull-only; engine = darktable/RawTherapee/builtin; generative = batch AI redraw; hybrid = engine then generative.'),
        cull_quality: strEnum(['fast', 'balanced', 'thorough'], 'fast = classical only; balanced = classical + VLM candidates; thorough = + specialised models and full VLM.'),
        output_dir: str('Delivery directory. Defaults to the current project export directory.'),
        deliver_mode: strEnum(['originals', 'rendered'], 'originals = copy picked files for cull-only; rendered = full-res engine/recipe export.'),
        checkpoint: strEnum(['after-selection', 'none'], 'Ask the user to approve the selection before creating retouch tasks.'),
        brief: str('The user request or a short plan summary; used to infer the goal when it is omitted.'),
      }),
      async run(args, exec) {
        const cwd = exec.agent?.session.requestHeader()?.cwd
        const outputDir = args.output_dir?.trim() === '' ? undefined : args.output_dir
        let project = args.project === undefined ? rt.projectForAgent(exec.agent?.id) : rt.project(args.project, exec.agent?.id)
        let source = project === undefined ? '' : project.root
        const hasPath = args.path !== undefined && args.path.trim() !== ''
        const hasFiles = args.files !== undefined && args.files.length > 0
        const attachments = !hasPath && !hasFiles && args.project === undefined ? rt.attachmentInputs(exec) : []

        if (hasPath) {
          const target = resolveUserPath(args.path ?? '', cwd)
          if (!existsSync(target)) throw new ChengyingError('not-found', `path does not exist: ${target}`)
          if (statSync(target).isDirectory()) {
            project = rt.openProject(target, exec.agent?.id, { exportDir: outputDir, cwd })
          } else {
            project = await rt.importFiles([target], { agentId: exec.agent?.id, cwd, exportDir: outputDir })
          }
          source = target
        } else if (hasFiles) {
          const files = args.files ?? []
          project = await rt.importFiles(files, { agentId: exec.agent?.id, cwd, exportDir: outputDir })
          source = `files:${files.length}`
        } else if (attachments.length > 0) {
          project = await rt.importFiles(attachments, { agentId: exec.agent?.id, cwd, exportDir: outputDir })
          source = `attachments:${attachments.length}`
        } else if (project === undefined) {
          throw new ChengyingError('invalid-argument', 'no photo source: pass a directory path, files, or attach photos in the chat first')
        }

        if (project === undefined) throw new ChengyingError('not-found', 'no photo workspace is open')
        if (outputDir !== undefined) project.setExportDir(resolveUserPath(outputDir, cwd))
        const existing = rt.planFor(project, exec)
        const plan = defaultPlan(project, sessionIdOf(exec), source, {
          goal: args.goal,
          retouch: args.retouch,
          cullQuality: args.cull_quality,
          outputDir,
          deliverMode: args.deliver_mode,
          checkpoint: args.checkpoint,
          brief: args.brief,
          cwd,
          existing,
        })
        rt.savePlan(project, plan)
        project.repo.addEvent(null, 'info', 'plan', `photo session plan: ${plan.goal} · ${plan.retouch} · ${plan.deliverMode} → ${plan.outputDir}`, { plan })
        const notes: string[] = []
        if (attachments.some(a => a.downscaled === true)) {
          notes.push('部分附件已被宿主规范化（缩放/重编码）；需要原始画质请直接给照片目录或原始文件路径')
        }
        if (source.startsWith('attachments:') || source.startsWith('files:')) {
          notes.push(`照片副本在处理工作区 ${project.root}；成品默认交付到 ${plan.outputDir}`)
        }
        // Preflight the engines now instead of discovering after a 10 s scan
        // that a RAW batch has no usable decoder: the plan names the engine
        // that will develop RAW, or says plainly that previews/retouching will
        // not work and why.
        const preflight = await rt.enginePreflight(exec.signal)
        if (plan.retouch !== 'none' || plan.goal === 'retouch-deliver') {
          if (preflight.raw.length === 0) {
            notes.push(`未检测到可用的 RAW 引擎（${preflight.rejected.join('; ') || 'darktable/RawTherapee 均未安装'}）；RAW 照片将无法生成预览或修图，JPG/PNG 不受影响`)
          }
        }
        return {
          plan,
          project: project.summary(),
          workspace: project.root,
          deliveryDir: plan.outputDir,
          engines: preflight,
          notes,
          next: plan.goal === 'cull'
            ? 'Call photo_cull_run, then photo_select; deliver with photo_deliver (originals).'
            : plan.retouch === 'generative'
              ? 'Call photo_cull_run, photo_select, then gen_authorize once for the batch and photo_ai_redraw; finish with photo_deliver.'
              : 'Call photo_cull_run, photo_select, then edit_tasks_create and edit_run; finish with photo_deliver.',
          checkpoint: plan.checkpoint,
        }
      },
    }),

    defineTool<{ files: string[]; name?: string; export_dir?: string }>({
      name: 'photo_workspace_import',
      description: 'Import explicit image/file paths (for example read-only paths from chat attachments) into a managed inbox workspace inside the session workspace. Host attachment objects have no extension; the tool restores one from the declared media type or the bytes. Use photo_session_start when you also want to record the scope.',
      parameters: obj({
        files: arr(str('image/file path'), 'Files to copy into the inbox.'),
        name: str('Optional inbox name.'),
        export_dir: str('Optional delivery directory for this inbox.'),
      }, ['files']),
      async run(args, exec) {
        const cwd = exec.agent?.session.requestHeader()?.cwd
        const exportDir = args.export_dir?.trim() === '' ? undefined : args.export_dir
        const project = await rt.importFiles(args.files, { agentId: exec.agent?.id, cwd, exportDir, name: args.name })
        return { project: project.summary(), workspace: project.root, deliveryDir: project.exportDir }
      },
    }),

    defineTool<{
      project?: string
      selection?: string
      tasks?: string[]
      shots?: string[]
      dir?: string
      mode?: 'originals' | 'rendered'
      manifest?: boolean
      format?: 'jpeg' | 'tiff' | 'png'
      quality?: number
      max_edge?: number
      subdir?: string
      naming?: 'original' | 'datetime'
      source?: 'raster' | 'raw' | 'both'
      include_raw?: boolean
      c2pa?: boolean
      overwrite?: boolean
      background?: boolean
      archive?: boolean
    }>({
      name: 'photo_deliver',
      description: 'Deliver the result to a directory. originals copies the picked source files byte-for-byte (cull-only); rendered exports every shot at full resolution with metadata verification and _recipes/ sidecars. Writes manifest.json unless manifest=false. Runs a quick original-integrity check and reports originalsIntact; archive=true also writes a store-only .zip next to the delivery directory. Defaults to the session plan outputDir/deliverMode.',
      parameters: obj({
        project: projectArg,
        selection: str('Selection id (default: latest).'),
        tasks: arr(str('task id'), 'Tasks to deliver.'),
        shots: arr(str('shot id'), 'Shots to deliver.'),
        dir: str('Delivery directory (absolute or ~/relative to the session workspace).'),
        mode: strEnum(['originals', 'rendered'], 'originals = copy sources; rendered = full-res export.'),
        manifest: bool('Write manifest.json (default true).'),
        format: strEnum(['jpeg', 'tiff', 'png'], 'Rendered format (default jpeg).'),
        quality: num('JPEG quality (default 95).'),
        max_edge: int('Downscale long edge; default full resolution.'),
        subdir: str('Sub-folder inside the delivery directory.'),
        naming: strEnum(['original', 'datetime'], 'File naming.'),
        source: strEnum(['raster', 'raw', 'both'], 'For originals: camera JPEG, RAW, or both.'),
        include_raw: bool('For rendered mode: also copy the paired RAW original alongside the rendered export.'),
        c2pa: bool('For rendered mode: write a C2PA content-credentials manifest and sign with c2patool when available.'),
        overwrite: bool('Replace this project’s earlier export with the same name (default true).'),
        background: bool('Run as a background job.'),
        archive: bool('Also write a store-only .zip next to the delivery directory.'),
      }),
      async run(args, exec) {
        const project = P(args, exec)
        return await runDelivery(rt, project, exec, {
          selection: args.selection, tasks: args.tasks, shots: args.shots, dir: args.dir, mode: args.mode,
          manifest: args.manifest, format: args.format, quality: args.quality, maxEdge: args.max_edge,
          subdir: args.subdir, naming: args.naming, source: args.source, includeRaw: args.include_raw, c2pa: args.c2pa, overwrite: args.overwrite, background: args.background, archive: args.archive,
        })
      },
    }),
  ]
}
