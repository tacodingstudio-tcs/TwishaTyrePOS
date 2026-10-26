// Renders the bill from the numbers in the shop's own Excel sheet (Car Bill / 2 Wheel Bill) so the two can be compared side by side.
//   npx tsx e2e/bill-preview.ts [outdir]      writes car.pdf, two-wheel.pdf, memo.pdf, long.pdf, quotation.pdf
import { writeFileSync, mkdirSync } from 'node:fs'
import { renderInvoicePdf, type InvoicePdfData, type BusinessHeader } from '../src/lib/tyre-pdf.js'

const out = process.argv[2] ?? 'e2e-out/bills'
mkdirSync(out, { recursive: true })
const biz: BusinessHeader = {
  name: 'Shakti Enterprise', address: 'Near Hero Showroom, Veraval-Kodinar Bypass', phone: '9227575753', email: 'shaktityre.2026@gmail.com',
  gstin: '24AFTFS9416C1ZP', bankName: 'AXIS BANK', bankAccount: '541010200000471', bankIfsc: 'UTIB0001591', poweredBy: 'Powered by Twisha Consultancy Services · https://www.twishaconsultancyservices.com/',
} as BusinessHeader

const base: InvoicePdfData = {
  number: '75', date: '2026-08-25', status: 'paid', layout: 'shakti', billKind: 'car',
  partyName: 'BHAVINBHAI  PARMAR', partyPhone: '9825012345', partyAddress: 'NAVAGAM', partyGstin: '24ATEPP3835H2ZN', vehicleNo: 'GJ-32-AA-5467', vehicleMake: 'NEXON',
  lines: [
    { description: 'Yokohama 215/60 R16', size: '215/60/16', brand: 'Yokohama', hsn: '4011', qty: 4, rate: 7627.12, discountAmt: 0, taxable: 30508.47, gstRate: 18, total: 36000, kind: 'tyre' },
    { description: 'Labour Charge', qty: 1, rate: 400, discountAmt: 0, taxable: 400, gstRate: 0, total: 400, kind: 'service', serviceType: 'other' },
  ],
  subtotal: 30908.47, discountTotal: 0, cgstTotal: 2745.76, sgstTotal: 2745.76, igstTotal: 0, roundOff: 0, grandTotal: 36400, paidAmt: 36400,
  exchangeValue: 0, exchangeQty: 0, terms: [], warranty: [],
} as InvoicePdfData

const jobs: Array<[string, InvoicePdfData]> = [
  ['car', base],
  ['two-wheel', {
    ...base, number: '2', billKind: 'two_wheel', partyName: 'VIJAYSINH BARAD VISWAS', partyPhone: '9824802222', partyAddress: 'KODINAR', partyGstin: '', vehicleNo: 'GJ32AA0001', vehicleMake: 'SUPAR SPLE',
    lines: [{ description: 'Dunlop 2.75-18', size: '2.75/18', brand: 'Danlpo', hsn: '0', qty: 1, rate: 1355.93, discountAmt: 0, taxable: 1355.93, gstRate: 18, total: 1600, kind: 'tyre' }],
    subtotal: 1355.93, cgstTotal: 122.03, sgstTotal: 122.03, grandTotal: 1600, paidAmt: 1600,
  } as InvoicePdfData],
  ['memo', { ...base, gstBill: false, number: '12', lines: [base.lines[0]!], subtotal: 36000, cgstTotal: 0, sgstTotal: 0, grandTotal: 36000, paidAmt: 20000 } as InvoicePdfData],
  ['long', { ...base, number: '90', lines: Array.from({ length: 52 }, (_, i) => ({ description: `Tyre ${i + 1}`, size: `${185 + i}/65/15`, brand: 'MRF', hsn: '4011', qty: 1, rate: 1000, discountAmt: 0, taxable: 1000, gstRate: 18, total: 1180, kind: 'tyre' })) as never,
    subtotal: 52000, cgstTotal: 4680, sgstTotal: 4680, grandTotal: 61360, paidAmt: 61360 } as InvoicePdfData],
  ['quotation', { ...base, number: 'QT-26-00001', docLabel: 'Quotation', isDocument: true, status: 'draft', paidAmt: 0 } as InvoicePdfData],
]
for (const [name, data] of jobs) {
  const t0 = Date.now()
  const buf = await renderInvoicePdf(data, biz)
  writeFileSync(`${out}/${name}.pdf`, buf)
  console.log(name.padEnd(10), `${(buf.length / 1024).toFixed(0)} KB  ${Date.now() - t0} ms`)
}
