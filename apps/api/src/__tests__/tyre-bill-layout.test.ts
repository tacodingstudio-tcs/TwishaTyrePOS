// The printed bill follows the shop's own Excel "Car Bill" / "2 Wheel Bill" sheets.
import { newShopTenant, type Session } from './helpers'

describe("Bill layout = the shop's Excel bill", () => {
  let owner: Session, tyre: any, bike: any, labour: any, align: any
  const G = (() => {
    const base = '24AABCR1234A1Z'; const CH = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'; let s = 0
    for (let i = 0; i < 14; i++) { const m = CH.indexOf(base[i]!) * (i % 2 === 0 ? 1 : 2); s += Math.floor(m / 36) + (m % 36) }
    return base + CH[(36 - (s % 36)) % 36]
  })()

  /** every string a PDF draws, in order (pdfkit's standard fonts write text as hex strings inside deflated streams) */
  const pdfText = async (invoiceId: string): Promise<string> => {
    const zlib = await import('node:zlib')
    const res = await owner.api.get(`/api/tyre/invoices/${invoiceId}/pdf`, { responseType: 'arraybuffer' })
    expect(res.status).toBe(200)
    const str = Buffer.from(res.data).toString('latin1')
    let all = '', i = 0
    while ((i = str.indexOf('stream', i)) >= 0) {
      const a = str.indexOf('\n', i) + 1, e = str.indexOf('endstream', a); if (e < 0) break
      try { all += zlib.inflateSync(Buffer.from(str.slice(a, e), 'latin1')).toString('latin1') + '\n' } catch { /* not a compressed stream */ }
      i = e + 9
    }
    const piece = /<([0-9a-fA-F]*)>|\(((?:\\.|[^\\)])*)\)/g
    const str1 = (s: string) => [...s.matchAll(piece)].map((m) => (m[1] !== undefined ? Buffer.from(m[1], 'hex').toString('latin1') : m[2]!.replace(/\\(.)/g, '$1'))).join('')
    // each text-drawing operator is one run: the pieces of a TJ array (kerned letters) belong together
    const runs = [...all.matchAll(/\[((?:<[0-9a-fA-F]*>|\((?:\\.|[^\\)])*\)|[-\d.\s])*)\]\s*TJ|(<[0-9a-fA-F]*>|\((?:\\.|[^\\)])*\))\s*Tj/g)]
      .map((m) => str1(m[1] ?? m[2] ?? ''))
    return runs.join(' ').replace(/\s+/g, ' ')
  }
  const pagesOf = async (invoiceId: string): Promise<number> => {
    const res = await owner.api.get(`/api/tyre/invoices/${invoiceId}/pdf`, { responseType: 'arraybuffer' })
    return (Buffer.from(res.data).toString('latin1').match(/\/Type \/Page\b/g) ?? []).length
  }
  const sale = (body: Record<string, unknown>) => owner.api.post('/api/tyre/sales', body, { headers: { 'Idempotency-Key': crypto.randomUUID() } })
  const item = (p: any, extra: Record<string, unknown> = {}) => ({ productId: p.id, qty: 1, ...extra })
  /** every part appears, in this order */
  const inOrder = (text: string, parts: string[]) => {
    let at = 0
    for (const p of parts) { const k = text.indexOf(p, at); expect([p, k >= 0]).toEqual([p, true]); at = k + p.length }
  }

  beforeAll(async () => {
    owner = await newShopTenant('Shakti Layout Tyres')
    const b = (await owner.api.get('/api/branches')).data[0]
    await owner.api.patch(`/api/branches/${b.id}`, {
      gstin: '24AFTFS9416C1ZP', address: { line1: 'Near Hero Showroom, Veraval-Kodinar Bypass' },
      domainConfig: {
        business_phone: '9227575753', business_email: 'shaktityre.2026@gmail.com', prices_include_gst: true, default_service_gst: 0,
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
      'Debit Memo', 'Tax Invoice', 'Original', 'Bill No. -', '93', 'PO Date:', 'Date:',
      'Bill To,', 'GST No.: 24AFTFS9416C1ZP', 'GST.NO', G, 'Customer Name:', 'BHAVINBHAI PARMAR', 'Mobile Number', '9811100777', 'Address', 'NAVAGAM', 'Vehicle Number:', 'GJ32AA5467',
      'Sr.No.', 'Vehicle Company', 'Product Description', 'Tyre Brand', 'HSN Code', 'Unit Rate', 'Qty', 'Taxable Value', 'Total GST', 'Grand Total',
      'NEXON', '215/60/16', 'YOKOHAMA', '401110', '8813.56', '4', '35254.24', '6345.76', '41600.00',
      'Alignment', '600.00', 'Balancing', '0.00', 'Weight Charge', '0.00', 'Labour Charge', '400.00',
      'Sub total', '36254.24', 'CGST', '3172.88', 'SGST', '3172.88', 'Grand Total', '42000.00'])
    expect(await pagesOf(r.data.invoice.id)).toBe(1)                        // one sheet, no blank second page
    expect(t).toMatch(/Powered by Twisha Consultancy Services/)          // the software credit is always there
    expect(t).not.toMatch(/AMOUNT IN WORDS|TERMS/)                         // not part of their bill
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
      const zlib = await import('node:zlib')
      const res = await owner.api.get(`/api/tyre/invoices/${id}/pdf${q}`, { responseType: 'arraybuffer' })
      expect(res.status).toBe(200)
      const s = Buffer.from(res.data).toString('latin1'); let all = '', i = 0
      while ((i = s.indexOf('stream', i)) >= 0) { const a = s.indexOf('\n', i) + 1, e = s.indexOf('endstream', a); if (e < 0) break; try { all += zlib.inflateSync(Buffer.from(s.slice(a, e), 'latin1')).toString('latin1') + '\n' } catch { /* raw */ } i = e + 9 }
      return [...all.matchAll(/\[((?:<[0-9a-fA-F]*>|\((?:\.|[^\)])*\)|[-\d.\s])*)\]\s*TJ|(<[0-9a-fA-F]*>|\((?:\.|[^\)])*\))\s*Tj/g)]
        .map((m) => [...(m[1] ?? m[2] ?? '').matchAll(/<([0-9a-fA-F]*)>|\(((?:\.|[^\)])*)\)/g)].map((x) => (x[1] !== undefined ? Buffer.from(x[1], 'hex').toString('latin1') : x[2]!)).join('')).join(' ')
    }
    expect(await text()).toMatch(/Original/)
    expect(await text('?copy=original')).toMatch(/Original/)
    const dup = await text('?copy=duplicate')
    expect(dup).toMatch(/Duplicate/); expect(dup).not.toMatch(/Original/)
    expect(await text('?copy=triplicate')).toMatch(/Triplicate/)
    expect((await owner.api.get(`/api/tyre/invoices/${id}/pdf?copy=fake`, { responseType: 'arraybuffer' })).status).toBe(422)
  })
})
