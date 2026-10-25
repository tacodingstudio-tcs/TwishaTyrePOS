// Reads the text a PDF draws, in drawing order, for tests. Handles both kinds of font pdfkit writes:
//   · the standard fonts (Helvetica …): one byte per letter, read as Latin-1
//   · embedded TrueType fonts (the bill's Calibri-twin): two-byte glyph codes, turned back into letters with the font's own
//     ToUnicode table
// Each text-drawing operator is one "run" (the pieces of a TJ array — kerned letters — belong together).

import { inflateSync } from 'node:zlib'

type Obj = { dict: string; stream?: Buffer }

export function pdfText(buf: Buffer): string {
  const str = buf.toString('latin1')
  const objs = new Map<number, Obj>()
  for (const m of str.matchAll(/(\d+) 0 obj([\s\S]*?)endobj/g)) {
    const body = m[2]!
    const si = body.indexOf('stream')
    if (si < 0) { objs.set(Number(m[1]), { dict: body }); continue }
    const dict = body.slice(0, si)
    let a = si + 6
    if (body[a] === '\r') a++
    if (body[a] === '\n') a++
    const e = body.lastIndexOf('endstream')
    const raw = Buffer.from(body.slice(a, e), 'latin1')
    let data = raw
    if (/FlateDecode/.test(dict)) { try { data = inflateSync(raw) } catch { /* not decodable: keep the raw bytes */ } }
    objs.set(Number(m[1]), { dict, stream: data })
  }

  // font object → glyph code → text
  const toUni = (cmap: string): Map<number, string> => {
    const map = new Map<number, string>()
    const u = (h: string) => (h.replace(/\s+/g, '').match(/.{4}/g) ?? []).map((x) => String.fromCharCode(parseInt(x, 16))).join('')
    for (const blk of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g))
      for (const p of blk[1]!.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F\s]+)>/g)) map.set(parseInt(p[1]!, 16), u(p[2]!))
    for (const blk of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
      for (const p of blk[1]!.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F\s]+>|\[[^\]]*\])/g)) {
        const lo = parseInt(p[1]!, 16), hi = parseInt(p[2]!, 16)
        if (p[3]!.startsWith('[')) [...p[3]!.matchAll(/<([0-9a-fA-F\s]+)>/g)].forEach((x, i) => map.set(lo + i, u(x[1]!)))
        else { const start = parseInt(p[3]!.slice(1, -1), 16); for (let c = lo; c <= hi; c++) map.set(c, String.fromCharCode(start + (c - lo))) }
      }
    }
    return map
  }
  const fontMaps = new Map<number, Map<number, string>>()
  for (const [n, o] of objs) {
    if (!/\/Type\s*\/Font\b/.test(o.dict)) continue
    const t = /\/ToUnicode\s+(\d+)\s+0\s+R/.exec(o.dict)
    const cm = t ? objs.get(Number(t[1]))?.stream : undefined
    if (cm) fontMaps.set(n, toUni(cm.toString('latin1')))
  }
  const fontByName = new Map<string, number>()
  for (const [, o] of objs) for (const m of o.dict.matchAll(/\/(F\d+)\s+(\d+)\s+0\s+R/g)) fontByName.set(m[1]!, Number(m[2]))

  const decode = (hex: string, font: Map<number, string> | undefined): string => {
    if (!font) return Buffer.from(hex, 'hex').toString('latin1')
    return (hex.match(/.{4}/g) ?? []).map((c) => font.get(parseInt(c, 16)) ?? '').join('')
  }
  const lit = (s: string) => s.replace(/\\(.)/g, '$1')

  const runs: string[] = []
  for (const [, o] of objs) {
    if (!o.stream) continue
    const c = o.stream.toString('latin1')
    if (!/\bBT\b/.test(c)) continue
    let font: Map<number, string> | undefined
    const re = /\/(F\d+)\s+[\d.]+\s+Tf|\[((?:<[0-9a-fA-F]*>|\((?:\\.|[^\\)])*\)|[-\d.\s])*)\]\s*TJ|<([0-9a-fA-F]*)>\s*Tj|\(((?:\\.|[^\\)])*)\)\s*Tj/g
    for (const m of c.matchAll(re)) {
      if (m[1]) { const n = fontByName.get(m[1]); font = n !== undefined ? fontMaps.get(n) : undefined; continue }
      if (m[2] !== undefined) {
        runs.push([...m[2].matchAll(/<([0-9a-fA-F]*)>|\(((?:\\.|[^\\)])*)\)/g)].map((p) => (p[1] !== undefined ? decode(p[1], font) : lit(p[2]!))).join(''))
      } else if (m[3] !== undefined) runs.push(decode(m[3], font))
      else if (m[4] !== undefined) runs.push(lit(m[4]))
    }
  }
  return runs.join(' ').replace(/\s+/g, ' ')
}
