/** RawTherapee processing profile (.pp3, GLib key file) parsing and writing. */

export type Pp3 = Map<string, Map<string, string>>

export function parsePp3(text: string): Pp3 {
  const out: Pp3 = new Map()
  let section: Map<string, string> | undefined
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^\uFEFF/, '')
    if (line.trim() === '' || line.startsWith('#')) continue
    const m = /^\[(.+)\]\s*$/.exec(line)
    if (m !== null) {
      section = out.get(m[1] as string) ?? new Map()
      out.set(m[1] as string, section)
      continue
    }
    const eq = line.indexOf('=')
    if (eq < 0 || section === undefined) continue
    section.set(line.slice(0, eq), line.slice(eq + 1))
  }
  return out
}

/** GLib key-file escaping for values (\\, \n, \t, leading space). */
function escape(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\t/g, '\\t').replace(/\r/g, '\\r').replace(/^ /, '\\s')
}

export function writePp3(p: Pp3, header = true): string {
  const lines: string[] = []
  for (const [section, keys] of p) {
    if (keys.size === 0) continue
    lines.push(`[${section}]`)
    for (const [k, v] of keys) lines.push(`${k}=${escape(v)}`)
    lines.push('')
  }
  return (header ? '# Written by Chengying\n' : '') + lines.join('\n')
}

/** Serialize a JSON value as RawTherapee writes it. */
export function toPp3Value(v: unknown): string {
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 1e9) / 1e9)
  if (Array.isArray(v)) return v.map(x => (Array.isArray(x) ? x.join(';') : String(x))).join(';') + (v.length > 0 ? ';' : '')
  return String(v ?? '')
}
