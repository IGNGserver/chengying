/** Integrity / audit tools. */
import type { ChengyingRuntime } from '../runtime.ts'
import type { ToolDefinition, ToolRunContext } from '../host-types.ts'
import type { Project } from '../../core/project.ts'
import { defineTool, obj, str, arr, bool } from '../tool.ts'

const projectArg = str('Project id or workspace path; defaults to the workspace opened most recently in this session.')

export function auditTools(rt: ChengyingRuntime): ToolDefinition[] {
  const P = (args: { project?: string }, exec: ToolRunContext): Project => rt.project(args.project, exec.agent?.id)

  return [
    defineTool<{ project?: string; shots?: string[]; hash?: boolean; repair_baseline?: boolean }>({
      name: 'photo_integrity_check',
      description: 'Verify that original photo files still match the baseline recorded when they were scanned. Chengying tools can never write an original, but a mounted shell (bash/pwsh) runs outside FsGuard, so this is how "originals are read-only" becomes checkable. Size/mtime are always compared; hash=true computes a full SHA-256 for files whose metadata changed. repair_baseline=true accepts the current files as the new reference — only after the user confirms an intentional external change. photo_deliver runs the same quick check automatically.',
      parameters: obj({
        project: projectArg,
        shots: arr(str('shot id'), 'Only check files of these shots (default: every file in the workspace).'),
        hash: bool('Compute full SHA-256 for files whose size/mtime changed (definitive, reads the files).'),
        repair_baseline: bool('Accept the current files as the new baseline (explicit user approval).'),
      }),
      concurrencySafe: true,
      async run(args, exec) {
        const project = P(args, exec)
        return await project.integrity.check({
          shotIds: args.shots,
          hash: args.hash === true,
          repair: args.repair_baseline === true,
        })
      },
    }),
  ]
}
