#!/usr/bin/env node
/** Install the actual packed artifact into an empty consumer and execute it. */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const temp = mkdtempSync(join(tmpdir(), 'chengying-packed-'))
const run = (command, args, cwd = root) => execFileSync(command, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' })
const executable = name => process.platform === 'win32' ? `${name}.cmd` : name
try {
  let archive = process.argv[2] === undefined ? undefined : resolve(process.argv[2])
  if (archive === undefined) {
    run(executable('pnpm'), ['pack', '--pack-destination', temp])
    archive = readdirSync(temp).filter(name => /^chengying-.+\.tgz$/.test(name)).map(name => join(temp, name))[0]
  }
  if (archive === undefined) throw new Error('pnpm pack produced no Chengying tarball')
  const consumer = join(temp, 'consumer')
  mkdirSync(consumer, { recursive: true })
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'chengying-packed-smoke', private: true, type: 'module', version: '1.0.0' }))
  run(executable('npm'), ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', archive], consumer)
  const version = JSON.parse(run(process.execPath, [join(consumer, 'node_modules', 'chengying', 'lib', 'cli.js'), 'version'], consumer))
  if (typeof version.version !== 'string' || !/^\d+\.\d+\.\d+/.test(version.version)) throw new Error(`unexpected CLI version response ${JSON.stringify(version)}`)
  writeFileSync(join(consumer, 'smoke.mjs'), `import { parseChineseNumber } from 'chengying/core'\nif (parseChineseNumber('一亿零三万') !== 100030000) throw new Error('core export failed')\n`)
  run(process.execPath, [join(consumer, 'smoke.mjs')], consumer)
  console.log(`packed artifact smoke passed: ${archive}`)
} finally {
  rmSync(temp, { recursive: true, force: true })
}
