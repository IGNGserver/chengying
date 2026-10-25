/**
 * `chengying` command line: run the pipeline without a Harness session (batch
 * jobs, CI, debugging). Output is JSON.
 */
import { Project } from './core/project.ts'
import { parseSelectionRequest } from './core/select/nl.ts'
import { errorMessage } from './core/util/errors.ts'
import { cliExtensions } from './cli-extensions.ts'

declare const __CHENGYING_VERSION__: string

const USAGE = `chengying <command> [options]

  cull <workspace> [--force]            scan, previews, analyze, group
  select <workspace> "<request>"        create a selection from a natural-language request
  status <workspace>                    project summary
${cliExtensions.map(e => `  ${e.usage}`).join('\n')}
  version

Options: --state <dir> (default $CHENGYING_HOME or ~/.chengying), --export <dir>`

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  if (i < 0) return undefined
  const v = args[i + 1]
  args.splice(i, 2)
  return v
}

async function main(argv: string[]): Promise<number> {
  const args = [...argv]
  const state = flag(args, '--state')
  const exportDir = flag(args, '--export')
  const force = args.includes('--force')
  const rest = args.filter(a => a !== '--force')
  const [cmd, ...pos] = rest
  const out = (v: unknown): void => { process.stdout.write(`${JSON.stringify(v, null, 2)}\n`) }
  const open = (ws: string | undefined): Project => {
    if (ws === undefined) throw new Error('workspace path required')
    return Project.open(ws, { stateRoot: state, exportDir })
  }
  switch (cmd) {
    case 'version': out({ version: typeof __CHENGYING_VERSION__ === 'string' ? __CHENGYING_VERSION__ : 'dev' }); return 0
    case 'cull': {
      const p = open(pos[0])
      try {
        const progress = (x: { stage: string; done: number; total: number }): void => { if (x.done % 50 === 0 || x.done === x.total) process.stderr.write(`${x.stage} ${x.done}/${x.total}\n`) }
        const scan = await p.scan({ onProgress: progress })
        const previews = await p.buildPreviews({ force, onProgress: progress })
        const analyze = await p.analyze({ force, onProgress: progress })
        out({ scan, previews: { built: previews.built, failed: previews.failed.length }, analyze: { analyzed: analyze.analyzed, failed: analyze.failed.length }, summary: p.summary() })
      } finally { await p.close() }
      return 0
    }
    case 'select': {
      const p = open(pos[0])
      try {
        const spec = parseSelectionRequest(pos[1] ?? '')
        const { selectionId, result } = p.select(spec)
        out({ selectionId, spec, stats: result.stats, items: result.items.filter(i => i.included) })
      } finally { await p.close() }
      return 0
    }
    case 'status': {
      const p = open(pos[0])
      try { out(p.summary()) } finally { await p.close() }
      return 0
    }
    default: {
      const ext = cliExtensions.find(e => e.name === cmd)
      if (ext !== undefined) return await ext.run(pos, { state, exportDir, force, out })
      process.stderr.write(`${USAGE}\n`)
      return cmd === undefined || cmd === 'help' ? 0 : 2
    }
  }
}

main(process.argv.slice(2)).then(code => { process.exitCode = code }, (error: unknown) => {
  process.stderr.write(`chengying: ${errorMessage(error)}\n`)
  process.exitCode = 1
})
