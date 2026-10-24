// What goes wrong at a real counter, found by replaying the shop's paper book and walking the screens.
// Dates, names without a mobile number, returns done twice, credit paid off in instalments, a very big bill, an
// Excel export with Gujarati names, and a forgotten PIN.

import axios from 'axios'
import { newShopTenant, BASE, type Session } from './helpers'

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
})
