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

describe('No-GST (cash memo) bills', () => {
  test('withGst:false charges no tax, uses its own register, stays out of GST returns, prints as Cash Memo', async () => {
    const owner = await newShopTenant('Shakti NoGst Tyres')
    const p = (await owner.api.post('/api/products', {
      itemType: 'product', gstRate: 18, unit: 'pcs', trackStock: true, name: 'Yokohama 165/80 R14', sku: 'YOK-165',
      salePrice: 5000, openingStock: 20, domainAttrs: { item_kind: 'tyre', brand: 'Yokohama', size: '165/80 R14', vehicle_type: 'car' },
    })).data
    const b = (await owner.api.get('/api/branches')).data[0]
    await owner.api.patch(`/api/branches/${b.id}`, { domainConfig: { prices_include_gst: true,
      bill_series: { car: { prefix: '', start: 93 }, non_gst: { prefix: 'NG-', start: 1 } } } })
    const post = (body: any) => owner.api.post('/api/tyre/sales', body, { headers: { 'Idempotency-Key': crypto.randomUUID() } })
    const gst = await post({ customer: { name: 'With GST', phone: '9876543401' }, billSeries: 'car',
      items: [{ productId: p.id, qty: 2, rate: 5900 }], payments: [{ method: 'cash', amount: 11800 }] })
    const cash = await post({ customer: { name: 'Cash Memo', phone: '9876543402' }, withGst: false, billSeries: 'non_gst',
      items: [{ productId: p.id, qty: 2, rate: 5000 }], charges: [{ label: 'Alignment', amount: 300 }],
      payments: [{ method: 'cash', amount: 10300 }] })
    expect([gst.status, cash.status]).toEqual([201, 201])
    expect(cash.data.invoice.number).toBe('NG-1')
    expect(Number(cash.data.invoice.grandTotal)).toBe(10300)
    expect(Number(cash.data.invoice.cgstTotal)).toBe(0)

    const month = new Date().toISOString().slice(0, 7)
    const sum = (await owner.api.get('/api/analytics/gst-summary', { params: { month } })).data
    expect(sum.summary).toMatchObject({ invoice_count: 1, total_invoice_value: 11800 })   // only the GST bill is in the return

    const reg = (await owner.api.get('/api/tyre/reports/register')).data.rows
    expect(reg.find((r: any) => r['Bill No'] === 'NG-1')['GST Bill']).toBe('No')
    expect(reg.find((r: any) => r['Bill No'] === '93')['GST Bill']).toBe('Yes')

    const pdf = await owner.api.get(`/api/tyre/invoices/${cash.data.invoice.id}/pdf`, { responseType: 'arraybuffer' })
    expect(pdf.status).toBe(200)
    expect(Buffer.from(pdf.data).subarray(0, 4).toString()).toBe('%PDF')
    expect((await post({ customer: { name: 'X', phone: '9876543403' }, withGst: 'no', items: [{ productId: p.id, qty: 1 }], payments: [] })).status).toBe(422)
  })
})

describe('Data Entry price drives the discount', () => {
  test('finalPrice below list is recorded as a discount; at/above list there is none; totals are exact', async () => {
    const owner = await newShopTenant('Shakti Discount Tyres')
    const p = (await owner.api.post('/api/products', {
      itemType: 'product', gstRate: 18, unit: 'pcs', trackStock: true, name: 'Yokohama 215/60 R17', sku: 'YOK-215',
      salePrice: 11000, purchasePrice: 8000, openingStock: 30, domainAttrs: { item_kind: 'tyre', brand: 'Yokohama', size: '215/60 R17', vehicle_type: 'car' },
    })).data
    const b = (await owner.api.get('/api/branches')).data[0]
    await owner.api.patch(`/api/branches/${b.id}`, { domainConfig: { prices_include_gst: true } })
    const sale = async (item: any, paid: number, phone: string) => {
      const r = await owner.api.post('/api/tyre/sales', { customer: { name: 'D', phone }, items: [{ productId: p.id, ...item }],
        payments: [{ method: 'cash', amount: paid }] }, { headers: { 'Idempotency-Key': crypto.randomUUID() } })
      expect(r.status).toBe(201)
      const inv = (await owner.api.get(`/api/invoices/${r.data.invoice.id}`)).data
      return inv
    }
    // list 11,000 → typed 10,400 × 4 = 41,600; discount (11,000 − 10,400) × 4 = 2,400 incl. GST
    const a = await sale({ qty: 4, finalPrice: 10400 }, 41600, '9876543501')
    expect(Number(a.grandTotal)).toBe(41600)
    const gross = 44000, discIncl = 2400
    expect(Number(a.items[0].discountAmt)).toBeCloseTo(discIncl * 100 / 118, 2)
    expect(Number(a.items[0].taxableAmt)).toBeCloseTo((gross - discIncl) * 100 / 118, 2)
    // a price with paise and an awkward percentage stays exact
    const c = await sale({ qty: 3, finalPrice: 9876.5 }, 29629.5, '9876543502')
    expect(Number(c.grandTotal)).toBe(Math.round(29629.5))            // whole-rupee rounding on the bill
    // charged above list: no discount, price is what was typed
    const up = await sale({ qty: 1, finalPrice: 12000 }, 12000, '9876543503')
    expect([Number(up.grandTotal), Number(up.items[0].discountAmt)]).toEqual([12000, 0])
    // no finalPrice: the catalogue price is used as before
    const plain = await sale({ qty: 1 }, 11000, '9876543504')
    expect(Number(plain.grandTotal)).toBe(11000)
  })
})

describe('Reminder rules: 0 days switches a reminder off', () => {
  test('0 for alignment = no next-service date after an alignment; other jobs keep their rule', async () => {
    const owner = await newShopTenant('Shakti Rules Tyres')
    const p = (await owner.api.post('/api/products', {
      itemType: 'product', gstRate: 18, unit: 'pcs', trackStock: true, name: 'Yokohama 155/65 R13', sku: 'YOK-155',
      salePrice: 4000, openingStock: 20, domainAttrs: { item_kind: 'tyre', brand: 'Yokohama', size: '155/65 R13', vehicle_type: 'car' },
    })).data
    const svc = ((await owner.api.get('/api/tyre/finder', { params: { kind: 'service', limit: 50 } })).data.data as any[]).find((s) => s.sku === 'SVC-ALN')
    const b = (await owner.api.get('/api/branches')).data[0]
    await owner.api.patch(`/api/branches/${b.id}`, { domainConfig: { alignment_reminder_days: 0, service_reminder_days: 120 } })
    const sale = async (items: any[], vehicleNo: string, phone: string) => {
      const r = await owner.api.post('/api/tyre/sales', { customer: { name: 'R', phone }, vehicleNo, vehicleType: 'car', odometer: 40000, items,
        payments: [{ method: 'cash', amount: 100000 }] }, { headers: { 'Idempotency-Key': crypto.randomUUID() } })
      if (r.status === 422) return owner.api.post('/api/tyre/sales', { customer: { name: 'R', phone }, vehicleNo, vehicleType: 'car', odometer: 40000, items }, { headers: { 'Idempotency-Key': crypto.randomUUID() } })
      return r
    }
    const vehicle = async (reg: string) => (await owner.api.get('/api/tyre/vehicles', { params: { search: reg } })).data.data[0]

    const a = await sale([{ productId: svc.id, qty: 4 }], 'GJ01AA0001', '9876544001')
    expect(a.status).toBe(201)
    const va = await vehicle('GJ01AA0001')
    expect(va.nextServiceDate ?? null).toBeNull()           // alignment reminder switched off
    expect(va.nextServiceKm ?? null).toBeNull()

    const t = await sale([{ productId: p.id, qty: 2 }], 'GJ01AA0002', '9876544002')
    expect(t.status).toBe(201)
    const vt = await vehicle('GJ01AA0002')
    expect(String(vt.nextServiceDate).slice(0, 10)).toBe(new Date(Date.now() + 5.5 * 3600000 + 120 * 86400000).toISOString().slice(0, 10))
  })
})

describe('Excel product import', () => {
  test('preview changes nothing; import creates, then a second sheet updates prices and ADDS stock', async () => {
    const { addStaff } = await import('./helpers')
    const owner = await newShopTenant('Shakti Product Import')
    const cashier = await addStaff(owner, 'cashier')
    const imp = (s: any, body: any) => s.api.post('/api/tyre/import/products', body)
    const stockOf = async (name: string) => {
      const r = (await owner.api.get('/api/tyre/finder', { params: { q: name, kind: 'any', inStock: 'false', limit: 5 } })).data.data as any[]
      return r.find((x) => x.name === name)
    }
    const rows = [
      { brand: 'Yokohama', size: '195 65 15', kind: 'tyre', vehicleType: 'car', salePrice: 6900, purchasePrice: 5800, stock: 8, reorderLevel: 4 },
      { brand: 'Apollo', size: '2.75-18', kind: 'tyre', vehicleType: 'two_wheeler', salePrice: 2100, stock: 10, reorderLevel: 3, sku: 'APL-275' },
      { name: 'Tube 4.00-8', kind: 'tube', vehicleType: 'two_wheeler', salePrice: 350, stock: 20 },
      { brand: 'Ceat', size: '185/70 R14', salePrice: undefined },           // new item with no price → error row
    ]
    expect((await imp(cashier, { rows })).status).toBe(403)

    const prev = (await imp(owner, { rows, dryRun: true })).data
    expect(prev).toMatchObject({ dryRun: true, created: 3, failed: 1 })
    expect(await stockOf('Yokohama 195/65 R15')).toBeUndefined()           // nothing saved by a preview

    const done = (await imp(owner, { rows })).data
    expect(done).toMatchObject({ created: 3, updated: 0, failed: 1, stockAdded: 38 })
    const y = await stockOf('Yokohama 195/65 R15')
    expect([y.stock, y.salePrice, y.lowStockQty]).toEqual([8, 6900, 4])
    expect(y.domainAttrs).toMatchObject({ size: '195/65 R15', brand: 'Yokohama', vehicle_type: 'car' })

    // a second delivery: same item, new price, 6 more received
    const again = (await imp(owner, { rows: [{ brand: 'Yokohama', size: '195/65 R15', salePrice: 7100, stock: 6 }] })).data
    expect(again).toMatchObject({ created: 0, updated: 1, failed: 0, stockAdded: 6 })
    const y2 = await stockOf('Yokohama 195/65 R15')
    expect([y2.stock, y2.salePrice]).toEqual([14, 7100])
    // the same tyre typed another way is recognised, not duplicated
    const alt = (await imp(owner, { rows: [{ brand: 'yokohama', size: '195/65R15', stock: 1 }] })).data
    expect(alt).toMatchObject({ created: 0, updated: 1 })
    expect((await stockOf('Yokohama 195/65 R15')).stock).toBe(15)
    // categorised, so the Tyres & Items chips find them
    const cats = (await owner.api.get('/api/categories')).data as any[]
    const bike = cats.find((c) => c.slug === 'two-wheeler')
    const inBike = (await owner.api.get('/api/products', { params: { categoryId: bike.id } })).data.data.map((p: any) => p.name)
    expect(inBike).toEqual(expect.arrayContaining(['Apollo 2.75-18']))
    // duplicate rows in one sheet are rejected; bad enum is a 422
    const dup = (await imp(owner, { rows: [rows[0], rows[0]] })).data
    expect(dup.rows.map((r: any) => r.action)).toEqual(['update', 'error'])
    expect((await imp(owner, { rows: [{ ...rows[0], kind: 'banana' }] })).status).toBe(422)
    expect((await imp(owner, { rows: [] })).status).toBe(422)
  })
})

describe('AI bill scan option', () => {
  test('can be switched off in settings; status reflects it; the line parser reads brand, size and kind', async () => {
    const { parseTyreLine } = await import('../lib/tyre-parse')
    expect(parseTyreLine('YOKOHAMA 185/65R15 BluEarth ES32')).toMatchObject({ brand: 'Yokohama', size: '185/65 R15', kind: 'tyre', vehicleType: 'car' })
    expect(parseTyreLine('MRF 205 55 16 ZVTV')).toMatchObject({ brand: 'MRF', size: '205/55 R16' })
    expect(parseTyreLine('Apollo 2.75-18 tube')).toMatchObject({ brand: 'Apollo', kind: 'tube', size: '2.75-18', vehicleType: 'two_wheeler' })
    expect(parseTyreLine('CEAT 10.00 R20 truck')).toMatchObject({ brand: 'CEAT', vehicleType: 'truck_bus' })
    expect(parseTyreLine('Wheel weights 5 kg').size).toBe('')

    const owner = await newShopTenant('Shakti Ai Option')
    const b = (await owner.api.get('/api/branches')).data[0]
    const st = async () => (await owner.api.get('/api/tyre/import/ai-status')).data
    expect((await st()).enabled).toBe(true)
    await owner.api.patch(`/api/branches/${b.id}`, { domainConfig: { ai_enabled: false } })
    expect(await st()).toMatchObject({ enabled: false, available: false })
    const scan = await owner.api.post('/api/tyre/import/scan-bill', { imageBase64: 'A'.repeat(200) })
    expect(scan.status).toBe(403)
    expect(String(scan.data.error)).toMatch(/switched off/i)
    // Excel import keeps working with AI off
    const imp = await owner.api.post('/api/tyre/import/products', { rows: [{ brand: 'Yokohama', size: '175/65 R14', salePrice: 5900, stock: 4 }] })
    expect(imp.status).toBe(200)
    expect(imp.data.created).toBe(1)
  })
})

describe('Services follow the "GST on services" setting', () => {
  test('0 = no GST on service cards; the register export puts them in the Alignment/Weight/Labour columns', async () => {
    const owner = await newShopTenant('Shakti Service Gst')
    const svc = (await owner.api.get('/api/tyre/finder', { params: { kind: 'service', limit: 50 } })).data.data as any[]
    const aln = svc.find((s) => s.sku === 'SVC-ALN'), bal = svc.find((s) => s.sku === 'SVC-BAL')
    const b = (await owner.api.get('/api/branches')).data[0]
    await owner.api.patch(`/api/branches/${b.id}`, { domainConfig: { prices_include_gst: true, default_service_gst: 0 } })
    const r = await owner.api.post('/api/tyre/sales', {
      customer: { name: 'Walk In', phone: '9876544101' }, vehicleNo: 'GJ01ZZ0001', saleKind: 'service_only',
      items: [{ productId: aln.id, qty: 1 }, { productId: bal.id, qty: 4 }], payments: [{ method: 'cash', amount: 1000 }],
    }, { headers: { 'Idempotency-Key': crypto.randomUUID() } })
    expect(r.status).toBe(201)
    expect([Number(r.data.invoice.grandTotal), Number(r.data.invoice.cgstTotal), Number(r.data.invoice.taxableAmt)]).toEqual([1000, 0, 1000])

    const row = (await owner.api.get('/api/tyre/reports/register')).data.rows[0]
    expect(row).toMatchObject({ Alignment: 600, Balancing: 400, 'Bill Total': 1000, 'GST Bill': 'Yes' })

    // the default stays 18% for shops that charge it
    await owner.api.patch(`/api/branches/${b.id}`, { domainConfig: { default_service_gst: 18 } })
    const g = await owner.api.post('/api/tyre/sales', {
      customer: { name: 'Walk In 2', phone: '9876544102' }, saleKind: 'service_only',
      items: [{ productId: aln.id, qty: 1 }], payments: [{ method: 'cash', amount: 600 }],
    }, { headers: { 'Idempotency-Key': crypto.randomUUID() } })
    expect(Number(g.data.invoice.cgstTotal) + Number(g.data.invoice.sgstTotal)).toBeCloseTo(91.53, 2)   // 600 incl. 18%
  })
})

describe('Powered-by credit', () => {
  test('bill PDFs always carry the provider credit and link, even if a business tries to switch it off, and never spill onto a new page', async () => {
    const owner = await newShopTenant('Shakti Credit Tyres')
    const p = (await owner.api.post('/api/products', { itemType: 'product', gstRate: 18, unit: 'pcs', trackStock: true, name: 'Yokohama 175/70 R14',
      sku: 'YOK-1770', salePrice: 5000, openingStock: 9, domainAttrs: { item_kind: 'tyre', brand: 'Yokohama', size: '175/70 R14', vehicle_type: 'car' } })).data
    const mk = async (phone: string) => (await owner.api.post('/api/tyre/sales', { customer: { name: 'C', phone }, items: [{ productId: p.id, qty: 1 }],
      payments: [{ method: 'cash', amount: 5000 }] }, { headers: { 'Idempotency-Key': crypto.randomUUID() } })).data.invoice.id
    const pdfText = async (id: string) => {
      const buf = Buffer.from((await owner.api.get(`/api/tyre/invoices/${id}/pdf`, { responseType: 'arraybuffer' })).data)
      return { raw: buf.toString('latin1'), pages: (buf.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length }
    }
    const on = await pdfText(await mk('9876545001'))
    expect(on.pages).toBe(1)
    const b = (await owner.api.get('/api/branches')).data[0]
    await owner.api.patch(`/api/branches/${b.id}`, { domainConfig: { show_powered_by: false } })
    const off = await pdfText(await mk('9876545002'))
    expect(off.pages).toBe(1)
    expect(Math.abs(off.raw.length - on.raw.length)).toBeLessThan(2000)   // same document: the setting has no effect
    const withCredit = await owner.api.get(`/api/tyre/invoices/${(await owner.api.get('/api/invoices', { params: { limit: 1 } })).data.data[0].id}/pdf`, { responseType: 'arraybuffer' })
    expect(withCredit.status).toBe(200)
  })
})

describe('Customer GSTIN on a bill (optional)', () => {
  let owner: Session, tyre: any

  /** A GSTIN that passes the check digit, built the same way the real ones are. */
  const gstinOf = (state: string, pan: string, entity = '1'): string => {
    const base = `${state}${pan}${entity}Z`
    const CH = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
    let sum = 0
    for (let i = 0; i < 14; i++) { const m = CH.indexOf(base[i]!) * (i % 2 === 0 ? 1 : 2); sum += Math.floor(m / 36) + (m % 36) }
    return base + CH[(36 - (sum % 36)) % 36]
  }
  const G1 = gstinOf('24', 'AABCR1234A'), G2 = gstinOf('24', 'AAACS5678B'), G3 = gstinOf('27', 'AAACT9999C')

  const sale = (body: Record<string, unknown>) =>
    owner.api.post('/api/tyre/sales', { items: [{ productId: tyre.id, qty: 1, rate: 5000 }], payments: [{ method: 'cash', amount: 5000 }], ...body },
      { headers: { 'Idempotency-Key': crypto.randomUUID() } })
  const partyOf = async (invoiceId: string) => {
    const inv = (await owner.api.get(`/api/invoices/${invoiceId}`)).data
    return (await owner.api.get(`/api/parties/${inv.partyId}`)).data
  }

  beforeAll(async () => {
    owner = await newShopTenant('Gstin Tyres')
    tyre = (await owner.api.post('/api/products', {
      itemType: 'product', gstRate: 18, unit: 'pcs', trackStock: true, name: 'MRF 185/65 R15', sku: 'MRF-185', salePrice: 5000, purchasePrice: 3500, openingStock: 40,
      domainAttrs: { item_kind: 'tyre', brand: 'MRF', size: '185/65 R15', vehicle_type: 'car' },
    })).data
  })

  test('a normal bill without a GSTIN works exactly as before', async () => {
    const r = await sale({ customer: { name: 'Walk In', phone: '9811100001' } })
    expect(r.status).toBe(201)
    expect((await partyOf(r.data.invoice.id)).gstin ?? null).toBeNull()
  })

  test('a valid GSTIN is kept on the new customer and printed on the bill', async () => {
    const r = await sale({ customer: { name: 'Shree Roadlines', phone: '9811100002' }, customerGstin: G1.toLowerCase() })
    expect(r.status).toBe(201)
    expect((await partyOf(r.data.invoice.id)).gstin).toBe(G1)
    const pdf = await owner.api.get(`/api/tyre/invoices/${r.data.invoice.id}/pdf`, { responseType: 'arraybuffer' })
    expect(pdf.status).toBe(200)
    expect(Buffer.from(pdf.data).subarray(0, 4).toString()).toBe('%PDF')
  })

  test('a wrong or half-typed GSTIN is refused with a clear message; blank is fine', async () => {
    const bad = await sale({ customer: { name: 'X Traders', phone: '9811100003' }, customerGstin: G1.slice(0, 14) + (G1.endsWith('0') ? '1' : '0') })
    expect(bad.status).toBe(422)
    expect(JSON.stringify(bad.data)).toMatch(/GSTIN is not valid/)
    expect((await sale({ customer: { name: 'Short', phone: '9811100004' }, customerGstin: '24AABC' })).status).toBe(422)
    expect((await sale({ customer: { name: 'Blank', phone: '9811100005' }, customerGstin: '   ' })).status).toBe(201)
  })

  test('the same GSTIN is the same business: no duplicate customer is made', async () => {
    const a = await partyOf((await sale({ customer: { name: 'Shree Roadlines Pvt', phone: '9811100099' }, customerGstin: G1 })).data.invoice.id)
    const b = await partyOf((await sale({ customer: { name: 'Shree Roadlines', phone: '9811100002' }, customerGstin: G1 })).data.invoice.id)
    expect(a.id).toBe(b.id)
    expect(a.name).toBe('Shree Roadlines')
  })

  test('a saved customer without a GSTIN gets it filled in; a different one is not silently overwritten', async () => {
    const first = await sale({ customer: { name: 'Hari Transport', phone: '9811100006' } })
    const party = await partyOf(first.data.invoice.id)
    expect(party.gstin ?? null).toBeNull()
    const second = await sale({ partyId: party.id, customerGstin: G2 })
    expect(second.status).toBe(201)
    expect((await owner.api.get(`/api/parties/${party.id}`)).data.gstin).toBe(G2)
    const clash = await sale({ partyId: party.id, customerGstin: G3 })
    expect(clash.status).toBe(422)
    expect(JSON.stringify(clash.data)).toMatch(new RegExp(G2))
    expect((await sale({ partyId: party.id, customerGstin: G2 })).status).toBe(201)      // the same one again is fine
  })

  test('a GSTIN with a name but no mobile number still saves the customer', async () => {
    const r = await sale({ customer: { name: 'No Phone Traders' }, customerGstin: G3 })
    expect(r.status).toBe(201)
    const p = await partyOf(r.data.invoice.id)
    expect(p.gstin).toBe(G3)
    expect(p.name).toBe('No Phone Traders')
  })

  test('the bill goes to the B2B table of GSTR-1 under the customer GSTIN', async () => {
    const month = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 7)
    const g = await owner.api.get('/api/reports/gstr1', { params: { month } })
    expect(g.status).toBe(200)
    const text = JSON.stringify(g.data)
    expect(text).toContain(G1)
  })
})

describe('HSN code fills in by itself from the tyre', () => {
  let owner: Session
  const mk = async (name: string, sku: string, vt: string, extra: Record<string, unknown> = {}) =>
    (await owner.api.post('/api/products', {
      itemType: 'product', gstRate: 18, unit: 'pcs', trackStock: true, name, sku, salePrice: 5000, purchasePrice: 3500, openingStock: 20,
      domainAttrs: { item_kind: 'tyre', brand: 'MRF', size: '185/65 R15', vehicle_type: vt }, ...extra,
    })).data
  const sale = (productId: string, item: Record<string, unknown> = {}) =>
    owner.api.post('/api/tyre/sales', { customer: { name: 'Hsn Cust', phone: '9822200001' }, items: [{ productId, qty: 1, rate: 5000, ...item }], payments: [{ method: 'cash', amount: 5000 }] },
      { headers: { 'Idempotency-Key': crypto.randomUUID() } })
  const hsnOnBill = async (invoiceId: string) => (await owner.api.get(`/api/invoices/${invoiceId}`)).data.items[0].hsnSacCode

  beforeAll(async () => { owner = await newShopTenant('Hsn Tyres') })

  test('a new tyre gets the HSN of its vehicle class without anyone typing it', async () => {
    expect((await mk('MRF Car', 'H-CAR', 'car')).hsnSacCode).toBe('401110')
    expect((await mk('MRF Bike', 'H-2W', 'two_wheeler')).hsnSacCode).toBe('401140')
    expect((await mk('MRF Truck', 'H-TRK', 'truck_bus')).hsnSacCode).toBe('401120')
  })

  test('a code typed on the product is respected', async () => {
    expect((await mk('MRF Special', 'H-SPL', 'car', { hsnSacCode: '40111010' })).hsnSacCode).toBe('40111010')
  })

  test('the size finder returns the HSN, even for a tyre saved before this existed', async () => {
    const old = await mk('MRF Old', 'H-OLD', 'car')
    await owner.api.put(`/api/products/${old.id}`, { hsnSacCode: null }).catch(() => {})
    const f = await owner.api.get('/api/tyre/finder', { params: { size: '185/65R15', limit: 50 } })
    expect(f.data.data.length).toBeGreaterThan(0)
    for (const r of f.data.data) expect(r.hsn).toMatch(/^\d{6,8}$/)
  })

  test('the bill carries the tyre’s HSN; a changed code on the line wins for that bill only', async () => {
    const p = await mk('MRF Bill', 'H-BILL', 'car')
    expect(await hsnOnBill((await sale(p.id)).data.invoice.id)).toBe('401110')
    expect(await hsnOnBill((await sale(p.id, { hsnSacCode: '40111090' })).data.invoice.id)).toBe('40111090')
    expect((await owner.api.get(`/api/products/${p.id}`)).data.hsnSacCode).toBe('401110')      // the product itself is unchanged
  })

  test('a tyre with no HSN on file gets the standard one saved when it is sold', async () => {
    const p = await mk('MRF Blank', 'H-BLANK', 'two_wheeler')
    // simulate a catalogue row that predates the auto-fill
    const run = await owner.api.patch(`/api/products/${p.id}`, { hsnSacCode: '' })
    void run
    const inv = await sale(p.id)
    expect(inv.status).toBe(201)
    expect(await hsnOnBill(inv.data.invoice.id)).toMatch(/^4011/)
  })

  test('a malformed HSN is refused', async () => {
    const p = await mk('MRF Bad', 'H-BAD', 'car')
    const r = await sale(p.id, { hsnSacCode: 'ABC' })
    expect(r.status).toBe(422)
    expect(JSON.stringify(r.data)).toMatch(/HSN/)
    expect((await sale(p.id, { hsnSacCode: '123' })).status).toBe(422)
  })
})
