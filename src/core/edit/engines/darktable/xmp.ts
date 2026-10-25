/** darktable XMP sidecar writer / history importer (xmp_version 5). */
import type { DtForm } from './blend.ts'

export interface DtHistoryItem {
  num: number
  operation: string
  enabled: boolean
  modversion: number
  params: Buffer
  multiName: string
  multiPriority: number
  blendopVersion?: number
  blendopParams?: Buffer
}

const esc = (s: string): string => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string))

export function buildXmp(opts: { history: DtHistoryItem[]; forms: Array<{ num: number; form: DtForm }>; autoPresets: boolean; iopOrderVersion: number; iopOrderList?: string }): string {
  const masks = opts.forms.map(({ num, form }) => `     <rdf:li
      darktable:mask_num="${num}"
      darktable:mask_id="${form.id}"
      darktable:mask_type="${form.type}"
      darktable:mask_name="${esc(form.name)}"
      darktable:mask_version="${form.version}"
      darktable:mask_points="${form.points.toString('hex')}"
      darktable:mask_nb="${form.nb}"
      darktable:mask_src="${form.src.toString('hex')}"/>`).join('\n')
  const items = opts.history.map(h => `     <rdf:li
      darktable:num="${h.num}"
      darktable:operation="${esc(h.operation)}"
      darktable:enabled="${h.enabled ? 1 : 0}"
      darktable:modversion="${h.modversion}"
      darktable:params="${h.params.toString('hex')}"
      darktable:multi_name="${esc(h.multiName)}"
      darktable:multi_name_hand_edited="${h.multiName === '' ? 0 : 1}"
      darktable:multi_priority="${h.multiPriority}"${h.blendopParams !== undefined ? `
      darktable:blendop_version="${h.blendopVersion ?? 14}"
      darktable:blendop_params="${h.blendopParams.toString('hex')}"` : ''}/>`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="XMP Core 4.4.0-Exiv2">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:darktable="http://darktable.sf.net/"
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
   xmp:CreatorTool="Chengying"
   darktable:xmp_version="5"
   darktable:raw_params="0"
   darktable:auto_presets_applied="${opts.autoPresets ? 0 : 1}"
   darktable:history_end="${opts.history.length}"
   darktable:iop_order_version="${opts.iopOrderVersion}"${opts.iopOrderList !== undefined ? `
   darktable:iop_order_list="${esc(opts.iopOrderList)}"` : ''}>
${opts.forms.length > 0 ? `   <darktable:masks_history>
    <rdf:Seq>
${masks}
    </rdf:Seq>
   </darktable:masks_history>
` : ''}   <darktable:history>
    <rdf:Seq>
${items}
    </rdf:Seq>
   </darktable:history>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
`
}

function attr(block: string, name: string): string | undefined {
  const m = new RegExp(`darktable:${name}="([^"]*)"`).exec(block) ?? new RegExp(`<darktable:${name}>([^<]*)</darktable:${name}>`).exec(block)
  return m?.[1]?.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}

export interface ImportedItem { operation: string; enabled: boolean; modversion: number; params: string; multiName: string; multiPriority: number; blendopVersion?: number; blendopParams?: string }

/** Parse history items from a darktable XMP sidecar. */
export function parseXmpHistory(xmp: string): { items: ImportedItem[]; historyEnd?: number; autoPresetsApplied?: boolean } {
  const histBlock = /<darktable:history>([\s\S]*?)<\/darktable:history>/.exec(xmp)?.[1] ?? ''
  const lis = histBlock.split(/<rdf:li\b/).slice(1)
  const items = lis.map(li => ({
    operation: attr(li, 'operation') ?? '',
    enabled: attr(li, 'enabled') !== '0',
    modversion: Number(attr(li, 'modversion') ?? 0),
    params: attr(li, 'params') ?? '',
    multiName: attr(li, 'multi_name') ?? '',
    multiPriority: Number(attr(li, 'multi_priority') ?? 0),
    blendopVersion: attr(li, 'blendop_version') !== undefined ? Number(attr(li, 'blendop_version')) : undefined,
    blendopParams: attr(li, 'blendop_params'),
  })).filter(i => i.operation !== '')
  const end = /darktable:history_end="(\d+)"/.exec(xmp)?.[1]
  const ap = /darktable:auto_presets_applied="(\d)"/.exec(xmp)?.[1]
  return { items: end !== undefined ? items.slice(0, Number(end)) : items, historyEnd: end === undefined ? undefined : Number(end), autoPresetsApplied: ap === undefined ? undefined : ap === '1' }
}

/** Parse a .dtstyle file (darktable style export). */
export function parseDtStyle(xml: string): { name: string; items: ImportedItem[] } {
  const name = /<name>([^<]*)<\/name>/.exec(xml)?.[1] ?? 'style'
  const plugins = xml.split('<plugin>').slice(1).map(p => p.split('</plugin>')[0] ?? '')
  const tag = (block: string, t: string): string | undefined => new RegExp(`<${t}>([^<]*)</${t}>`).exec(block)?.[1]
  const items = plugins.map(p => ({
    operation: tag(p, 'operation') ?? '',
    enabled: tag(p, 'enabled') !== '0',
    modversion: Number(tag(p, 'module') ?? 0),
    params: tag(p, 'op_params') ?? '',
    multiName: tag(p, 'multi_name') ?? '',
    multiPriority: Number(tag(p, 'multi_priority') ?? 0),
    blendopVersion: tag(p, 'blendop_version') !== undefined ? Number(tag(p, 'blendop_version')) : undefined,
    blendopParams: tag(p, 'blendop_params'),
  })).filter(i => i.operation !== '')
  return { name, items }
}
