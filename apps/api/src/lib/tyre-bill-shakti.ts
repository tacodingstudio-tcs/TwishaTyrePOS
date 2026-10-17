// The bill as Shakti Enterprise prints it from their Excel "Car Bill" / "2 Wheel Bill" sheets:
//
//   ┌ SHAKTI ENTERPRISE (teal, underlined, on a peach band) ┐   address · phone · email
//   Debit Memo            Tax Invoice            Original
//   Bill No. - 75                                PO Date:
//   Date: 25-08-2026
//   ┌ Bill To,                         │ GST.NO   <customer GSTIN>
//   │ Shakti Enterprise …              │ Customer Name · Mobile Number · Address · Vehicle Number
//   Sr.No. | Vehicle Company | Product Description | Tyre Brand | HSN Code | Unit Rate | Qty | Taxable Value | Total GST | Grand Total
//   1 | NEXON | 215/60/16 | YOKOHAMA | 4011 | 7627.12 | 4 | 30508.47 | 5491.53 | 36000
//        Alignment · Balancing · Weight Charge · Labour Charge  (amount in the Grand Total column)
//                                              Sub total · CGST · SGST · Grand Total
//
// The two-wheeler sheet is the same bill with the columns "Total | GST | Grand Total" and no fixed charge rows.
// A bill without GST (cash memo) keeps the same frame but drops the HSN / GST columns and the tax lines.
// Two details differ from the spreadsheet on purpose: "Alignment" is spelt correctly, and the empty last column
// of the sheet is folded into "Grand Total".

import type { InvoicePdfData, BusinessHeader } from './tyre-pdf.js'

const TEAL = '#31859C'
const PEACH = '#FDE9D9'
const INK = '#000000'
const GREY = '#6B7280'

const f2 = (n: unknown): string => (Math.round((Number(n ?? 0) + Number.EPSILON) * 100) / 100).toFixed(2)
const dmy = (v: unknown): string => {
  if (!v) return ''
  const d = v instanceof Date ? v : new Date(String(v))
  if (isNaN(d.getTime())) return String(v)
  const p = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Asia/Kolkata' }).formatToParts(d)
  const g = (t: string) => p.find((x) => x.type === t)!.value
  return `${g('day')}-${g('month')}-${g('year')}`
}

type Slot = 'Alignment' | 'Balancing' | 'Weight Charge' | 'Labour Charge'
const SLOTS: Slot[] = ['Alignment', 'Balancing', 'Weight Charge', 'Labour Charge']
function slotOf(l: { description: string; serviceType?: string | null }): Slot | null {
  const t = `${l.description} ${l.serviceType ?? ''}`.toLowerCase()
  if (/align/.test(t)) return 'Alignment'
  if (/weight/.test(t)) return 'Weight Charge'
  if (/balanc/.test(t)) return 'Balancing'
  if (/lab(o)?ur/.test(t)) return 'Labour Charge'
  return null
}
const isJob = (l: { kind?: string | null }) => l.kind === 'service' || l.kind === 'charge'

export function drawShaktiBill(doc: PDFKit.PDFDocument, b: InvoicePdfData, biz: BusinessHeader): void {
  const M = 24
  const X = M, W = doc.page.width - 2 * M
  const pageBottom = () => doc.page.height - 38
  const two = b.billKind === 'two_wheel'
  const gst = b.gstBill !== false
  const R = 15                                           // row height

  const text = (t: string, x: number, y: number, o: { w?: number; align?: 'left' | 'right' | 'center'; bold?: boolean; size?: number; color?: string } = {}) => {
    doc.font(o.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(o.size ?? 9).fillColor(o.color ?? INK)
      .text(t, x, y, { width: o.w ?? 400, align: o.align ?? 'left', lineBreak: false, ellipsis: true })
  }
  /** the largest font size (down to 6) at which the text fits the cell on one line — a long make like SPLENDOR never wraps */
  const fit = (t: string, w: number, size: number, bold = false): number => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica')
    let s = size
    while (s > 6 && doc.fontSize(s).widthOfString(t) > w) s -= 0.25
    return s
  }
  const hline = (y: number, x1 = X, x2 = X + W, w = 0.6) => doc.lineWidth(w).strokeColor(INK).moveTo(x1, y).lineTo(x2, y).stroke()
  const vline = (x: number, y1: number, y2: number, w = 0.6) => doc.lineWidth(w).strokeColor(INK).moveTo(x, y1).lineTo(x, y2).stroke()

  // ── masthead ────────────────────────────────────────────────────────────────
  let y = M
  const bandX = X + W * 0.059
  doc.rect(bandX, y, X + W - bandX, 38).fill(PEACH)
  doc.font('Helvetica-Bold').fontSize(24).fillColor(TEAL)
    .text(biz.name.toUpperCase(), bandX, y + 7, { width: X + W - bandX, align: 'center', underline: true, lineBreak: false })
  y += 44
  const cx = bandX, cw = X + W - bandX
  if (biz.address) { text(biz.address, cx, y, { w: cw, align: 'center', bold: true, size: 10 }); y += 14 }
  const contact = [biz.phone && `Co.No. ${biz.phone}`, biz.email && `Email ID: ${biz.email}`].filter(Boolean).join('    ')
  if (contact) { text(contact, cx, y, { w: cw, align: 'center', bold: true, size: 10 }); y += 14 }
  y += 4

  // copy / type labels, exactly as on the sheet
  text('Debit Memo', X + W * 0.059, y, { bold: true, size: 10 })
  text(gst ? 'Tax Invoice' : 'Cash Memo', X + W * 0.467, y, { bold: true, size: 10 })
  text('Original', X + W * 0.749, y, { bold: true, size: 10 })
  y += 22

  // bill no / date / PO
  text('Bill No. -', X + W * 0.059, y, { size: 9.5 })
  text(String(b.number), X + W * 0.059, y, { w: W * 0.235 + 8, align: 'right', size: 9.5 })
  const po = [b.poNo && `PO No.: ${b.poNo}`, `PO Date: ${b.poDate ? dmy(b.poDate) : ''}`].filter(Boolean).join('    ')
  text(po, X + W * 0.559, y, { w: W * 0.44, size: 9.5 })
  y += R
  text('Date:', X + W * 0.059, y, { size: 9.5 })
  text(dmy(b.date), X + W * 0.059, y, { w: W * 0.235 + 8, align: 'right', size: 9.5 })
  y += R + 3

  // ── bill-to box ─────────────────────────────────────────────────────────────
  const boxTop = y
  const splitX = X + W * 0.559, valX = X + W * 0.725
  const left = ['Bill To,', biz.name, biz.address ?? '', contact, biz.gstin ? `GST No.: ${biz.gstin}` : ''].filter((s, i) => i < 2 || !!s)
  const right: Array<[string, string, boolean?]> = [
    ['GST.NO', gst ? (b.partyGstin ?? '') : '', true],
    ['Customer Name:', b.partyName || 'Walk-in customer'],
    ['Mobile Number', b.partyPhone ?? ''],
    ['Address', b.partyAddress ?? ''],
    ['Vehicle Number:', b.vehicleNo ?? ''],
  ]
  doc.font('Helvetica').fontSize(9.5)
  const addrLines = Math.max(1, Math.ceil(doc.widthOfString(b.partyAddress ?? '') / (X + W - valX - 8)))
  const rows = Math.max(left.length, right.length + (addrLines - 1), 5)
  const boxH = rows * R + 4
  left.forEach((s, i) => text(s, X + W * 0.059 + 4, boxTop + 3 + i * R, { w: splitX - X - W * 0.059 - 8, bold: i === 0 || (i === 4 && false), size: 9.5 }))
  let ry = boxTop + 3
  right.forEach(([k, v, bold]) => {
    text(k, splitX + 4, ry, { w: valX - splitX - 4, bold: k === 'GST.NO', size: 9 })
    if (k === 'Address') {
      doc.font('Helvetica').fontSize(9.5).fillColor(INK).text(v, valX, ry, { width: X + W - valX - 6 })
      ry += R * addrLines
    } else {
      text(v, valX, ry, { w: X + W - valX - 6, bold: !!bold, size: 9.5 })
      ry += R
    }
  })
  doc.lineWidth(1.2).strokeColor(INK).rect(X, boxTop, W, boxH).stroke()
  vline(X + W * 0.059, boxTop, boxTop + boxH, 0.6)
  vline(splitX, boxTop, boxTop + boxH, 1.2)
  y = boxTop + boxH + 12

  // ── item table ──────────────────────────────────────────────────────────────
  type Col = { head: string; w: number; align: 'left' | 'right' | 'center'; key: string }
  const grandHead = 'Grand Total'
  const cols: Col[] = gst
    ? [
      { head: 'Sr.No.', w: 6.5, align: 'left', key: 'sr' }, { head: 'Vehicle Company', w: 9.5, align: 'left', key: 'veh' },
      { head: 'Product Description', w: 14, align: 'left', key: 'prod' }, { head: 'Tyre Brand', w: 10.5, align: 'left', key: 'brand' },
      { head: 'HSN Code', w: 8, align: 'left', key: 'hsn' }, { head: 'Unit Rate', w: 10, align: 'right', key: 'rate' },
      { head: 'Qty', w: 5, align: 'right', key: 'qty' }, { head: two ? 'Total' : 'Taxable Value', w: 12, align: 'right', key: 'tax' },
      { head: two ? 'GST' : 'Total GST', w: 10.5, align: 'right', key: 'gst' }, { head: grandHead, w: 14.5, align: 'right', key: 'tot' },
    ]
    : [
      { head: 'Sr.No.', w: 6, align: 'left', key: 'sr' }, { head: 'Vehicle Company', w: 14, align: 'left', key: 'veh' },
      { head: 'Product Description', w: 22, align: 'left', key: 'prod' }, { head: 'Tyre Brand', w: 16, align: 'left', key: 'brand' },
      { head: 'Unit Rate', w: 14, align: 'right', key: 'rate' }, { head: 'Qty', w: 8, align: 'right', key: 'qty' },
      { head: 'Amount', w: 20, align: 'right', key: 'tot' },
    ]
  const xs: number[] = []; let acc = X
  const tw = cols.reduce((s, c) => s + c.w, 0)
  cols.forEach((c) => { xs.push(acc); acc += (c.w / tw) * W })
  xs.push(X + W)

  const drawHeader = () => {
    const hh = 26
    doc.lineWidth(0.6).strokeColor(INK).rect(X, y, W, hh).stroke()
    cols.forEach((c, i) => {
      if (i > 0) vline(xs[i]!, y, y + hh)
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(INK)
        .text(c.head, xs[i]! + 3, y + (c.head.includes(' ') && doc.widthOfString(c.head) > xs[i + 1]! - xs[i]! - 6 ? 3 : 9), { width: xs[i + 1]! - xs[i]! - 6, align: c.align, lineGap: -1 })
    })
    y += hh
  }
  const drawRow = (cells: Record<string, string>, bold = false) => {
    doc.lineWidth(0.6).strokeColor(INK).rect(X, y, W, R).stroke()
    cols.forEach((c, i) => {
      if (i > 0) vline(xs[i]!, y, y + R)
      const v = cells[c.key]
      if (v) { const w = xs[i + 1]! - xs[i]! - 6; text(v, xs[i]! + 3, y + 3.5, { w, align: c.align, size: fit(v, w, 8.5, bold), bold }) }
    })
    y += R
  }

  drawHeader()
  const goods = b.lines.filter((l) => !isJob(l))
  const jobs = b.lines.filter(isJob)
  const slotSum = new Map<Slot, number>(); const extras: Array<{ name: string; total: number }> = []
  for (const j of jobs) {
    const s = slotOf(j)
    if (s) slotSum.set(s, (slotSum.get(s) ?? 0) + j.total)
    else extras.push({ name: j.description, total: j.total })
  }
  let n = 0, rowsDrawn = 0
  const room = (rowsNeeded: number) => {
    if (y + rowsNeeded * R > pageBottom() - 110) { doc.addPage(); y = M; drawHeader() }
  }
  for (const l of goods) {
    room(1)
    n++; rowsDrawn++
    const prod = l.size || l.description
    drawRow({
      sr: String(n), veh: b.vehicleMake ?? '', prod, brand: (l.brand ?? '').toUpperCase(), hsn: l.hsn ?? '',
      rate: f2(l.qty > 0 ? l.taxable / l.qty : l.rate), qty: String(Math.round(l.qty * 100) / 100),
      tax: f2(l.taxable), gst: f2(l.total - l.taxable), tot: f2(l.total),
    })
  }
  if (!two) for (const s of SLOTS) { room(1); rowsDrawn++; drawRow({ prod: s, tot: f2(slotSum.get(s) ?? 0) }) }
  else for (const s of SLOTS) if (slotSum.has(s)) { room(1); rowsDrawn++; drawRow({ prod: s, tot: f2(slotSum.get(s)!) }) }
  for (const e of extras) { room(1); rowsDrawn++; drawRow({ prod: e.name, tot: f2(e.total) }) }
  for (let k = rowsDrawn; k < (two ? 5 : 7); k++) { room(1); drawRow({}) }

  // ── totals ──────────────────────────────────────────────────────────────────
  const tr: Array<[string, string, boolean?]> = []
  if (gst) {
    tr.push(['Sub total', f2(b.subtotal)])
    if (b.igstTotal > 0) tr.push(['IGST', f2(b.igstTotal)])
    else tr.push(['CGST', f2(b.cgstTotal)], ['SGST', f2(b.sgstTotal)])
    if (b.roundOff) tr.push(['Round off', f2(b.roundOff)])
  } else if (b.discountTotal > 0) tr.push(['Discount', f2(b.discountTotal)])
  tr.push(['Grand Total', f2(b.grandTotal), true])
  if (b.exchangeValue > 0) tr.push([`Old tyre exchange${b.exchangeQty ? ` (${b.exchangeQty})` : ''}`, `- ${f2(b.exchangeValue)}`])
  const received = Math.max(0, b.paidAmt - b.exchangeValue)
  const balance = Math.max(0, b.grandTotal - b.paidAmt)
  if (balance > 0.004) { if (received > 0.004) tr.push(['Received', `- ${f2(received)}`]); tr.push(['Balance due', f2(balance), true]) }

  const boxH2 = tr.length * R + 6
  if (y + 26 + boxH2 > pageBottom()) { doc.addPage(); y = M }
  y += 24
  const tTop = y
  doc.lineWidth(1.2).strokeColor(INK).rect(X, tTop, W, boxH2).stroke()
  tr.forEach(([k, v, bold], i) => {
    const ty = tTop + 4 + i * R
    text(k, X + W * 0.617, ty, { w: W * 0.25, size: 9.5, bold })
    text(v, X + W * 0.617, ty, { w: W * 0.383 - 5, align: 'right', size: 9.5, bold })
  })
  if (b.notes && !/^imported from/i.test(b.notes)) text(`Note: ${b.notes}`, X + 5, tTop + 4, { w: W * 0.58, size: 8, color: GREY })
  y = tTop + boxH2 + 8
  if (b.customTerms && b.terms.length) {
    doc.font('Helvetica').fontSize(7).fillColor(GREY)
    b.terms.forEach((t, i) => { doc.text(`${i + 1}. ${t}`, X, y, { width: W }); y = doc.y })
  }

  // software credit — always printed, tiny, out of the way
  if (biz.poweredBy) doc.fillColor('#9CA3AF').font('Helvetica').fontSize(6.5)
    .text(biz.poweredBy, X, doc.page.height - 44, { width: W, align: 'center', lineBreak: false })
}
