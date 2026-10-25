// The bill exactly as Shakti Enterprise prints it from their Excel "Car Bill" / "2 Wheel Bill" sheets (Shakti Bill Book.xlsx).
//
// This is not a look-alike: it is the sheet itself, redrawn from its own numbers —
//   · the same 11 columns A..K (widths, including the blank first strip and the blank last column K),
//   · the same row heights (title row 36, tall header row 29, the tall "contact" row on the car bill …),
//   · the same borders (medium box around the customer block and the totals, thin grid in the item table),
//   · the same font (Calibri → Carlito, its metric-compatible twin: identical letter widths),
//   · the sheet's own page setup: A4, margins 0.7" / 0.75", scaled to fit the page width (what Excel prints),
//   · the same number formats: unit rate / taxable / GST / totals with 2 decimals, the Grand Total column as plain numbers.
//
// Differences from the spreadsheet, on purpose: "Alignment" / "Description" are spelt correctly, the shop's emblem sits at the
// left of the title band, a bill with more lines simply gets more rows (and a second page when it must), and a blank
// customer mobile prints nothing instead of "0".
//
//   Car bill:       Sr.No. | Vehicle Company | Product Description | Tyre Brand | HSN Code | Unit Rate | Qty | Taxable Value | Total GST | Grand Total
//                   + fixed rows Alignment / Balancing / Weight Charge / Labour Charge (amount in the Grand Total column)
//   Two-wheeler:    same, with "Total | GST" and no fixed charge rows.
//   Cash memo:      same frame, no HSN / GST columns and no tax lines.

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { InvoicePdfData, BusinessHeader } from './tyre-pdf.js'

// The shop's emblem, printed at the left of the title band. A deployment serves one shop, so the file is
// assets/shop-logo.png (transparent PNG, any square size); BILL_LOGO_FILE points elsewhere. No file = no logo.
const LOGO_PATH = process.env['BILL_LOGO_FILE'] || fileURLToPath(new URL('../../assets/shop-logo.png', import.meta.url))
const LOGO: Buffer | null = existsSync(LOGO_PATH) ? readFileSync(LOGO_PATH) : null

// Calibri's free metric-compatible twin (SIL Open Font License). Without the files the bill falls back to Helvetica.
const FONT_DIR = fileURLToPath(new URL('../../assets/fonts/', import.meta.url))
const FONT_FILES = { regular: `${FONT_DIR}Carlito-Regular.ttf`, bold: `${FONT_DIR}Carlito-Bold.ttf` }
const FONT_BUF = existsSync(FONT_FILES.regular) && existsSync(FONT_FILES.bold)
  ? { regular: readFileSync(FONT_FILES.regular), bold: readFileSync(FONT_FILES.bold) } : null

const TEAL = '#31859C'
const PEACH = '#FDE9D9'
const INK = '#000000'

// ── the sheet's geometry ─────────────────────────────────────────────────────────────────────────────────────────────
const PX = 0.75                                                // one Excel pixel, in points
const COLS = [64, 83, 163, 92, 92, 97, 64, 64, 77, 169, 97]    // A..K in pixels (A, G, H are the default 8.43-character width)
const ROW = 14.5                                               // the default row height, points
const A4_MARGIN_X = 0.7 * 72, A4_MARGIN_TOP = 0.75 * 72, A4_MARGIN_BOTTOM = 0.75 * 72

const f2 = (n: unknown): string => (Math.round((Number(n ?? 0) + Number.EPSILON) * 100) / 100).toFixed(2)
/** Excel's "General" format: whole numbers plain, otherwise no needless zeros */
const general = (n: unknown): string => String(Math.round((Number(n ?? 0) + Number.EPSILON) * 100) / 100)
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

type Align = 'left' | 'right' | 'center'

export function drawShaktiBill(doc: PDFKit.PDFDocument, b: InvoicePdfData, biz: BusinessHeader): void {
  const two = b.billKind === 'two_wheel'
  const gst = b.gstBill !== false

  if (FONT_BUF) { doc.registerFont('Calibri', FONT_BUF.regular); doc.registerFont('Calibri-Bold', FONT_BUF.bold) }
  const face = (bold: boolean) => (FONT_BUF ? (bold ? 'Calibri-Bold' : 'Calibri') : (bold ? 'Helvetica-Bold' : 'Helvetica'))

  // Excel "fit to page": the sheet's width is scaled onto the printable width of the A4 page
  const sheetW = COLS.reduce((a, c) => a + c, 0) * PX
  const availW = doc.page.width - 2 * A4_MARGIN_X
  const S = availW / sheetW
  const SY = S * 0.938                                              // rows and type (measured: Excel's own PDF is 6 % tighter vertically than the column widths imply)
  const left = A4_MARGIN_X
  const colLeft = (i: number) => left + COLS.slice(0, i).reduce((a, c) => a + c, 0) * PX * S
  const colW = (i: number, j = i) => COLS.slice(i, j + 1).reduce((a, c) => a + c, 0) * PX * S
  const PAD = 2 * PX * S                                           // Excel's 2-pixel cell padding
  const THIN = 0.9375 * S, MEDIUM = 1.875 * S                      // line weights as Excel draws them
  const pageBottom = () => doc.page.height - A4_MARGIN_BOTTOM

  let y = A4_MARGIN_TOP

  // ── drawing helpers ────────────────────────────────────────────────────────────────────────────────────────────
  const hline = (x1: number, x2: number, yy: number, w: number) => doc.lineWidth(w).strokeColor(INK).moveTo(x1, yy).lineTo(x2, yy).stroke()
  const vline = (xx: number, y1: number, y2: number, w: number) => doc.lineWidth(w).strokeColor(INK).moveTo(xx, y1).lineTo(xx, y2).stroke()

  /** text in a cell range (first..last column), bottom-aligned like Excel; a long value shrinks to fit instead of being cut */
  const text = (t: string, c1: number, c2: number, rowTop: number, rowH: number, o: { bold?: boolean; size?: number; align?: Align; color?: string; wrap?: boolean; underline?: boolean } = {}) => {
    if (!t) return
    const size = (o.size ?? 11) * SY
    const w = colW(c1, c2) - 2 * PAD
    let fs = size
    doc.font(face(!!o.bold))
    if (!o.wrap) { while (fs > 4 && doc.fontSize(fs).widthOfString(t) > w) fs -= 0.2 }
    doc.fontSize(fs).fillColor(o.color ?? INK)
    const h = o.wrap ? doc.heightOfString(t, { width: w }) : fs * 1.22
    const ty = rowTop + rowH - h - PAD * 0.55
    doc.text(t, colLeft(c1) + PAD, ty, { width: w, align: o.align ?? 'left', lineBreak: !!o.wrap, underline: o.underline, lineGap: 0 })
  }

  // ── rows 2-4: the title band, address, contact ─────────────────────────────────────────────────────────────────
  y += ROW * SY                                                     // row 1 is empty
  const titleH = 36 * SY
  doc.rect(colLeft(1), y, colW(1, 10), titleH).fill(PEACH)
  text(biz.name.toUpperCase(), 1, 9, y, titleH, { bold: true, size: 28, align: 'center', color: TEAL })
  {
    // double underline, as the sheet has it, just under the title text
    const tf = doc.font(face(true)).fontSize(28 * SY)
    let tw = 0
    { let fs = 28 * SY; while (fs > 4 && doc.fontSize(fs).widthOfString(biz.name.toUpperCase()) > colW(1, 9) - 2 * PAD) fs -= 0.2; tw = doc.fontSize(fs).widthOfString(biz.name.toUpperCase()) }
    void tf
    const ux = colLeft(1) + (colW(1, 9) - tw) / 2
    doc.rect(ux, y + titleH * 0.789, tw, titleH * 0.05).fill(TEAL)
    doc.rect(ux, y + titleH * 0.889, tw, titleH * 0.05).fill(TEAL)
  }
  if (LOGO) doc.image(LOGO, left + PAD, y - 1, { fit: [titleH + 2 * ROW * SY, titleH + 2 * ROW * SY] })
  y += titleH
  const contact = [biz.phone && `Co.No. ${biz.phone}`, biz.email && `Email ID: ${biz.email}`].filter(Boolean).join('    ')
  if (biz.address) text(biz.address, 1, 10, y, ROW * SY, { bold: true, align: 'center' })
  y += ROW * SY
  if (contact) text(contact, 1, 10, y, ROW * SY, { bold: true, align: 'center' })
  y += ROW * SY

  // ── row 5: the three labels; rows 7-8: bill number, date, PO ──────────────────────────────────────────────────
  text('Debit Memo', 1, 4, y, ROW * SY, { bold: true })
  text(b.docLabel ?? (gst ? 'Tax Invoice' : 'Cash Memo'), 5, 8, y, ROW * SY, { bold: true })
  if (!b.isDocument) text(b.copyLabel ?? 'Original', 9, 10, y, ROW * SY, { bold: true })      // a quotation is not a copy of anything
  y += ROW * SY
  y += ROW * SY                                                     // row 6
  text('Bill No. -', 1, 1, y, ROW * SY)
  text(String(b.number), 2, 2, y, ROW * SY, { align: 'right' })
  const po = [b.poNo && `PO No.: ${b.poNo}`, `PO Date: ${b.poDate ? dmy(b.poDate) : ''}`].filter(Boolean).join('    ')
  text(po, 6, 10, y, ROW * SY)
  y += ROW * SY
  text('Date:', 1, 1, y, 15 * SY)
  text(dmy(b.date), 2, 2, y, 15 * SY, { align: 'right' })
  y += 15 * SY

  // ── rows 9-13: the two boxes ───────────────────────────────────────────────────────────────────────────────────
  const boxTop = y
  const wideAddress = (b.partyAddress ?? '').length > 30
  // the car sheet's 4th row is the tall one (58); on the two-wheeler sheet it is normal height, and grows only for a long address
  const rh = [ROW, ROW, ROW, two ? (wideAddress ? ROW * 2 : ROW) : 58, 15].map((h) => h * SY)
  const ry = [boxTop]; rh.forEach((h, i) => ry.push(ry[i]! + h))
  // left box: the shop itself, as on the sheet
  text('Bill To,', 1, 5, ry[0]!, rh[0]!, { bold: true })
  text(biz.name, 1, 5, ry[1]!, rh[1]!)
  if (biz.address) text(biz.address, 1, 5, ry[2]!, rh[2]!)
  if (contact) text(contact, 1, 5, ry[3]!, rh[3]!)
  if (biz.gstin) text(`GST No.: ${biz.gstin}`, 1, 5, ry[4]!, rh[4]!)
  // right box: the customer
  text('GST.NO', 6, 6, ry[0]!, rh[0]!, { bold: true })
  text(gst ? (b.partyGstin ?? '') : '', 7, 10, ry[0]!, rh[0]!, { bold: true })
  text('Customer Name:', 6, 7, ry[1]!, rh[1]!)
  text(b.partyName || 'Walk-in customer', 8, 10, ry[1]!, rh[1]!)
  text('Mobile Number', 6, 7, ry[2]!, rh[2]!)
  text(b.partyPhone ?? '', 8, 10, ry[2]!, rh[2]!)
  text('Address', 6, 7, ry[3]!, rh[3]!)
  if (two) text(b.partyAddress ?? '', 8, 10, ry[3]!, rh[3]!, { wrap: true })
  else text(b.partyAddress ?? '', 9, 10, ry[3]!, rh[3]!, { wrap: true })
  text('Vehicle Number:', 6, 7, ry[4]!, rh[4]!)
  text(b.vehicleNo ?? '', 8, 10, ry[4]!, rh[4]!)
  const boxBottom = ry[5]!
  // medium borders: outer box, the strip after column A, and the line between the shop and the customer
  const right = colLeft(10) + colW(10)
  hline(left, right, boxTop, MEDIUM); hline(left, right, boxBottom, MEDIUM)
  vline(left, boxTop, boxBottom, MEDIUM); vline(colLeft(1), boxTop, boxBottom, MEDIUM)
  vline(colLeft(6), boxTop, boxBottom, MEDIUM); vline(right, boxTop, boxBottom, MEDIUM)
  y = boxBottom + ROW * SY                                          // row 14

  // ── the item table ─────────────────────────────────────────────────────────────────────────────────────────────
  const heads: string[] = gst
    ? ['Sr.No.', 'Vehicle Company', 'Product Description', 'Tyre Brand', 'HSN Code', 'Unit Rate', 'Qty', two ? 'Total' : 'Taxable Value', two ? 'GST' : 'Total GST', 'Grand Total', '']
    : ['Sr.No.', 'Vehicle Company', 'Product Description', 'Tyre Brand', '', 'Unit Rate', 'Qty', '', '', 'Amount', '']
  const rightCols = new Set([5, 6, 7, 8, 9])                       // F..J hold numbers → right aligned; A (serial) and E (HSN) too when numeric

  const gridRow = (h: number, cells: string[], bold = false, wrap = false) => {
    if (y + h > pageBottom() - 8 * ROW * SY) { newPage(); header() }
    cells.forEach((v, i) => {
      doc.lineWidth(THIN).strokeColor(INK).rect(colLeft(i), y, colW(i), h).stroke()
      const num = !bold && (i === 0 || i === 4 ? /^\d+$/.test(v) : rightCols.has(i))      // header text stays left-aligned, as in the sheet
      if (v) text(v, i, i, y, h, { bold, wrap, align: num ? 'right' : 'left' })
    })
    y += h
  }
  const header = () => gridRow(29 * SY, heads, true, true)
  const newPage = () => { doc.addPage(); y = A4_MARGIN_TOP }

  header()
  const goods = b.lines.filter((l) => !isJob(l))
  const jobs = b.lines.filter(isJob)
  const slotSum = new Map<Slot, number>(); const extras: Array<{ name: string; total: number }> = []
  for (const j of jobs) {
    const s = slotOf(j)
    if (s) slotSum.set(s, (slotSum.get(s) ?? 0) + j.total)
    else extras.push({ name: j.description, total: j.total })
  }
  let n = 0, drawn = 0
  for (const l of goods) {
    n++; drawn++
    const q = Number(l.qty)
    const rate = q > 0 ? l.taxable / q : l.rate
    gridRow(ROW * SY, gst
      ? [String(n), b.vehicleMake ?? '', l.size || l.description, (l.brand ?? '').toUpperCase(), l.hsn ?? '', f2(rate), String(Math.round(q * 100) / 100), f2(l.taxable), f2(l.total - l.taxable), general(l.total), '']
      : [String(n), b.vehicleMake ?? '', l.size || l.description, (l.brand ?? '').toUpperCase(), '', f2(l.total / (q || 1)), String(Math.round(q * 100) / 100), '', '', general(l.total), ''])
  }
  const chargeRow = (label: string, amount: number) => { drawn++; gridRow(ROW * SY, ['', '', label, '', '', '', '', '', '', general(amount), '']) }
  if (!two) for (const s of SLOTS) chargeRow(s, slotSum.get(s) ?? 0)
  else for (const s of SLOTS) if (slotSum.has(s)) chargeRow(s, slotSum.get(s)!)
  for (const e of extras) chargeRow(e.name, e.total)
  for (let k = drawn; k < (two ? 5 : 7); k++) { drawn++; gridRow(ROW * SY, Array(11).fill('')) }      // the sheet's spare rows

  // ── totals box ──────────────────────────────────────────────────────────────────────────────────────────────────
  const tr: Array<[string, string]> = []
  if (gst) {
    tr.push(['Sub total', f2(b.subtotal)])
    if (b.igstTotal > 0) tr.push(['IGST', f2(b.igstTotal)])
    else tr.push(['CGST', f2(b.cgstTotal)], ['SGST', f2(b.sgstTotal)])
    if (b.roundOff) tr.push(['Round off', f2(b.roundOff)])
  } else if (b.discountTotal > 0) tr.push(['Discount', f2(b.discountTotal)])
  tr.push(['Grand Total', f2(b.grandTotal)])
  if (b.exchangeValue > 0 && !b.isDocument) tr.push([`Old tyre exchange${b.exchangeQty ? ` (${b.exchangeQty})` : ''}`, `- ${f2(b.exchangeValue)}`])
  const received = Math.max(0, b.paidAmt - b.exchangeValue)
  const balance = Math.max(0, b.grandTotal - b.paidAmt)
  if (balance > 0.004 && !b.isDocument) { if (received > 0.004) tr.push(['Received', `- ${f2(received)}`]); tr.push(['Balance due', f2(balance)]) }

  const gap = two ? 3 : 1                                          // blank rows between the grid and "Sub total" (sides only)
  const totalsH = gap * ROW * SY + (tr.length - 1) * ROW * SY + 15 * SY
  if (y + totalsH > pageBottom() - 14) { newPage(); header() }
  const tTop = y
  y += gap * ROW * SY
  tr.forEach(([k, v], i) => {
    const h = (i === tr.length - 1 ? 15 : ROW) * SY
    text(k, 7, 8, y, h)
    text(v, 10, 10, y, h, { align: 'right' })
    y += h
  })
  const tBottom = y
  if (b.notes && !/^imported from/i.test(b.notes)) text(`Note: ${b.notes}`, 1, 5, tTop + gap * ROW * SY, ROW * SY, { size: 9, color: '#6B7280' })
  vline(left, tTop, tBottom, MEDIUM); vline(right, tTop, tBottom, MEDIUM); hline(left, right, tBottom, MEDIUM)
  y = tBottom + 6
  if (b.customTerms && b.terms.length) {
    doc.font(face(false)).fontSize(7).fillColor('#6B7280')
    b.terms.forEach((t, i) => { doc.text(`${i + 1}. ${t}`, left, y, { width: availW }); y = doc.y })
  }

  // software credit — always printed, tiny, out of the way
  if (biz.poweredBy) doc.fillColor('#9CA3AF').font('Helvetica').fontSize(6.5)
    .text(biz.poweredBy, left, doc.page.height - 44, { width: availW, align: 'center', lineBreak: false })
}
