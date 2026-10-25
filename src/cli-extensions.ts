/** CLI commands contributed by the editing and export layers. */
export interface CliExtension {
  name: string
  usage: string
  run(pos: string[], opts: { state?: string; exportDir?: string; force: boolean; out: (v: unknown) => void }): Promise<number>
}

export const cliExtensions: CliExtension[] = []

/* engines: list / verify (interface coverage report) */
cliExtensions.push({
  name: 'engines',
  usage: 'engines [list | verify <engine> [--input <file>] [--report <file>] [--only op1,op2]]',
  async run(pos, opts) {
    const { EngineRegistry } = await import('./core/edit/registry.ts')
    const { verifyEngine, writeReport } = await import('./core/edit/verify.ts')
    const { defaultStateRoot } = await import('./core/project.ts')
    const { join, resolve } = await import('node:path')
    const sharp = (await import('sharp')).default
    const args = [...pos]
    const flag = (n: string): string | undefined => { const i = args.indexOf(n); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v }
    const input = flag('--input')
    const report = flag('--report')
    const only = flag('--only')?.split(',')
    const state = opts.state ?? defaultStateRoot()
    const registry = new EngineRegistry(join(state, 'engines'))
    try {
      if (args[0] === undefined || args[0] === 'list') {
        const probes = await registry.probeAll(true)
        const out: unknown[] = []
        for (const p of probes) {
          if (!p.available) { out.push(p); continue }
          const c = await registry.catalog(p.id)
          out.push({ ...p, operations: c.coverage.operations, parameters: c.coverage.parameters, source: c.source, extensions: c.coverage.extensions, unsupported: c.coverage.unsupported })
        }
        opts.out(out)
        return 0
      }
      if (args[0] === 'verify') {
        const id = args[1] ?? 'builtin'
        const engine = registry.get(id)
        const catalog = await registry.catalog(id, true)
        let file = input
        let kind: 'raw' | 'raster' = 'raster'
        if (file === undefined) {
          file = join(state, 'verify-input.jpg')
          await sharp({ create: { width: 900, height: 600, channels: 3, background: '#6d8fb5' } }).composite([{ input: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600"><rect x="0" y="380" width="900" height="220" fill="#4b6b2f"/><circle cx="650" cy="150" r="60" fill="#fff3c4"/><rect x="300" y="300" width="160" height="120" fill="#b0392b"/></svg>') }]).jpeg().toFile(file)
        } else {
          kind = /\.(nef|cr2|cr3|arw|raf|rw2|orf|dng|pef|srw)$/i.test(file) ? 'raw' : 'raster'
        }
        const r = await verifyEngine(engine, catalog, { input: resolve(file), inputKind: kind, workDir: join(state, 'verify', id), only, onProgress: (d, t) => process.stderr.write(`verify ${id} ${d}/${t}\n`) })
        if (report !== undefined) writeReport(report, r)
        opts.out({ summary: r.summary, failed: r.operations.filter(o => o.status === 'failed'), skipped: r.operations.filter(o => o.status === 'skipped') })
        return r.summary.failed === 0 ? 0 : 3
      }
      return 2
    } finally {
      await registry.close()
    }
  },
})
