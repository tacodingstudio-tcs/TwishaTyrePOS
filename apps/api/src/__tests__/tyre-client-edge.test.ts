// What goes wrong at a real counter, found by replaying the shop's paper book and walking the screens.
// Dates, names without a mobile number, returns done twice, credit paid off in instalments, a very big bill, an
// Excel export with Gujarati names, and a forgotten PIN.

import axios from 'axios'
import { newShopTenant, testPhone, login, BASE, type Session } from './helpers'

describe('Client edge cases', () => {
  let owner: Session, tyre: any, tube: any
  const sale = (b: Record<string, unknown>, key = crypto.randomUUID()) => owner.api.post('/api/tyre/sales', b, { headers: { 'Idempotency-Key': key } })
  const inv = async (id: string) => (await owner.api.get(`/api/invoices/${id}`)).data
  const stockOf = async (id: string) => Number(((await owner.api.get('/api/stock', { params: { limit: 500 } })).data.data as any[]).find((s) => s.productId === id)?.currentQty)
  const ymd = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10)
  const cash = (amount: number) => [{ method: 'cash', amount }]

  beforeAll(async () => {
    owner = await newShopTenant('Client Edge Tyres')
    const mk = async (name: string, sku: string, price: number, size: string) => (await owner.api.post('/api/products', {
      itemType: 'product', gstRate: 18, unit: 'pcs', trackStock: true, name, sku, salePrice: price, purchasePrice: Math.round(price * 0.7), openingStock: 200,
      domainAttrs: { item_kind: 'tyre', brand: 'MRF', size, vehicle_type: 'car' },
    })).data
    tyre = await mk('MRF 185/65 R15', 'E1', 5000, '185/65 R15')
    tube = await mk('MRF 195/65 R15', 'E2', 100, '195/65 R15')
  }, 60_000)

  describe('bill date', () => {
    test('a date in the future, or more than a year back, is refused with a plain message (a typo would land the bill in the wrong GST month)', async () => {
      for (const [d, re] of [[ymd(1), /in the future/], ['2099-01-01', /in the future/], ['2016-02-27', /more than a year ago/], [ymd(-400), /more than a year ago/]] as const) {
        const r = await sale({ customer: { name: 'Date Check' }, date: d, items: [{ productId: tyre.id, qty: 1 }], payments: cash(5900) })
        expect([d, r.status]).toEqual([d, 422]); expect(JSON.stringify(r.data)).toMatch(re)
      }
    })
    test('today and yesterday are fine; a date that does not exist is a clear 422, never a crash', async () => {
      expect((await sale({ customer: { name: 'Yday' }, date: ymd(-1), items: [{ productId: tyre.id, qty: 1 }], payments: cash(5900) })).status).toBe(201)
      expect((await sale({ customer: { name: 'Today' }, date: ymd(0), items: [{ productId: tyre.id, qty: 1 }], payments: cash(5900) })).status).toBe(201)
      for (const d of ['2026-13-45', '2026-02-30', '2025-02-29', '0000-00-00']) {
        const r = await sale({ customer: { name: 'Bad Date' }, date: d, items: [{ productId: tyre.id, qty: 1 }], payments: cash(5900) })
        expect([d, r.status]).toEqual([d, 422]); expect(JSON.stringify(r.data)).toMatch(/does not exist|Use YYYY-MM-DD/)
      }
    })
    test('report ranges with a date that does not exist are refused, not a 500', async () => {
      const r = await owner.api.get('/api/tyre/reports/register', { params: { from: '2026-13-01', to: '2026-14-01' } })
      expect(r.status).toBe(422)
    })
  })

  describe('a customer typed by name only (no mobile)', () => {
    test('the name and address stay on the bill, the register, the CSV and the PDF — Gujarati included', async () => {
      const r = await sale({ customer: { name: 'ગુજરાતી ગ્રાહક', address: 'કોડીનાર' }, items: [{ productId: tyre.id, qty: 1 }], payments: cash(5900) })
      expect(r.status).toBe(201)
      expect((await inv(r.data.invoice.id)).domainData.customer_name).toBe('ગુજરાતી ગ્રાહક')
      const reg = (await owner.api.get('/api/tyre/reports/register')).data
      expect((reg.rows as any[]).some((x) => x['Customer'] === 'ગુજરાતી ગ્રાહક' && x['Address'] === 'કોડીનાર')).toBe(true)
      const csv = await owner.api.get('/api/tyre/reports/register', { params: { format: 'csv' }, responseType: 'arraybuffer' })
      const b = Buffer.from(csv.data)
      expect(b.subarray(0, 3).toString('hex')).toBe('efbbbf')                       // Excel reads the Gujarati correctly
      expect(b.toString('utf8')).toContain('ગુજરાતી ગ્રાહક')
      const pdf = await owner.api.get(`/api/tyre/invoices/${r.data.invoice.id}/pdf`, { responseType: 'arraybuffer' })
      expect(pdf.status).toBe(200)
    })
    test('no customer record is made for a name with no mobile, so the customer list is not filled with one-off names', async () => {
      const before = (await owner.api.get('/api/parties', { params: { type: 'customer', limit: 1 } })).data.meta.total
      await sale({ customer: { name: 'One Off Walk In' }, items: [{ productId: tyre.id, qty: 1 }], payments: cash(5900) })
      expect((await owner.api.get('/api/parties', { params: { type: 'customer', limit: 1 } })).data.meta.total).toBe(before)
    })
  })

  describe('returns', () => {
    let billId: string, lineId: string
    beforeAll(async () => {
      const r = await sale({ customer: { name: 'Returner', phone: '9825077001' }, items: [{ productId: tyre.id, qty: 4 }], payments: cash(4 * 5900) })
      billId = r.data.invoice.id
      lineId = (await inv(billId)).items.find((i: any) => i.productId === tyre.id).id
    })
    test('part return, then the rest: stock comes back each time, and no more than was sold can be returned in total', async () => {
      const s0 = await stockOf(tyre.id)
      expect((await owner.api.post(`/api/invoices/${billId}/return`, { items: [{ invoiceItemId: lineId, qty: 1 }] })).status).toBe(201)
      expect(await stockOf(tyre.id)).toBe(s0 + 1)
      expect((await owner.api.post(`/api/invoices/${billId}/return`, { items: [{ invoiceItemId: lineId, qty: 3 }] })).status).toBe(201)
      expect(await stockOf(tyre.id)).toBe(s0 + 4)
      const again = await owner.api.post(`/api/invoices/${billId}/return`, { items: [{ invoiceItemId: lineId, qty: 1 }] })
      expect([409, 422]).toContain(again.status)                                       // already fully returned
      expect(await stockOf(tyre.id)).toBe(s0 + 4)
    })
    test('returning more than was sold in one go is refused', async () => {
      const r = await sale({ customer: { name: 'Over Return', phone: '9825077002' }, items: [{ productId: tyre.id, qty: 2 }], payments: cash(2 * 5900) })
      const line = (await inv(r.data.invoice.id)).items.find((i: any) => i.productId === tyre.id).id
      const over = await owner.api.post(`/api/invoices/${r.data.invoice.id}/return`, { items: [{ invoiceItemId: line, qty: 3 }] })
      expect(over.status).toBe(422)
    })
    test('a cancelled bill cannot be returned', async () => {
      const r = await sale({ customer: { name: 'Cancel Then Return', phone: '9825077003' }, items: [{ productId: tyre.id, qty: 1 }], payments: [] })
      const id = r.data.invoice.id
      expect([200, 201]).toContain((await owner.api.post(`/api/invoices/${id}/cancel`, {})).status)
      const line = (await inv(id)).items.find((i: any) => i.productId === tyre.id).id
      expect([409, 422]).toContain((await owner.api.post(`/api/invoices/${id}/return`, { items: [{ invoiceItemId: line, qty: 1 }] })).status)
    })
  })

  describe('credit (udhaar) paid off in instalments', () => {
    test('balance goes down with each payment; the bill turns paid at the end; an extra payment is refused', async () => {
      const r = await sale({ customer: { name: 'Udhaar Customer', phone: '9825077010' }, items: [{ productId: tyre.id, qty: 1 }], payments: cash(1000) })
      expect(r.status).toBe(201)
      const id = r.data.invoice.id
      const total = Number((await inv(id)).grandTotal)
      expect(Number((await inv(id)).paidAmt)).toBe(1000)
      const pay = (amount: number) => owner.api.post(`/api/invoices/${id}/payment`, { amount, method: 'cash' }, { headers: { 'Idempotency-Key': crypto.randomUUID() } })
      expect([200, 201]).toContain((await pay(2000)).status)
      expect([200, 201]).toContain((await pay(total - 3000)).status)
      const done = await inv(id)
      expect(Number(done.paidAmt)).toBe(total); expect(done.status).toBe('paid')
      expect((await pay(1)).status).toBeGreaterThanOrEqual(400)                        // nothing left to pay
    })
  })

  describe('a very big bill', () => {
    test('60 lines and large amounts reconcile and print as a multi-page PDF', async () => {
      const items = Array.from({ length: 60 }, (_, i) => ({ productId: i % 2 ? tyre.id : tube.id, qty: 1, rate: 1234.56 + i }))
      const expected = items.reduce((s, i) => s + i.rate, 0)
      const r = await sale({ customer: { name: 'Fleet Owner', phone: '9825077020' }, items, payments: [], creditDays: 30 })
      expect(r.status).toBe(201)
      const bill = await inv(r.data.invoice.id)
      expect(bill.items.length).toBe(60)
      expect(Math.abs(Number(bill.grandTotal) - expected * 1.18)).toBeLessThan(35)       // 60 lines of rounding, never off by rupees
      const pdf = await owner.api.get(`/api/tyre/invoices/${r.data.invoice.id}/pdf`, { responseType: 'arraybuffer' })
      expect(pdf.status).toBe(200)
      expect((Buffer.from(pdf.data).toString('latin1').match(/\/Type \/Page\b/g) ?? []).length).toBeGreaterThan(1)
    })
    test('61 lines, a quantity of 1001 and a price above ₹1 crore are refused', async () => {
      expect((await sale({ customer: { name: 'X', phone: '9825077021' }, items: Array.from({ length: 61 }, () => ({ productId: tyre.id, qty: 1 })), payments: [] })).status).toBe(422)
      expect((await sale({ customer: { name: 'X' }, items: [{ productId: tyre.id, qty: 1001 }], payments: [] })).status).toBe(422)
      expect((await sale({ customer: { name: 'X' }, items: [{ productId: tyre.id, qty: 1, rate: 20_000_000 }], payments: [] })).status).toBe(422)
    })
  })

  describe('a forgotten PIN', () => {
    test('five wrong tries lock the sign-in with a message that says how long; the right PIN waits too; another shop is unaffected', async () => {
      const shop = await newShopTenant('Lockout Tyres')
      const other = await newShopTenant('Other Tyres')
      const bad = () => axios.post(`${BASE}/api/auth/login`, { tenantPhone: shop.tenantPhone, phone: shop.tenantPhone, pin: '9999' }, { validateStatus: () => true })
      for (let i = 0; i < 5; i++) expect((await bad()).status).toBe(401)
      const locked = await bad()
      expect(locked.status).toBe(429)
      expect(String(locked.data.message)).toMatch(/Try again in \d+ minutes/)
      const right = await axios.post(`${BASE}/api/auth/login`, { tenantPhone: shop.tenantPhone, phone: shop.tenantPhone, pin: '1234' }, { validateStatus: () => true })
      expect(right.status).toBe(429)
      const ok = await axios.post(`${BASE}/api/auth/login`, { tenantPhone: other.tenantPhone, phone: other.tenantPhone, pin: '1234' }, { validateStatus: () => true })
      expect(ok.status).toBe(200)
    })
  })

  describe('owner / manager unlock', () => {
    const tryPin = (tenant: string, phone: string, pin: string) => axios.post(`${BASE}/api/auth/login`, { tenantPhone: tenant, phone, pin }, { validateStatus: () => true })
    const lockOut = async (tenant: string, phone: string) => { for (let i = 0; i < 5; i++) await tryPin(tenant, phone, '9999') }
    const addUser = async (shop: Session, role: string) => {
      const phone = testPhone()
      const r = await shop.api.post('/api/users', { name: `${role} person`, phone, pin: '4321', role })
      expect(r.status).toBe(201)
      return { id: r.data.id as string, phone }
    }

    test('the owner lifts a staff lock at once; the list shows who is locked; the staff member signs in straight away', async () => {
      const shop = await newShopTenant('Unlock Tyres')
      const staff = await addUser(shop, 'cashier')
      await lockOut(shop.tenantPhone, staff.phone)
      expect((await tryPin(shop.tenantPhone, staff.phone, '4321')).status).toBe(429)
      const listed = (await shop.api.get('/api/users')).data.users.find((u: any) => u.id === staff.id)
      expect(listed.lockedMinutes).toBeGreaterThan(0)
      const un = await shop.api.post(`/api/users/${staff.id}/unlock`)
      expect(un.status).toBe(200); expect(un.data.wasLocked).toBe(true)
      expect((await shop.api.get('/api/users')).data.users.find((u: any) => u.id === staff.id).lockedMinutes).toBe(0)
      expect((await tryPin(shop.tenantPhone, staff.phone, '4321')).status).toBe(200)
    })
    test('a manager can unlock the owner who forgot the PIN; the PIN is still needed (a wrong one counts again)', async () => {
      const shop = await newShopTenant('Owner Locked Tyres')
      const mgr = await addUser(shop, 'manager')
      await lockOut(shop.tenantPhone, shop.tenantPhone)
      expect((await tryPin(shop.tenantPhone, shop.tenantPhone, '1234')).status).toBe(429)
      const mgrSession = await login(mgr.phone, '4321', shop.tenantPhone)
      const owner = (await mgrSession.api.get('/api/users')).data.users.find((u: any) => u.role === 'owner')
      expect(owner.lockedMinutes).toBeGreaterThan(0)
      expect((await mgrSession.api.post(`/api/users/${owner.id}/unlock`)).status).toBe(200)
      expect((await tryPin(shop.tenantPhone, shop.tenantPhone, '9999')).status).toBe(401)    // not a bypass: wrong PIN still fails
      expect((await tryPin(shop.tenantPhone, shop.tenantPhone, '1234')).status).toBe(200)
    })
    test('counter staff and viewers cannot unlock anyone; an unknown user is 404; unlocking an open account is harmless', async () => {
      const shop = await newShopTenant('Unlock Rules Tyres')
      const cashier = await addUser(shop, 'cashier'), viewer = await addUser(shop, 'viewer'), other = await addUser(shop, 'cashier')
      await lockOut(shop.tenantPhone, other.phone)
      const c = await login(cashier.phone, '4321', shop.tenantPhone), v = await login(viewer.phone, '4321', shop.tenantPhone)
      expect((await c.api.post(`/api/users/${other.id}/unlock`)).status).toBe(403)
      expect((await v.api.post(`/api/users/${other.id}/unlock`)).status).toBe(403)
      expect((await tryPin(shop.tenantPhone, other.phone, '4321')).status).toBe(429)         // still locked
      expect((await shop.api.post('/api/users/00000000-0000-4000-8000-000000000000/unlock')).status).toBe(404)
      const open = await shop.api.post(`/api/users/${cashier.id}/unlock`)
      expect(open.status).toBe(200); expect(open.data.wasLocked).toBe(false)
    })
    test('another business cannot unlock the people of this one', async () => {
      const a = await newShopTenant('Shop A'), b = await newShopTenant('Shop B')
      const staff = await addUser(a, 'cashier')
      await lockOut(a.tenantPhone, staff.phone)
      expect((await b.api.post(`/api/users/${staff.id}/unlock`)).status).toBe(404)
      expect((await tryPin(a.tenantPhone, staff.phone, '4321')).status).toBe(429)
    })
    test('resetting a PIN lifts the lock too', async () => {
      const shop = await newShopTenant('Reset Lifts Tyres')
      const staff = await addUser(shop, 'cashier')
      await lockOut(shop.tenantPhone, staff.phone)
      expect((await shop.api.post(`/api/users/${staff.id}/reset-pin`, { pin: '5555' })).status).toBe(200)
      expect((await tryPin(shop.tenantPhone, staff.phone, '5555')).status).toBe(200)
    })
  })

  describe('changing your own PIN', () => {
    test('needs the current PIN; the new PIN signs in, the old one does not', async () => {
      const shop = await newShopTenant('Own Pin Tyres')
      const staff = { phone: testPhone() }
      expect((await shop.api.post('/api/users', { name: 'cashier user', phone: staff.phone, pin: '4321', role: 'cashier' })).status).toBeLessThan(300)
      const tryPin = (pin: string) => axios.post(`${BASE}/api/auth/login`, { tenantPhone: shop.tenantPhone, phone: staff.phone, pin }, { validateStatus: () => true })
      const me = await login(staff.phone, '4321', shop.tenantPhone)
      expect((await me.api.post('/api/users/me/change-pin', { currentPin: '9999', newPin: '2468' })).status).toBe(422)
      expect((await me.api.post('/api/users/me/change-pin', { currentPin: '4321', newPin: '4321' })).status).toBe(422)
      expect((await me.api.post('/api/users/me/change-pin', { currentPin: '4321', newPin: '12' })).status).toBeGreaterThanOrEqual(400)
      expect((await me.api.post('/api/users/me/change-pin', { currentPin: '4321', newPin: '2468' })).status).toBe(200)
      expect((await tryPin('2468')).status).toBe(200)
      expect((await tryPin('4321')).status).toBe(401)
    })
    test('wrong current PINs count towards the sign-in lock', async () => {
      const shop = await newShopTenant('Own Pin Lock Tyres')
      for (let i = 0; i < 5; i++) await shop.api.post('/api/users/me/change-pin', { currentPin: '0000', newPin: '2468' })
      expect((await shop.api.post('/api/users/me/change-pin', { currentPin: '1234', newPin: '2468' })).status).toBe(429)
    })
  })

  describe('bill search', () => {
    let nums: Record<string, string> = {}
    beforeAll(async () => {
      for (const [k, name, phone] of [['a', 'Rameshbhai Patel', '9825078001'], ['b', 'ramesh Shah', '9825078002'], ['c', 'Kiran Desai', '9825078003']] as const) {
        const r = await sale({ customer: { name, phone }, items: [{ productId: tyre.id, qty: 1 }], payments: cash(5900) })
        nums[k] = r.data.invoice.number
      }
    })
    const find = async (q: string, extra: Record<string, unknown> = {}) => (await owner.api.get('/api/invoices', { params: { search: q, limit: 50, ...extra } })).data
    test('finds by the start of the customer name, ignoring case', async () => {
      for (const q of ['rame', 'RAMESH', 'Ramesh']) { const r = await find(q); expect([q, r.meta.total]).toEqual([q, 2]) }
      expect((await find('kir')).data[0].party.name).toBe('Kiran Desai')
    })
    test('finds by the start of the mobile number, and by the start of the bill number', async () => {
      expect((await find('98250780')).meta.total).toBe(3)
      expect((await find('9825078002')).data[0].party.name).toBe('ramesh Shah')
      const byNo = await find(nums['c']!.slice(0, nums['c']!.length - 1).toLowerCase())
      expect(byNo.data.some((x: any) => x.number === nums['c'])).toBe(true)
    })
    test('it is a "starts with" search: the middle of a name does not match; nothing found is an empty list, not an error', async () => {
      expect((await find('patel')).meta.total).toBe(0)
      const none = await find('zzzz-no-such')
      expect(none.data).toEqual([]); expect(none.meta.total).toBe(0)
    })
    test('a typed % or _ means itself, never "anything"; quotes and SQL are harmless', async () => {
      for (const q of ['%', '_', 'r%', "x' OR 1=1 --", '\\', 'a;DROP TABLE invoices']) {
        const r = await owner.api.get('/api/invoices', { params: { search: q } })
        expect([q, r.status]).toEqual([q, 200]); expect(r.data.meta.total).toBe(0)
      }
    })
    test('works together with filters and paging: results stay newest first, each bill once', async () => {
      const p1 = await find('ramesh', { limit: 1, page: 1 }), p2 = await find('ramesh', { limit: 1, page: 2 }), p3 = await find('ramesh', { limit: 1, page: 3 })
      expect(p1.meta.total).toBe(2); expect(p1.meta.totalPages).toBe(2)
      expect(p1.data).toHaveLength(1); expect(p2.data).toHaveLength(1); expect(p3.data).toHaveLength(0)
      expect(p1.data[0].id).not.toBe(p2.data[0].id)
      expect((await find('ramesh', { txnType: 'sale_invoice', status: 'paid' })).meta.total).toBe(2)
      expect((await find('ramesh', { status: 'cancelled' })).meta.total).toBe(0)
      expect((await find('ramesh', { fromDate: ymd(1) })).meta.total).toBe(0)
    })
    test('another business never shows up in the results', async () => {
      const other = await newShopTenant('Search Other Tyres')
      expect((await other.api.get('/api/invoices', { params: { search: 'ramesh' } })).data.meta.total).toBe(0)
    })
  })
})
