import { describe, expect, it } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { crc32 } from 'node:zlib'
import { zipDirectory } from '../src/core/export/zip.ts'
import { freshDir } from './helpers/fixtures.ts'

interface Entry { name: string; data: Buffer; crc: number }

function readZip(buffer: Buffer): Entry[] {
  const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  if (eocd < 0) throw new Error('no EOCD')
  const count = buffer.readUInt16LE(eocd + 10)
  const cdOffset = buffer.readUInt32LE(eocd + 16)
  const entries: Entry[] = []
  let at = cdOffset
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(at) !== 0x02014b50) throw new Error('bad central header')
    const crc = buffer.readUInt32LE(at + 16)
    const size = buffer.readUInt32LE(at + 24)
    const nameLen = buffer.readUInt16LE(at + 28)
    const extraLen = buffer.readUInt16LE(at + 30)
    const commentLen = buffer.readUInt16LE(at + 32)
    const local = buffer.readUInt32LE(at + 42)
    const name = buffer.subarray(at + 46, at + 46 + nameLen).toString('utf8')
    if (buffer.readUInt32LE(local) !== 0x04034b50) throw new Error('bad local header')
    const localNameLen = buffer.readUInt16LE(local + 26)
    const localExtraLen = buffer.readUInt16LE(local + 28)
    const dataStart = local + 30 + localNameLen + localExtraLen
    const data = buffer.subarray(dataStart, dataStart + size)
    entries.push({ name, data, crc })
    at += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

describe('delivery zip', () => {
  it('stores files with correct names, bytes and CRCs', async () => {
    const dir = await freshDir('zip-src')
    const out = join(await freshDir('zip-out'), 'delivery.zip')
    mkdirSync(join(dir, 'nested'))
    const hello = Buffer.from('hello world\n')
    const binary = Buffer.alloc(4096)
    for (let i = 0; i < binary.length; i++) binary[i] = (i * 37 + 11) & 0xff
    writeFileSync(join(dir, 'a.txt'), hello)
    writeFileSync(join(dir, 'nested', 'b.bin'), binary)

    const result = zipDirectory(dir, out)
    expect(result.entries).toBe(2)
    expect(result.bytes).toBeGreaterThan(0)

    const entries = readZip(readFileSync(out))
    expect(entries.map(e => e.name).sort()).toEqual(['a.txt', 'nested/b.bin'])
    const a = entries.find(e => e.name === 'a.txt')
    const b = entries.find(e => e.name === 'nested/b.bin')
    expect(a?.data.equals(hello)).toBe(true)
    expect(b?.data.equals(binary)).toBe(true)
    expect(a?.crc).toBe(crc32(hello))
    expect(b?.crc).toBe(crc32(binary))
  })

  it('refuses an empty directory', async () => {
    const dir = await freshDir('zip-empty')
    const out = join(await freshDir('zip-empty-out'), 'empty.zip')
    expect(() => zipDirectory(dir, out)).toThrow(/nothing to archive/)
  })
})
