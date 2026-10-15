// Shakti Enterprise flow: GST-inclusive "Data Entry" price, free-amount charges, plain numbered registers.

import { newShopTenant, type Session } from './helpers'

describe('Shakti bill: Data Entry price, charges, series', () => {
  let owner: Session, tyre: any, branchId: string

  const sale = (body: Record<string, unknown>) =>
    owner.api.post('/api/tyre/sales', body, { headers: { 'Idempotency-Key': crypto.randomUUID() } })
  const invoice = async (id: string) => (await owner.api.get(`/api/invoices/${id}`)).data

  beforeAll(async () => {
    owner = await newShopTenant('Shakti Test Tyres')
    const r = await owner.api.post('/api/products', {
      itemType: 'product', gstRate: 18, unit: 'pcs', trackStock: true, name: 'Yokohama 195/65 R15', sku: 'YOK-195',
      salePrice: 6000, purchasePrice: 4000, openingStock: 50,
      domainAttrs: { item_kind: 'tyre', brand: 'Yokohama', size: '195/65 R15', vehicle_type: 'car' },
    })
    tyre = r.data
    branchId = (await owner.api.get('/api/branches')).data[0].id
    await owner.api.patch(`/api/branches/${branchId}`, {
      domainConfig: { prices_include_gst: true, bill_series: { car: { prefix: '', start: 93 }, two_wheel: { prefix: '2W-', start: 1 } } },
    })
  })

  test('typed price is the GST-inclusive total: 4 × ₹10,400 = ₹41,600 with CGST = SGST', async () => {
    const r = await sale({
      customer: { name: 'Walk In', phone: '9876543210' }, vehicleNo: 'GJ32AB1234', makeModel: 'Hyundai Creta',
      items: [{ productId: tyre.id, qty: 4, rate: 10400 }], payments: [{ method: 'cash', amount: 41600 }],
    })
    expect(r.status).toBe(201)
    const inv = await invoice(r.data.invoice.id)
    expect(Number(inv.grandTotal)).toBe(41600)
    expect(Number(inv.taxableAmt ?? inv.subtotal)).toBeGreaterThan(0)
    const it = inv.items[0]
    expect(Number(it.taxableAmt)).toBe(35254.24)
    expect(Number(it.cgstAmt)).toBe(3172.88)
    expect(Number(it.sgstAmt)).toBe(3172.88)
  })

  test('per-tyre discount comes off the inclusive price', async () => {
    const r = await sale({
      customer: { name: 'Disc', phone: '9876543211' },
      items: [{ productId: tyre.id, qty: 2, rate: 5000, discountPct: 10 }], payments: [{ method: 'cash', amount: 9000 }],
    })
    expect(r.status).toBe(201)
    expect(Number((await invoice(r.data.invoice.id)).grandTotal)).toBe(9000)
  })

  test('charges are added with no GST: ₹15,600 + 200 + 300 + 120 = ₹16,220', async () => {
    const r = await sale({
      customer: { name: 'Charges', phone: '9876543212' },
      items: [{ productId: tyre.id, qty: 2, rate: 7800 }],
      charges: [{ label: 'Alignment', amount: 200 }, { label: 'Balancing', amount: 300 }, { label: 'Weight', amount: 120 }, { label: 'Labour', amount: 0 }],
      payments: [{ method: 'cash', amount: 16220 }],
    })
    expect(r.status).toBe(201)
    const inv = await invoice(r.data.invoice.id)
    expect(Number(inv.grandTotal)).toBe(16220)
    expect(inv.items).toHaveLength(4)                     // zero-amount labour line is dropped
    expect(Number(inv.cgstTotal)).toBe(1189.83)           // GST on the tyre only
  })

  test('car and two-wheel registers number on their own', async () => {
    const car = await sale({ customer: { name: 'A', phone: '9876543213' }, billSeries: 'car',
      items: [{ productId: tyre.id, qty: 1, rate: 6000 }], payments: [{ method: 'cash', amount: 6000 }] })
    const car2 = await sale({ customer: { name: 'A', phone: '9876543213' }, billSeries: 'car',
      items: [{ productId: tyre.id, qty: 1, rate: 6000 }], payments: [{ method: 'cash', amount: 6000 }] })
    const tw = await sale({ customer: { name: 'B', phone: '9876543214' }, billSeries: 'two_wheel',
      items: [{ productId: tyre.id, qty: 1, rate: 3000 }], payments: [{ method: 'cash', amount: 3000 }] })
    expect([car.status, car2.status, tw.status]).toEqual([201, 201, 201])
    expect(car.data.invoice.number).toBe('93')
    expect(car2.data.invoice.number).toBe('94')
    expect(tw.data.invoice.number).toBe('2W-1')
  })

  test('unknown series is a 422; charges need a name and a sane amount', async () => {
    const base = { customer: { name: 'X', phone: '9876543215' }, items: [{ productId: tyre.id, qty: 1, rate: 100 }], payments: [{ method: 'cash', amount: 100 }] }
    expect((await sale({ ...base, billSeries: 'bike' })).status).toBe(422)
    expect((await sale({ ...base, charges: [{ label: '', amount: 10 }] })).status).toBe(422)
    expect((await sale({ ...base, charges: [{ label: 'Alignment', amount: -5 }] })).status).toBe(422)
  })

  test('an explicit pricesIncludeGst:false still adds GST on top', async () => {
    const r = await sale({
      customer: { name: 'Excl', phone: '9876543216' }, pricesIncludeGst: false,
      items: [{ productId: tyre.id, qty: 1, rate: 1000 }], payments: [{ method: 'cash', amount: 1180 }],
    })
    expect(r.status).toBe(201)
    expect(Number((await invoice(r.data.invoice.id)).grandTotal)).toBe(1180)
  })
})

describe('Shakti bill PDF', () => {
  test('renders with vehicle make, PO, charges and the series number', async () => {
    const owner = await newShopTenant('Shakti Pdf Tyres')
    const p = (await owner.api.post('/api/products', {
      itemType: 'product', gstRate: 18, unit: 'pcs', trackStock: true, name: 'Yokohama 205/55 R16', sku: 'YOK-205',
      salePrice: 8000, openingStock: 10, domainAttrs: { item_kind: 'tyre', brand: 'Yokohama', size: '205/55 R16', vehicle_type: 'car' },
    })).data
    const b = (await owner.api.get('/api/branches')).data[0]
    await owner.api.patch(`/api/branches/${b.id}`, { domainConfig: { prices_include_gst: true, business_email: 'shakti@example.com', bill_series: { car: { prefix: '', start: 93 } } } })
    const r = await owner.api.post('/api/tyre/sales', {
      customer: { name: 'Pdf Customer', phone: '9876543299', address: 'Kodinar, Gir Somnath' }, makeModel: 'Maruti Swift', vehicleNo: 'GJ11XY9999',
      billSeries: 'car', poNo: 'PO-7', poDate: '2026-10-01', items: [{ productId: p.id, qty: 4, rate: 8000, discountPct: 5 }],
      charges: [{ label: 'Alignment', amount: 400 }], payments: [{ method: 'cash', amount: 30800 }],
    }, { headers: { 'Idempotency-Key': crypto.randomUUID() } })
    expect(r.status).toBe(201)
    const pdf = await owner.api.get(`/api/tyre/invoices/${r.data.invoice.id}/pdf`, { responseType: 'arraybuffer' })
    expect(pdf.status).toBe(200)
    expect(Buffer.from(pdf.data).subarray(0, 4).toString()).toBe('%PDF')
  })
})

describe('Shakti register export', () => {
  test('rows follow the paper register; series filter and CSV work; formula-looking names are neutralised', async () => {
    const owner = await newShopTenant('Shakti Register Tyres')
    const p = (await owner.api.post('/api/products', {
      itemType: 'product', gstRate: 18, unit: 'pcs', trackStock: true, name: 'Yokohama 185/65 R15', sku: 'YOK-185',
      salePrice: 7800, openingStock: 20, domainAttrs: { item_kind: 'tyre', brand: 'Yokohama', size: '185/65 R15', vehicle_type: 'car' },
    })).data
    const b = (await owner.api.get('/api/branches')).data[0]
    await owner.api.patch(`/api/branches/${b.id}`, { domainConfig: { prices_include_gst: true, bill_series: { car: { prefix: '', start: 93 }, two_wheel: { prefix: '2W-', start: 1 } } } })
    const post = (body: any) => owner.api.post('/api/tyre/sales', body, { headers: { 'Idempotency-Key': crypto.randomUUID() } })
    const a = await post({ customer: { name: '=HYPERLINK("x")', phone: '9876543301' }, billSeries: 'car', vehicleNo: 'GJ32AB1', makeModel: 'Swift',
      items: [{ productId: p.id, qty: 2, rate: 7800 }],
      charges: [{ label: 'Alignment', amount: 200 }, { label: 'Balancing', amount: 300 }, { label: 'Weight', amount: 120 }],
      payments: [{ method: 'cash', amount: 16220 }] })
    const t = await post({ customer: { name: 'Two Wheel', phone: '9876543302' }, billSeries: 'two_wheel',
      items: [{ productId: p.id, qty: 1, rate: 3000 }], payments: [{ method: 'cash', amount: 3000 }] })
    expect([a.status, t.status]).toEqual([201, 201])

    const all = (await owner.api.get('/api/tyre/reports/register')).data
    expect(all.count).toBe(2)
    const car = all.rows.find((r: any) => r['Bill No'] === '93')
    expect(car).toMatchObject({ 'Qty': 2, 'Data Entry': 7800, 'Tyre Total': 15600, 'Alignment': 200, 'Balancing': 300, 'Weight': 120, 'Labour': 0,
      'Bill Total': 16220, 'CGST %': 9, 'Vehicle Make': 'Swift', 'Vehicle No': 'GJ32AB1' })
    expect(car['Taxable']).toBe(13220.34)

    const only = (await owner.api.get('/api/tyre/reports/register', { params: { series: 'two_wheel' } })).data
    expect(only.rows.map((r: any) => r['Bill No'])).toEqual(['2W-1'])

    const csv = await owner.api.get('/api/tyre/reports/register', { params: { format: 'csv' }, responseType: 'text' })
    expect(csv.status).toBe(200)
    expect(String(csv.headers['content-type'])).toContain('text/csv')
    expect(csv.data).toContain("'=HYPERLINK")
    expect(csv.data).not.toMatch(/,=HYPERLINK/)

    expect((await owner.api.get('/api/tyre/reports/register', { params: { series: 'Bad Series!' } })).status).toBe(422)
    expect((await owner.api.get('/api/tyre/reports/register', { params: { from: '2026-13-45' } })).status).toBeGreaterThanOrEqual(400)
  })
})

describe('Old register import', () => {
  test('creates historic bills without moving stock, skips repeats, handles service-only bills, owner/manager only', async () => {
    const { addStaff } = await import('./helpers')
    const owner = await newShopTenant('Shakti Import Tyres')
    const cashier = await addStaff(owner, 'cashier')
    const b = (await owner.api.get('/api/branches')).data[0]
    await owner.api.patch(`/api/branches/${b.id}`, { domainConfig: { prices_include_gst: true, bill_series: { car: { prefix: '', start: 93 } } } })
    const rows = [
      { date: '2025-06-01', billNo: 1, customer: 'Old Customer', mobile: '9876500001', vehicleNo: 'GJ-32-AB-0001', vehicleMake: 'Swift', km: 40000,
        brand: 'Yokohama', size: '185/65R15', qty: 4, price: 10400, charges: { alignment: 200 } },
      { date: '2025-06-02', billNo: 2, customer: 'Service Only', vehicleNo: 'GJ-32-AB-0002', charges: { alignment: 250, balancing: 300 } },
    ]
    const run = (s: any, body: any) => s.api.post('/api/tyre/import/register', body)
    expect((await run(cashier, { series: 'car', rows })).status).toBe(403)
    const dry = (await run(owner, { series: 'car', rows, dryRun: true })).data
    expect(dry).toMatchObject({ created: 2, dryRun: true })
    expect((await owner.api.get('/api/invoices', { params: { txnType: 'sale_invoice' } })).data.data ?? []).toHaveLength(0)

    const r = await run(owner, { series: 'car', rows })
    expect(r.data).toMatchObject({ created: 2, skipped: 0, failed: 0 })
    expect((await run(owner, { series: 'car', rows })).data).toMatchObject({ created: 0, skipped: 2 })

    const reg = (await owner.api.get('/api/tyre/reports/register', { params: { from: '2025-01-01', to: '2025-12-31' } })).data.rows
    const one = reg.find((x: any) => x['Bill No'] === '1')
    expect(one).toMatchObject({ 'Bill Total': 41800, 'Tyre Total': 41600, 'Alignment': 200, 'Date': '2025-06-01' })
    expect(reg.find((x: any) => x['Bill No'] === '2')['Bill Total']).toBe(550)

    // next live bill continues after the imported numbers, and the vehicle is on file
    const vehicles = (await owner.api.get('/api/tyre/vehicles')).data
    expect(JSON.stringify(vehicles)).toContain('GJ32AB0001')
    expect((await run(owner, { series: 'car', rows: [{ ...rows[0], billNo: 'X1', qty: -1 }] })).status).toBe(422)
  })
})

describe('Gujarati on the bill', () => {
  test('a bill with a Gujarati name and address renders with the Gujarati font embedded; plain bills do not', async () => {
    const owner = await newShopTenant('Shakti Gujarati Tyres')
    const p = (await owner.api.post('/api/products', {
      itemType: 'product', gstRate: 18, unit: 'pcs', trackStock: true, name: 'Yokohama 175/65 R14', sku: 'YOK-175',
      salePrice: 5000, openingStock: 10, domainAttrs: { item_kind: 'tyre', brand: 'Yokohama', size: '175/65 R14', vehicle_type: 'car' },
    })).data
    const sale = async (name: string, address: string) => (await owner.api.post('/api/tyre/sales', {
      customer: { name, phone: '9876543' + String(Math.floor(100 + Math.random() * 899)), address },
      items: [{ productId: p.id, qty: 2 }], payments: [{ method: 'cash', amount: 11800 }],
    }, { headers: { 'Idempotency-Key': crypto.randomUUID() } })).data.invoice.id
    const pdfOf = async (id: string) => Buffer.from((await owner.api.get(`/api/tyre/invoices/${id}/pdf`, { responseType: 'arraybuffer' })).data)

    const guj = await pdfOf(await sale('વિજયસિંહ બારડ', 'કોડીનાર, ગીર સોમનાથ'))
    expect(guj.subarray(0, 4).toString()).toBe('%PDF')
    expect(guj.toString('latin1')).toContain('NotoSansGujarati')
    const plain = await pdfOf(await sale('Plain Customer', 'Kodinar'))
    expect(plain.toString('latin1')).not.toContain('NotoSansGujarati')
  })
})
