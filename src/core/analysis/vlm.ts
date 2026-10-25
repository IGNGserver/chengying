/**
 * Vision-LLM scoring contract: prompt construction and robust response parsing.
 * Transport (which model, which provider, token accounting) belongs to the
 * caller — the DSH layer streams through the Harness LLM service.
 */
import type { ScoreSet } from '../types.ts'
import { clamp } from '../util/misc.ts'

export const VLM_RUBRIC_VERSION = 2

export interface VlmItem {
  label: string        // label drawn on the contact sheet, e.g. "#3"
  shotId: string
  context: string      // compact metadata: time, place, camera, heuristic scores
}

export function buildVlmPrompt(items: VlmItem[], options: { language?: 'zh' | 'en'; purpose?: string } = {}): string {
  const lines = items.map(i => `${i.label}: ${i.context}`).join('\n')
  const lang = options.language === 'en' ? 'English' : 'Simplified Chinese'
  return `You are a senior travel-photography editor culling a large trip archive.
The attached image is a contact sheet; each frame is labeled (${items.map(i => i.label).join(', ')}).
${options.purpose ? `Selection goal: ${options.purpose}\n` : ''}Frame context (from metadata and classical analysis):
${lines}

Score EVERY labeled frame independently on a 0-100 scale:
- technical: focus on the subject, motion blur, exposure, noise as visible at this size
- aesthetic: light, color, mood, overall visual impact
- composition: framing, subject placement, horizon, clutter, cropping potential
- content: how interesting/meaningful the subject is (people's expressions, landmarks, moments)
- story: value for telling the trip's story (establishing shots, key moments, details, people)
- potential: how much a professional edit could still improve it
Also give: tags (short lowercase English nouns such as people, landscape, sunset, food, architecture, street, animal, night, sea, landmark, selfie, detail), issues (e.g. eyes-closed, out-of-focus, tilted, overexposed, cluttered, duplicate-feel), and a one-line caption in ${lang}.

Answer with ONLY a JSON array, one object per frame, no prose:
[{"label":"#1","technical":0,"aesthetic":0,"composition":0,"content":0,"story":0,"potential":0,"tags":[],"issues":[],"caption":""}]`
}

function extractJsonArray(text: string): unknown[] | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const body = fenced?.[1] ?? text
  const start = body.indexOf('[')
  const end = body.lastIndexOf(']')
  if (start < 0 || end <= start) return undefined
  try {
    const v = JSON.parse(body.slice(start, end + 1))
    return Array.isArray(v) ? v : undefined
  } catch {
    return undefined
  }
}

const rawNum = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) ? n : undefined
}
const DIMS = ['technical', 'aesthetic', 'composition', 'content', 'story', 'potential'] as const

export function parseVlmResponse(text: string, items: VlmItem[]): Map<string, ScoreSet> {
  const out = new Map<string, ScoreSet>()
  const arr = extractJsonArray(text)
  if (arr === undefined) return out
  const byLabel = new Map(items.map(i => [i.label.replace(/^#/, ''), i]))
  arr.forEach((raw, index) => {
    if (typeof raw !== 'object' || raw === null) return
    const r = raw as Record<string, unknown>
    const label = String(r.label ?? r.id ?? '').replace(/^#/, '')
    const item = byLabel.get(label) ?? items[index]
    if (item === undefined) return
    const tags = Array.isArray(r.tags) ? r.tags.map(t => String(t).toLowerCase().trim()).filter(Boolean) : []
    const issues = Array.isArray(r.issues) ? r.issues.map(t => String(t).toLowerCase().trim()).filter(Boolean) : []
    const values = DIMS.map(d => rawNum(r[d]))
    // Some models answer on a 0..10 scale despite the instruction; detect per record.
    const present = values.filter((v): v is number => v !== undefined)
    const scale = present.length > 0 && present.every(v => v <= 10) ? 10 : 1
    const num = (i: number): number | undefined => { const v = values[i]; return v === undefined ? undefined : clamp(v * scale, 0, 100) }
    const score: ScoreSet = {
      technical: num(0),
      aesthetic: num(1),
      composition: num(2),
      content: num(3),
      story: num(4),
      potential: num(5),
      tags,
      issues,
      caption: typeof r.caption === 'string' ? r.caption : undefined,
      detail: { rubric: VLM_RUBRIC_VERSION },
    }
    const dims = [score.technical, score.aesthetic, score.composition, score.content, score.story].filter((v): v is number => v !== undefined)
    score.overall = dims.length > 0 ? dims.reduce((a, b) => a + b, 0) / dims.length : undefined
    out.set(item.shotId, score)
  })
  return out
}
