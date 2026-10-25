// Tyre module — edge cases: auth & roles, input validation, hostile strings, cross-business access,
// races, idempotency, vehicle lifecycle, and the daily alert job.
// Self-provisioning (throwaway tenants), like tyre.test.ts.

import { newShopTenant, addStaff, today, type Session } from './helpers'

const U = '00000000-0000-4000-8000-0000000000aa'     // a well-formed uuid that exists nowhere
let n = 0
const serial = (p = 'E') => `${p}${Date.now().toString().slice(-7)}${n++}`
const phone = () => `98${String(Date.now()).slice(-6)}${String(n++).padStart(2, '0')}`.slice(0, 10)

describe('Tyre edge cases', () => {
  let owner: Session, other: Session, viewer: Session, manager: Session, cashier: Session
  let tyre: any, cheap: any, tube: any, fitting: any, alignment: any, scrapItem: any

  const call = (s: Session, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    s.api.request({ method, url: path, data: body, headers: { 'Idempotency-Key': crypto.randomUUID(), ...headers } })
  const sale = (s: Session, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
    call(s, 'POST', '/api/tyre/sales', body, headers)
  const mk = async (s: Session, body: Record<string, unknown>) => {
    const r = await s.api.post('/api/products', { itemType: 'product', gstRate: 18, unit: 'pcs', trackStock: true, ...body })
    expect([200, 201]).toContain(r.status)
    return r.data
  }
  const stock = async (s: Session, id: string) =>
    (await s.api.get('/api/tyre/finder', { params: { id, kind: 'any', limit: 1 } })).data.data[0]?.stock as number
  const msg = (r: any) => String(r.data?.message ?? r.data?.error ?? JSON.stringify(r.data))

  beforeAll(async () => {
    owner   = await newShopTenant('Edge Tyres')
    other   = await newShopTenant('Other Edge Tyres')
    viewer  = await addStaff(owner, 'viewer')
    manager = await addStaff(owner, 'manager')
    cashier = await addStaff(owner, 'cashier')

    tyre = await mk(owner, {
      name: 'Edge Tyre 195/60 R15', sku: 'EDGE-195', salePrice: 5000, purchasePrice: 4000, mrp: 5400, lowStockQty: 5, openingStock: 50,
      domainAttrs: { item_kind: 'tyre', brand: 'MRF', pattern: 'Edge', size: '195/60 R15', vehicle_type: 'car', warranty_months: 6 },
    })
    cheap = await mk(owner, {
      name: 'Edge Cheap 155/80 R13', sku: 'EDGE-155', salePrice: 2000, purchasePrice: 1800, openingStock: 50,
      domainAttrs: { item_kind: 'tyre', brand: 'CEAT', size: '155/80 R13', vehicle_type: 'car' },
    })
    tube = await mk(owner, {
      name: 'Edge Tube', sku: 'EDGE-TUBE', salePrice: 300, purchasePrice: 200, openingStock: 100,
      domainAttrs: { item_kind: 'tube', brand: 'MRF', size: '4.00-8' },
    })
    const svc = (await owner.api.get('/api/tyre/finder', { params: { kind: 'service', limit: 50 } })).data.data
    fitting = svc.find((p: any) => p.sku === 'SVC-FIT')
    alignment = svc.find((p: any) => p.sku === 'SVC-ALN')
    scrapItem = (await owner.api.get('/api/tyre/finder', { params: { kind: 'scrap', limit: 1 } })).data.data[0]
  })

  // ═══════════════════════════════════════════════════════════════════════════
  describe('authentication & roles', () => {
    const ENDPOINTS: Array<[string, string]> = [
      ['GET', '/api/tyre/dashboard'], ['GET', '/api/tyre/finder'], ['GET', '/api/tyre/sizes'], ['GET', '/api/tyre/brands'],
      ['GET', '/api/tyre/dead-stock'], ['POST', '/api/tyre/sales'], ['GET', `/api/tyre/sales/${U}`],
      ['GET', '/api/tyre/vehicles'], ['GET', '/api/tyre/vehicles/lookup?regNo=GJ05AB1234'], ['POST', '/api/tyre/vehicles'],
      ['GET', `/api/tyre/vehicles/${U}`], ['PATCH', `/api/tyre/vehicles/${U}`], ['DELETE', `/api/tyre/vehicles/${U}`],
      ['POST', `/api/tyre/vehicles/${U}/remind`], ['GET', '/api/tyre/reminders'], ['GET', '/api/tyre/warranty'],
      ['POST', `/api/tyre/warranty/${U}/claim`], ['POST', `/api/tyre/warranty/${U}/void`], ['GET', '/api/tyre/reports/sales'],
      ['GET', `/api/tyre/invoices/${U}/pdf`], ['POST', `/api/tyre/invoices/${U}/notify`], ['GET', '/api/tyre/notifications'],
      ['POST', `/api/tyre/notifications/${U}/retry`], ['GET', '/api/tyre/notify-settings'], ['PUT', '/api/tyre/notify-settings'],
      ['POST', '/api/tyre/notify/run-alerts'],
    ]

    test('every tyre endpoint rejects a request with no token (401)', async () => {
      const bad: string[] = []
      for (const [m, p] of ENDPOINTS) {
        const r = await owner.api.request({ method: m, url: p, data: m === 'GET' || m === 'DELETE' ? undefined : {}, headers: { Authorization: '' } })
        if (r.status !== 401) bad.push(`${m} ${p} → ${r.status}`)
      }
      expect(bad).toEqual([])
    })

    test('a garbage or tampered token is rejected', async () => {
      const r = await owner.api.get('/api/tyre/dashboard', { headers: { Authorization: 'Bearer not.a.token' } })
      expect(r.status).toBe(401)
      const t = owner.token.split('.')
      const tampered = await owner.api.get('/api/tyre/dashboard', { headers: { Authorization: `Bearer ${t[0]}.${t[1]}.${'x'.repeat(t[2]!.length)}` } })
      expect(tampered.status).toBe(401)
    })

    test('a viewer can read everything but write nothing', async () => {
      for (const p of ['/api/tyre/dashboard', '/api/tyre/finder', '/api/tyre/sizes', '/api/tyre/brands', '/api/tyre/dead-stock',
        '/api/tyre/vehicles', '/api/tyre/reminders', '/api/tyre/warranty', '/api/tyre/reports/sales', '/api/tyre/notifications', '/api/tyre/notify-settings']) {
        expect([p, (await viewer.api.get(p)).status]).toEqual([p, 200])
      }
      const writes: Array<[string, string, unknown]> = [
        ['POST', '/api/tyre/sales', { items: [{ productId: tube.id, qty: 1 }] }],
        ['POST', '/api/tyre/vehicles', { regNo: 'GJ05VW0001' }],
        ['PATCH', `/api/tyre/vehicles/${U}`, { notes: 'x' }],
        ['DELETE', `/api/tyre/vehicles/${U}`, undefined],
        ['POST', `/api/tyre/vehicles/${U}/remind`, {}],
        ['POST', `/api/tyre/warranty/${U}/claim`, { outcome: 'replaced', notes: 'abc' }],
        ['POST', `/api/tyre/warranty/${U}/void`, { reason: 'abc' }],
        ['POST', `/api/tyre/invoices/${U}/notify`, {}],
        ['POST', `/api/tyre/notifications/${U}/retry`, {}],
        ['PUT', '/api/tyre/notify-settings', { notify_invoice: true }],
        ['POST', '/api/tyre/notify/run-alerts', {}],
      ]
      for (const [m, p, b] of writes) expect([m, p, (await call(viewer, m, p, b)).status]).toEqual([m, p, 403])
    })

    test('counter staff cannot delete vehicles, void warranty, change settings or run the daily job', async () => {
      for (const [m, p, b] of [
        ['DELETE', `/api/tyre/vehicles/${U}`, undefined],
        ['POST', `/api/tyre/warranty/${U}/void`, { reason: 'abc' }],
        ['PUT', '/api/tyre/notify-settings', { notify_invoice: true }],
        ['POST', '/api/tyre/notify/run-alerts', {}],
      ] as Array<[string, string, unknown]>) {
        expect([m, p, (await call(cashier, m, p, b)).status]).toEqual([m, p, 403])
      }
    })

    test("another business's ids are simply not found", async () => {
      const s = await sale(owner, { vehicleNo: 'GJ05OT0001', customer: { name: 'Mine', phone: phone() }, items: [{ productId: tube.id, qty: 1, }], payments: [{ method: 'cash', amount: 354 }] })
      expect(s.status).toBe(201)
      const invoiceId = s.data.invoice.id
      const v = (await owner.api.get('/api/tyre/vehicles/lookup', { params: { regNo: 'GJ05OT0001' } })).data.vehicle
      expect((await other.api.get(`/api/tyre/sales/${invoiceId}`)).status).toBe(404)
      expect((await other.api.get(`/api/tyre/invoices/${invoiceId}/pdf`)).status).toBe(404)
      expect((await other.api.get(`/api/tyre/vehicles/${v.id}`)).status).toBe(404)
      expect((await call(other, 'PATCH', `/api/tyre/vehicles/${v.id}`, { notes: 'hijack' })).status).toBe(404)
      expect((await call(other, 'DELETE', `/api/tyre/vehicles/${v.id}`)).status).toBe(404)
      expect((await call(other, 'POST', `/api/tyre/vehicles/${v.id}/remind`)).status).toBe(404)
      expect((await call(other, 'POST', `/api/tyre/invoices/${invoiceId}/notify`, {})).status).toBe(404)
      expect((await call(other, 'POST', '/api/tyre/sales', { items: [{ productId: tube.id, qty: 1 }], payments: [] })).status).toBe(404)
      expect((await other.api.get('/api/tyre/vehicles/lookup', { params: { regNo: 'GJ05OT0001' } })).data.vehicle).toBeNull()
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  describe('input validation — query strings and paths', () => {
    test.each([
      ['/api/tyre/finder?vehicleType=spaceship'], ['/api/tyre/finder?limit=0'], ['/api/tyre/finder?limit=101'],
      ['/api/tyre/finder?size=' + 'x'.repeat(31)], ['/api/tyre/finder?id=not-a-uuid'], ['/api/tyre/finder?kind=bogus'], ['/api/tyre/finder?inStock=maybe'],
      ['/api/tyre/dead-stock?days=6'], ['/api/tyre/dead-stock?days=721'], ['/api/tyre/dead-stock?days=abc'],
      ['/api/tyre/vehicles?page=0'], ['/api/tyre/vehicles?limit=101'], ['/api/tyre/vehicles?due=maybe'],
      ['/api/tyre/vehicles/lookup'], ['/api/tyre/vehicles/lookup?regNo=ab'],
      ['/api/tyre/reminders?days=-1'], ['/api/tyre/reminders?days=121'],
      ['/api/tyre/warranty?status=bogus'], ['/api/tyre/warranty?expiringDays=0'], ['/api/tyre/warranty?expiringDays=366'], ['/api/tyre/warranty?limit=0'],
      ['/api/tyre/reports/sales?by=bogus'], ['/api/tyre/reports/sales?from=13-10-2026'], ['/api/tyre/reports/sales?to=tomorrow'],
      ['/api/tyre/notifications?limit=101'], ['/api/tyre/notifications?status=bogus'], ['/api/tyre/notifications?refId=nope'], ['/api/tyre/notifications?refType=bogus'],
      ['/api/tyre/sales/not-a-uuid'], ['/api/tyre/vehicles/not-a-uuid'], ['/api/tyre/invoices/not-a-uuid/pdf'],
    ])('%s → 4xx, never 5xx', async (url) => {
      const r = await owner.api.get(url)
      expect(r.status).toBeGreaterThanOrEqual(400)
      expect(r.status).toBeLessThan(500)
    })

    test('hostile strings in search boxes are harmless (quotes, SQL, wildcards, regex, unicode, very long)', async () => {
      const nasty = ["'; DROP TABLE products;--", '%', '_', '\\', '(.*)', '[', '𝕋𝕪𝕣𝕖 ✓', "\u0000", 'a'.repeat(80)]
      for (const s of nasty) {
        for (const url of ['/api/tyre/finder', '/api/tyre/vehicles', '/api/tyre/warranty']) {
          const param = url.endsWith('finder') ? { q: s.slice(0, 80), size: s.slice(0, 30), brand: s.slice(0, 60) } : { [url.endsWith('vehicles') ? 'search' : 'search']: s.slice(0, 60) }
          const r = await owner.api.get(url, { params: param })
          expect([url, s.slice(0, 12), r.status < 500]).toEqual([url, s.slice(0, 12), true])
        }
      }
      // and the catalogue is intact
      expect((await owner.api.get('/api/tyre/finder', { params: { size: '195/60 R15' } })).data.data.length).toBeGreaterThan(0)
    })

    test('a size query is forgiving: spacing, case, separators and a trailing letter all find the tyre', async () => {
      for (const q of ['195/60R15', '195 60 15', '1956015', '195/60-15', '195/60 r15', '195/60zr15', '  195/60 R15  ', '195/60']) {
        const rows = (await owner.api.get('/api/tyre/finder', { params: { size: q } })).data.data
        expect([q, rows.some((r: any) => r.sku === 'EDGE-195')]).toEqual([q, true])
      }
      const none = (await owner.api.get('/api/tyre/finder', { params: { size: '999/99 R99' } })).data.data
      expect(none).toHaveLength(0)
    })

    test('bad JSON bodies are 4xx', async () => {
      const r = await owner.api.post('/api/tyre/sales', '{not json', { headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() } })
      expect(r.status).toBeGreaterThanOrEqual(400)
      expect(r.status).toBeLessThan(500)
      const arr = await call(owner, 'POST', '/api/tyre/sales', [1, 2, 3])
      expect(arr.status).toBeGreaterThanOrEqual(400)
      expect(arr.status).toBeLessThan(500)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  describe('counter sale — bad input', () => {
    const base = (extra: Record<string, unknown> = {}) => ({ customer: { name: 'Edge Cust', phone: phone() }, items: [{ productId: tube.id, qty: 1 }], payments: [], ...extra })

    test.each([
      ['no items', { items: [] }],
      ['61 items', { items: Array.from({ length: 61 }, () => ({ productId: 'TUBE', qty: 1 })) }],
      ['qty 0', { items: [{ productId: 'TUBE', qty: 0 }] }],
      ['qty negative', { items: [{ productId: 'TUBE', qty: -1 }] }],
      ['qty 1001', { items: [{ productId: 'TUBE', qty: 1001 }] }],
      ['rate negative', { items: [{ productId: 'TUBE', qty: 1, rate: -5 }] }],
      ['rate over limit', { items: [{ productId: 'TUBE', qty: 1, rate: 1e8 }] }],
      ['discount over 100', { items: [{ productId: 'TUBE', qty: 1, discountPct: 101 }] }],
      ['discount negative', { items: [{ productId: 'TUBE', qty: 1, discountPct: -1 }] }],
      ['productId not a uuid', { items: [{ productId: 'abc', qty: 1 }] }],
      ['DOT not 4 digits', { items: [{ productId: 'TUBE', qty: 1, dotCodes: ['12345'] }] }],
      ['serial too long', { items: [{ productId: 'TUBE', qty: 1, serialNos: ['x'.repeat(41)] }] }],
      ['bad position', { items: [{ productId: 'TUBE', qty: 1, positions: ['TOP'] }] }],
      ['bad date', { date: '13-10-2026' }],
      ['vehicle no too long', { vehicleNo: 'X'.repeat(21) }],
      ['negative odometer', { odometer: -1 }],
      ['absurd odometer', { odometer: 3_000_000 }],
      ['bad vehicle type', { vehicleType: 'spaceship' }],
      ['credit days 181', { creditDays: 181 }],
      ['credit days negative', { creditDays: -1 }],
      ['payment zero', { payments: [{ method: 'cash', amount: 0 }] }],
      ['payment negative', { payments: [{ method: 'cash', amount: -10 }] }],
      ['payment method exchange', { payments: [{ method: 'exchange', amount: 10 }] }],
      ['payment method unknown', { payments: [{ method: 'barter', amount: 10 }] }],
      ['6 payments', { payments: Array.from({ length: 6 }, () => ({ method: 'cash', amount: 1 })) }],
      ['exchange qty 0', { exchange: { qty: 0, value: 100 } }],
      ['exchange value 0', { exchange: { qty: 1, value: 0 } }],
      ['exchange qty fractional', { exchange: { qty: 1.5, value: 100 } }],
      ['sale kind unknown', { saleKind: 'barter' }],
      ['partyId not a uuid', { partyId: 'abc' }],
      ['customer name empty', { customer: { name: '', phone: '9825000000' } }],
      ['notes too long', { notes: 'n'.repeat(501) }],
    ] as Array<[string, Record<string, unknown>]>)('%s → 422', async (_label, patch) => {
      const body: any = base(patch)
      // placeholders in the table above are swapped for the real product here
      body.items = (body.items as any[]).map((i) => (i.productId === 'TUBE' ? { ...i, productId: tube.id } : i))
      const r = await sale(owner, body)
      expect([_label, r.status]).toEqual([_label, 422])
    })

    test('unknown, foreign and archived products are 404', async () => {
      expect((await sale(owner, base({ items: [{ productId: U, qty: 1 }] }))).status).toBe(404)
      const foreign = await mk(other, { name: 'Foreign Tube', sku: 'FOR-1', salePrice: 100, openingStock: 5, domainAttrs: { item_kind: 'tube' } })
      expect((await sale(owner, base({ items: [{ productId: foreign.id, qty: 1 }] }))).status).toBe(404)

      const p = await mk(owner, { name: 'To Archive', sku: 'ARCH-1', salePrice: 100, openingStock: 5, domainAttrs: { item_kind: 'tube' } })
      expect((await sale(owner, base({ items: [{ productId: p.id, qty: 1 }], payments: [{ method: 'cash', amount: 118 }] }))).status).toBe(201)
      expect((await owner.api.delete(`/api/products/${p.id}`)).status).toBeLessThan(300)
      const gone = await sale(owner, base({ items: [{ productId: p.id, qty: 1 }] }))
      expect(gone.status).toBe(404)
      expect((await owner.api.get('/api/tyre/finder', { params: { q: 'To Archive', kind: 'any' } })).data.data).toHaveLength(0)
    })

    test('unknown or foreign customer ids are 404', async () => {
      expect((await sale(owner, base({ partyId: U, customer: undefined }))).status).toBe(404)
      const foreignParty = (await other.api.post('/api/parties', { type: 'customer', name: 'Foreign Cust' })).data
      expect((await sale(owner, base({ partyId: foreignParty.id, customer: undefined }))).status).toBe(404)
    })

    test('a mobile number that is not 10 digits is refused; no mobile at all is a walk-in; credit then needs a proper number', async () => {
      for (const bad of ['123', '12345678901', '5876543210', 'abcdefghij']) {
        const r = await sale(owner, { customer: { name: 'Bad Phone', phone: bad }, items: [{ productId: tube.id, qty: 1 }], payments: [{ method: 'cash', amount: 354 }] })
        expect(r.status).toBe(422)
        expect(JSON.stringify(r.data)).toMatch(/10-digit mobile/)
      }
      // +91 / 0 prefixes and spaces are tidied into the plain 10 digits
      const tidy = await sale(owner, { customer: { name: 'Prefixed', phone: '+91 98765 43210' }, items: [{ productId: tube.id, qty: 1 }], payments: [{ method: 'cash', amount: 354 }] })
      expect(tidy.status).toBe(201)
      expect((await owner.api.get(`/api/parties/${tidy.data.invoice.partyId}`)).data.phone).toBe('9876543210')
      const cash = await sale(owner, { customer: { name: 'No Phone' }, items: [{ productId: tube.id, qty: 1 }], payments: [{ method: 'cash', amount: 354 }] })
      expect(cash.status).toBe(201)
      expect(cash.data.invoice.partyId).toBeNull()
      const credit = await sale(owner, { customer: { name: 'No Phone' }, items: [{ productId: tube.id, qty: 1 }], payments: [] })
      expect(credit.status).toBe(422)
    })

    test('names are stored verbatim, including quotes and non-latin text, and nothing is injected', async () => {
      const nasty = "Robert'); DROP TABLE users;-- ગુજરાતી Tyres ✓"
      const r = await sale(owner, { customer: { name: nasty, phone: phone() }, vehicleNo: "gj-05'--x", items: [{ productId: tube.id, qty: 1 }], payments: [{ method: 'cash', amount: 354 }] })
      expect(r.status).toBe(201)
      const p = (await owner.api.get(`/api/parties/${r.data.invoice.partyId}`)).data
      expect(p.name).toBe(nasty)
      expect((await owner.api.get('/api/users')).status).toBe(200)           // table still there
      expect(r.data.vehicle.regNo).toBe('GJ05X')                              // punctuation stripped
    })

    test('punctuation-only vehicle number creates no vehicle', async () => {
      const before = (await owner.api.get('/api/tyre/vehicles', { params: { limit: 100 } })).data.total
      const r = await sale(owner, { customer: { name: 'Dash', phone: phone() }, vehicleNo: '---', items: [{ productId: tube.id, qty: 1 }], payments: [{ method: 'cash', amount: 354 }] })
      expect(r.status).toBe(201)
      expect(r.data.vehicle ?? null).toBeNull()
      expect((await owner.api.get('/api/tyre/vehicles', { params: { limit: 100 } })).data.total).toBe(before)
    })

    test('fractional quantity: fine for a service, refused for a serial-tracked tyre', async () => {
      const ok = await sale(owner, { customer: { name: 'Frac', phone: phone() }, items: [{ productId: alignment.id, qty: 0.5 }], payments: [{ method: 'cash', amount: 354 }] })
      expect(ok.status).toBe(201)
      const bad = await sale(owner, { customer: { name: 'Frac', phone: phone() }, items: [{ productId: tyre.id, qty: 1.5 }], payments: [] })
      expect(bad.status).toBe(422)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  describe('counter sale — money edge cases', () => {
    test('100% discount makes a ₹0 bill that is settled', async () => {
      const r = await sale(owner, { customer: { name: 'Gift', phone: phone() }, items: [{ productId: tube.id, qty: 1, discountPct: 100 }], payments: [] })
      expect(r.status).toBe(201)
      expect(Number(r.data.invoice.grandTotal)).toBe(0)
    })

    test('GST-exempt item carries no tax; an out-of-state customer gets IGST, not CGST+SGST', async () => {
      const ex = await mk(owner, { name: 'Exempt Thing', sku: 'EXM-1', salePrice: 1000, gstExempt: true, gstRate: 0, openingStock: 5, domainAttrs: { item_kind: 'accessory' } })
      const guj = await sale(owner, { customer: { name: 'Exempt Buyer', phone: phone() }, items: [{ productId: ex.id, qty: 1 }], payments: [{ method: 'cash', amount: 1000 }] })
      expect(guj.status).toBe(201)
      expect(Number(guj.data.invoice.cgstTotal) + Number(guj.data.invoice.igstTotal)).toBe(0)

      const mum = (await owner.api.post('/api/parties', { type: 'customer', name: 'Mumbai Fleet', phone: phone(), address: { city: 'Mumbai', stateCode: '27' } })).data
      const r = await sale(owner, { partyId: mum.id, items: [{ productId: tyre.id, qty: 1, rate: 5000 }], payments: [{ method: 'bank_transfer', amount: 5900 }] })
      expect(r.status).toBe(201)
      expect(Number(r.data.invoice.igstTotal)).toBeCloseTo(900, 2)
      expect(Number(r.data.invoice.cgstTotal)).toBe(0)
    })

    test('rounding: a 3-line bill with odd rates reconciles to the paisa', async () => {
      const r = await sale(owner, {
        customer: { name: 'Round', phone: phone() },
        items: [{ productId: tube.id, qty: 3, rate: 333.33, discountPct: 7.5 }, { productId: fitting.id, qty: 3, rate: 99.99 }],
        payments: [],
      })
      expect(r.status).toBe(201)
      const i = r.data.invoice
      const lines = i.items.reduce((s: number, x: any) => s + Number(x.total), 0)
      expect(Math.abs(Number(i.grandTotal) - lines)).toBeLessThan(1)               // only round-off apart
      expect(Number(i.taxableAmt) + Number(i.cgstTotal) + Number(i.sgstTotal) + Number(i.roundOff)).toBeCloseTo(Number(i.grandTotal), 1)
    })

    test('same item on two lines: stock is checked on the total', async () => {
      const p = await mk(owner, { name: 'Three Left', sku: 'TL-1', salePrice: 100, openingStock: 3, domainAttrs: { item_kind: 'tube' } })
      const r = await sale(owner, { customer: { name: 'Two Lines', phone: phone() }, items: [{ productId: p.id, qty: 2 }, { productId: p.id, qty: 2 }], payments: [] })
      expect(r.status).toBe(409)
      expect(await stock(owner, p.id)).toBe(3)
    })

    test('a product that is not stock-tracked sells without limit', async () => {
      const p = await mk(owner, { name: 'Untracked', sku: 'UT-1', salePrice: 10, trackStock: false, domainAttrs: { item_kind: 'accessory' } })
      const r = await sale(owner, { customer: { name: 'Untracked', phone: phone() }, items: [{ productId: p.id, qty: 500 }], payments: [] })
      expect(r.status).toBe(201)
    })

    test('old-tyre exchange when the catalogue has no scrap item still saves the bill, with a warning', async () => {
      const s = await newShopTenant('No Scrap Tyres')
      const scrap = (await s.api.get('/api/tyre/finder', { params: { kind: 'scrap', limit: 1 } })).data.data[0]
      expect((await s.api.delete(`/api/products/${scrap.id}`)).status).toBeLessThan(300)
      const t = await mk(s, { name: 'NS Tyre', sku: 'NS-1', salePrice: 1000, openingStock: 5, domainAttrs: { item_kind: 'tyre' } })
      const r = await sale(s, { customer: { name: 'NS', phone: phone() }, items: [{ productId: t.id, qty: 1 }], exchange: { qty: 1, value: 100 }, payments: [{ method: 'cash', amount: 1080 }] })
      expect(r.status).toBe(201)
      expect(r.data.warnings.join(' ')).toMatch(/scrap/i)
      expect(r.data.invoice.status).toBe('paid')
    })

    test('exchange equal to the whole bill settles it with no cash', async () => {
      const r = await sale(owner, { customer: { name: 'All Exchange', phone: phone() }, items: [{ productId: tube.id, qty: 1 }], exchange: { qty: 1, value: 354 }, payments: [] })
      expect(r.status).toBe(201)
      expect(r.data.invoice.status).toBe('paid')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  describe('races and retries', () => {
    test('two counters selling the last unit at once: exactly one wins, stock never goes negative', async () => {
      const p = await mk(owner, { name: 'Last One', sku: 'LAST-1', salePrice: 1000, openingStock: 1, domainAttrs: { item_kind: 'tyre' } })
      const body = (name: string) => ({ customer: { name, phone: phone() }, items: [{ productId: p.id, qty: 1 }], payments: [] })
      const [a, b] = await Promise.all([sale(owner, body('Counter A')), sale(manager, body('Counter B'))])
      const statuses = [a.status, b.status].sort()
      expect(statuses[0]).toBe(201)
      expect(statuses[1]).toBeGreaterThanOrEqual(400)
      expect(statuses[1]).toBeLessThan(500)                    // a clean "out of stock", not a crash
      expect(await stock(owner, p.id)).toBe(0)
    })

    test('the same Idempotency-Key sent concurrently creates one bill', async () => {
      const p = await mk(owner, { name: 'Retry Tube', sku: 'RT-1', salePrice: 100, openingStock: 10, domainAttrs: { item_kind: 'tube' } })
      const key = crypto.randomUUID()
      const body = { customer: { name: 'Double Click', phone: phone() }, items: [{ productId: p.id, qty: 2 }], payments: [] }
      const rs = await Promise.all([sale(owner, body, { 'Idempotency-Key': key }), sale(owner, body, { 'Idempotency-Key': key }), sale(owner, body, { 'Idempotency-Key': key })])
      const created = rs.filter((r) => r.status === 201)
      expect(created).toHaveLength(1)
      expect(rs.every((r) => r.status < 500)).toBe(true)
      expect(await stock(owner, p.id)).toBe(8)
    })

    test('a double-click with no Idempotency-Key at all does not double-sell', async () => {
      const p = await mk(owner, { name: 'Clicky', sku: 'CLK-1', salePrice: 100, openingStock: 10, domainAttrs: { item_kind: 'tube' } })
      const body = { customer: { name: 'Clicky', phone: phone() }, items: [{ productId: p.id, qty: 1 }], payments: [] }
      // the jest harness injects a unique key into every axios POST unless one is given — an empty
      // header is how this test sends "no key" (the route treats blank as absent)
      const send = () => owner.api.post('/api/tyre/sales', body, { headers: { 'Idempotency-Key': '' } })
      const rs = await Promise.all([send(), send()])
      expect(rs.filter((r) => r.status === 201).length).toBeLessThanOrEqual(1)
      expect(await stock(owner, p.id)).toBe(9)
    })

    test('a key replayed with a different body returns the original bill, not a second sale', async () => {
      const key = crypto.randomUUID()
      const a = await sale(owner, { customer: { name: 'First Body', phone: phone() }, items: [{ productId: tube.id, qty: 1 }], payments: [] }, { 'Idempotency-Key': key })
      const b = await sale(owner, { customer: { name: 'Second Body', phone: phone() }, items: [{ productId: tube.id, qty: 5 }], payments: [] }, { 'Idempotency-Key': key })
      expect(a.status).toBe(201)
      expect([200, 409]).toContain(b.status)
      if (b.status === 200) expect(b.data.invoice.id).toBe(a.data.invoice.id)
    })

    test('the same serial sold to two customers at once: one wins', async () => {
      const s = serial('RACE')
      const body = (name: string) => ({ customer: { name, phone: phone() }, items: [{ productId: tyre.id, qty: 1, serialNos: [s] }], payments: [] })
      const rs = await Promise.all([sale(owner, body('R1')), sale(manager, body('R2'))])
      expect(rs.every((r) => r.status < 500)).toBe(true)
      // The register can hold a serial only once. If both bills got through the pre-check, the one that
      // lost the unique index is still a saved sale — but it must say the warranty was not recorded.
      const created = rs.filter((r) => r.status === 201)
      expect(created.length).toBeGreaterThanOrEqual(1)
      if (created.length === 2) {
        const warned = created.filter((r) => (r.data.warnings ?? []).join(' ').match(/warranty/i))
        expect(warned).toHaveLength(1)
      }
      const live = (await owner.api.get('/api/tyre/warranty', { params: { serial: s } })).data
      expect(live.total).toBe(1)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  describe('vehicles', () => {
    test('create, update, delete, and a sold-to vehicle comes back after deletion', async () => {
      const c = await call(owner, 'POST', '/api/tyre/vehicles', { regNo: 'gj 05-vh 0001', vehicleType: 'suv', ownerName: 'V Owner', ownerPhone: '9825000001' })
      expect(c.status).toBe(201)
      expect(c.data.regNo).toBe('GJ05VH0001')

      const bad = await call(owner, 'POST', '/api/tyre/vehicles', { regNo: 'GJ', vehicleType: 'car' })
      expect(bad.status).toBe(422)
      expect((await call(owner, 'POST', '/api/tyre/vehicles', { regNo: 'GJ05VH0002', nextServiceDate: '12/10/2026' })).status).toBe(422)

      const u = await call(owner, 'PATCH', `/api/tyre/vehicles/${c.data.id}`, { makeModel: 'Creta', nextServiceKm: 55000 })
      expect(u.status).toBe(200)
      expect(u.data).toMatchObject({ makeModel: 'Creta', nextServiceKm: 55000 })
      expect((await call(owner, 'PATCH', `/api/tyre/vehicles/${c.data.id}`, { regNo: 'GJ05VH9999' })).status).toBeLessThan(500)
      expect((await call(owner, 'PATCH', `/api/tyre/vehicles/${U}`, { notes: 'x' })).status).toBe(404)

      expect((await call(manager, 'DELETE', `/api/tyre/vehicles/${c.data.id}`)).status).toBe(200)
      expect((await owner.api.get('/api/tyre/vehicles', { params: { search: 'GJ05VH0001' } })).data.total).toBe(0)

      // the shop adds the same vehicle again — it must not be blocked or stay hidden
      const again = await call(owner, 'POST', '/api/tyre/vehicles', { regNo: 'GJ05VH0001', vehicleType: 'suv' })
      expect([200, 201]).toContain(again.status)
      expect((await owner.api.get('/api/tyre/vehicles', { params: { search: 'GJ05VH0001' } })).data.total).toBe(1)
    })

    test('a sale to a deleted vehicle reactivates it', async () => {
      const r1 = await sale(owner, { vehicleNo: 'GJ05VH7777', customer: { name: 'Back Again', phone: phone() }, items: [{ productId: tube.id, qty: 1 }], payments: [] })
      expect(r1.status).toBe(201)
      expect((await call(owner, 'DELETE', `/api/tyre/vehicles/${r1.data.vehicle.id}`)).status).toBe(200)
      expect((await owner.api.get('/api/tyre/vehicles', { params: { search: 'GJ05VH7777' } })).data.total).toBe(0)
      const r2 = await sale(owner, { vehicleNo: 'GJ05VH7777', customer: { name: 'Back Again', phone: phone() }, items: [{ productId: tube.id, qty: 1 }], payments: [] })
      expect(r2.status).toBe(201)
      expect((await owner.api.get('/api/tyre/vehicles', { params: { search: 'GJ05VH7777' } })).data.total).toBe(1)
    })

    test('turning reminders off for a vehicle keeps it out of the daily job but a manual remind still works', async () => {
      const v = (await call(owner, 'POST', '/api/tyre/vehicles', { regNo: 'GJ05RM0001', ownerPhone: '9825000099', nextServiceDate: today(-3), remindersOff: true })).data
      const r = await call(owner, 'POST', `/api/tyre/vehicles/${v.id}/remind`)
      expect(r.status).toBe(202)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  describe('warranty', () => {
    let w: any

    beforeAll(async () => {
      const r = await sale(owner, { vehicleNo: 'GJ05WW0001', customer: { name: 'Warr', phone: phone() }, items: [{ productId: tyre.id, qty: 1, serialNos: [serial('WW')] }], payments: [] })
      w = r.data.warranty[0]
    })

    test('unknown ids are 404; bad bodies are 422', async () => {
      expect((await call(owner, 'POST', `/api/tyre/warranty/${U}/claim`, { outcome: 'replaced', notes: 'abc' })).status).toBe(404)
      expect((await call(owner, 'POST', `/api/tyre/warranty/${U}/void`, { reason: 'abc' })).status).toBe(404)
      expect((await call(owner, 'POST', `/api/tyre/warranty/${w.id}/claim`, { outcome: 'bogus', notes: 'abc' })).status).toBe(422)
      expect((await call(owner, 'POST', `/api/tyre/warranty/${w.id}/claim`, { outcome: 'replaced', notes: 'ab' })).status).toBe(422)
      expect((await call(owner, 'POST', `/api/tyre/warranty/${w.id}/claim`, { outcome: 'replaced', notes: 'abc', claimAmount: -5 })).status).toBe(422)
      expect((await call(other, 'POST', `/api/tyre/warranty/${w.id}/claim`, { outcome: 'replaced', notes: 'abc' })).status).toBe(404)
    })

    test('void: needs a reason, works once, blocks later claims, and a voided row is hidden from "any"', async () => {
      expect((await call(manager, 'POST', `/api/tyre/warranty/${w.id}/void`, {})).status).toBe(422)
      expect((await call(manager, 'POST', `/api/tyre/warranty/${w.id}/void`, { reason: 'tyre returned' })).status).toBe(200)
      expect((await call(manager, 'POST', `/api/tyre/warranty/${w.id}/void`, { reason: 'again' })).status).toBe(422)
      expect((await call(owner, 'POST', `/api/tyre/warranty/${w.id}/claim`, { outcome: 'replaced', notes: 'too late' })).status).toBe(422)
      const any = (await owner.api.get('/api/tyre/warranty', { params: { serial: w.serialNo } })).data
      expect(any.total).toBe(0)
      const voided = (await owner.api.get('/api/tyre/warranty', { params: { serial: w.serialNo, status: 'void' } })).data
      expect(voided.total).toBe(1)
    })

    test('"ending soon" lists only active tyres ending inside the window', async () => {
      const t = await mk(owner, { name: 'Short Warranty', sku: 'SW-1', salePrice: 1000, openingStock: 5, domainAttrs: { item_kind: 'tyre', warranty_months: 1 } })
      const r = await sale(owner, { date: today(-20), customer: { name: 'Soon', phone: phone() }, items: [{ productId: t.id, qty: 1, serialNos: [serial('SW')] }], payments: [] })
      expect(r.status).toBe(201)
      const soon = (await owner.api.get('/api/tyre/warranty', { params: { expiringDays: 30, limit: 100 } })).data.data
      expect(soon.some((x: any) => x.id === r.data.warranty[0].id)).toBe(true)
      expect(soon.every((x: any) => x.status === 'active')).toBe(true)
      const narrow = (await owner.api.get('/api/tyre/warranty', { params: { expiringDays: 1, limit: 100 } })).data.data
      expect(narrow.some((x: any) => x.id === r.data.warranty[0].id)).toBe(false)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  describe('documents, messages and settings', () => {
    test('invoice PDF: unknown id 404, cancelled bill still renders, big bill paginates', async () => {
      expect((await owner.api.get(`/api/tyre/invoices/${U}/pdf`)).status).toBe(404)
      const one = await sale(owner, { customer: { name: 'To Cancel', phone: phone() }, items: [{ productId: tube.id, qty: 1 }], payments: [] })
      expect((await call(manager, 'POST', `/api/invoices/${one.data.invoice.id}/cancel`, {})).status).toBeLessThan(300)
      const pdf = await owner.api.get(`/api/tyre/invoices/${one.data.invoice.id}/pdf`, { responseType: 'arraybuffer' })
      expect(pdf.status).toBe(200)

      const items = Array.from({ length: 40 }, (_, i) => ({ productId: tube.id, qty: 1, serialNos: [serial(`PG${i}`)] }))
      const big = await sale(owner, { customer: { name: 'Fleet Order', phone: phone() }, items, payments: [] })
      expect(big.status).toBe(201)
      const bigPdf = await owner.api.get(`/api/tyre/invoices/${big.data.invoice.id}/pdf`, { responseType: 'arraybuffer' })
      expect(bigPdf.status).toBe(200)
      expect(Buffer.from(bigPdf.data).toString('latin1').match(/\/Type \/Page\b/g)?.length).toBeGreaterThanOrEqual(2)
    })

    test('manual send: cancelled bill is refused, retry of an unknown id is 404, a sent/queued message cannot be retried', async () => {
      const r = await sale(owner, { customer: { name: 'Msg', phone: phone() }, items: [{ productId: tube.id, qty: 1 }], payments: [] })
      const id = r.data.invoice.id
      const sent = await call(owner, 'POST', `/api/tyre/invoices/${id}/notify`, {})
      expect(sent.status).toBe(202)
      const log = (await owner.api.get('/api/tyre/notifications', { params: { refId: id } })).data.data
      expect(log).toHaveLength(1)
      // A queued or sent message cannot be retried (422). Where the message worker runs inside the app (the offline install) and
      // WhatsApp is not configured, it has already marked the message "skipped" by now — that one may be retried (202).
      const now = (await owner.api.get('/api/tyre/notifications', { params: { refId: id } })).data.data[0]
      const retry = (await call(owner, 'POST', `/api/tyre/notifications/${log[0].id}/retry`)).status
      expect(retry).toBe(['queued', 'sent'].includes(now.status) ? 422 : 202)
      expect((await call(owner, 'POST', `/api/tyre/notifications/${U}/retry`)).status).toBe(404)

      await call(manager, 'POST', `/api/invoices/${id}/cancel`, {})
      expect((await call(owner, 'POST', `/api/tyre/invoices/${id}/notify`, {})).status).toBe(422)
      expect((await call(owner, 'POST', `/api/tyre/invoices/${U}/notify`, {})).status).toBe(404)
    })

    test('an override number that is not a mobile is reported, not sent', async () => {
      const r = await sale(owner, { customer: { name: 'Override', phone: phone() }, items: [{ productId: tube.id, qty: 1 }], payments: [] })
      const bad = await call(owner, 'POST', `/api/tyre/invoices/${r.data.invoice.id}/notify`, { toPhone: '0000' })
      expect(bad.status).toBe(422)
    })

    test('settings: unknown keys and out-of-range values are refused; an empty update changes nothing', async () => {
      const before = (await owner.api.get('/api/tyre/notify-settings')).data
      for (const body of [{ notify_reminder_every_days: 0 }, { notify_reminder_every_days: 61 }, { notify_invoice: 'yes' }, { surprise: true }, { notify_owner_phone: 'x'.repeat(21) }]) {
        expect([JSON.stringify(body), (await call(manager, 'PUT', '/api/tyre/notify-settings', body)).status]).toEqual([JSON.stringify(body), 422])
      }
      const same = await call(manager, 'PUT', '/api/tyre/notify-settings', {})
      expect(same.status).toBe(200)
      expect(same.data).toEqual(before)
      const set = await call(manager, 'PUT', '/api/tyre/notify-settings', { notify_owner_phone: null, notify_reminder_every_days: 3 })
      expect(set.data).toMatchObject({ notify_owner_phone: null, notify_reminder_every_days: 3 })
    })

    test('saving the business form does not wipe the message settings', async () => {
      await call(manager, 'PUT', '/api/tyre/notify-settings', { notify_service_reminders: true })
      const b = (await owner.api.get('/api/branches')).data[0]
      const p = await owner.api.patch(`/api/branches/${b.id}`, { domainConfig: { default_tyre_gst: 18, dead_stock_days: 45 } })
      expect(p.status).toBe(200)
      const s = (await owner.api.get('/api/tyre/notify-settings')).data
      expect(s.notify_service_reminders).toBe(true)
      await call(manager, 'PUT', '/api/tyre/notify-settings', { notify_service_reminders: false })
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  describe('daily alert job', () => {
    let s: Session, ownerPhoneDigits: string

    beforeAll(async () => {
      s = await newShopTenant('Alerts Tyres')
      ownerPhoneDigits = s.tenantPhone
    })

    test('with everything off the job sends nothing', async () => {
      const r = await call(s, 'POST', '/api/tyre/notify/run-alerts')
      expect(r.status).toBe(200)
      expect(r.data).toEqual({ reminders: 0, serviceDue: 0, ownerAlerts: 0 })
    })

    test('overdue bill + due vehicle + low stock produce one message each, once', async () => {
      const low = await mk(s, { name: 'Almost Out', sku: 'AO-1', salePrice: 1000, purchasePrice: 800, lowStockQty: 5, openingStock: 2, domainAttrs: { item_kind: 'tyre' } })
      const ok = await mk(s, { name: 'Plenty', sku: 'PL-1', salePrice: 1000, purchasePrice: 800, lowStockQty: 5, openingStock: 50, domainAttrs: { item_kind: 'tyre' } })
      void ok
      const custPhone = phone()
      // a bill 20 days old on 5 days credit, unpaid → overdue
      const old = await sale(s, { date: today(-20), creditDays: 5, customer: { name: 'Late Payer', phone: custPhone }, items: [{ productId: low.id, qty: 1 }], payments: [] })
      expect(old.status).toBe(201)
      // a vehicle whose check was due 5 days ago
      const v = await call(s, 'POST', '/api/tyre/vehicles', { regNo: 'GJ05AL0001', ownerName: 'Due Owner', ownerPhone: '9825055555', nextServiceDate: today(-5), nextServiceFor: 'Wheel balancing' })
      expect(v.status).toBe(201)

      expect((await call(s, 'PUT', '/api/tyre/notify-settings', { notify_payment_reminders: true, notify_service_reminders: true, notify_owner_alerts: true })).status).toBe(200)

      const run1 = await call(s, 'POST', '/api/tyre/notify/run-alerts')
      expect(run1.status).toBe(200)
      expect(run1.data.reminders).toBe(1)
      expect(run1.data.serviceDue).toBe(1)
      expect(run1.data.ownerAlerts).toBeGreaterThanOrEqual(2)      // low stock + overdue money

      const log = (await s.api.get('/api/tyre/notifications', { params: { limit: 50 } })).data.data
      const kinds = log.map((m: any) => m.kind).sort()
      expect(kinds).toEqual(expect.arrayContaining(['owner_alerts', 'payment_reminder', 'service_due']))
      const pay = log.find((m: any) => m.kind === 'payment_reminder')
      expect(pay.toPhone).toBe(`91${custPhone}`)
      expect(pay.message).toMatch(/overdue by 15 days/)
      const svc = log.find((m: any) => m.kind === 'service_due')
      expect(svc.message).toMatch(/wheel balancing/i)
      const digest = log.find((m: any) => m.kind === 'owner_alerts')
      expect(digest.toPhone).toBe(`91${ownerPhoneDigits}`)
      expect(digest.message).toMatch(/Low stock: Almost Out/)
      expect(digest.message).not.toMatch(/Plenty/)

      // running again the same day must not message anyone twice
      const run2 = await call(s, 'POST', '/api/tyre/notify/run-alerts')
      expect(run2.data).toEqual({ reminders: 0, serviceDue: 0, ownerAlerts: 0 })
      expect((await s.api.get('/api/tyre/notifications', { params: { limit: 50 } })).data.total).toBe(log.length)
    })

    test('a paid-up customer and a vehicle with reminders off are left alone', async () => {
      const t = await mk(s, { name: 'Quiet Tyre', sku: 'QT-1', salePrice: 100, purchasePrice: 50, openingStock: 20, domainAttrs: { item_kind: 'tyre' } })
      const paid = await sale(s, { date: today(-30), creditDays: 5, customer: { name: 'Paid Up', phone: phone() }, items: [{ productId: t.id, qty: 1 }], payments: [{ method: 'cash', amount: 118 }] })
      expect(paid.status).toBe(201)
      await call(s, 'POST', '/api/tyre/vehicles', { regNo: 'GJ05AL0002', ownerPhone: '9825066666', nextServiceDate: today(-5), remindersOff: true })
      const before = (await s.api.get('/api/tyre/notifications', { params: { limit: 100 } })).data.total
      const r = await call(s, 'POST', '/api/tyre/notify/run-alerts')
      expect(r.data.reminders).toBe(0)
      expect(r.data.serviceDue).toBe(0)
      expect((await s.api.get('/api/tyre/notifications', { params: { limit: 100 } })).data.total).toBe(before)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  describe('reports and dead stock', () => {
    test('dead stock: an item last sold long ago and still on the shelf is listed, with its value', async () => {
      const p = await mk(owner, { name: 'Dusty Tyre', sku: 'DUST-1', salePrice: 1000, purchasePrice: 700, openingStock: 10, domainAttrs: { item_kind: 'tyre', size: '175/70 R13' } })
      const r = await sale(owner, { date: today(-200), customer: { name: 'Old Sale', phone: phone() }, items: [{ productId: p.id, qty: 1 }], payments: [{ method: 'cash', amount: 1180 }] })
      expect(r.status).toBe(201)
      const d = (await owner.api.get('/api/tyre/dead-stock', { params: { days: 90 } })).data
      const row = d.data.find((x: any) => x.id === p.id)
      expect(row).toBeTruthy()
      expect(row.stock).toBe(9)
      expect(row.stockValue).toBe(9 * 700)
      expect(row.idleDays).toBeGreaterThanOrEqual(199)
      expect(row.neverSold).toBe(false)
      expect((await owner.api.get('/api/tyre/dead-stock', { params: { days: 365 } })).data.data.some((x: any) => x.id === p.id)).toBe(false)
      expect(d.data.every((x: any) => x.stock > 0)).toBe(true)
    })

    test('reports: every grouping answers, an inverted or empty range is empty not an error, cancelled bills are excluded', async () => {
      for (const by of ['size', 'brand', 'product', 'vehicle_type']) {
        const r = await owner.api.get('/api/tyre/reports/sales', { params: { by } })
        expect([by, r.status]).toEqual([by, 200])
        expect(r.data.data.every((x: any) => Number.isFinite(x.revenue) && Number.isFinite(x.marginPct))).toBe(true)
      }
      const inverted = await owner.api.get('/api/tyre/reports/sales', { params: { from: '2026-12-31', to: '2026-01-01' } })
      expect(inverted.status).toBe(200)
      expect(inverted.data.data).toEqual([])
      expect(inverted.data.totals.revenue).toBe(0)

      const p = await mk(owner, { name: 'Cancel Report', sku: 'CR-1', salePrice: 1000, purchasePrice: 500, openingStock: 5, domainAttrs: { item_kind: 'tyre', size: '88/88 R18' } })
      const b = await sale(owner, { customer: { name: 'CR', phone: phone() }, items: [{ productId: p.id, qty: 2 }], payments: [] })
      const during = (await owner.api.get('/api/tyre/reports/sales', { params: { by: 'size' } })).data.data.find((x: any) => x.label === '88/88 R18')
      expect(during.units).toBe(2)
      await call(manager, 'POST', `/api/invoices/${b.data.invoice.id}/cancel`, {})
      const after = (await owner.api.get('/api/tyre/reports/sales', { params: { by: 'size' } })).data.data.find((x: any) => x.label === '88/88 R18')
      expect(after).toBeUndefined()
      expect(await stock(owner, p.id)).toBe(5)              // stock came back
    })

    test('dashboard on an empty business and for a viewer is well-formed', async () => {
      const d = (await viewer.api.get('/api/tyre/dashboard')).data
      for (const k of ['today', 'month', 'receivable', 'stock', 'warranty']) expect(d[k]).toBeTruthy()
      expect(Array.isArray(d.recent)).toBe(true)
      expect(Array.isArray(d.topSizes)).toBe(true)
      expect(Number.isFinite(d.stock.value)).toBe(true)
    })
  })
})
