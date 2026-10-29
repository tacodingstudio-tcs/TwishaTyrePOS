// The bill in the shop's boxed "Tax Invoice" format (grey title band with emblem, serif shop name, boxed customer block,
// full-height item table, boxed totals, "For, <shop>" / Authorised Signatory).
//
// The CONTENT is the shop's Excel bill book (Shakti Bill Book.xlsx), unchanged:
//   Car bill:       Sr.No. | Vehicle Company | Product Description | Tyre Brand | HSN Code | Unit Rate | Qty | Taxable Value | Total GST | Grand Total
//                   + fixed rows Alignment / Balancing / Weight Charge / Labour Charge (amount in the Grand Total column)
//   Two-wheeler:    same, with "Total | GST" and no fixed charge rows.
//   Cash memo:      same frame, no HSN / GST columns and no tax lines.
//   Header fields:  Debit Memo / Tax Invoice / Original, Bill No., Date, PO No. / PO Date, Bill To (the shop, GST No.),
//                   GST.NO, Customer Name, Mobile Number, Address, Vehicle Number.

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { InvoicePdfData, BusinessHeader } from './tyre-pdf.js'

// The shop's emblem, printed at the left of the title band. A deployment serves one shop, so the file is
// assets/shop-logo.png (transparent PNG, any square size); BILL_LOGO_FILE points elsewhere. No file = no logo.
const LOGO_PATH = process.env['BILL_LOGO_FILE'] || fileURLToPath(new URL('../../assets/shop-logo.png', import.meta.url))
const LOGO: Buffer | null = existsSync(LOGO_PATH) ? readFileSync(LOGO_PATH) : null

// Calibri's free metric-compatible twin (SIL Open Font License). Without the files the bill falls back to Helvetica.
const FONT_DIR = fileURLToPath(new URL('../../assets/fonts/', import.meta.url))
const FONT_FILES = { regular: `${FONT_DIR}Carlito-Regular.ttf`, bold: `${FONT_DIR}Carlito-Bold.ttf`, italic: `${FONT_DIR}Carlito-Italic.ttf` }
const FONT_BUF = existsSync(FONT_FILES.regular) && existsSync(FONT_FILES.bold)
  ? {
      regular: readFileSync(FONT_FILES.regular), bold: readFileSync(FONT_FILES.bold),
      italic: existsSync(FONT_FILES.italic) ? readFileSync(FONT_FILES.italic) : null,
    } : null

const INK = '#000000'
const GREY = '#E4E4E4'
const MUTED = '#444444'

// ── formatting ───────────────────────────────────────────────────────────────────────────────────────────────────────
/** Indian digit grouping with 2 decimals: 4,57,326.50 */
const money = (n: unknown): string =>
  (Math.round((Number(n ?? 0) + Number.EPSILON) * 100) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const qtyText = (n: unknown): string => {
  const v = Math.round((Number(n ?? 0) + Number.EPSILON) * 100) / 100
  return Number.isInteger(v) ? String(v) : v.toFixed(2)
}
const dmy = (v: unknown): string => {
  if (!v) return ''
  const d = v instanceof Date ? v : new Date(String(v))
  if (isNaN(d.getTime())) return String(v)
  const p = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Asia/Kolkata' }).formatToParts(d)
  const g = (t: string) => p.find((x) => x.type === t)!.value
  return `${g('day')}/${g('month')}/${g('year')}`
}


const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen',
  'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen']
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety']
function below1000(n: number): string {
  const out: string[] = []
  if (n >= 100) { out.push(`${ONES[Math.floor(n / 100)]} Hundred`); n %= 100 }
  if (n >= 20) { out.push(TENS[Math.floor(n / 10)]!); n %= 10 }
  if (n > 0) out.push(ONES[n]!)
  return out.join(' ')
}
function wholeInWords(n: number): string {
  if (n === 0) return 'Zero'
  const parts: string[] = []
  const crore = Math.floor(n / 1e7); n %= 1e7
  const lakh = Math.floor(n / 1e5); n %= 1e5
  const thousand = Math.floor(n / 1e3); n %= 1e3
  if (crore) parts.push(`${below1000(crore)} Crore`)
  if (lakh) parts.push(`${below1000(lakh)} Lakh`)
  if (thousand) parts.push(`${below1000(thousand)} Thousand`)
  if (n) parts.push(below1000(n))
  return parts.join(' ')
}
/** "Eighty Two Thousand Three Hundred Eighteen And Seventy Seven Paise Only" */
export function amountInWords(amount: number): string {
  const paise = Math.round((Math.abs(amount) + Number.EPSILON) * 100)
  const rupees = Math.floor(paise / 100), ps = paise % 100
  const r = rupees > 0 || ps === 0 ? wholeInWords(rupees) : ''
  const p = ps > 0 ? `${below1000(ps)} Paise` : ''
  return `${[r, p].filter(Boolean).join(' And ')} Only`
}

// printed under the totals of every sale bill (not on quotations / orders)
const WARRANTY_HEAD = 'TYRE WARRANTY & CLAIM TERMS'
const WARRANTY_TERMS = [
  "Warranty is subject to the tyre manufacturer's terms and conditions.",
  'Original purchase bill is mandatory for warranty claims.',
  "Repaired tyres/tubes may not be eligible for warranty claims, as per the manufacturer's policy.",
  'Replacement is subject to manufacturer approval.',
  'Applicable depreciation/wear-and-tear charges, service charges and GST shall be payable by the customer as per the approved claim assessment.',
  "Warranty on replacement tyres/tubes shall be as per the manufacturer's applicable policy.",
  "All claims are subject to the manufacturer's warranty terms and conditions.",
]
const WARRANTY_W = 0.66                                             // share of the bill width the terms may use (the signature sits on the right)

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
  const gst = b.gstBill !== false
  const two = b.billKind === 'two_wheel'

  if (FONT_BUF) {
    doc.registerFont('Calibri', FONT_BUF.regular); doc.registerFont('Calibri-Bold', FONT_BUF.bold)
    if (FONT_BUF.italic) doc.registerFont('Calibri-Italic', FONT_BUF.italic)
  }
  const face = (bold: boolean, italic = false) => FONT_BUF
    ? (bold ? 'Calibri-Bold' : italic && FONT_BUF.italic ? 'Calibri-Italic' : 'Calibri')
    : (bold ? 'Helvetica-Bold' : italic ? 'Helvetica-Oblique' : 'Helvetica')

  const M = 20
  const W = doc.page.width - 2 * M
  const L = M, R = M + W
  const pageTop = M, pageBottom = doc.page.height - M

  type O = { bold?: boolean; italic?: boolean; size?: number; align?: 'left' | 'right' | 'center'; color?: string; font?: string }
  /** one line of text, shrunk to fit the width; returns nothing */
  const put = (t: string, x: number, y: number, w: number, o: O = {}) => {
    if (!t) return
    let fs = o.size ?? 11
    doc.font(o.font ?? face(!!o.bold, !!o.italic))
    while (fs > 5 && doc.fontSize(fs).widthOfString(t) > w) fs -= 0.25
    doc.fontSize(fs).fillColor(o.color ?? INK).text(t, x, y, { width: w, align: o.align ?? 'left', lineBreak: false })
  }
  /** wrapped text; returns its height */
  const para = (t: string, x: number, y: number, w: number, o: O = {}, maxH?: number): number => {
    if (!t) return 0
    doc.font(o.font ?? face(!!o.bold, !!o.italic)).fontSize(o.size ?? 11)
    const h = doc.heightOfString(t, { width: w })
    doc.fillColor(o.color ?? INK).text(t, x, y, { width: w, align: o.align ?? 'left', ...(maxH ? { height: maxH, ellipsis: true } : {}) })
    return maxH ? Math.min(h, maxH) : h
  }
  const hline = (x1: number, x2: number, y: number, w = 0.8) => doc.lineWidth(w).strokeColor(INK).moveTo(x1, y).lineTo(x2, y).stroke()
  const vline = (x: number, y1: number, y2: number, w = 0.8) => doc.lineWidth(w).strokeColor(INK).moveTo(x, y1).lineTo(x, y2).stroke()

  // ── columns (the totals box lines up with the table's column lines) ─────────────────────────────────────────────────
  type Col = { head: string; w: number; align: 'left' | 'right' | 'center' }
  const cols: Col[] = gst
    ? [{ head: 'Sr.No.', w: 0.07, align: 'center' }, { head: 'Vehicle Company', w: 0.1, align: 'left' }, { head: 'Product Description', w: 0.16, align: 'left' },
       { head: 'Tyre Brand', w: 0.12, align: 'left' }, { head: 'HSN Code', w: 0.07, align: 'right' }, { head: 'Unit Rate', w: 0.1, align: 'right' },
       { head: 'Qty', w: 0.05, align: 'right' }, { head: two ? 'Total' : 'Taxable Value', w: 0.11, align: 'right' }, { head: two ? 'GST' : 'Total GST', w: 0.09, align: 'right' },
       { head: 'Grand Total', w: 0.125, align: 'right' }]
    : [{ head: 'Sr.No.', w: 0.06, align: 'center' }, { head: 'Vehicle Company', w: 0.16, align: 'left' }, { head: 'Product Description', w: 0.3, align: 'left' },
       { head: 'Tyre Brand', w: 0.16, align: 'left' }, { head: 'Unit Rate', w: 0.12, align: 'right' }, { head: 'Qty', w: 0.07, align: 'right' }, { head: 'Amount', w: 0.13, align: 'right' }]
  const total = cols.reduce((a, c) => a + c.w, 0)
  const xs: number[] = [L]
  cols.forEach((c) => xs.push(xs[xs.length - 1]! + (c.w / total) * W))
  const colX = (i: number) => xs[i]!, colW = (i: number) => xs[i + 1]! - xs[i]!
  // ── footer geometry (needed first: the item table stops above it) ──────────────────────────────────────────────────
  const splitX = xs[gst ? 7 : 4]!                                   // continues the table's Qty | Taxable Value line down through the totals
  const contact = [biz.phone && `Co.No. ${biz.phone}`, biz.email && `Email ID: ${biz.email}`].filter(Boolean).join('    ')
  const sums: Array<[string, string]> = []
  if (gst) {
    sums.push(['Taxable Amount', money(b.subtotal)])
    if (b.igstTotal > 0) sums.push(['IGST', money(b.igstTotal)])
    else sums.push(['CGST', money(b.cgstTotal)], ['SGST', money(b.sgstTotal)])
    sums.push(['Round Off', money(b.roundOff)])
  } else if (b.discountTotal > 0) sums.push(['Discount', money(b.discountTotal)])
  const after: Array<[string, string]> = []
  if (b.exchangeValue > 0 && !b.isDocument) after.push([`Old tyre exchange${b.exchangeQty ? ` (${b.exchangeQty})` : ''}`, `- ${money(b.exchangeValue)}`])
  const received = Math.max(0, b.paidAmt - b.exchangeValue)
  const balance = Math.max(0, b.grandTotal - b.paidAmt)
  if (balance > 0.004 && !b.isDocument) { if (received > 0.004) after.push(['Received', `- ${money(received)}`]); after.push(['Balance due', money(balance)]) }

  const totalGst = b.cgstTotal + b.sgstTotal + b.igstTotal
  const subRowH = gst ? 24 : 0
  const rightH = subRowH + 6 + sums.length * 15 + (sums.length ? 6 : 0) + 32 + after.length * 15 + (after.length ? 4 : 0)
  const showTerms = b.customTerms && b.terms.length
  const note = b.notes && !/^imported from/i.test(b.notes) ? b.notes : ''
  const wordsW = splitX - L - 112
  const wordsH = (t: string) => { doc.font(face(false, true)).fontSize(10.5); return Math.max(16, doc.heightOfString(t, { width: wordsW }) + 6) }
  const gstWordsH = gst ? wordsH(amountInWords(totalGst)) : 0
  const billWordsH = wordsH(amountInWords(b.grandTotal))
  // bank details the shop saved in My Business → Edit business (printed only when filled in)
  const QR = 72                                                      // the scan-and-pay QR (a bill with a balance, when the shop has saved its UPI ID)
  const bank = ([['Bank Name', biz.bankName], ['Bank A/c No.', biz.bankAccount], ['RTGS/IFSC Code', biz.bankIfsc], ['UPI ID', b.payQr?.upiId]] as Array<[string, string | null | undefined]>)
    .filter(([, v]) => v && String(v).trim()) as Array<[string, string]>
  const bankH = bank.length || b.payQr ? Math.max(8 + bank.length * 14 + (b.payQr ? 18 : 0) + 4, b.payQr ? 8 + QR + 4 : 0) : 0
  // the Note strip sits above the Received / Balance lines of the right-hand box, so the left side must leave room for them too
  const leftH = subRowH + bankH + 8 + (gst ? gstWordsH + 10 : 0) + billWordsH + 10 + 32 + after.length * 15 + (after.length ? 4 : 0)
  const footBoxH = Math.max(rightH, leftH)

  const showDecl = !b.isDocument
  doc.font(face(false)).fontSize(8.5)
  const termsH = WARRANTY_TERMS.reduce((a, t) => a + doc.heightOfString(t, { width: W * WARRANTY_W - 16 }) + 1.5, 0)
  let declH = showDecl ? 26 + termsH : 50
  if (showTerms) {
    doc.font(face(false, true)).fontSize(9)
    declH += b.terms.reduce((a, t, i) => a + doc.heightOfString(`${i + 1}. ${t}`, { width: W * 0.62 }) + 1, 0)
  }
  const poweredH = 0
  const footTop = pageBottom - poweredH - declH - footBoxH

  /** the heavy border round the whole sheet, on every page */
  const pageBorder = () => doc.lineWidth(2.2).strokeColor(INK).rect(L, pageTop, W, pageBottom - pageTop).stroke()

  // ── page frame + title block ───────────────────────────────────────────────────────────────────────────────────────
  const frame = (): number => {
    let y = pageTop
    const titleH = 50
    doc.rect(L, y, W, titleH).fill(GREY)
    const name = biz.name.toUpperCase()
    let fs = 27
    doc.font('Times-Bold')
    while (fs > 8 && doc.fontSize(fs).widthOfString(name) > W - 130) fs -= 0.5
    doc.fontSize(fs).fillColor(INK).text(name, L + 65, y + (titleH - fs * 1.1) / 2, { width: W - 130, align: 'center', lineBreak: false })
    if (LOGO) doc.image(LOGO, L + 8, y + 4, { fit: [titleH - 8, titleH - 8] })
    y += titleH
    hline(L, R, y, 0.8)
    const contact = [biz.phone && `Co.No. ${biz.phone}`, biz.email && `Email ID: ${biz.email}`].filter(Boolean).join('    ')
    y += 7
    if (biz.address) { put(biz.address.toUpperCase(), L + 10, y, W - 20, { size: 12, align: 'center' }); y += 16 }
    if (contact) { put(contact, L + 10, y, W - 20, { size: 10, align: 'center' }); y += 14 }
    y += 6
    hline(L, R, y, 0.8)
    // Debit Memo | TAX INVOICE | Original
    const stripH = 24
    put('Debit Memo', L + 10, y + 6, 120, { bold: true, size: 12 })
    put((b.docLabel ?? (gst ? 'Tax Invoice' : 'Cash Memo')).toUpperCase(), L + 140, y + 4, W - 280, { bold: true, size: 15, align: 'center' })
    if (!b.isDocument) put(b.copyLabel ?? 'Original', R - 130, y + 6, 120, { bold: true, size: 12, align: 'right' })
    y += stripH
    hline(L, R, y, 0.8)
    return y
  }

  // ── customer block: the shop ("Bill To,") on the left, bill / customer details in the grey box ──────────────────────
  const customerBlock = (top: number): number => {
    const custX = xs[gst ? 4 : 3]!                                   // the divider continues a table line (HSN Code | Tyre Brand on a cash memo)
    const rows: Array<[string, string]> = [
      ['Bill No. -', String(b.number)], ['Date:', dmy(b.date)],
      ['PO No.:', b.poNo ?? ''], ['PO Date:', b.poDate ? dmy(b.poDate) : ''],
      ['GST.NO', gst ? (b.partyGstin ?? '') : ''], ['Customer Name:', b.partyName || 'Walk-in customer'],
      ['Mobile Number', b.partyPhone ?? ''], ['Address', b.partyAddress ?? ''], ['Vehicle Number:', b.vehicleNo ?? ''],
    ]
    const rh = 15
    const h = 8 + rows.length * rh + 4
    doc.rect(custX, top, R - custX, h).fill(GREY)
    put('Bill To,', L + 10, top + 6, custX - L - 20, { bold: true, size: 12 })
    put(biz.name, L + 10, top + 6 + rh, custX - L - 20, { size: 12 })
    let sy = top + 6 + 2 * rh
    if (biz.address) sy += para(biz.address, L + 10, sy, custX - L - 20, { size: 11 }, 30) + 2
    if (contact) sy += para(contact, L + 10, sy, custX - L - 20, { size: 11 }, 30) + 2
    if (biz.gstin && !gst) put(`GST No.: ${biz.gstin}`, L + 10, top + h - rh - 2, custX - L - 20, { size: 11 })
    rows.forEach(([k, v], i) => {
      const ry = top + 8 + i * rh
      put(k, custX + 10, ry, 84, { bold: true, size: 11 })
      if (v) put(v, custX + 94, ry, R - custX - 100, { size: 11, bold: k === 'GST.NO' })
    })
    vline(custX, top, top + h, 0.8)
    hline(L, R, top + h, 0.8)
    return top + h
  }

  // ── item table: the shop's own columns ─────────────────────────────────────────────────────────────────────────────
  const PADX = 4
  const DESC = 2

  const tableHead = (y: number): number => {
    const h = 30
    doc.rect(L, y, W, h).fill(GREY)
    cols.forEach((c, i) => para(c.head, colX(i) + PADX, y + 3, colW(i) - 2 * PADX, { bold: true, size: 9.5, align: 'center' }))
    hline(L, R, y, 0.8); hline(L, R, y + h, 0.8)
    verticals(y, y + h)                                              // the column lines run through the heading row too
    return y + h
  }
  const verticals = (top: number, bottom: number) => xs.slice(1, -1).forEach((x) => vline(x, top, bottom, 0.8))
  const outerBox = (top: number, bottom: number) => { vline(L, top, bottom, 0.8); vline(R, top, bottom, 0.8) }

  let y = frame()
  y = customerBlock(y)
  let tableTop = y
  y = tableHead(y)
  let bodyTop = y
  // every page but the last uses its full height; only the last page keeps room for the totals box
  const bodyLimit = pageBottom - 2

  const closeBody = (bottom: number) => { verticals(bodyTop, bottom); outerBox(tableTop, bottom) }
  const nextPage = (bottom: number) => {
    closeBody(bottom)
    pageBorder()                                                     // last, so the grey bands do not cover half of it
    doc.addPage()
    tableTop = pageTop
    y = tableHead(pageTop)
    bodyTop = y
  }
  const pending: string[][] = []
  const row = (cells: string[]) => { pending.push(cells) }
  const rowHeight = (cells: string[]) => {
    doc.font(face(false)).fontSize(11)
    return Math.max(18, doc.heightOfString(cells[DESC] ?? '', { width: colW(DESC) - 2 * PADX }) + 8)
  }
  const drawRow = (cells: string[], h: number) => {
    if (y + h > bodyLimit) nextPage(pageBottom)
    cells.forEach((v, i) => {
      if (!v) return
      if (i === DESC) para(v, colX(i) + PADX, y + 4, colW(i) - 2 * PADX, { size: 11 })
      else put(v, colX(i) + PADX, y + 4, colW(i) - 2 * PADX, { size: 11, align: cols[i]!.align })
    })
    y += h
  }

  const goods = b.lines.filter((l) => !isJob(l))
  const jobs = b.lines.filter(isJob)
  const slotSum = new Map<Slot, number>(); const extras: Array<{ name: string; total: number }> = []
  for (const j of jobs) {
    const s = slotOf(j)
    if (s) slotSum.set(s, (slotSum.get(s) ?? 0) + j.total)
    else extras.push({ name: j.description, total: j.total })
  }
  goods.forEach((l, i) => {
    const q = Number(l.qty)
    const rate = q > 0 ? l.taxable / q : l.rate
    row(gst
      ? [String(i + 1), b.vehicleMake ?? '', l.size || l.description, (l.brand ?? '').toUpperCase(), l.hsn ?? '', money(rate), qtyText(q), money(l.taxable), money(l.total - l.taxable), money(l.total)]
      : [String(i + 1), b.vehicleMake ?? '', l.size || l.description, (l.brand ?? '').toUpperCase(), money(l.total / (q || 1)), qtyText(q), money(l.total)])
  })
  const chargeRow = (label: string, amount: number) => {
    const c = Array(cols.length).fill('') as string[]
    c[DESC] = label; c[cols.length - 1] = money(amount)
    row(c)
  }
  if (!two) for (const s of SLOTS) chargeRow(s, slotSum.get(s) ?? 0)
  else for (const s of SLOTS) if (slotSum.has(s)) chargeRow(s, slotSum.get(s)!)
  for (const e of extras) chargeRow(e.name, e.total)
  // the totals did not fit under the last row: they go on a fresh page (heading row + totals), never over the rows
  const heights = pending.map(rowHeight)
  const endY = (): number => { let yy = y; for (const h of heights) { if (yy + h > bodyLimit) yy = pageTop + 30; yy += h } return yy }
  // The totals box is tall. When the rows end below the place it needs, the totals would sit alone on a new page above an empty
  // table; instead the last few rows move over with them, so that page always carries some rows too.
  const keepWithTotals = pending.length > 1 && endY() > footTop ? Math.min(3, pending.length - 1) : 0
  pending.forEach((cells, i) => {
    if (keepWithTotals && i === pending.length - keepWithTotals) nextPage(pageBottom)
    drawRow(cells, heights[i]!)
  })
  if (y > footTop) nextPage(pageBottom)
  // the table runs down to the totals, as on the printed format
  closeBody(footTop)

  // ── totals box ─────────────────────────────────────────────────────────────────────────────────────────────────────
  const fTop = footTop
  const fBottom = fTop + footBoxH
  hline(L, R, fTop, 0.8)
  let ry = fTop
  // left: GSTIN band, the amounts in words, the note
  let ly = fTop
  if (gst) {
    doc.rect(L, fTop, splitX - L, 24).fill(GREY)
    put(`GSTIN No.: ${biz.gstin ?? ''}`, L + 8, fTop + 5, splitX - L - 16, { bold: true, size: 13 })
    ly += 24
    hline(L, splitX, ly, 0.8)
  }
  if (bank.length || b.payQr) {
    const bankTop = ly + 8
    ly = bankTop
    // the values stop short of the QR, which sits at the right end of this band
    const valW = splitX - L - 118 - (b.payQr ? QR + 14 : 0)
    for (const [k, v] of bank) {
      put(k, L + 8, ly, 90, { bold: true, size: 11 }); put(':', L + 98, ly, 8, { size: 11 }); put(v, L + 108, ly, valW, { size: 11 })
      ly += 14
    }
    if (b.payQr) {
      put(`Scan the QR to pay Rs. ${money(b.payQr.amount)}`, L + 8, ly + 3, splitX - L - QR - 30, { bold: true, size: 10 })
      const n = b.payQr.rows.length, m = QR / n, qx = splitX - 8 - QR
      doc.fillColor(INK)
      b.payQr.rows.forEach((row, r) => row.forEach((on, c) => { if (on) doc.rect(qx + c * m, bankTop + r * m, m + 0.15, m + 0.15).fill() }))
    }
    ly = bankTop + Math.max(bank.length * 14 + (b.payQr ? 18 : 0) - 4, b.payQr ? QR : 0) + 8
    hline(L, splitX, ly, 0.8)
  }
  ly += 8
  if (gst) {
    put('Total GST', L + 8, ly + 1, 70, { bold: true, size: 13 }); put(':', L + 86, ly + 1, 8, { size: 13 })
    para(amountInWords(totalGst), L + 100, ly + 3, wordsW, { italic: true, size: 10.5 })
    ly += gstWordsH + 10
  }
  put('Bill Amount', L + 8, ly + 1, 80, { bold: true, size: 13 }); put(':', L + 86, ly + 1, 8, { size: 13 })
  para(amountInWords(b.grandTotal), L + 100, ly + 3, wordsW, { italic: true, size: 10.5 })
  ly += billWordsH + 10
  const afterH = after.length * 15 + (after.length ? 4 : 0)
  const gtTop = fBottom - 32 - afterH                                // the Grand Total band and the Note strip share this line
  hline(L, R, gtTop, 0.8)
  put(`Note :${note ? ` ${note}` : ''}`, L + 8, gtTop + 9, splitX - L - 16, { size: 11 })
  if (gst) {
    doc.rect(splitX, fTop, R - splitX, 24).fill(GREY)
    put('Sub total', splitX + 10, fTop + 5, 90, { bold: true, size: 12 })
    put(money(b.subtotal), splitX + 100, fTop + 5, R - splitX - 110, { bold: true, size: 13, align: 'right' })
    ry += 24
    hline(splitX, R, ry, 0.8)
  }
  ry += 6
  sums.forEach(([k, v], i) => {
    const strong = gst && i === 0
    put(k, splitX + 10, ry, 100, { size: strong ? 12 : 11, bold: strong })
    put(v, splitX + 100, ry, R - splitX - 110, { size: strong ? 12.5 : 11, bold: strong, align: 'right' })
    ry += 15
  })
  ry = gtTop
  doc.rect(splitX, ry, R - splitX, 32).fill(GREY)
  put('Grand Total', splitX + 10, ry + 8, 100, { bold: true, size: 14 })
  put(money(b.grandTotal), splitX + 100, ry + 7, R - splitX - 110, { bold: true, size: 15, align: 'right' })
  ry += 32
  hline(splitX, R, ry, 0.8)
  after.forEach(([k, v]) => { ry += 2; put(k, splitX + 10, ry, 100, { size: 11 }); put(v, splitX + 100, ry, R - splitX - 110, { size: 11, align: 'right' }); ry += 13 })
  vline(splitX, fTop, fBottom, 0.8)
  outerBox(fTop, fBottom)
  hline(L, R, fBottom, 0.8)

  // ── declaration / terms / signature ────────────────────────────────────────────────────────────────────────────────
  pageBorder()
  doc.page.margins.bottom = 0                                       // text below the margin must not open a new page
  let dy = fBottom + 6
  if (showDecl) {
    put(WARRANTY_HEAD, L + 8, dy, W * WARRANTY_W, { bold: true, size: 10.5 }); dy += 15
    WARRANTY_TERMS.forEach((t) => { dy += para(t, L + 8, dy, W * WARRANTY_W - 16, { size: 8.5 }) + 1.5 })
  }
  if (showTerms) b.terms.forEach((t, i) => { dy += para(`${i + 1}. ${t}`, L + 8, dy, W * 0.62, { italic: true, size: 9 }) + 1 })
  put(`For, ${biz.name.toUpperCase()}`, L + W * 0.55, fBottom + 10, W * 0.45 - 10, { size: 12, align: 'right' })
  put('(Authorised Signatory)', L + W * 0.55, pageBottom - poweredH - 16, W * 0.45 - 10, { size: 10, align: 'right' })
  const boxBottom = pageBottom - poweredH
  vline(L, fBottom, boxBottom, 0.8); vline(R, fBottom, boxBottom, 0.8); hline(L, R, boxBottom, 1.4)

  void MUTED
}
