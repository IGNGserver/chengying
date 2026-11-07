import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The release pipeline derives asset names from `package.json` (via `pnpm pack`)
 * while the tag, the release notes file and the GitHub Release body are keyed by
 * the root `VERSION`. When the two drift, `v0.7.0` ships `chengying-0.6.0.tgz`
 * and the inlined `__CHENGYING_VERSION__` reports the previous version, so the
 * mismatch has to fail in normal CI rather than at tag time.
 */
const root = process.cwd()
const version = readFileSync(join(root, 'VERSION'), 'utf8').trim()
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: string }

describe('release version sources', () => {
  it('keeps package.json in sync with VERSION', () => {
    expect(pkg.version).toBe(version)
  })

  it('uses a plain SemVer without a v prefix', () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+(-rev\.\d+)?$/)
  })

  it('ships a release notes file for the current version', () => {
    const notes = readFileSync(join(root, '.github', 'release-notes', `${version}.md`), 'utf8').trim()
    expect(notes.length).toBeGreaterThan(0)
  })
})
