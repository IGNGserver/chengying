import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import { cliExtensions } from '../src/cli-extensions.ts'
import { freshDir } from './helpers/fixtures.ts'

const extension = cliExtensions.find(item => item.name === 'engines')!

describe('engine CLI argument safety', () => {
  it.each(['0', '-1', 'NaN', 'Infinity', '1.5'])('rejects invalid edge %s', async edge => {
    const state = await freshDir('cli-edge-state')
    await expect(extension.run(['preview', '/does/not/matter.jpg', '--engine', 'builtin', '--edge', edge], { state, force: false, out: () => undefined })).rejects.toThrow(/positive integer/)
  })

  it('rejects missing flag values, empty operation filters and input overwrite', async () => {
    const state = await freshDir('cli-args-state')
    const run = (args: string[]) => extension.run(args, { state, force: false, out: () => undefined })
    await expect(run(['preview', '/does/not/matter.jpg', '--engine', 'builtin', '--edge'])).rejects.toThrow(/requires a value/)
    await expect(run(['verify', 'builtin', '--only', ' exposure, ,crop '])).rejects.toThrow(/non-empty/)
    await expect(run(['preview', '/does/not/matter.jpg', '--out', '/does/not/matter.jpg', '--engine', 'builtin'])).rejects.toThrow(/overwrite/)
  })

  it('renders a real builtin preview after validation', async () => {
    const state = await freshDir('cli-preview-state'); const dir = await freshDir('cli-preview-input')
    const input = join(dir, 'input.jpg'); const output = join(dir, 'output.jpg')
    await sharp({ create: { width: 80, height: 60, channels: 3, background: '#336699' } }).jpeg().toFile(input)
    let result: unknown
    const code = await extension.run(['preview', input, '--out', output, '--engine', 'builtin', '--edge', '64'], { state, force: false, out: value => { result = value } })
    expect(code).toBe(0)
    expect(existsSync(output)).toBe(true)
    expect(result).toMatchObject({ engine: 'builtin', width: 64 })
  })
})
