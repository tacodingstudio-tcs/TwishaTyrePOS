// Renders GST bills and cash memos with different numbers of item lines, so the page breaks can be looked at.
//   npx tsx e2e/bill-pages.ts [outdir]      writes gst-<n>.pdf and memo-<n>.pdf; then check the last page of each carries item rows
import { writeFileSync, mkdirSync } from 'node:fs'
import { renderInvoicePdf, type InvoicePdfData, type BusinessHeader } from '../src/lib/tyre-pdf.js'

const out = process.argv[2] ?? 'e2e-out/bill-pages'
mkdirSync(out, { recursive: true })
const biz = {
  name: 'Shakti Enterprise', address: 'Near Hero Showroom, Veraval-Kodinar Bypass', phone: '9227575753', email: 'shaktityre.2026@gmail.com',
  gstin: '24AFTFS9416C1ZP', bankName: 'AXIS BANK', bankAccount: '541010200000471', bankIfsc: 'UTIB0001591',
} as BusinessHeader

const bill = (n: number, gstBill: boolean): InvoicePdfData => ({
  number: String(n), date: '2026-08-25', status: 'paid', layout: 'shakti', billKind: 'car', gstBill,
  partyName: 'BHAVINBHAI  PARMAR', partyPhone: '9825012345', partyAddress: 'NAVAGAM', partyGstin: gstBill ? '24ATEPP3835H2ZN' : '', vehicleNo: 'GJ-32-AA-5467', vehicleMake: 'NEXON',
  lines: Array.from({ length: n }, (_, i) => ({ description: `Tyre ${i + 1}`, size: `${185 + i}/65/15`, brand: 'MRF', hsn: '4011', qty: 1, rate: 1000, discountAmt: 0, taxable: gstBill ? 1000 : 1180, gstRate: gstBill ? 18 : 0, total: 1180, kind: 'tyre' })) as never,
  subtotal: gstBill ? n * 1000 : n * 1180, discountTotal: 0, cgstTotal: gstBill ? n * 90 : 0, sgstTotal: gstBill ? n * 90 : 0, igstTotal: 0, roundOff: 0, grandTotal: n * 1180, paidAmt: n * 1180,
  exchangeValue: 0, exchangeQty: 0, terms: [], warranty: [],
} as InvoicePdfData)

for (const n of [8, 18, 19, 20, 21, 22, 26, 45, 60]) {
  for (const [kind, gst] of [['gst', true], ['memo', false]] as const) {
    writeFileSync(`${out}/${kind}-${n}.pdf`, await renderInvoicePdf(bill(n, gst), biz))
  }
}
console.log('written to', out)
