import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Guards for `presets/chengying.patch.yml`.
 *
 * A preset mounts as one Loader tree and `mountPreset()` fails the WHOLE preset
 * when a single enabled row cannot be imported (`auditRows()` collects the
 * failure and the registry throws). DSH reshapes its own plugin rows between
 * minors — 0.2.2-rc.1 folded `@deepseek-ai/dsh-tool-subagent-control/list-agents`
 * into the package main entry and dropped the subpath export — so every row that
 * names a package subpath must carry a `disabled: !!js` guard that survives a
 * missing subpath instead of taking the preset down with it.
 */

const PRESET = join(import.meta.dirname, '..', 'presets', 'chengying.patch.yml')

interface Row {
  id: string
  name: string
  guarded: boolean
}

/** Split the preset YAML into loader rows; enough structure for name/disabled auditing. */
function rows(text: string): Row[] {
  const blocks = text.split(/\n(?=\s*-\s+id:\s)/)
  const parsed: Row[] = []
  for (const block of blocks) {
    const id = /-\s+id:\s*(\S+)/.exec(block)?.[1]
    const name = /^\s*name:\s*(?:'([^']+)'|"([^"]+)")/m.exec(block)
    if (id === undefined || name === null) continue
    parsed.push({
      id,
      name: (name[1] ?? name[2] ?? '').trim(),
      guarded: /^\s*disabled:\s*!!js\s/m.test(block),
    })
  }
  return parsed
}

/** Whether a row name addresses a package subpath rather than a package root. */
function subpathOf(name: string): string | undefined {
  if (name.startsWith('cordis:') || name.startsWith('.') || name.startsWith('/')) return undefined
  const segments = name.split('/')
  const rootLength = name.startsWith('@') ? 2 : 1
  return segments.length > rootLength ? segments.slice(rootLength).join('/') : undefined
}

const source = readFileSync(PRESET, 'utf8')
const presetRows = rows(source)

describe('chengying preset rows', () => {
  it('parses the rows it is meant to audit', () => {
    expect(presetRows.length).toBeGreaterThan(20)
    expect(presetRows.map(row => row.id)).toContain('tool-subagent-list-agents')
  })

  it('guards every package-subpath row against a removed export', () => {
    const unguarded = presetRows
      .filter(row => subpathOf(row.name) !== undefined && !row.guarded)
      .map(row => `${row.id} (${row.name})`)
    expect(unguarded).toEqual([])
  })

  it('keeps the list-agents guard on a resolvable row name', () => {
    const row = presetRows.find(entry => entry.id === 'tool-subagent-list-agents')
    expect(row?.name).toBe('@deepseek-ai/dsh-tool-subagent-control/list-agents')
    expect(row?.guarded).toBe(true)
  })
})

describe('the list-agents guard expression', () => {
  const expression = /- id: tool-subagent-list-agents[\s\S]*?disabled:\s*!!js\s+"([^"]+)"/.exec(source)?.[1]

  /** Fixture package whose exports either keep or drop the `./list-agents` subpath. */
  function packageWith(exports: Record<string, string> | undefined): string {
    const root = mkdtempSync(join(tmpdir(), 'cy-preset-'))
    const pkg = join(root, 'node_modules', '@deepseek-ai', 'dsh-tool-subagent-control')
    mkdirSync(pkg, { recursive: true })
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-tool-subagent-control',
      version: '0.0.0',
      exports,
    }))
    for (const target of Object.values(exports ?? { '.': './index.js' })) {
      const file = join(pkg, target)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, 'export default 1\n')
    }
    return root
  }

  /** Evaluate the guard the way the Cordis loader does: `ctx` in scope, real `process`. */
  function evaluate(baseUrl: string | URL): boolean {
    expect(expression).toBeTypeOf('string')
    const factory = new Function('ctx', 'process', `return (${expression})`)
    return factory({ baseUrl }, process) as boolean
  }

  it('enables the row where the subpath still resolves (dsh 0.2.1.x)', () => {
    const root = packageWith({ '.': './index.js', './list-agents': './lib/list-agents.js' })
    expect(evaluate(`${root}/`)).toBe(false)
    expect(evaluate(pathToFileURL(`${root}/`))).toBe(false)
  })

  it('disables the row where the subpath was removed (dsh 0.2.2-rc.1+)', () => {
    const root = packageWith({ '.': './index.js' })
    expect(evaluate(`${root}/`)).toBe(true)
  })

  it('disables itself instead of throwing when the base is unusable', () => {
    expect(evaluate('')).toBe(true)
    expect(evaluate(join(tmpdir(), 'cy-preset-absent'))).toBe(true)
  })
})
