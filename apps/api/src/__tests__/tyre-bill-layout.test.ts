// The printed bill follows the shop's own Excel "Car Bill" / "2 Wheel Bill" sheets.
import { newShopTenant, type Session } from './helpers'
import { pdfText as readPdfText } from './pdf-text'

describe("Bill layout = the shop's Excel bill", () => {
  let owner: Session, tyre: any, bike: any, labour: any, align: any
  const G = (() => {
    const base = '24AABCR1234A1Z'; const CH = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'; let s = 0
    for (let i = 0; i < 14; i++) { const m = CH.indexOf(base[i]!) * (i % 2 === 0 ? 1 : 2); s += Math.floor(m / 36) + (m % 36) }
    return base + CH[(36 - (s % 36)) % 36]
  })()

  /** every string a PDF draws, in order (reads the bill's embedded Calibri-twin font as well as the standard fonts) */
  const pdfText = async (invoiceId: string): Promise<string> => {
    const res = await owner.api.get(`/api/tyre/invoices/${invoiceId}/pdf`, { responseType: 'arraybuffer' })
    expect(res.status).toBe(200)
    return readPdfText(Buffer.from(res.data))
  }
  const pagesOf = async (invoiceId: string): Promise<number> => {
    const res = await owner.api.get(`/api/tyre/invoices/${invoiceId}/pdf`, { responseType: 'arraybuffer' })
    return (Buffer.from(res.data).toString('latin1').match(/\/Type \/Page\b/g) ?? []).length
  }
  const sale = (body: Record<string, unknown>) => owner.api.post('/api/tyre/sales', body, { headers: { 'Idempotency-Key': crypto.randomUUID() } })
  const item = (p: any, extra: Record<string, unknown> = {}) => ({ productId: p.id, qty: 1, ...extra })
  /** every part appears, in this order */
  // the bill prints Indian digit grouping (1,23,456.00) and an upper-case title: compare without those
  const inOrder = (text: string, parts: string[]) => {
    const flat = text.replace(/(\d),(?=\d)/g, '$1').toLowerCase()
    let at = 0
    for (const p of parts) { const k = flat.indexOf(p.toLowerCase(), at); expect([p, k >= 0]).toEqual([p, true]); at = k + p.length }
  }

  beforeAll(async () => {
    owner = await newShopTenant('Shakti Layout Tyres')
    const b = (await owner.api.get('/api/branches')).data[0]
    await owner.api.patch(`/api/branches/${b.id}`, {
      gstin: '24AFTFS9416C1ZP', address: { line1: 'Near Hero Showroom, Veraval-Kodinar Bypass' },
      domainConfig: {
        business_phone: '9227575753', business_email: 'shaktityre.2026@gmail.com', bank_name: 'AXIS BANK', bank_account_no: '541010200000471', bank_ifsc: 'UTIB0001591', prices_include_gst: true, default_service_gst: 0,
        bill_series: { car: { prefix: '', start: 93 }, two_wheel: { prefix: '2W-', start: 1 } },
      },
    })
    const mkTyre = async (name: string, sku: string, vt: string, size: string) => (await owner.api.post('/api/products', {
      itemType: 'product', gstRate: 18, unit: 'pcs', trackStock: true, name, sku, salePrice: 10400, purchasePrice: 7000, openingStock: 50,
      domainAttrs: { item_kind: 'tyre', brand: 'Yokohama', size, vehicle_type: vt },
    })).data
    tyre = await mkTyre('Yokohama 215/60 R16', 'Y-216', 'car', '215/60/16')
    bike = await mkTyre('Dunlop 2.75-18', 'D-275', 'two_wheeler', '2.75/18')
    const svc = async (name: string, price: number, type: string) => (await owner.api.post('/api/products', {
      itemType: 'service', name, salePrice: price, gstRate: 0, unit: 'job', trackStock: false, domainAttrs: { item_kind: 'service', service_type: type },
    })).data
    labour = await svc('Labour Charge', 400, 'other')
    align = await svc('Wheel Alignment', 600, 'alignment')
  })

  test("car bill: same boxes, headings and figures as the Excel sheet, with the customer's GSTIN and the HSN", async () => {
    const r = await sale({
      customer: { name: 'BHAVINBHAI PARMAR', phone: '9811100777', address: 'NAVAGAM' }, customerGstin: G, vehicleNo: 'GJ32AA5467', makeModel: 'NEXON', billSeries: 'car',
      items: [item(tyre, { qty: 4 }), item(labour), item(align)], payments: [{ method: 'cash', amount: 42000 }],
    })
    expect(r.status).toBe(201)
    const t = await pdfText(r.data.invoice.id)
    inOrder(t, ['SHAKTI LAYOUT TYRES', 'Near Hero Showroom, Veraval-Kodinar Bypass', 'Co.No. 9227575753', 'Email ID: shaktityre.2026@gmail.com',
      'Debit Memo', 'Tax Invoice', 'Original',
      'Bill To,', 'Bill No. -', '93', 'Date:', 'PO No.:', 'PO Date:', 'GST.NO', G, 'Customer Name:', 'BHAVINBHAI PARMAR', 'Mobile Number', '9811100777', 'Address', 'NAVAGAM', 'Vehicle Number:', 'GJ32AA5467',
      'Sr.No.', 'Vehicle Company', 'Product Description', 'Tyre Brand', 'HSN Code', 'Unit Rate', 'Qty', 'Taxable Value', 'Total GST', 'Grand Total',
      'NEXON', '215/60/16', 'YOKOHAMA', '401110', '8813.56', '4', '35254.24', '6345.76', '41600',
      'Alignment', '600', 'Balancing', '0', 'Weight Charge', '0', 'Labour Charge', '400',
      'Sub total', '36254.24', 'CGST', '3172.88', 'SGST', '3172.88', 'Grand Total', '42000.00'])
    inOrder(t, ['GSTIN No.: 24AFTFS9416C1ZP', 'Bank Name', 'AXIS BANK', 'Bank A/c No.', '541010200000471', 'RTGS/IFSC Code', 'UTIB0001591', 'Total GST'])   // the bank details saved in settings
    expect(t).toContain('GSTIN No.: 24AFTFS9416C1ZP')                      // the shop's GSTIN sits in the footer band only
    expect(t).not.toContain('GST No.:')
    expect(await pagesOf(r.data.invoice.id)).toBe(1)                        // one sheet, no blank second page
    expect(t).not.toMatch(/Powered by/)                                  // no software credit on the bill
    expect(t).toMatch(/TYRE WARRANTY & CLAIM TERMS/)                      // the shop's warranty terms sit under the totals
    expect(t).not.toMatch(/GTA Declaration/)
  })

  test('two-wheeler bill: Total / GST columns and no fixed charge rows', async () => {
    const r = await sale({
      customer: { name: 'DHIRUBHAI', phone: '9811100778' }, vehicleNo: 'GJ3238050', makeModel: 'SPLENDOR', billSeries: 'two_wheel',
      items: [item(bike)], payments: [{ method: 'cash', amount: 10400 }],
    })
    expect(r.status).toBe(201)
    const t = await pdfText(r.data.invoice.id)
    inOrder(t, ['Bill No. -', '2W-1', 'Sr.No.', 'Vehicle Company', 'Product Description', 'Tyre Brand', 'HSN Code', 'Unit Rate', 'Qty', 'Total', 'GST', 'Grand Total',
      'SPLENDOR', '2.75/18', 'YOKOHAMA', '401140', '10400.00'])
    expect(t).not.toMatch(/Weight Charge|Labour Charge|Taxable Value/)
  })

  test('cash memo: same frame, no HSN / GST columns and no tax lines', async () => {
    const r = await sale({ customer: { name: 'Walk In', phone: '9811100779' }, withGst: false, items: [item(tyre)], payments: [{ method: 'cash', amount: 8813 }] })
    expect(r.status).toBe(201)
    const t = await pdfText(r.data.invoice.id)
    inOrder(t, ['Debit Memo', 'Cash Memo', 'Original', 'Customer Name:', 'Sr.No.', 'Product Description', 'Tyre Brand', 'Unit Rate', 'Qty', 'Amount', 'Grand Total'])
    expect(t).not.toMatch(/Tax Invoice|HSN Code|Total GST|CGST|SGST/)
  })

  test('a credit bill shows what is still to pay; no GSTIN leaves the GST.NO box empty', async () => {
    const r = await sale({ customer: { name: 'Udhaar Wala', phone: '9811100780' }, items: [item(tyre)], payments: [{ method: 'cash', amount: 4000 }], creditDays: 15 })
    expect(r.status).toBe(201)
    const t = await pdfText(r.data.invoice.id)
    inOrder(t, ['GST.NO', 'Customer Name:', 'Udhaar Wala', 'Grand Total', '10400.00', 'Received', '- 4000.00', 'Balance due', '6400.00'])
  })

  test('the generic invoice is still available as a setting (bill_layout: standard)', async () => {
    const b = (await owner.api.get('/api/branches')).data[0]
    await owner.api.patch(`/api/branches/${b.id}`, { domainConfig: { bill_layout: 'standard' } })
    const r = await sale({ customer: { name: 'Std Layout', phone: '9811100781' }, items: [item(tyre)], payments: [{ method: 'cash', amount: 10400 }] })
    const t = await pdfText(r.data.invoice.id)
    expect(t).toMatch(/TAX INVOICE/)
    expect(t).not.toMatch(/Debit Memo/)
    await owner.api.patch(`/api/branches/${b.id}`, { domainConfig: { bill_layout: 'shakti' } })
  })

  test("the shop's emblem is printed on the bill (one embedded image), and nothing else about the layout moves", async () => {
    const r = await sale({ customer: { name: 'LOGO CHECK', phone: '9811100888' }, vehicleNo: 'GJ32AA0001', billSeries: 'car', items: [item(tyre)], payments: [] })
    expect(r.status).toBe(201)
    const res = await owner.api.get(`/api/tyre/invoices/${r.data.invoice.id}/pdf`, { responseType: 'arraybuffer' })
    expect((Buffer.from(res.data).toString('latin1').match(/\/Subtype \/Image/g) ?? []).length).toBeGreaterThanOrEqual(1)
  })
})

describe('Reprint copies', () => {
  test('the copy label follows ?copy= (Original by default) and a bad value is refused', async () => {
    const owner = await newShopTenant('Reprint Tyres')
    const p = (await owner.api.post('/api/products', { itemType: 'product', gstRate: 18, unit: 'pcs', trackStock: true, name: 'MRF 185/65 R15', sku: 'RP-1', salePrice: 5000, openingStock: 9,
      domainAttrs: { item_kind: 'tyre', brand: 'MRF', size: '185/65 R15', vehicle_type: 'car' } })).data
    const r = await owner.api.post('/api/tyre/sales', { customer: { name: 'Reprint Wala', phone: '9811100991' }, items: [{ productId: p.id, qty: 1 }], payments: [{ method: 'cash', amount: 5000 }] },
      { headers: { 'Idempotency-Key': crypto.randomUUID() } })
    const id = r.data.invoice.id
    const text = async (q = '') => {
      const res = await owner.api.get(`/api/tyre/invoices/${id}/pdf${q}`, { responseType: 'arraybuffer' })
      expect(res.status).toBe(200)
      return readPdfText(Buffer.from(res.data))
    }
    expect(await text()).toMatch(/Original/)
    expect(await text('?copy=original')).toMatch(/Original/)
    const dup = await text('?copy=duplicate')
    expect(dup).toMatch(/Duplicate/); expect(dup).not.toMatch(/Original(?! purchase bill)/)
    expect(await text('?copy=triplicate')).toMatch(/Triplicate/)
    expect((await owner.api.get(`/api/tyre/invoices/${id}/pdf?copy=fake`, { responseType: 'arraybuffer' })).status).toBe(422)
  })
})
