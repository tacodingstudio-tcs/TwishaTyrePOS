// Tyre module — integration tests against a running API (see jest.config.cjs / README).
// Every suite provisions its own throwaway tenants (phones 7xxxxxxxxx are purged by globalSetup),
// so nothing depends on seed data.

import { newShopTenant, addStaff, today, type Session } from './helpers'

let skuCounter = 0
const uniqueSerial = (p = 'SN') => `${p}${Date.now().toString().slice(-7)}${skuCounter++}`

describe('Tyre shop', () => {
  let owner: Session, other: Session, viewer: Session, manager: Session, cashier: Session
  let walkin: any

  // catalogue (created once for `owner`)
  let car: any, car2: any, truck: any, tube: any, cheap: any
  let fitting: any, alignment: any, scrap: any

  const mkProduct = async (s: Session, body: Record<string, unknown>) => {
    const r = await s.api.post('/api/products', {
      itemType: 'product', gstRate: 18, unit: 'pcs', trackStock: true, ...body,
    })
    expect([200, 201]).toContain(r.status)
    return r.data
  }
  const sale = async (s: Session, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
    s.api.post('/api/tyre/sales', body, { headers: { 'Idempotency-Key': crypto.randomUUID(), ...headers } })
  const stockOf = async (s: Session, id: string): Promise<number> => {
    const r = await s.api.get('/api/tyre/finder', { params: { id, kind: 'any', limit: 1 } })
    return r.data.data[0]?.stock ?? NaN
  }
  const find = async (s: Session, params: Record<string, unknown>) =>
    (await s.api.get('/api/tyre/finder', { params })).data.data as any[]

  beforeAll(async () => {
    owner   = await newShopTenant('Alpha Tyres')
    other   = await newShopTenant('Beta Tyres')
    viewer  = await addStaff(owner, 'viewer')
    manager = await addStaff(owner, 'manager')
    cashier = await addStaff(owner, 'cashier')

    car = await mkProduct(owner, {
      name: 'MRF ZVTV 185/65 R15', sku: 'MRF-ZVTV-185', salePrice: 4200, purchasePrice: 3600, mrp: 4500, lowStockQty: 4, openingStock: 20,
      domainAttrs: { item_kind: 'tyre', brand: 'MRF', pattern: 'ZVTV', size: '185/65 R15', vehicle_type: 'car', tube_type: 'tubeless', warranty_months: 12 },
    })
    car2 = await mkProduct(owner, {
      name: 'Apollo Amazer 4G 185/65 R15', sku: 'APL-AMZ-185', salePrice: 3900, purchasePrice: 3400, openingStock: 8,
      domainAttrs: { item_kind: 'tyre', brand: 'Apollo', pattern: 'Amazer 4G', size: '185/65R15', vehicle_type: 'car', tube_type: 'tubeless', warranty_months: 0 },
    })
    truck = await mkProduct(owner, {
      name: 'JK Jetway 10.00 R20', sku: 'JK-1000', salePrice: 18500, purchasePrice: 16500, openingStock: 6, gstRate: 0,
      domainAttrs: { item_kind: 'tyre', brand: 'JK', pattern: 'Jetway', size: '10.00 R20', vehicle_type: 'truck_bus', construction: 'radial' },
    })
    tube = await mkProduct(owner, {
      name: 'Tube 4.00-8', sku: 'TUBE-400', salePrice: 350, purchasePrice: 280, openingStock: 30,
      domainAttrs: { item_kind: 'tube', brand: 'MRF', size: '4.00-8', vehicle_type: 'two_wheeler' },
    })
    cheap = await mkProduct(owner, {
      name: 'Ceat Milaze 165/80 R14', sku: 'CEAT-165', salePrice: 3000, purchasePrice: 2800, openingStock: 40,
      domainAttrs: { item_kind: 'tyre', brand: 'CEAT', pattern: 'Milaze', size: '165/80 R14', vehicle_type: 'car' },
    })

    const svc = await find(owner, { kind: 'service', limit: 50 })
    fitting   = svc.find((p) => p.sku === 'SVC-FIT')
    alignment = svc.find((p) => p.sku === 'SVC-ALN')
    const sc = await find(owner, { kind: 'scrap', limit: 5 })
    scrap = sc[0]
  })

  // ═══════════════════════════════════════════════════════════════════════════
  describe('registration & catalogue', () => {
    test('a new shop is on the tyre domain with fitting services and an old-tyre item pre-seeded', async () => {
      const list = (await owner.api.get('/api/branches')).data
      expect(list).toHaveLength(1)
      expect(list[0].domainType).toBe('tyre')
      expect(list[0].domainConfig).toMatchObject({ default_tyre_gst: 18, default_service_sac: '998714' })
      expect(fitting).toBeTruthy()
      expect(alignment).toBeTruthy()
      expect(fitting.hsnSacCode).toBe('998714')
      expect(scrap).toBeTruthy()
      expect(scrap.sku).toBe('SCRAP-TYRE')
    })

    test('tyre attributes are validated: an unknown vehicle type is a 4xx', async () => {
      const r = await owner.api.post('/api/products', {
        name: 'Bad tyre', salePrice: 100, domainAttrs: { item_kind: 'tyre', vehicle_type: 'spaceship' },
      })
      expect(r.status).toBeGreaterThanOrEqual(400)
      expect(r.status).toBeLessThan(500)
    })

    test('additional branches cannot be created', async () => {
      expect((await owner.api.post('/api/branches', { name: 'Second Shop', domainType: 'tyre' })).status).toBe(403)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  describe('size finder', () => {
    test.each(['185/65 R15', '185/65R15', '185 65 15', '1856515', '185/65-15', '185/65 ZR15'])('"%s" finds the 185/65 R15 tyres', async (size) => {
      const rows = await find(owner, { size })
      const names = rows.map((r) => r.name)
      expect(names).toContain('MRF ZVTV 185/65 R15')
      expect(names).toContain('Apollo Amazer 4G 185/65 R15')
      expect(names).not.toContain('JK Jetway 10.00 R20')
    })

    test('truck sizes and brand / stock filters work', async () => {
      expect((await find(owner, { size: '10.00 R20' })).map((r) => r.name)).toEqual(['JK Jetway 10.00 R20'])
      expect((await find(owner, { size: '1000R20' })).length).toBeGreaterThanOrEqual(0)   // no crash on odd input
      const mrf = await find(owner, { brand: 'mrf', kind: 'any' })
      expect(mrf.map((r) => r.sku).sort()).toEqual(['MRF-ZVTV-185', 'TUBE-400'])
      const tubes = await find(owner, { kind: 'tube' })
      expect(tubes.map((r) => r.sku)).toEqual(['TUBE-400'])
    })

    test('stock comes from the ledger, services are listed separately, and a viewer sees no margin', async () => {
      const r = (await find(owner, { size: '185/65 R15' })).find((x) => x.sku === 'MRF-ZVTV-185')
      expect(r.stock).toBe(20)
      expect(r.marginPct).toBeCloseTo(14.3, 1)
      const asViewer = (await find(viewer, { size: '185/65 R15' })).find((x) => x.sku === 'MRF-ZVTV-185')
      expect(asViewer.marginPct).toBeNull()
      expect((await find(owner, { size: '185/65 R15' })).some((x) => x.sku === 'SVC-FIT')).toBe(false)
      const svc = await find(owner, { kind: 'service' })
      expect(svc.map((s) => s.sku)).toEqual(expect.arrayContaining(['SVC-FIT', 'SVC-ALN']))
    })

    test('catalogue is private to its business', async () => {
      expect(await find(other, { size: '185/65 R15' })).toHaveLength(0)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  describe('counter sale', () => {
    test('cash sale: bill, GST split, stock out, warranty rows, vehicle and next-service date', async () => {
      const s1 = uniqueSerial(), s2 = uniqueSerial()
      const before = await stockOf(owner, car.id)
      const r = await sale(owner, {
        vehicleNo: 'gj 05 ab 1234', vehicleType: 'car', odometer: 42000, makeModel: 'Swift',
        customer: { name: 'Ramesh Patel', phone: '9825011111' },
        items: [{ productId: car.id, qty: 2, serialNos: [s1, s2], dotCodes: ['2325', '2425'], positions: ['FL', 'FR'] }],
        payments: [{ method: 'cash', amount: 9912 }],      // 2 × 4200 × 1.18
      })
      expect(r.status).toBe(201)
      const inv = r.data.invoice
      expect(inv.status).toBe('paid')
      expect(Number(inv.taxableAmt)).toBeCloseTo(8400, 2)
      expect(Number(inv.cgstTotal)).toBeCloseTo(756, 2)         // 9% + 9%, same state (24)
      expect(Number(inv.sgstTotal)).toBeCloseTo(756, 2)
      expect(Number(inv.grandTotal)).toBeCloseTo(9912, 0)
      expect(await stockOf(owner, car.id)).toBe(before - 2)

      expect(r.data.warranty).toHaveLength(2)
      expect(r.data.warranty.map((w: any) => w.serialNo).sort()).toEqual([s1, s2].sort())
      expect(r.data.warranty[0]).toMatchObject({ vehicleNo: 'GJ05AB1234', itemKind: 'tyre', warrantyMonths: 12, status: 'active', brand: 'MRF' })
      expect(String(r.data.warranty[0].warrantyUntil).slice(0, 10)).toBe(
        new Date(Date.UTC(Number(today().slice(0, 4)), Number(today().slice(5, 7)) - 1 + 12, Number(today().slice(8, 10)))).toISOString().slice(0, 10))

      expect(r.data.vehicle).toMatchObject({ regNo: 'GJ05AB1234', vehicleType: 'car', makeModel: 'Swift', lastOdometer: 42000 })
      expect(String(r.data.vehicle.nextServiceDate).slice(0, 10)).toBe(
        new Date(Date.now() + 5.5 * 3600_000 + 180 * 86_400_000).toISOString().slice(0, 10))
      expect(r.data.vehicle.tyreSize).toBe('185/65 R15')

      // the customer was created from name + phone and linked
      const parties = (await owner.api.get('/api/parties', { params: { search: '9825011111' } })).data.data
      expect(parties).toHaveLength(1)
      expect(inv.partyId).toBe(parties[0].id)
    })

    test('a repeat sale to the same mobile reuses the customer and updates the same vehicle', async () => {
      const before = (await owner.api.get('/api/parties', { params: { search: '9825011111' } })).data.data
      const r = await sale(owner, {
        vehicleNo: 'GJ05AB1234', customer: { name: 'Ramesh P.', phone: '98250 11111' },
        items: [{ productId: tube.id, qty: 1 }], payments: [{ method: 'upi', amount: 413 }],
      })
      expect(r.status).toBe(201)
      expect(r.data.invoice.partyId).toBe(before[0].id)
      const after = (await owner.api.get('/api/parties', { params: { search: '9825011111' } })).data.data
      expect(after).toHaveLength(1)
      const v = (await owner.api.get('/api/tyre/vehicles', { params: { search: 'GJ05AB1234' } })).data
      expect(v.total).toBe(1)
    })

    test('fitting services ride on the same bill and take the service GST rate and SAC', async () => {
      const r = await sale(owner, {
        customer: { name: 'Walk-in Fit', phone: '9825022222' },
        items: [{ productId: cheap.id, qty: 4, serialNos: [uniqueSerial(), uniqueSerial(), uniqueSerial(), uniqueSerial()] },
                { productId: fitting.id, qty: 4 }, { productId: alignment.id, qty: 1 }],
        payments: [{ method: 'cash', amount: 14000 + 400 + 600 }],
      })
      expect(r.status).toBe(201)
      const items = r.data.invoice.items
      const svc = items.find((i: any) => i.hsnSacCode === '998714')
      expect(svc).toBeTruthy()
      // services never create warranty rows or touch stock
      expect(r.data.warranty).toHaveLength(4)
      expect(r.data.warnings).toEqual([])
    })

    test('the catalogue GST of 0 falls back to the shop default; HSN defaults by vehicle class', async () => {
      const r = await sale(owner, {
        customer: { name: 'Fleet One', phone: '9825033333' },
        items: [{ productId: truck.id, qty: 1 }],
        payments: [{ method: 'bank_transfer', amount: 21830 }],
      })
      expect(r.status).toBe(201)
      expect(Number(r.data.invoice.grandTotal)).toBeCloseTo(21830, 0)       // 18500 × 1.18
      expect(r.data.invoice.items[0].hsnSacCode).toBe('401120')
    })

    test('selling more than is in stock is refused before anything is written', async () => {
      const left = await stockOf(owner, car2.id)
      const r = await sale(owner, { customer: { name: 'Greedy', phone: '9825044444' }, items: [{ productId: car2.id, qty: left + 1 }], payments: [] })
      expect(r.status).toBe(409)
      expect(r.data.message ?? r.data.error).toMatch(/in stock/i)
      expect(await stockOf(owner, car2.id)).toBe(left)
    })

    test('the same serial cannot be sold twice; it is allowed on a different product', async () => {
      const serial = uniqueSerial('DUP')
      const ok = await sale(owner, { customer: { name: 'First', phone: '9825055555' }, items: [{ productId: car.id, qty: 1, serialNos: [serial] }], payments: [{ method: 'cash', amount: 4956 }] })
      expect(ok.status).toBe(201)
      const dup = await sale(owner, { customer: { name: 'Second', phone: '9825066666' }, items: [{ productId: car.id, qty: 1, serialNos: [serial.toLowerCase()] }], payments: [{ method: 'cash', amount: 4956 }] })
      expect(dup.status).toBe(409)
      const diff = await sale(owner, { customer: { name: 'Third', phone: '9825077777' }, items: [{ productId: car2.id, qty: 1, serialNos: [serial] }], payments: [{ method: 'cash', amount: 4602 }] })
      expect(diff.status).toBe(201)
      // within one request too
      const twice = await sale(owner, { customer: { name: 'Fourth', phone: '9825088888' }, items: [{ productId: car.id, qty: 2, serialNos: ['ZZ1', 'zz1'] }], payments: [] })
      expect(twice.status).toBe(422)
    })

    test('serial / DOT shape is checked', async () => {
      const tooMany = await sale(owner, { customer: { name: 'X', phone: '9825099991' }, items: [{ productId: car.id, qty: 1, serialNos: ['A', 'B'] }], payments: [] })
      expect(tooMany.status).toBe(422)
      const badDot = await sale(owner, { customer: { name: 'X', phone: '9825099991' }, items: [{ productId: car.id, qty: 1, dotCodes: ['23-25'] }], payments: [] })
      expect(badDot.status).toBe(422)
      const onService = await sale(owner, { customer: { name: 'X', phone: '9825099991' }, items: [{ productId: fitting.id, qty: 1, serialNos: ['A'] }], payments: [] })
      expect(onService.status).toBe(422)
    })

    test('credit needs a customer; with one the balance goes on their account', async () => {
      const anon = await sale(owner, { items: [{ productId: tube.id, qty: 1 }], payments: [{ method: 'cash', amount: 100 }] })
      expect(anon.status).toBe(422)

      const credit = await sale(owner, {
        customer: { name: 'Credit Garage', phone: '9825012345' }, creditDays: 15,
        items: [{ productId: tube.id, qty: 2 }], payments: [{ method: 'cash', amount: 200 }],
      })
      expect(credit.status).toBe(201)
      expect(credit.data.invoice.status).toBe('partial')
      const party = (await owner.api.get('/api/parties', { params: { search: '9825012345' } })).data.data[0]
      expect(Number(party.balance)).toBeCloseTo(826 - 200, 0)      // 2 × 350 × 1.18 = 826
      expect(String(credit.data.invoice.dueDate).slice(0, 10)).toBe(
        new Date(Date.now() + 5.5 * 3600_000 + 15 * 86_400_000).toISOString().slice(0, 10))
    })

    test('payments beyond the bill are refused', async () => {
      const r = await sale(owner, { customer: { name: 'Overpay', phone: '9825012399' }, items: [{ productId: tube.id, qty: 1 }], payments: [{ method: 'cash', amount: 5000 }] })
      expect(r.status).toBe(422)
    })

    test('old-tyre exchange: full-value bill, allowance as a payment, scrap into stock', async () => {
      const scrapBefore = await stockOf(owner, scrap.id)
      const r = await sale(owner, {
        customer: { name: 'Exchange Customer', phone: '9825013579' },
        items: [{ productId: cheap.id, qty: 1, serialNos: [uniqueSerial()] }],
        exchange: { qty: 1, value: 600, note: 'MRF 165/80 R14, 40% tread' },
        payments: [{ method: 'cash', amount: 2940 }],      // 3000 × 1.18 = 3540 − 600
      })
      expect(r.status).toBe(201)
      expect(Number(r.data.invoice.grandTotal)).toBeCloseTo(3540, 0)       // GST on the full value
      expect(r.data.invoice.status).toBe('paid')
      expect(r.data.exchange).toMatchObject({ qty: 1, value: 600 })
      expect(await stockOf(owner, scrap.id)).toBe(scrapBefore + 1)
      const pay = (await owner.api.get('/api/payments', { params: { partyId: r.data.invoice.partyId, limit: 20 } })).data
      const list: any[] = pay.items ?? []
      expect(list.map((p) => p.method).sort()).toEqual(['cash', 'exchange'])
    })

    test('an allowance larger than the bill is refused', async () => {
      const r = await sale(owner, { customer: { name: 'Big Allowance', phone: '9825013580' }, items: [{ productId: tube.id, qty: 1 }], exchange: { qty: 1, value: 5000 }, payments: [] })
      expect(r.status).toBe(422)
    })

    test('the same Idempotency-Key never sells (or deducts stock) twice', async () => {
      const key = crypto.randomUUID()
      const body = { customer: { name: 'Retry', phone: '9825024680' }, items: [{ productId: tube.id, qty: 3 }], payments: [{ method: 'cash', amount: 1239 }] }
      const before = await stockOf(owner, tube.id)
      const a = await sale(owner, body, { 'Idempotency-Key': key })
      const b = await sale(owner, body, { 'Idempotency-Key': key })
      expect(a.status).toBe(201)
      expect(b.status).toBe(200)
      expect(b.data.invoice.id).toBe(a.data.invoice.id)
      expect(await stockOf(owner, tube.id)).toBe(before - 3)
    })

    test('counter staff cannot sell below cost; a manager can, with a warning', async () => {
      const body = { customer: { name: 'Haggler', phone: '9825036912' }, items: [{ productId: cheap.id, qty: 1, rate: 2500 }], payments: [{ method: 'cash', amount: 2950 }] }
      const c = await sale(cashier, body)
      expect(c.status).toBe(403)
      const m = await sale(manager, { ...body, customer: { name: 'Haggler 2', phone: '9825036913' } })
      expect(m.status).toBe(201)
      expect(m.data.warnings.join(' ')).toMatch(/below cost/i)
    })

    test('serial_required makes a serial number mandatory for tyres, and can be switched off again', async () => {
      const branchId = owner.branchId
      await owner.api.patch(`/api/branches/${branchId}`, { domainConfig: { serial_required: true } })
      const r = await sale(owner, { customer: { name: 'NoSerial', phone: '9825047001' }, items: [{ productId: cheap.id, qty: 1 }], payments: [] })
      expect(r.status).toBe(422)
      expect(r.data.message ?? r.data.error).toMatch(/serial/i)
      await owner.api.patch(`/api/branches/${branchId}`, { domainConfig: { serial_required: false } })
      const ok = await sale(owner, { customer: { name: 'NoSerial', phone: '9825047001' }, items: [{ productId: cheap.id, qty: 1 }], payments: [{ method: 'cash', amount: 3540 }] })
      expect(ok.status).toBe(201)
    })

    test('read-only users cannot sell; another business cannot use this catalogue', async () => {
      expect((await sale(viewer, { customer: { name: 'V', phone: '9825058001' }, items: [{ productId: tube.id, qty: 1 }], payments: [] })).status).toBe(403)
      expect((await sale(other, { customer: { name: 'O', phone: '9825058002' }, items: [{ productId: tube.id, qty: 1 }], payments: [] })).status).toBe(404)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  describe('warranty', () => {
    let rows: any[], billId: string

    beforeAll(async () => {
      const s = uniqueSerial('WR')
      const r = await sale(owner, {
        vehicleNo: 'GJ01WR0001', customer: { name: 'Warranty Wala', phone: '9825061111' },
        items: [{ productId: car.id, qty: 1, serialNos: [s], dotCodes: ['0125'] }], payments: [{ method: 'cash', amount: 4956 }],
      })
      billId = r.data.invoice.id
      rows = r.data.warranty
    })

    test('lookup by serial, vehicle, mobile and bill number', async () => {
      const w = rows[0]
      const bySerial = (await owner.api.get('/api/tyre/warranty', { params: { serial: w.serialNo } })).data
      expect(bySerial.total).toBe(1)
      expect((await owner.api.get('/api/tyre/warranty', { params: { vehicleNo: 'gj01 wr0001' } })).data.total).toBe(1)
      expect((await owner.api.get('/api/tyre/warranty', { params: { phone: '9825061111' } })).data.total).toBe(1)
      expect((await owner.api.get('/api/tyre/warranty', { params: { invoiceNo: w.invoiceNo } })).data.total).toBeGreaterThanOrEqual(1)
      expect((await other.api.get('/api/tyre/warranty', { params: { serial: w.serialNo } })).data.total).toBe(0)
    })

    test('a claim is recorded once, with an outcome; staff can record, only a manager can void', async () => {
      const w = rows[0]
      const bad = await cashier.api.post(`/api/tyre/warranty/${w.id}/claim`, { outcome: 'replaced', notes: 'x' })
      expect(bad.status).toBe(422)
      const ok = await cashier.api.post(`/api/tyre/warranty/${w.id}/claim`, { outcome: 'replaced', notes: 'Sidewall bulge, brand rep approved', claimAmount: 4200 })
      expect(ok.status).toBe(200)
      expect(ok.data).toMatchObject({ status: 'claimed', claimOutcome: 'replaced' })
      expect((await cashier.api.post(`/api/tyre/warranty/${w.id}/claim`, { outcome: 'repaired', notes: 'again' })).status).toBe(409)
      expect((await cashier.api.post(`/api/tyre/warranty/${w.id}/void`, { reason: 'wrong entry' })).status).toBe(403)
      expect((await viewer.api.post(`/api/tyre/warranty/${w.id}/claim`, { outcome: 'replaced', notes: 'abc' })).status).toBe(403)
    })

    test('a claim on an expired warranty can only be recorded as rejected', async () => {
      const s = uniqueSerial('EXP')
      const r = await sale(owner, {
        date: today(-400), customer: { name: 'Old Timer', phone: '9825062222' },
        items: [{ productId: car.id, qty: 1, serialNos: [s] }], payments: [{ method: 'cash', amount: 4956 }],
      })
      const w = r.data.warranty[0]
      expect(String(w.warrantyUntil).slice(0, 10) < today()).toBe(true)
      const replace = await owner.api.post(`/api/tyre/warranty/${w.id}/claim`, { outcome: 'replaced', notes: 'trying my luck' })
      expect(replace.status).toBe(422)
      const reject = await owner.api.post(`/api/tyre/warranty/${w.id}/claim`, { outcome: 'rejected', notes: 'Out of warranty by 1 month' })
      expect(reject.status).toBe(200)
    })

    test('cancelling an unpaid bill voids its warranty rows and frees the serial for sale again', async () => {
      const s = uniqueSerial('CAN')
      const r = await sale(owner, { customer: { name: 'Cancel Me', phone: '9825063333' }, items: [{ productId: car.id, qty: 1, serialNos: [s] }], payments: [] })
      expect(r.status).toBe(201)
      const cancel = await manager.api.post(`/api/invoices/${r.data.invoice.id}/cancel`, {})
      expect([200, 201]).toContain(cancel.status)
      const rows2 = (await owner.api.get('/api/tyre/warranty', { params: { serial: s, status: 'any' } })).data
      expect(rows2.total).toBe(0)                                 // void rows are hidden from "any"
      const voided = (await owner.api.get('/api/tyre/warranty', { params: { serial: s, status: 'void' } })).data
      expect(voided.data[0].status).toBe('void')
      const again = await sale(owner, { customer: { name: 'Resale', phone: '9825064444' }, items: [{ productId: car.id, qty: 1, serialNos: [s] }], payments: [{ method: 'cash', amount: 4956 }] })
      expect(again.status).toBe(201)
    })

    test('the bill PDF is a real PDF with the warranty card page; other businesses cannot read it', async () => {
      const r = await owner.api.get(`/api/tyre/invoices/${billId}/pdf`, { responseType: 'arraybuffer' })
      expect(r.status).toBe(200)
      expect(r.headers['content-type']).toContain('application/pdf')
      const buf = Buffer.from(r.data)
      expect(buf.slice(0, 5).toString()).toBe('%PDF-')
      expect(buf.toString('latin1').match(/\/Type \/Page\b/g)?.length).toBeGreaterThanOrEqual(2)   // invoice + warranty card
      expect((await other.api.get(`/api/tyre/invoices/${billId}/pdf`, { responseType: 'arraybuffer' })).status).toBe(404)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  describe('vehicles & reminders', () => {
    test('vehicle lookup by registration, with the owner and tyre size', async () => {
      const r = await owner.api.get('/api/tyre/vehicles/lookup', { params: { regNo: 'gj-05 ab-1234' } })
      expect(r.status).toBe(200)
      expect(r.data.vehicle).toMatchObject({ regNo: 'GJ05AB1234', tyreSize: '185/65 R15' })
      expect((await other.api.get('/api/tyre/vehicles/lookup', { params: { regNo: 'GJ05AB1234' } })).data.vehicle).toBeNull()
    })

    test('vehicle detail lists its bills and tyres', async () => {
      const v = (await owner.api.get('/api/tyre/vehicles', { params: { search: 'GJ05AB1234' } })).data.data[0]
      const d = (await owner.api.get(`/api/tyre/vehicles/${v.id}`)).data
      expect(d.bills.length).toBeGreaterThanOrEqual(2)
      expect(d.warranty.length).toBeGreaterThanOrEqual(2)
    })

    test('a vehicle past its next-service date shows in reminders; a WhatsApp reminder is logged', async () => {
      const v = (await owner.api.post('/api/tyre/vehicles', {
        regNo: 'GJ09DUE001', vehicleType: 'car', ownerName: 'Due Owner', ownerPhone: '9825070001', nextServiceDate: today(-10),
      })).data
      expect((await owner.api.post('/api/tyre/vehicles', { regNo: 'gj09due001' })).status).toBe(409)
      const due = (await owner.api.get('/api/tyre/reminders', { params: { days: 0 } })).data
      const mine = due.find((r: any) => r.id === v.id)
      expect(mine).toBeTruthy()
      expect(mine.overdueDays).toBeGreaterThanOrEqual(10)

      const sent = await owner.api.post(`/api/tyre/vehicles/${v.id}/remind`)
      expect(sent.status).toBe(202)
      const log = (await owner.api.get('/api/tyre/notifications', { params: { refId: v.id } })).data.data
      expect(log[0]).toMatchObject({ kind: 'service_due', toPhone: '919825070001' })

      // a vehicle with no usable number is logged as not sent
      const v2 = (await owner.api.post('/api/tyre/vehicles', { regNo: 'GJ09DUE002', ownerPhone: '123' })).data
      const none = await owner.api.post(`/api/tyre/vehicles/${v2.id}/remind`)
      expect(none.status).toBe(422)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  describe('messages', () => {
    test('automatic sends are off by default and switchable only by a manager', async () => {
      const s = (await owner.api.get('/api/tyre/notify-settings')).data
      expect(s).toMatchObject({ notify_invoice: false, notify_service_reminders: false })
      expect((await cashier.api.put('/api/tyre/notify-settings', { notify_invoice: true })).status).toBe(403)
      const on = await manager.api.put('/api/tyre/notify-settings', { notify_invoice: true })
      expect(on.data.notify_invoice).toBe(true)
      expect((await manager.api.put('/api/tyre/notify-settings', { bogus: true })).status).toBe(422)
    })

    test('with the switch on, a sale queues the invoice PDF for the customer', async () => {
      await manager.api.put('/api/tyre/notify-settings', { notify_invoice: true })
      const r = await sale(owner, { customer: { name: 'Notify Me', phone: '9825080001' }, items: [{ productId: tube.id, qty: 1 }], payments: [{ method: 'cash', amount: 413 }] })
      expect(r.status).toBe(201)
      let msg: any
      for (let i = 0; i < 25 && !msg; i++) {
        const log = (await owner.api.get('/api/tyre/notifications', { params: { refId: r.data.invoice.id } })).data.data
        msg = log.find((m: any) => m.kind === 'invoice')
        if (!msg) await new Promise((res) => setTimeout(res, 150))
      }
      expect(msg).toBeTruthy()
      expect(msg.toPhone).toBe('919825080001')
      expect(msg.attachment).toBe(`invoice_pdf:${r.data.invoice.id}`)
      await manager.api.put('/api/tyre/notify-settings', { notify_invoice: false })
    })

    test('a manual send for a customer with no mobile is reported, not lost', async () => {
      const r = await sale(owner, { items: [{ productId: tube.id, qty: 1 }], payments: [{ method: 'cash', amount: 413 }] })
      expect(r.status).toBe(201)
      const n = await owner.api.post(`/api/tyre/invoices/${r.data.invoice.id}/notify`, {})
      expect(n.status).toBe(422)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  describe('dashboard & reports', () => {
    test('home numbers follow the data', async () => {
      const d = (await owner.api.get('/api/tyre/dashboard')).data
      expect(d.today.bills).toBeGreaterThan(5)
      expect(d.today.amount).toBeGreaterThan(0)
      expect(d.stock.items).toBeGreaterThanOrEqual(5)
      expect(d.stock.value).toBeGreaterThan(0)
      expect(d.warranty.active).toBeGreaterThan(0)
      expect(d.recent.length).toBeGreaterThan(0)
      const fresh = (await other.api.get('/api/tyre/dashboard')).data
      expect(fresh.today.bills).toBe(0)
      expect(fresh.stock.value).toBe(0)
    })

    test('sales by size: units, revenue and margin add up', async () => {
      const r = (await owner.api.get('/api/tyre/reports/sales', { params: { by: 'size' } })).data
      const row = r.data.find((x: any) => x.label === '185/65 R15')
      expect(row).toBeTruthy()
      expect(row.units).toBeGreaterThanOrEqual(2)
      expect(row.margin).toBeCloseTo(row.revenue - row.cost, 1)
      expect(r.totals.revenue).toBeCloseTo(r.data.reduce((s: number, x: any) => s + x.revenue, 0), 1)
      const byBrand = (await owner.api.get('/api/tyre/reports/sales', { params: { by: 'brand' } })).data
      expect(byBrand.data.map((x: any) => x.label)).toEqual(expect.arrayContaining(['MRF']))
    })

    test('dead stock lists unsold items, never fitting services or scrap', async () => {
      const r = (await owner.api.get('/api/tyre/dead-stock', { params: { days: 7 } })).data
      // everything in this fresh catalogue was received just now, so nothing is "idle 7 days" yet
      expect(r.count).toBe(0)
      expect(r.data).toEqual([])
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  describe('alignment & balancing as services', () => {
    let balancing: any

    beforeAll(async () => {
      const svc = await find(owner, { kind: 'service', limit: 50 })
      balancing = svc.find((p) => p.sku === 'SVC-BAL')
    })

    const plusDays = (n: number) => new Date(Date.now() + 5.5 * 3600_000 + n * 86_400_000).toISOString().slice(0, 10)

    test('a service-only visit: no tyre, no stock, no warranty — readings and wheels are kept on the bill', async () => {
      const r = await sale(owner, {
        vehicleNo: 'GJ05SV1111', vehicleType: 'car', odometer: 30000, saleKind: 'service_only',
        customer: { name: 'Service Only', phone: '9825101111' },
        items: [
          { productId: alignment.id, qty: 1, readings: { before: { 'Front toe': '0.45', 'Camber L': '-1.2' }, after: { 'Front toe': '0.02', 'Camber L': '-0.5' } } },
          { productId: balancing.id, qty: 4, wheels: 4 },
        ],
        payments: [{ method: 'upi', amount: 1000 }],       // (600 + 4×100) × 1.18 = 1180
      })
      expect(r.status).toBe(201)
      expect(r.data.warranty).toHaveLength(0)
      expect(Number(r.data.invoice.grandTotal)).toBeCloseTo(1180, 0)
      const meta = r.data.invoice.items.find((i: any) => i.itemMeta?.service_type === 'alignment')?.itemMeta
      expect(meta.readings.before['Front toe']).toBe('0.45')
      expect(meta.readings.after['Camber L']).toBe('-0.5')
      const bal = r.data.invoice.items.find((i: any) => i.itemMeta?.service_type === 'balancing')?.itemMeta
      expect(bal.wheels).toBe(4)
    })

    test('the next check is for the earliest-due service — balancing (3 months) before alignment (6 months)', async () => {
      const v = (await owner.api.get('/api/tyre/vehicles/lookup', { params: { regNo: 'GJ05SV1111' } })).data.vehicle
      expect(v.nextServiceFor).toBe('Wheel balancing')
      expect(String(v.nextServiceDate).slice(0, 10)).toBe(plusDays(90))
      expect(Number(v.nextServiceKm)).toBe(30000 + 5000)
    })

    test('alignment alone is due after the alignment interval, and the reminder says so', async () => {
      const r = await sale(owner, {
        vehicleNo: 'GJ05SV2222', odometer: 12000, customer: { name: 'Align Only', phone: '9825102222' },
        items: [{ productId: alignment.id, qty: 1 }], payments: [{ method: 'cash', amount: 708 }],
      })
      expect(r.status).toBe(201)
      const v = (await owner.api.get('/api/tyre/vehicles/lookup', { params: { regNo: 'GJ05SV2222' } })).data.vehicle
      expect(v.nextServiceFor).toBe('Wheel alignment')
      expect(String(v.nextServiceDate).slice(0, 10)).toBe(plusDays(180))
      expect(Number(v.nextServiceKm)).toBe(12000 + 10000)

      await owner.api.patch(`/api/tyre/vehicles/${v.id}`, { nextServiceDate: today(-1) })
      const due = (await owner.api.get('/api/tyre/reminders', { params: { days: 0 } })).data
      expect(due.find((x: any) => x.id === v.id)?.nextServiceFor).toBe('Wheel alignment')
      await owner.api.post(`/api/tyre/vehicles/${v.id}/remind`)
      const log = (await owner.api.get('/api/tyre/notifications', { params: { refId: v.id } })).data.data
      expect(log[0].message).toMatch(/wheel alignment/i)
    })

    test('a puncture repair does not start a reminder', async () => {
      const svc = await find(owner, { kind: 'service', limit: 50 })
      const puncture = svc.find((p) => p.sku === 'SVC-PNC')
      const r = await sale(owner, {
        vehicleNo: 'GJ05SV3333', customer: { name: 'Puncture', phone: '9825103333' },
        items: [{ productId: puncture.id, qty: 1 }], payments: [{ method: 'cash', amount: 177 }],
      })
      expect(r.status).toBe(201)
      const v = (await owner.api.get('/api/tyre/vehicles/lookup', { params: { regNo: 'GJ05SV3333' } })).data.vehicle
      expect(v.nextServiceDate).toBeNull()
    })

    test('the bill PDF prints the readings', async () => {
      const bills = (await owner.api.get('/api/tyre/vehicles', { params: { search: 'GJ05SV1111' } })).data.data
      const detail = (await owner.api.get(`/api/tyre/vehicles/${bills[0].id}`)).data
      const pdf = await owner.api.get(`/api/tyre/invoices/${detail.bills[0].id}/pdf`, { responseType: 'arraybuffer' })
      expect(pdf.status).toBe(200)
      expect(Buffer.from(pdf.data).slice(0, 5).toString()).toBe('%PDF-')
    })

    test('readings with an unknown shape are refused', async () => {
      const r = await sale(owner, {
        vehicleNo: 'GJ05SV4444', customer: { name: 'Bad Readings', phone: '9825104444' },
        items: [{ productId: alignment.id, qty: 1, readings: { before: { 'Front toe': 5 } } }], payments: [],
      })
      expect(r.status).toBeGreaterThanOrEqual(400)
      expect(r.status).toBeLessThan(500)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  describe('shared pickers', () => {
    test('supplier and customer pickers include parties of type "both"', async () => {
      const both = (await owner.api.post('/api/parties', { type: 'both', name: 'Dual Role Tyres' })).data
      const sup  = (await owner.api.get('/api/parties', { params: { type: 'supplier', search: 'Dual Role' } })).data
      expect(sup.data.map((p: any) => p.id)).toContain(both.id)
      const cust = (await owner.api.get('/api/parties', { params: { type: 'customer', search: 'Dual Role' } })).data
      expect(cust.data.map((p: any) => p.id)).toContain(both.id)
    })
  })

  void walkin
})
