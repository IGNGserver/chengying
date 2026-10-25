/**
 * Rule-based natural-language → SelectionSpec parser (Chinese and English).
 * The agent normally builds the spec itself from the conversation; this parser
 * serves the task UI's quick-select box and gives the agent a deterministic
 * baseline it can refine.
 */
import type { SelectionSpec } from '../types.ts'

const CN_DIGITS: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }

export function parseChineseNumber(s: string): number | undefined {
  if (/^\d+$/.test(s)) return Number(s)
  let total = 0
  let section = 0
  let digit = 0
  let seen = false
  for (const ch of s) {
    if (ch in CN_DIGITS) { digit = CN_DIGITS[ch] as number; seen = true; continue }
    const unit = ch === '十' ? 10 : ch === '百' ? 100 : ch === '千' ? 1000 : ch === '万' ? 10000 : 0
    if (unit === 0) return undefined
    seen = true
    if (unit === 10000) { total = (total + section + digit) * unit; section = 0 } else section += (digit === 0 ? 1 : digit) * unit
    digit = 0
  }
  return seen ? total + section + digit : undefined
}

/** Keyword → canonical tag used by scorers (VLM/agent) and selection. */
export const TAG_SYNONYMS: Array<[RegExp, string]> = [
  [/人像|人物|肖像|portrait|people|person|合影/i, 'people'],
  [/风景|山|湖|landscape|scenery|nature/i, 'landscape'],
  [/夜景|夜晚|night/i, 'night'],
  [/日落|日出|黄昏|晚霞|sunset|sunrise|golden hour/i, 'sunset'],
  [/美食|食物|吃|food|dish/i, 'food'],
  [/建筑|古建|寺|庙|architecture|building/i, 'architecture'],
  [/街拍|街头|城市|street|city|urban/i, 'street'],
  [/动物|猫|狗|鸟|animal|wildlife|pet/i, 'animal'],
  [/海|沙滩|海滩|sea|beach|ocean/i, 'sea'],
  [/花|植物|flower|plant/i, 'flower'],
  [/地标|景点|landmark/i, 'landmark'],
  [/自拍|selfie/i, 'selfie'],
  [/航拍|无人机|aerial|drone/i, 'aerial'],
  [/星空|银河|astro|stars|milky way/i, 'astro'],
]

export function parseSelectionRequest(text: string): SelectionSpec {
  const t = text.trim()
  const spec: SelectionSpec = { request: t }
  const count = /(?:选|挑|精选|保留|留|pick|select|choose|keep|top)\s*(?:出|个|上)?\s*([0-9]+|[零〇一二两三四五六七八九十百千]+)\s*(?:张|幅|个|photos?|images?|pictures?|shots?)?/i.exec(t)
    ?? /([0-9]+|[零〇一二两三四五六七八九十百千]+)\s*(?:张|幅|photos?|images?|pictures?|shots?)/i.exec(t)
  const unlimited = /不限|不限制|所有(?:好|优秀|合格)|全部(?:好|优秀|合格)|any number|no limit|all (?:good|great|keepers)/i.test(t)
  if (count !== null && !unlimited) {
    const n = parseChineseNumber(count[1] as string)
    if (n !== undefined && n > 0) spec.count = n
  }
  const threshold = /(?:质量|分数|评分|得分|score|quality)\s*(?:高于|大于|超过|不低于|>=|>|at least|above|over)?\s*([0-9]{1,3})\s*(?:分|以上|\+)?/i.exec(t)
    ?? /([0-9]{1,3})\s*分以上/.exec(t)
  if (threshold !== null) spec.minScore = Math.min(100, Number(threshold[1]))
  else if (spec.count === undefined) {
    if (/高质量|最好|最佳|精品|顶级|best|excellent|outstanding/i.test(t)) spec.minScore = 78
    else if (unlimited || /合格|能用|usable|decent/i.test(t)) spec.minScore = 62
  }
  if (/多样|丰富|不重复|各种|variety|diverse|different/i.test(t)) spec.diversity = 0.6
  if (/相似也行|不在乎重复|允许重复|similar ok/i.test(t)) spec.diversity = 0.1
  if (/叙事|故事|行程|旅程|时间线|按时间|narrative|story|journey|timeline/i.test(t)) spec.narrative = true
  if (/横图|横向|横幅|landscape orientation|horizontal/i.test(t)) spec.orientation = 'landscape'
  else if (/竖图|竖向|竖幅|portrait orientation|vertical/i.test(t)) spec.orientation = 'portrait'
  else if (/方图|正方形|square/i.test(t)) spec.orientation = 'square'
  if (/只要\s*RAW|仅\s*RAW|raw only|only raw/i.test(t)) spec.rawOnly = true
  const prefer: string[] = []
  const avoid: string[] = []
  for (const [re, tag] of TAG_SYNONYMS) {
    const m = re.exec(t)
    if (m === null) continue
    const before = t.slice(Math.max(0, m.index - 4), m.index)
    if (/不要|别|排除|去掉|no |without|exclude/i.test(before)) avoid.push(tag)
    else prefer.push(tag)
  }
  if (prefer.length > 0) spec.preferTags = prefer
  if (avoid.length > 0) spec.avoidTags = avoid
  if (/技术|清晰|锐利|sharp|technical/i.test(t)) spec.weights = { ...spec.weights, technical: 0.45 }
  if (/构图|composition/i.test(t)) spec.weights = { ...spec.weights, composition: 0.25 }
  if (/氛围|美感|好看|艺术|aesthetic|beautiful|artistic/i.test(t)) spec.weights = { ...spec.weights, aesthetic: 0.4 }
  return spec
}
