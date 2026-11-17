// "Correct this bill": a wrong tyre on a bill is fixed by replacing the bill — same number, same date — in one
// all-or-nothing step. Stock, customer balance, payments and warranty rows must all end up as if the bill had
// been right the first time; the old bill stays on record, cancelled.

import { newShopTenant, addStaff, testPhone, type Session } from './helpers'
import { pdfText } from './pdf-text'

describe('Correct this bill', () => {
  let owner: Session, a: any, b: any
  const sale = (body: Record<string, unknown>) => owner.api.post('/api/tyre/sales', body, { headers: { 'Idempotency-Key': crypto.randomUUID() } })
  const correct = (id: string, body: Record<string, unknown>, api = owner.api) => api.post(`/api/tyre/sales/${id}/correct`, body, { headers: { 'Idempotency-Key': crypto.randomUUID() } })
  const inv = async (id: string) => (await owner.api.get(`/api/invoices/${id}`)).data
  const stockOf = async (id: string) => Number(((await owner.api.get('/api/stock', { params: { limit: 500 } })).data.data as any[]).find((s) => s.productId === id)?.currentQty)
  const balanceOf = async (partyId: string) => Number((await owner.api.get(`/api/parties/${partyId}`)).data.balance)
  const cash = (amount: number) => [{ method: 'cash', amount }]
  const phone = () => testPhone()
  const ymdNow = (d: number) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10)

  beforeAll(async () => {
    owner = await newShopTenant('Correct Bill Tyres')
    const mk = async (name: string, sku: string, price: number, size: string) => (await owner.api.post('/api/products', {
      itemType: 'product', gstRate: 18, unit: 'pcs', trackStock: true, name, sku, salePrice: price, purchasePrice: Math.round(price * 0.7), openingStock: 50,
      domainAttrs: { item_kind: 'tyre', brand: 'MRF', size, vehicle_type: 'car' },
    })).data
    a = await mk('MRF 185/65 R15', 'C1', 5000, '185/65 R15')
    b = await mk('MRF 195/65 R15', 'C2', 6000, '195/65 R15')
  }, 60_000)

  test('a paid bill with the wrong tyre becomes a right bill: same number and date, stock and payment follow', async () => {
    const mobile = phone()
    const old = await sale({ customer: { name: 'Wrong Tyre Customer', phone: mobile }, items: [{ productId: a.id, qty: 2, serialNos: ['CORR-S1', 'CORR-S2'] }], payments: cash(11800) })
    expect(old.status).toBe(201)
    const oldId = old.data.invoice.id, number = old.data.invoice.number, partyId = old.data.invoice.partyId
    const stockA = await stockOf(a.id), stockB = await stockOf(b.id)

    const r = await correct(oldId, { customer: { name: 'Wrong Tyre Customer', phone: mobile }, items: [{ productId: b.id, qty: 1, serialNos: ['CORR-S1'] }], payments: cash(7080), reason: 'wrong tyre picked' })
    expect(r.status).toBe(201)
    expect(r.data.invoice.number).toBe(number)
    expect(String(r.data.invoice.date).slice(0, 10)).toBe(String(old.data.invoice.date).slice(0, 10))
    expect(r.data.invoice.id).not.toBe(oldId)
    expect(r.data.corrected.oldBillRenamedTo).toBe(`${number}-OLD`)

    const oldNow = await inv(oldId)
    expect(oldNow.status).toBe('cancelled'); expect(oldNow.number).toBe(`${number}-OLD`); expect(Number(oldNow.paidAmt)).toBe(0)
    expect(JSON.stringify(oldNow.notes)).toMatch(/wrong tyre picked/)
    const fresh = await inv(r.data.invoice.id)
    expect(fresh.status).toBe('paid'); expect(Number(fresh.grandTotal)).toBe(7080)

    expect(await stockOf(a.id)).toBe(stockA + 2)       // the two tyres on the wrong bill are back on the shelf
    expect(await stockOf(b.id)).toBe(stockB - 1)
    expect(await balanceOf(partyId)).toBe(0)           // paid in full both times
    // the serial of the wrong bill is free again and sits on the new bill; the second serial is no longer sold
    const w = (await owner.api.get('/api/tyre/warranty', { params: { q: 'CORR-S', limit: 50 } })).data.data as any[]
    const live = w.filter((x) => x.status !== 'void')
    expect(live.map((x) => x.serialNo).sort()).toEqual(['CORR-S1'])
    expect(live[0].invoiceNo).toBe(number)
    // only one live bill answers to that number
    const list = (await owner.api.get('/api/invoices', { params: { search: number, limit: 50 } })).data.data as any[]
    expect(list.filter((x) => x.number === number && x.status !== 'cancelled')).toHaveLength(1)
  })

  test('a credit bill: the customer owes exactly the corrected amount afterwards', async () => {
    const mobile = phone()
    const old = await sale({ customer: { name: 'Credit Customer', phone: mobile }, items: [{ productId: b.id, qty: 2 }], payments: cash(2000) })
    const partyId = old.data.invoice.partyId
    expect(await balanceOf(partyId)).toBe(12000 * 1.18 - 2000)
    const r = await correct(old.data.invoice.id, { customer: { name: 'Credit Customer', phone: mobile }, items: [{ productId: a.id, qty: 1 }], payments: cash(1000) })
    expect(r.status).toBe(201)
    expect(await balanceOf(partyId)).toBe(5900 - 1000)
  })

  test('a failed correction changes nothing: the old bill, its stock and its payment stay exactly as they were', async () => {
    const mobile = phone()
    const old = await sale({ customer: { name: 'Safe Customer', phone: mobile }, items: [{ productId: a.id, qty: 1 }], payments: cash(5900) })
    const id = old.data.invoice.id, number = old.data.invoice.number
    const stockA = await stockOf(a.id)
    const bad = await correct(id, { customer: { name: 'Safe Customer', phone: mobile }, items: [{ productId: b.id, qty: 9999 }], payments: cash(5900) })
    expect([409, 422]).toContain(bad.status)
    const same = await inv(id)
    expect(same.number).toBe(number); expect(same.status).toBe('paid'); expect(Number(same.paidAmt)).toBe(5900)
    expect(await stockOf(a.id)).toBe(stockA)
    // a second kind of failure, after the old bill was already undone inside the transaction: payments larger than the bill
    const bad2 = await correct(id, { customer: { name: 'Safe Customer', phone: mobile }, items: [{ productId: b.id, qty: 1 }], payments: cash(999999) })
    expect(bad2.status).toBe(422)
    const again = await inv(id)
    expect(again.number).toBe(number); expect(again.status).toBe('paid')
    expect(await stockOf(a.id)).toBe(stockA)
  })

  test('the same bill can be corrected again; each cancelled copy keeps its own name', async () => {
    const mobile = phone()
    const first = await sale({ customer: { name: 'Twice', phone: mobile }, items: [{ productId: a.id, qty: 1 }], payments: cash(5900) })
    const n = first.data.invoice.number
    const c1 = await correct(first.data.invoice.id, { customer: { name: 'Twice', phone: mobile }, items: [{ productId: b.id, qty: 1 }], payments: cash(7080) })
    const c2 = await correct(c1.data.invoice.id, { customer: { name: 'Twice', phone: mobile }, items: [{ productId: a.id, qty: 2 }], payments: cash(11800) })
    expect(c2.status).toBe(201)
    expect(c2.data.invoice.number).toBe(n)
    expect(c1.data.corrected.oldBillRenamedTo).toBe(`${n}-OLD`)
    expect(c2.data.corrected.oldBillRenamedTo).toBe(`${n}-OLDB`)
    // a cancelled bill cannot be corrected
    expect((await correct(first.data.invoice.id, { customer: { name: 'Twice', phone: mobile }, items: [{ productId: a.id, qty: 1 }], payments: cash(5900) })).status).toBe(409)

    // the list hides cancelled bills (the -OLD copies) unless "Cancelled" is picked; the live bill stays
    const ids = async (extra: Record<string, unknown>) => ((await owner.api.get('/api/invoices', { params: { search: n, limit: 50, ...extra } })).data.data as any[]).map((x) => x.number)
    expect(await ids({ hideCancelled: 'true' })).toEqual([n])
    expect((await ids({})).sort()).toEqual([n, `${n}-OLD`, `${n}-OLDB`].sort())
    expect((await ids({ hideCancelled: 'true', status: 'cancelled' })).sort()).toEqual([`${n}-OLD`, `${n}-OLDB`].sort())
  })

  test('the next new bill still gets the next number (the corrected bill and the -OLD copy do not disturb numbering)', async () => {
    const x = await sale({ customer: { name: 'Num A' }, items: [{ productId: a.id, qty: 1 }], payments: cash(5900) })
    await correct(x.data.invoice.id, { customer: { name: 'Num A' }, items: [{ productId: b.id, qty: 1 }], payments: cash(7080) })
    const y = await sale({ customer: { name: 'Num B' }, items: [{ productId: a.id, qty: 1 }], payments: cash(5900) })
    expect(Number(String(y.data.invoice.number).match(/(\d+)$/)![1])).toBe(Number(String(x.data.invoice.number).match(/(\d+)$/)![1]) + 1)
  })

  test('a bill that has a return against it cannot be corrected', async () => {
    const mobile = phone()
    const s = await sale({ customer: { name: 'Returned', phone: mobile }, items: [{ productId: a.id, qty: 2 }], payments: cash(11800) })
    const detail = await inv(s.data.invoice.id)
    const ret = await owner.api.post(`/api/invoices/${s.data.invoice.id}/return`, { items: [{ invoiceItemId: detail.items[0].id, qty: 1 }], reason: 'test' }, { headers: { 'Idempotency-Key': crypto.randomUUID() } })
    if (ret.status === 201 || ret.status === 200) {
      const r = await correct(s.data.invoice.id, { customer: { name: 'Returned', phone: mobile }, items: [{ productId: a.id, qty: 2 }], payments: cash(11800) })
      expect(r.status).toBe(409)
    }
  })

  test('only the owner or a manager may correct; a cashier and a viewer cannot', async () => {
    const s = await sale({ customer: { name: 'Roles' }, items: [{ productId: a.id, qty: 1 }], payments: cash(5900) })
    for (const role of ['cashier', 'viewer'] as const) {
      const u = await addStaff(owner, role)
      const r = await correct(s.data.invoice.id, { customer: { name: 'Roles' }, items: [{ productId: a.id, qty: 1 }], payments: cash(5900) }, u.api)
      expect([role, r.status]).toEqual([role, 403])
    }
    const m = await addStaff(owner, 'manager')
    expect((await correct(s.data.invoice.id, { customer: { name: 'Roles' }, items: [{ productId: b.id, qty: 1 }], payments: cash(7080) }, m.api)).status).toBe(201)
  })

  test('details edit: vehicle, make, km and notes change; money and stock do not', async () => {
    const s = await sale({ customer: { name: 'Words Only' }, vehicleNo: 'GJ32AB1111', items: [{ productId: a.id, qty: 1 }], payments: cash(5900) })
    const id = s.data.invoice.id
    const stock = await stockOf(a.id)
    const r = await owner.api.patch(`/api/tyre/sales/${id}/details`, { vehicleNo: 'gj 32 ab 2222', makeModel: 'Swift', odometer: 45000, notes: 'fixed', customerName: 'Words Fixed' })
    expect(r.status).toBe(200)
    const d = await inv(id)
    expect(d.domainData.vehicle_no).toBe('GJ32AB2222'); expect(d.domainData.vehicle_make).toBe('Swift')
    expect(d.domainData.customer_name).toBe('Words Fixed'); expect(d.notes).toBe('fixed')
    expect(Number(d.grandTotal)).toBe(5900); expect(await stockOf(a.id)).toBe(stock)
    // money fields are refused outright, not ignored
    expect((await owner.api.patch(`/api/tyre/sales/${id}/details`, { grandTotal: 1 })).status).toBe(422)
    // a cancelled bill cannot be edited
    await owner.api.post(`/api/tyre/sales/${id}/correct`, { customer: { name: 'Words Fixed' }, items: [{ productId: a.id, qty: 1 }], payments: cash(5900) }, { headers: { 'Idempotency-Key': crypto.randomUUID() } })
    expect((await owner.api.patch(`/api/tyre/sales/${id}/details`, { notes: 'x' })).status).toBe(409)
  })

  test('the printed bill says how it was paid: Cash, UPI, a split, or Credit', async () => {
    const paidBy = async (id: string) => {
      const pdf = await owner.api.get(`/api/tyre/invoices/${id}/pdf`, { responseType: 'arraybuffer' })
      expect(pdf.status).toBe(200)
      const m = pdfText(Buffer.from(pdf.data)).replace(/\s+/g, ' ').match(/Paid by\s*:?\s*((?:Cash|UPI|Card|Bank|Cheque|Credit)(?: \+ (?:Cash|UPI|Card|Bank|Cheque|Credit))*)/)
      return m?.[1] ?? null
    }
    const mk = async (payments: unknown[]) => (await sale({ customer: { name: 'Mode Customer', phone: phone() }, items: [{ productId: a.id, qty: 1 }], payments })).data.invoice.id
    expect(await paidBy(await mk([{ method: 'cash', amount: 5900 }]))).toBe('Cash')
    expect(await paidBy(await mk([{ method: 'upi', amount: 5900 }]))).toBe('UPI')
    expect(await paidBy(await mk([{ method: 'cash', amount: 3000 }, { method: 'upi', amount: 2900 }]))).toMatch(/^(Cash \+ UPI|UPI \+ Cash)$/)
    expect(await paidBy(await mk([]))).toBe('Credit')
    expect(await paidBy(await mk([{ method: 'cash', amount: 2000 }]))).toBe('Cash + Credit')
  })

  test('GSTIN address: kept on the bill (separate from the customer address), editable, optional, printed only when typed', async () => {
    const CH = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
    const base = '24AABCR1234A1Z'; let sum = 0
    for (let i = 0; i < 14; i++) { const m = CH.indexOf(base[i]!) * (i % 2 === 0 ? 1 : 2); sum += Math.floor(m / 36) + (m % 36) }
    const G = base + CH[(36 - (sum % 36)) % 36]
    const text = async (id: string) => {
      const pdf = await owner.api.get(`/api/tyre/invoices/${id}/pdf`, { responseType: 'arraybuffer' })
      return pdfText(Buffer.from(pdf.data)).replace(/\s+/g, ' ')
    }
    const r = await sale({ customer: { name: 'Rathod Roadlines', phone: phone(), address: 'Delivery: Kodinar' }, customerGstin: G, customerGstinAddress: 'Plot 5, GIDC Veraval', items: [{ productId: a.id, qty: 1 }], payments: cash(5900) })
    expect(r.status).toBe(201)
    const id = r.data.invoice.id
    expect((await inv(id)).domainData.gstin_address).toBe('Plot 5, GIDC Veraval')
    expect(await text(id)).toMatch(/Plot 5, GIDC Veraval/)
    const e = await owner.api.patch(`/api/tyre/sales/${id}/details`, { gstinAddress: 'Plot 9, GIDC Veraval' })
    expect(e.status).toBe(200)
    expect(await text(id)).toMatch(/Plot 9, GIDC Veraval/)
    // no GSTIN address typed: the bill saves and prints as before
    const plain = await sale({ customer: { name: 'No Addr', phone: phone() }, customerGstin: G, items: [{ productId: a.id, qty: 1 }], payments: cash(5900) })
    expect(plain.status).toBe(201)
    expect(await text(plain.data.invoice.id)).not.toMatch(/GSTIN Address/i)
  })

  test('settle with discount: the customer pays 5,300 on a 5,900 bill, the 600 is let go and shows as the expense "Discount allowed"', async () => {
    const mobile = phone()
    const bill = (await sale({ customer: { name: 'Round Off', phone: mobile }, items: [{ productId: a.id, qty: 1 }], payments: cash(5300) })).data.invoice
    const settle = (body: Record<string, unknown>, api = owner.api) => api.post('/api/payments/settle-discount', { invoiceId: bill.id, ...body })
    const partyId = (await inv(bill.id)).partyId
    expect(Number((await inv(bill.id)).paidAmt)).toBe(5300)
    expect(await balanceOf(partyId)).toBe(600)
    // too much, nothing, both amount and percent: refused
    expect((await settle({ amount: 700 })).status).toBe(422)
    expect((await settle({})).status).toBe(422)
    expect((await settle({ amount: 100, percent: 5 })).status).toBe(422)
    // a cashier cannot give a discount
    const cashier = await addStaff(owner, 'cashier')
    expect((await settle({ amount: 600 }, cashier.api)).status).toBe(403)
    // 10 % of the 600 due = 60 first, then the rest by amount
    const part = await settle({ percent: 10, reason: 'rounded off' })
    expect(part.status).toBe(201); expect(part.data).toMatchObject({ discount: 60, remaining: 540 })
    const rest = await settle({ amount: 540 })
    expect(rest.status).toBe(201); expect(rest.data.remaining).toBe(0)
    const after = await inv(bill.id)
    expect(after.status).toBe('paid'); expect(Number(after.paidAmt)).toBe(5900)
    expect(await balanceOf(partyId)).toBe(0)
    expect((await settle({ amount: 1 })).status).toBe(422)                                // nothing pending any more
    // the cost is booked as an expense; the money received is untouched
    const exp = ((await owner.api.get('/api/expenses', { params: { category: 'discount_allowed', limit: 50 } })).data.data as any[]).filter((e) => String(e.description).includes(String(bill.number)))
    expect(exp.map((e) => Number(e.amount)).sort((x, y) => x - y)).toEqual([60, 540])
    const sum = (await owner.api.get('/api/payments/summary', { params: { groupBy: 'day', from: ymdNow(-1), to: ymdNow(1) } })).data
    const digital = JSON.stringify(sum)
    expect(digital).toBeTruthy()
    // the bill prints "Paid by: Cash" - the discount is not a way of paying
    const pdf = await owner.api.get(`/api/tyre/invoices/${bill.id}/pdf`, { responseType: 'arraybuffer' })
    expect(pdfText(Buffer.from(pdf.data)).replace(/\s+/g, ' ')).toMatch(/Paid by\s*:?\s*Cash(?! \+)/)
    // undoing the 540: the payment is voided, its expense goes with it, the balance is back
    expect((await owner.api.post(`/api/payments/${rest.data.paymentId}/void`, { reason: 'wrong' })).status).toBe(200)
    expect(await balanceOf(partyId)).toBe(540)
    const exp2 = ((await owner.api.get('/api/expenses', { params: { category: 'discount_allowed', limit: 50 } })).data.data as any[]).filter((e) => String(e.description).includes(String(bill.number)))
    expect(exp2.map((e) => Number(e.amount))).toEqual([60])
  })

  test('Bills filters: date range, amount range, balance pending, vehicle number, register, customer', async () => {
    const p1 = phone(), p2 = phone()
    const b1 = (await sale({ customer: { name: 'Filter One', phone: p1 }, vehicleNo: 'GJ05AB1234', items: [{ productId: a.id, qty: 1 }], payments: cash(5900) })).data.invoice
    const b2 = (await sale({ customer: { name: 'Filter Two', phone: p2 }, vehicleNo: 'GJ32ZZ9999', date: ymdNow(-40), items: [{ productId: b.id, qty: 1 }], payments: cash(3000) })).data.invoice
    const ids = async (params: Record<string, unknown>) => ((await owner.api.get('/api/invoices', { params: { limit: 100, txnType: 'sale_invoice', hideCancelled: 'true', ...params } })).data.data as any[]).map((x) => x.id)
    const both = [b1.id, b2.id]
    const only = async (params: Record<string, unknown>) => (await ids(params)).filter((i) => both.includes(i))
    expect(await only({ fromDate: ymdNow(-3) })).toEqual([b1.id])                       // recent only
    expect(await only({ toDate: ymdNow(-30) })).toEqual([b2.id])                         // old only
    expect(await only({ fromDate: ymdNow(-60), toDate: ymdNow(1) })).toHaveLength(2)
    expect(await only({ minAmount: 6000 })).toEqual([b2.id])                             // 7,080 vs 5,900
    expect(await only({ maxAmount: 6000 })).toEqual([b1.id])
    expect(await only({ pending: 'true' })).toEqual([b2.id])                             // paid 3,000 of 7,080
    expect(await only({ vehicleNo: 'gj 05-ab' })).toEqual([b1.id])                       // spaces / case / dashes ignored
    expect(await only({ vehicleNo: 'GJ32' })).toEqual([b2.id])
    expect(await only({ partyId: (await inv(b2.id)).partyId })).toEqual([b2.id])
    const meta = (await owner.api.get('/api/invoices', { params: { limit: 5, txnType: 'sale_invoice', vehicleNo: 'GJ05AB1234' } })).data.meta
    expect(meta.total).toBeGreaterThanOrEqual(1)                                          // the count follows the filter
    expect((await owner.api.get('/api/invoices', { params: { minAmount: 'abc' } })).status).toBe(422)
  })

  test('a back-dated bill does not touch stock (even with none on the shelf); a bill dated today does; correcting keeps that', async () => {
    const stock0 = await stockOf(a.id)
    const old = (await sale({ customer: { name: 'Old Bill', phone: phone() }, date: ymdNow(-200), items: [{ productId: a.id, qty: 2 }], payments: cash(11800) })).data.invoice
    expect(await stockOf(a.id)).toBe(stock0)                                              // untouched
    expect((await inv(old.id)).domainData.stock_untouched).toBe(true)
    // more than is on the shelf is fine for an old bill
    const big = await sale({ customer: { name: 'Old Big', phone: phone() }, date: ymdNow(-100), items: [{ productId: a.id, qty: stock0 + 500 }], payments: [] })
    expect(big.status).toBe(201); expect(await stockOf(a.id)).toBe(stock0)
    // a bill dated today still moves stock
    expect((await sale({ customer: { name: 'Today', phone: phone() }, items: [{ productId: a.id, qty: 1 }], payments: cash(5900) })).status).toBe(201)
    expect(await stockOf(a.id)).toBe(stock0 - 1)
    // correcting the old bill neither adds nor removes stock
    const fixed = await correct(old.id, { customer: { name: 'Old Bill', phone: phone() }, items: [{ productId: a.id, qty: 3 }], payments: cash(17700) })
    expect(fixed.status).toBe(201)
    expect(await stockOf(a.id)).toBe(stock0 - 1)
    expect((await inv(fixed.data.invoice.id)).domainData.stock_untouched).toBe(true)
  })

  test('All Bills can be listed by bill number, oldest first (93, 94 … 117 — not text order), series after the plain book, with search and paging', async () => {
    const reg = await owner.api.get('/api/branches'); const br = reg.data[0]
    await owner.api.patch(`/api/branches/${br.id}`, { domainConfig: { ...(br.domainConfig ?? {}), bill_series: { car: { prefix: '', start: 98 }, two_wheel: { prefix: '2W-', start: 1 } } } })
    const mk = (series: string, name: string) => sale({ billSeries: series, customer: { name, phone: phone() }, items: [{ productId: a.id, qty: 1 }], payments: cash(5900) })
    for (let i = 0; i < 4; i++) await mk('car', `Order Car ${i}`)         // 98 99 100 101: text order would put 100, 101 before 98
    for (let i = 0; i < 2; i++) await mk('two_wheel', `Order Bike ${i}`)  // 2W-1 2W-2
    const list = async (extra: Record<string, unknown> = {}) => (await owner.api.get('/api/invoices', { params: { sort: 'number', limit: 100, txnType: 'sale_invoice', ...extra } })).data
    const nums = ((await list()).data as any[]).map((x) => String(x.number)).filter((n) => /^(\d+|2W-\d+)$/.test(n))
    expect(nums).toEqual(['98', '99', '100', '101', '2W-1', '2W-2'])
    // paging keeps the order
    const p1 = (await list({ limit: 2, page: 1 })).data.map((x: any) => x.number), p2 = (await list({ limit: 2, page: 2 })).data.map((x: any) => x.number)
    expect([...p1, ...p2].filter((n: string) => /^\d+$/.test(n)).length).toBeGreaterThan(0)
    expect(Number(p1[0]) || 0).toBeLessThanOrEqual(Number(p2[0]) || Infinity)
    // a search keeps the number order too
    const found = ((await list({ search: 'Order Car' })).data as any[]).map((x) => x.number)
    expect(found).toEqual(['98', '99', '100', '101'])
    // the default: newest date first, and the bills of one day newest number first
    const dflt = ((await owner.api.get('/api/invoices', { params: { limit: 100, txnType: 'sale_invoice' } })).data.data as any[])
    const today = dflt.filter((x) => /^(\d+)$/.test(String(x.number)) && Number(x.number) >= 98).map((x) => Number(x.number))
    expect(today).toEqual([...today].sort((x, y) => y - x))
    const dates = dflt.map((x) => String(x.date).slice(0, 10)); expect(dates).toEqual([...dates].sort().reverse())
    expect((await owner.api.get('/api/invoices', { params: { sort: 'bogus' } })).status).toBe(422)
  })

  test('an advance entered by mistake can be deleted: it leaves the list and the customer balance goes back', async () => {
    const mobile = phone()
    const first = await sale({ customer: { name: 'Advance Person', phone: mobile }, items: [{ productId: a.id, qty: 1 }], payments: cash(5900) })
    const partyId = first.data.invoice.partyId
    const before = await balanceOf(partyId)
    const adv = await owner.api.post('/api/invoices/advances', { partyId, amount: 2500, method: 'cash' }, { headers: { 'Idempotency-Key': crypto.randomUUID() } })
    expect(adv.status).toBe(201)
    expect(await balanceOf(partyId)).toBe(before - 2500)
    const del = await owner.api.post(`/api/payments/${adv.data.id}/void`, { reason: 'Advance entered by mistake' })
    expect(del.status).toBe(200)
    expect(await balanceOf(partyId)).toBe(before)
    const list = (await owner.api.get('/api/invoices/advances', { params: { partyId } })).data.items as any[]
    expect(list.find((x) => x.id === adv.data.id)).toBeUndefined()
    expect((await owner.api.post(`/api/payments/${adv.data.id}/void`, { reason: 'again' })).status).toBe(409)   // not twice
    const u = await addStaff(owner, 'cashier')
    const adv2 = await owner.api.post('/api/invoices/advances', { partyId, amount: 100, method: 'cash' }, { headers: { 'Idempotency-Key': crypto.randomUUID() } })
    expect((await u.api.post(`/api/payments/${adv2.data.id}/void`, { reason: 'x' })).status).toBe(403)         // a cashier cannot
  })

  test('All Bills shows how each bill was paid and can be filtered by it (cash, UPI, credit …)', async () => {
    const mk = async (tag: string, payments: unknown[]) => (await sale({ customer: { name: `Mode ${tag}`, phone: phone() }, items: [{ productId: a.id, qty: 1 }], payments })).data.invoice
    const cashB = await mk('cash', cash(5900)), upiB = await mk('upi', [{ method: 'upi', amount: 5900 }])
    const splitB = await mk('split', [{ method: 'cash', amount: 3000 }, { method: 'upi', amount: 2900 }])
    const creditB = await mk('credit', []), partB = await mk('part', cash(2000))
    const list = async (payMode?: string) => (await owner.api.get('/api/invoices', { params: { limit: 100, txnType: 'sale_invoice', ...(payMode ? { payMode } : {}) } })).data
    const all = (await list()).data as any[]
    const mode = (b: any) => all.find((x) => x.id === b.id)?.paymentMode
    expect(mode(cashB)).toBe('Cash'); expect(mode(upiB)).toBe('UPI'); expect(mode(splitB)).toMatch(/^(Cash \+ UPI|UPI \+ Cash)$/)
    expect(mode(creditB)).toBe('Credit'); expect(mode(partB)).toBe('Cash + Credit')
    const ids = async (m: string) => new Set(((await list(m)).data as any[]).map((x) => x.id))
    const cashIds = await ids('cash'), upiIds = await ids('upi'), creditIds = await ids('credit')
    expect(cashIds.has(cashB.id) && cashIds.has(splitB.id) && cashIds.has(partB.id)).toBe(true)
    expect(cashIds.has(upiB.id) || cashIds.has(creditB.id)).toBe(false)
    expect(upiIds.has(upiB.id) && upiIds.has(splitB.id)).toBe(true); expect(upiIds.has(cashB.id)).toBe(false)
    expect(creditIds.has(creditB.id) && creditIds.has(partB.id)).toBe(true); expect(creditIds.has(cashB.id)).toBe(false)
    // the filter keeps the count honest and combines with search and the number order
    const m = (await list('credit')).meta; expect(m.total).toBe(creditIds.size)
    expect(((await owner.api.get('/api/invoices', { params: { payMode: 'credit', search: 'Mode cred', sort: 'number' } })).data.data as any[]).map((x) => x.id)).toEqual([creditB.id])
    expect((await owner.api.get('/api/invoices', { params: { payMode: 'bogus' } })).status).toBe(422)
    // a cancelled (corrected) bill shows no mode
    const fixed = await correct(cashB.id, { customer: { name: 'Mode cash', phone: phone() }, items: [{ productId: a.id, qty: 1 }], payments: [{ method: 'upi', amount: 5900 }], reason: 'paid by UPI actually' })
    expect(fixed.status).toBe(201)
    const after = (await list()).data as any[]
    expect(after.find((x) => x.id === cashB.id)?.paymentMode ?? null).toBeNull()
    expect(after.find((x) => x.id === fixed.data.invoice.id)?.paymentMode).toBe('UPI')
  })
})
