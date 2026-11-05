import { describe, expect, it } from 'vitest'
import { canonicalExtension, extensionForMediaType, formatForExtension, mediaTypeForExtension, sniffImageFormat } from '../src/core/image/format.ts'

/** Build a header of at least 12 bytes with the given prefix. */
function head(...bytes: number[]): Uint8Array {
  const out = new Uint8Array(Math.max(16, bytes.length))
  out.set(bytes)
  return out
}

function ascii(text: string, size = 16): Uint8Array {
  const out = new Uint8Array(Math.max(size, text.length))
  out.set([...text].map(ch => ch.charCodeAt(0)))
  return out
}

describe('image format detection', () => {
  it('maps declared media types to extensions', () => {
    expect(extensionForMediaType('image/jpeg')).toBe('jpg')
    expect(extensionForMediaType('IMAGE/PNG')).toBe('png')
    expect(extensionForMediaType('image/webp')).toBe('webp')
    expect(extensionForMediaType('image/gif')).toBe('gif')
    expect(extensionForMediaType('image/heic')).toBe('heic')
    expect(extensionForMediaType('text/plain')).toBeUndefined()
    expect(extensionForMediaType(undefined)).toBeUndefined()
  })

  it('normalises aliases and rejects unknown extensions', () => {
    expect(canonicalExtension('jpeg')).toBe('jpg')
    expect(canonicalExtension('.JPG')).toBe('jpg')
    expect(canonicalExtension('tiff')).toBe('tif')
    expect(canonicalExtension('nef')).toBe('nef')
    expect(canonicalExtension('txt')).toBeUndefined()
    expect(formatForExtension('jpeg')).toMatchObject({ ext: 'jpg', mediaType: 'image/jpeg', kind: 'raster' })
    expect(formatForExtension('NEF')).toMatchObject({ ext: 'nef', kind: 'raw', mediaType: 'image/x-nef' })
    expect(mediaTypeForExtension('tif')).toBe('image/tiff')
  })

  it('sniffs the formats the Host accepts for pasted images', () => {
    expect(sniffImageFormat(head(0xff, 0xd8, 0xff, 0xe0))).toMatchObject({ ext: 'jpg', mediaType: 'image/jpeg' })
    expect(sniffImageFormat(head(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toMatchObject({ ext: 'png', mediaType: 'image/png' })
    expect(sniffImageFormat(ascii('GIF89a'))).toMatchObject({ ext: 'gif', mediaType: 'image/gif' })
    const webp = ascii('RIFF\0\0\0\0WEBP')
    expect(sniffImageFormat(webp)).toMatchObject({ ext: 'webp', mediaType: 'image/webp' })
  })

  it('detects TIFF containers and ISO-BMFF brands', () => {
    expect(sniffImageFormat(head(0x49, 0x49, 0x2a, 0x00))).toMatchObject({ ext: 'tif', container: 'tiff' })
    expect(sniffImageFormat(head(0x4d, 0x4d, 0x00, 0x2a))).toMatchObject({ ext: 'tif', container: 'tiff' })
    const heic = ascii('\0\0\0\x18ftypheic')
    expect(sniffImageFormat(heic)).toMatchObject({ ext: 'heic', container: 'isobmff' })
    const avif = ascii('\0\0\0\x18ftypavif')
    expect(sniffImageFormat(avif)).toMatchObject({ ext: 'avif', container: 'isobmff' })
  })

  it('returns undefined for non-images and short buffers', () => {
    expect(sniffImageFormat(ascii('not an image at all'))).toBeUndefined()
    expect(sniffImageFormat(new Uint8Array(4))).toBeUndefined()
  })
})
