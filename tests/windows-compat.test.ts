import { describe, expect, it } from 'vitest'
import { cliPath, cliPaths } from '../src/core/util/path.ts'
import { numericMatch } from '../src/core/meta/exif.ts'
import { compactStep } from '../src/dsh/tools/cull.ts'

describe('engine command-line paths', () => {
  it('uses forward slashes on Windows so pattern-parsing CLIs keep the separators', () => {
    // darktable-cli treats `\` in its output argument as an escape character and
    // exports to a file whose name has no directory separators at all.
    expect(cliPath('C:\\Users\\me\\Pictures\\out.jpg', 'win32')).toBe('C:/Users/me/Pictures/out.jpg')
    expect(cliPaths(['C:\\a\\b.xmp', undefined, 'C:\\c\\d.jpg'], 'win32')).toEqual(['C:/a/b.xmp', 'C:/c/d.jpg'])
  })

  it('leaves POSIX paths untouched', () => {
    expect(cliPath('/home/me/Pictures/out.jpg', 'linux')).toBe('/home/me/Pictures/out.jpg')
    expect(cliPath('/Users/me/out.jpg', 'darwin')).toBe('/Users/me/out.jpg')
  })
})

describe('metadata verification tolerance', () => {
  it('accepts a rational exposure time re-quantised on write-back', () => {
    // ExifTool stores 1/109 s; a JPEG round-trip reads back 0.009174311927.
    expect(numericMatch('ExposureTime', 0.00917632, 0.009174311927)).toBe(true)
    expect(numericMatch('FNumber', 4.1, 4.0999999)).toBe(true)
    expect(numericMatch('FocalLength', 22, 22.0000001)).toBe(true)
  })

  it('still catches real differences', () => {
    expect(numericMatch('ExposureTime', 0.00917632, 0.02)).toBe(false)
    expect(numericMatch('FNumber', 4.1, 5.6)).toBe(false)
    expect(numericMatch('ISO', 100, 400)).toBe(false)
    expect(numericMatch('GPSLatitude', 31.2, 31.3)).toBe(false)
  })
})

describe('cull result compaction', () => {
  const failed = Array.from({ length: 9 }, (_, i) => ({
    shotId: `s_${i}`,
    error: `cannot build a preview for C:\\photos\\IMG_${i}.dng: no embedded preview; ifd0: vips_colourspace: no known route from 'multiband' to 'srgb'\nvips_colourspace: no known route from 'multiband' to 'srgb'`,
  }))

  it('caps the list at five entries and keeps the total', () => {
    const out = compactStep({ built: 0, skipped: 0, failed }, false)
    expect(out.failed).toHaveLength(5)
    expect(out.failedCount).toBe(9)
    expect(out.failedTruncated).toBe(true)
    // One line per failure keeps the payload small enough to survive the host limit.
    expect(out.failed?.every(f => !f.error.includes('\n'))).toBe(true)
    expect(out.failed?.[0]?.error.length).toBeLessThanOrEqual(181)
  })

  it('returns everything with detail=true', () => {
    const out = compactStep({ built: 0, skipped: 0, failed }, true)
    expect(out.failed).toHaveLength(9)
    expect(out.failedTruncated).toBeUndefined()
  })

  it('leaves clean results untouched', () => {
    const clean = { built: 8, skipped: 0, failed: [] as Array<{ shotId: string; error: string }> }
    expect(compactStep(clean, false)).toBe(clean)
  })
})
