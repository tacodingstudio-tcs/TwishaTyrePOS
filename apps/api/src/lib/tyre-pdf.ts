// apps/api/src/lib/tyre-pdf.ts
// Server-side PDF for the tyre module: the GST tax invoice, with the warranty card on a second
// page when the bill carried serial-numbered tyres.
//
// Pure-JS (pdfkit) on purpose: the production image has no Chromium, and a headless browser is far
// too heavy for a small hosting plan. Output is a Buffer, so the same bytes can be streamed to the
// browser or attached to a WhatsApp message.
//
// pdfkit's built-in fonts have no ₹ glyph, so amounts are printed as "Rs." — a standard convention
// on Indian invoices.

import PDFDocument from 'pdfkit'

export interface BusinessHeader {
  name: string
  address?: string | null
  gstin?: string | null
  phone?: string | null
  email?: string | null
}

const INK = '#111827'
const MUTED = '#6B7280'
const LINE = '#9CA3AF'

const rs = (n: unknown, dp = 2): string =>
  `Rs. ${Number(n ?? 0).toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp })}`
const num = (n: unknown, dp = 0): string => Number(n ?? 0).toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp })
const date = (v: unknown): string => {
  if (!v) return ''
  const d = v instanceof Date ? v : new Date(String(v))
  if (isNaN(d.getTime())) return String(v)
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })
}

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
  'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen']
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety']
function below1000(n: number): string {
  const parts: string[] = []
  if (n >= 100) { parts.push(`${ONES[Math.floor(n / 100)]} Hundred`); n %= 100 }
  if (n >= 20) { parts.push(TENS[Math.floor(n / 10)]!); n %= 10 }
  if (n > 0) parts.push(ONES[n]!)
  return parts.join(' ')
}
/** 104212 → "One Lakh Four Thousand Two Hundred Twelve Only" */
export function amountInWords(amount: number): string {
  const rupees = Math.floor(Math.abs(amount))
  const paise = Math.round((Math.abs(amount) - rupees) * 100)
  if (rupees === 0 && paise === 0) return 'Zero Only'
  const units: Array<[number, string]> = [[10_000_000, 'Crore'], [100_000, 'Lakh'], [1000, 'Thousand']]
  let n = rupees
  const words: string[] = []
  for (const [size, name] of units) {
    if (n >= size) { words.push(`${below1000(Math.floor(n / size))} ${name}`); n %= size }
  }
  if (n > 0) words.push(below1000(n))
  const rupeeText = words.join(' ')
  const paiseText = paise > 0 ? `${below1000(paise)} Paise` : ''
  return [rupeeText, rupeeText && paiseText ? 'and' : '', paiseText].filter(Boolean).join(' ') + ' Only'
}

function collect(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    doc.on('data', (c: Buffer) => chunks.push(c))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)
  })
}

function letterhead(doc: PDFKit.PDFDocument, biz: BusinessHeader, title: string, subtitle: string, x: number, y: number, w: number): number {
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(15).text(biz.name, x, y, { width: w * 0.62 })
  let ly = y + 19
  doc.font('Helvetica').fontSize(8).fillColor(MUTED)
  if (biz.address) { doc.text(biz.address, x, ly, { width: w * 0.62 }); ly = doc.y }
  const meta = [biz.gstin && `GSTIN: ${biz.gstin}`, biz.phone && `Ph: ${biz.phone}`, biz.email && biz.email].filter(Boolean).join('   ')
  if (meta) { doc.text(meta, x, ly, { width: w * 0.62 }); ly = doc.y }
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(12).text(title.toUpperCase(), x + w * 0.62, y, { width: w * 0.38, align: 'right' })
  doc.font('Helvetica').fontSize(7.5).fillColor(MUTED).text(subtitle, x + w * 0.62, y + 16, { width: w * 0.38, align: 'right' })
  const bottom = Math.max(ly, y + 32) + 4
  doc.lineWidth(1.5).strokeColor(INK).moveTo(x, bottom).lineTo(x + w, bottom).stroke()
  return bottom + 8
}

// ══════════════════════════════════════════════════════════════════════════════

export interface InvoiceLine {
  description: string
  hsn?: string | null
  qty: number
  unit?: string | null
  rate: number
  discountAmt: number
  taxable: number
  gstRate: number
  total: number
  /** "Size 205/55 R16 · MRF ZVTV" etc. — printed under the description. */
  detail?: string | null
  serials?: string[]
  dots?: string[]
  positions?: string[]
}

export interface WarrantyCardRow {
  itemName: string
  size?: string | null
  serialNo?: string | null
  dotCode?: string | null
  position?: string | null
  warrantyMonths: number
  warrantyUntil?: unknown
}

export interface InvoicePdfData {
  number: string
  date: unknown
  dueDate?: unknown
  status: string
  partyName: string
  partyPhone?: string | null
  partyGstin?: string | null
  partyAddress?: string | null
  vehicleNo?: string | null
  vehicleMake?: string | null
  poNo?: string | null
  poDate?: unknown
  odometer?: number | null
  fittedBy?: string | null
  lines: InvoiceLine[]
  subtotal: number          // taxable total
  discountTotal: number
  cgstTotal: number
  sgstTotal: number
  igstTotal: number
  roundOff: number
  grandTotal: number
  paidAmt: number
  exchangeValue: number     // old-tyre allowance already settled against this bill
  exchangeQty: number
  notes?: string | null
  terms: string[]
  warranty: WarrantyCardRow[]
}

export async function renderInvoicePdf(b: InvoicePdfData, biz: BusinessHeader): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 30, info: { Title: `Invoice ${b.number}`, Author: biz.name } })
  const done = collect(doc)
  const X = 30, W = doc.page.width - 60
  const pageBottom = () => doc.page.height - 40

  let y = letterhead(doc, biz, 'Tax Invoice', 'Original for recipient · Tyres, tubes & fitting services', X, 30, W)

  // Bill-to / meta
  doc.lineWidth(0.5).strokeColor(LINE).rect(X, y, W * 0.58, 86).stroke().rect(X + W * 0.58, y, W * 0.42, 86).stroke()
  doc.fillColor(MUTED).font('Helvetica').fontSize(6.5).text('BILL TO', X + 5, y + 4)
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(10).text(b.partyName || 'Walk-in customer', X + 5, y + 14, { width: W * 0.58 - 10 })
  doc.font('Helvetica').fontSize(8).fillColor(MUTED)
  if (b.partyAddress) doc.text(b.partyAddress, X + 5, doc.y, { width: W * 0.58 - 10 })
  if (b.partyPhone) doc.text(`Ph: ${b.partyPhone}`, X + 5, doc.y, { width: W * 0.58 - 10 })
  if (b.partyGstin) doc.text(`GSTIN: ${b.partyGstin}`, X + 5, doc.y, { width: W * 0.58 - 10 })
  const mx = X + W * 0.58 + 6, mw = W * 0.42 - 12
  const meta: Array<[string, string]> = [
    ['Invoice no.', b.number], ['Date', date(b.date)],
    ...(b.dueDate ? [['Due date', date(b.dueDate)] as [string, string]] : []),
    ...(b.vehicleNo ? [['Vehicle', [b.vehicleMake, b.vehicleNo].filter(Boolean).join(' · ')] as [string, string]] : []),
    ...(b.poNo || b.poDate ? [['PO', [b.poNo, b.poDate ? date(b.poDate) : ''].filter(Boolean).join(' / ')] as [string, string]] : []),
    ...(b.odometer ? [['Odometer', `${num(b.odometer)} km`] as [string, string]] : []),
  ]
  meta.slice(0, 6).forEach(([k, v], i) => {
    doc.fillColor(MUTED).font('Helvetica').fontSize(8).text(k, mx, y + 6 + i * 14, { lineBreak: false })
    doc.fillColor(INK).font('Helvetica-Bold').text(v, mx, y + 6 + i * 14, { width: mw, align: 'right', lineBreak: false })
  })
  y += 94

  // Lines table
  const cols = [20, W - 20 - 52 - 30 - 56 - 46 - 62 - 34 - 66, 52, 30, 56, 46, 62, 34, 66]
  const heads = ['#', 'Item', 'HSN/SAC', 'Qty', 'Rate', 'Disc', 'Taxable', 'GST%', 'Amount']
  const rightFrom = 3
  const drawHead = () => {
    doc.rect(X, y, W, 16).fillAndStroke('#F3F4F6', LINE)
    let cx = X
    heads.forEach((h, i) => {
      doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(6.8).text(h.toUpperCase(), cx + 3, y + 5, { width: cols[i]! - 6, align: i >= rightFrom ? 'right' : 'left', lineBreak: false })
      cx += cols[i]!
    })
    y += 16
  }
  drawHead()
  b.lines.forEach((l, n) => {
    const sub: string[] = []
    if (l.detail) sub.push(l.detail)
    if (l.serials?.length) sub.push(`Serial: ${l.serials.join(', ')}`)
    if (l.dots?.length) sub.push(`DOT: ${l.dots.join(', ')}`)
    if (l.positions?.length) sub.push(`Position: ${l.positions.join(', ')}`)
    const descW = cols[1]! - 6
    doc.font('Helvetica-Bold').fontSize(8.5)
    let h = doc.heightOfString(l.description, { width: descW })
    doc.font('Helvetica').fontSize(7)
    for (const s of sub) h += doc.heightOfString(s, { width: descW })
    const rowH = Math.max(20, h + 8)
    if (y + rowH > pageBottom() - 170) { doc.addPage(); y = 30; drawHead() }

    let cx = X
    const cells = [String(n + 1), '', l.hsn ?? '', `${num(l.qty, l.qty % 1 ? 2 : 0)}${l.unit ? ' ' + l.unit : ''}`, num(l.rate, 2),
      l.discountAmt > 0 ? num(l.discountAmt, 2) : '', num(l.taxable, 2), num(l.gstRate), num(l.total, 2)]
    cells.forEach((v, i) => {
      if (i !== 1) doc.fillColor(INK).font('Helvetica').fontSize(8).text(v, cx + 3, y + 4, { width: cols[i]! - 6, align: i >= rightFrom ? 'right' : 'left', lineBreak: false })
      cx += cols[i]!
    })
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(8.5).text(l.description, X + cols[0]! + 3, y + 4, { width: descW })
    let ty = doc.y
    doc.font('Helvetica').fontSize(7).fillColor(MUTED)
    for (const s of sub) { doc.text(s, X + cols[0]! + 3, ty, { width: descW }); ty = doc.y }
    doc.lineWidth(0.4).strokeColor('#E5E7EB').moveTo(X, y + rowH).lineTo(X + W, y + rowH).stroke()
    y += rowH
  })

  // Totals
  if (y + 170 > pageBottom()) { doc.addPage(); y = 30 }
  y += 8
  const tw = 240, tx = X + W - tw
  const trows: Array<[string, string, boolean?]> = []
  trows.push([b.lines.some((l) => l.gstRate === 0 && l.total > 0 && !l.hsn) ? 'Sub total (incl. charges)' : 'Taxable value', rs(b.subtotal)])
  if (b.discountTotal > 0) trows.push(['Discount given', rs(b.discountTotal)])
  if (b.igstTotal > 0) trows.push(['IGST', rs(b.igstTotal)])
  if (b.cgstTotal > 0) trows.push(['CGST', rs(b.cgstTotal)], ['SGST', rs(b.sgstTotal)])
  if (b.roundOff) trows.push(['Round off', rs(b.roundOff)])
  trows.push(['Grand total', rs(b.grandTotal), true])
  if (b.exchangeValue > 0) trows.push([`Old tyre exchange${b.exchangeQty ? ` (${b.exchangeQty})` : ''}`, `- ${rs(b.exchangeValue)}`])
  const otherPaid = Math.max(0, b.paidAmt - b.exchangeValue)
  if (otherPaid > 0) trows.push(['Received', `- ${rs(otherPaid)}`])
  const balance = Math.max(0, b.grandTotal - b.paidAmt)
  trows.push(['Balance due', rs(balance), true])
  const totalsTop = y
  trows.forEach(([k, v, bold]) => {
    doc.fillColor(bold ? INK : MUTED).font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 10 : 8.5).text(k, tx, y, { width: tw * 0.62, lineBreak: false })
    doc.fillColor(INK).text(v, tx, y, { width: tw, align: 'right', lineBreak: false })
    y += bold ? 16 : 13
  })

  // Left of totals: amount in words + notes
  doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(7).text('AMOUNT IN WORDS', X, totalsTop)
  doc.fillColor(INK).font('Helvetica').fontSize(8.5).text(amountInWords(b.grandTotal), X, doc.y + 1, { width: W - tw - 14 })
  if (b.notes) {
    doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(7).text('NOTES', X, doc.y + 8)
    doc.fillColor(INK).font('Helvetica').fontSize(8).text(b.notes, X, doc.y + 1, { width: W - tw - 14 })
  }
  y = Math.max(doc.y, y) + 14

  if (b.terms.length) {
    if (y + 70 > pageBottom()) { doc.addPage(); y = 30 }
    doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(7).text('TERMS', X, y)
    doc.font('Helvetica').fontSize(7)
    b.terms.forEach((t, i) => doc.text(`${i + 1}. ${t}`, X, doc.y + 1, { width: W }))
  }
  doc.fillColor(MUTED).font('Helvetica').fontSize(7)
    .text(`For ${biz.name}   —   Authorised signatory`, X, pageBottom() - 6, { width: W, align: 'right', lineBreak: false })

  // ── Warranty card ─────────────────────────────────────────────────────────
  if (b.warranty.length) {
    doc.addPage()
    let wy = letterhead(doc, biz, 'Warranty Card', `Invoice ${b.number} · ${date(b.date)}`, X, 30, W)
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(10).text(b.partyName || 'Walk-in customer', X, wy)
    doc.font('Helvetica').fontSize(8.5).fillColor(MUTED)
      .text([b.partyPhone && `Ph: ${b.partyPhone}`, b.vehicleNo && `Vehicle: ${b.vehicleNo}`].filter(Boolean).join('   '), X, doc.y + 1)
    wy = doc.y + 12

    const wc = [W - 100 - 80 - 40 - 70 - 90, 100, 80, 40, 70, 90]
    const wh = ['Item', 'Serial no.', 'DOT', 'Pos.', 'Warranty', 'Valid until']
    doc.rect(X, wy, W, 16).fillAndStroke('#F3F4F6', LINE)
    let cx = X
    wh.forEach((h, i) => { doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(7).text(h.toUpperCase(), cx + 4, wy + 5, { width: wc[i]! - 8, lineBreak: false }); cx += wc[i]! })
    wy += 16
    for (const r of b.warranty) {
      const desc = [r.itemName, r.size].filter(Boolean).join(' · ')
      doc.font('Helvetica').fontSize(8.5)
      const rh = Math.max(20, doc.heightOfString(desc, { width: wc[0]! - 8 }) + 8)
      if (wy + rh > pageBottom() - 80) { doc.addPage(); wy = 30 }
      const vals = [desc, r.serialNo ?? '—', r.dotCode ?? '—', r.position ?? '—',
        r.warrantyMonths > 0 ? `${r.warrantyMonths} months` : 'As per maker', r.warrantyUntil ? date(r.warrantyUntil) : '—']
      cx = X
      vals.forEach((v, i) => { doc.fillColor(INK).font('Helvetica').fontSize(8.5).text(v, cx + 4, wy + 5, { width: wc[i]! - 8 }); cx += wc[i]! })
      doc.lineWidth(0.4).strokeColor('#E5E7EB').moveTo(X, wy + rh).lineTo(X + W, wy + rh).stroke()
      wy += rh
    }
    wy += 14
    doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(7).text('HOW TO CLAIM', X, wy)
    doc.font('Helvetica').fontSize(7.5).fillColor(INK)
    const how = [
      'Bring this card (or quote the invoice number) with the tyre to the shop where it was bought.',
      'The tyre is assessed by the manufacturer\'s norms; damage from punctures, cuts, bulges, wrong pressure, misalignment, accidents or use outside normal conditions is not covered.',
      'Replacement / pro-rata adjustment is at the manufacturer\'s decision. Fitting and balancing charges are payable by the customer.',
    ]
    how.forEach((t, i) => doc.text(`${i + 1}. ${t}`, X, doc.y + 2, { width: W }))
  }

  doc.end()
  return done
}
