/**
 * Minimal store-only ZIP writer for delivery archives.
 *
 * Photos are already compressed, so re-deflating them burns CPU for almost no
 * gain. Entries are stored (method 0), which keeps the implementation small and
 * makes the archive readable by every unzip implementation. Zip64 is not
 * implemented: a single delivery larger than 4 GiB reports a clear error and
 * the caller can fall back to the shell's zip/tar.
 */
import { closeSync, mkdirSync, openSync, readSync, readdirSync, rmSync, statSync, writeSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { ChengyingError, errorMessage } from '../util/errors.ts'
import { newId } from '../util/misc.ts'
import { commitPublications, temporaryFor } from './atomic.ts'

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32Update(crc: number, buffer: Buffer): number {
  let c = crc >>> 0
  for (let i = 0; i < buffer.length; i++) c = (CRC_TABLE[(c ^ (buffer[i] as number)) & 0xff] as number) ^ (c >>> 8)
  return c >>> 0
}

function dosDateTime(mtimeMs: number): { time: number; date: number } {
  const d = new Date(mtimeMs)
  const year = Math.max(1980, d.getFullYear())
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | (Math.floor(d.getSeconds() / 2) & 0x1f)
  const date = (((year - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f)
  return { time, date }
}

interface CentralRecord {
  name: Buffer
  crc: number
  size: number
  offset: number
  time: number
  date: number
}

function listFiles(root: string, dir: string, out: CentralRecord[], skip: Set<string>): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (skip.has(resolve(path)) || entry.name.endsWith('.chengying.lock')) continue
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      listFiles(root, path, out, skip)
    } else if (entry.isFile()) {
      out.push({ name: Buffer.from(relative(root, path).split(sep).join('/'), 'utf8'), crc: 0, size: 0, offset: 0, time: 0, date: 0 })
    }
  }
}

export interface ZipResult {
  path: string
  entries: number
  bytes: number
}

/**
 * Write `dir` as a store-only zip at `out`. `out` may be inside `dir`; both the
 * final path and its hidden staging file are excluded from the archive.
 */
export function zipDirectory(dir: string, out: string): ZipResult {
  const root = statSync(dir)
  if (!root.isDirectory()) throw new ChengyingError('invalid-argument', `not a directory: ${dir}`)
  mkdirSync(dirname(out), { recursive: true })
  const temporary = temporaryFor(out, newId('zip'), 'archive')
  const records: CentralRecord[] = []
  listFiles(dir, dir, records, new Set([resolve(out), resolve(temporary)]))
  if (records.length === 0) throw new ChengyingError('invalid-argument', `nothing to archive in ${dir}`)
  if (records.length > 0xffff) throw new ChengyingError('unsupported', `too many files for a store-only zip (${records.length} > 65535); use the shell zip/tar`)

  const fd = openSync(temporary, 'wx')
  let offset = 0
  const writeAll = (buffer: Buffer): void => {
    let written = 0
    while (written < buffer.length) written += writeSync(fd, buffer, written, buffer.length - written)
  }
  const write = (buffer: Buffer): void => {
    writeAll(buffer)
    offset += buffer.length
    if (offset > 0xffffffff) {
      throw new ChengyingError('unsupported', 'delivery archive exceeds 4 GiB; use the shell zip/tar for a larger delivery')
    }
  }

  try {
    for (const record of records) {
      const relativeName = record.name.toString('utf8')
      const path = join(dir, relativeName.split('/').join(sep))
      const stat = statSync(path)
      if (stat.size > 0xffffffff) throw new ChengyingError('unsupported', `file too large for a store-only zip: ${relativeName}`)
      const { time, date } = dosDateTime(stat.mtimeMs)
      const header = Buffer.alloc(30)
      header.writeUInt32LE(0x04034b50, 0)
      header.writeUInt16LE(20, 4)
      header.writeUInt16LE(0x0800, 6)
      header.writeUInt16LE(0, 8)
      header.writeUInt16LE(time, 10)
      header.writeUInt16LE(date, 12)
      header.writeUInt32LE(0, 14)
      header.writeUInt32LE(stat.size, 18)
      header.writeUInt32LE(stat.size, 22)
      header.writeUInt16LE(record.name.length, 26)
      header.writeUInt16LE(0, 28)
      record.offset = offset
      record.time = time
      record.date = date
      write(header)
      write(record.name)

      const chunk = Buffer.allocUnsafe(1024 * 1024)
      const file = openSync(path, 'r')
      let crc = 0xffffffff
      let read = 0
      try {
        while (true) {
          const n = readSync(file, chunk, 0, chunk.length, null)
          if (n === 0) break
          const view = chunk.subarray(0, n)
          crc = crc32Update(crc, view)
          write(view)
          read += n
        }
      } finally {
        closeSync(file)
      }
      const after = statSync(path)
      if (read !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new ChengyingError('internal', `file changed while archiving: ${relativeName}`)
      record.crc = (crc ^ 0xffffffff) >>> 0
      record.size = read
      // Rewrite the local header with the real CRC. The size is already correct
      // (stat before the copy); only CRC was unknown in the first pass.
      const crcHeader = Buffer.alloc(4)
      crcHeader.writeUInt32LE(record.crc, 0)
      writeSync(fd, crcHeader, 0, 4, record.offset + 14)
    }

    const cdStart = offset
    for (const record of records) {
      const header = Buffer.alloc(46)
      header.writeUInt32LE(0x02014b50, 0)
      header.writeUInt16LE(20, 4)
      header.writeUInt16LE(20, 6)
      header.writeUInt16LE(0x0800, 8)
      header.writeUInt16LE(0, 10)
      header.writeUInt16LE(record.time, 12)
      header.writeUInt16LE(record.date, 14)
      header.writeUInt32LE(record.crc, 16)
      header.writeUInt32LE(record.size, 20)
      header.writeUInt32LE(record.size, 24)
      header.writeUInt16LE(record.name.length, 28)
      header.writeUInt16LE(0, 30)
      header.writeUInt16LE(0, 32)
      header.writeUInt16LE(0, 34)
      header.writeUInt16LE(0, 36)
      header.writeUInt32LE((0o100644 << 16) >>> 0, 38)
      header.writeUInt32LE(record.offset, 42)
      write(header)
      write(record.name)
    }
    const cdSize = offset - cdStart
    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(0x06054b50, 0)
    eocd.writeUInt16LE(0, 4)
    eocd.writeUInt16LE(0, 6)
    eocd.writeUInt16LE(records.length, 8)
    eocd.writeUInt16LE(records.length, 10)
    eocd.writeUInt32LE(cdSize, 12)
    eocd.writeUInt32LE(cdStart, 16)
    eocd.writeUInt16LE(0, 20)
    write(eocd)
  } catch (error) {
    closeSync(fd)
    try { rmSync(temporary, { force: true }) } catch { /* scratch cleanup */ }
    throw error instanceof ChengyingError ? error : new ChengyingError('internal', `cannot write archive ${out}: ${errorMessage(error)}`, undefined, { cause: error })
  }
  closeSync(fd)
  commitPublications([{ temporary, target: out, overwrite: false }])
  return { path: out, entries: records.length, bytes: statSync(out).size }
}
