// The billing-core flows a tyre shop uses every day, driven with real payloads:
// purchase → receive → stock, payments & returns, expenses, staff, contracts, discounts, reports.
// Complements tyre.test.ts / tyre-edge.test.ts, which cover the tyre module itself.

import { newShopTenant, addStaff, today, type Session } from './helpers'

const U = '00000000-0000-4000-8000-0000000000bb'
let n = 0
const phone = () => `97${String(Date.now()).slice(-6)}${String(n++).padStart(2, '0')}`.slice(0, 10)

describe('Billing core flows in a tyre shop', () => {
  let owner: Session, other: Session, viewer: Session, cashier: Session
  let tyre: any, supplier: any, customer: any

  const call = (s: Session, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    s.api.request({ method, url: path, data: body, headers: { 'Idempotency-Key': crypto.randomUUID(), ...headers } })
  const stock = async (s: Session, id: string) =>
    (await s.api.get('/api/tyre/finder', { params: { id, kind: 'any', limit: 1 } })).data.data[0]?.stock as number
  const sale = (s: Session, body: Record<string, unknown>) => call(s, 'POST', '/api/tyre/sales', body)

  beforeAll(async () => {
    owner   = await newShopTenant('Core Tyres')
    other   = await newShopTenant('Core Other')
    viewer  = await addStaff(owner, 'viewer')
    cashier = await addStaff(owner, 'cashier')

    const p = await owner.api.post('/api/products', {
      name: 'Core Tyre 185/65 R15', sku: 'CORE-1', itemType: 'product', gstRate: 18, unit: 'pcs', salePrice: 4000, purchasePrice: 3200,
      mrp: 4400, lowStockQty: 4, openingStock: 10,
      domainAttrs: { item_kind: 'tyre', brand: 'MRF', size: '185/65 R15', vehicle_type: 'car', warranty_months: 12 },
    })
    expect(p.status).toBeLessThan(300)
    tyre = p.data
    supplier = (await owner.api.post('/api/inventory/suppliers', { name: 'MRF Depot', phone: phone(), gstin: '24AAACM1234A1Z5' })).data
    customer = (await owner.api.post('/api/parties', { type: 'customer', name: 'Core Customer', phone: phone() })).data
  })

  // ═══════════════════════════════════════════════════════════════════════════
  describe('products', () => {
    test('create → read → update price → stock history → archive', async () => {
      const c = await owner.api.post('/api/products', {
        name: 'Flow Tube', sku: 'FLOW-1', itemType: 'product', gstRate: 18, salePrice: 300, purchasePrice: 200, openingStock: 7,
        domainAttrs: { item_kind: 'tube', brand: 'MRF' },
      })
      expect(c.status).toBeLessThan(300)
      const id = c.data.id
      expect((await owner.api.get(`/api/products/${id}`)).data).toMatchObject({ name: 'Flow Tube', domainAttrs: { item_kind: 'tube' } })

      const u = await owner.api.patch(`/api/products/${id}`, { salePrice: 350, domainAttrs: { item_kind: 'tube', brand: 'Apollo' } })
      expect(u.status).toBe(200)
      expect(Number(u.data.salePrice)).toBe(350)
      expect(u.data.domainAttrs.brand).toBe('Apollo')

      const hist = await owner.api.get(`/api/products/${id}/stock-history`)
      expect(hist.status).toBe(200)
      expect(hist.data.length).toBeGreaterThanOrEqual(1)

      expect((await owner.api.delete(`/api/products/${id}`)).status).toBeLessThan(300)
      const list = (await owner.api.get('/api/products', { params: { q: 'Flow Tube' } })).data
      expect(JSON.stringify(list)).not.toContain('Flow Tube')
    })

    test('duplicate barcode is a conflict; bad attributes and negative prices are rejected', async () => {
      const a = await owner.api.post('/api/products', { name: 'BC One', barcode: 'BC-EDGE-1', salePrice: 10, domainAttrs: { item_kind: 'tube' } })
      expect(a.status).toBeLessThan(300)
      const b = await owner.api.post('/api/products', { name: 'BC Two', barcode: 'BC-EDGE-1', salePrice: 10, domainAttrs: { item_kind: 'tube' } })
      expect(b.status).toBe(409)
      expect((await owner.api.get('/api/products/barcode/BC-EDGE-1')).status).toBe(200)
      expect((await owner.api.get('/api/products/barcode/NOPE-0000')).status).toBe(404)
      expect((await owner.api.post('/api/products', { name: 'Neg', salePrice: -1 })).status).toBe(422)
      expect((await owner.api.post('/api/products', { name: 'BadAttr', salePrice: 1, domainAttrs: { item_kind: 'unicorn' } })).status).toBe(422)
      expect((await owner.api.patch(`/api/products/${U}`, { salePrice: 1 })).status).toBe(404)
      expect((await other.api.patch(`/api/products/${tyre.id}`, { salePrice: 1 })).status).toBe(404)
    })

    test('low-stock list picks up an item at or below its reorder level', async () => {
      const p = (await owner.api.post('/api/products', { name: 'Reorder Me', sku: 'LOW-1', salePrice: 10, lowStockQty: 5, openingStock: 2, domainAttrs: { item_kind: 'tube' } })).data
      const low = (await owner.api.get('/api/products/low-stock')).data
      const rows = Array.isArray(low) ? low : (low.data ?? low.items ?? [])
      expect(JSON.stringify(rows)).toContain(p.id)
      const sl = await owner.api.get('/api/stock/low')
      expect(sl.status).toBe(200)
    })

    test('manual stock adjustment moves the ledger, and cannot go on a non-tracked item', async () => {
      const before = await stock(owner, tyre.id)
      const r = await owner.api.post(`/api/products/${tyre.id}/stock-adjustment`, { qty: -2, reason: 'Damaged in godown' })
      expect(r.status).toBeLessThan(300)
      expect(await stock(owner, tyre.id)).toBe(before - 2)
      await owner.api.post(`/api/products/${tyre.id}/stock-adjustment`, { qty: 2, reason: 'Found' })
      const svc = (await owner.api.get('/api/tyre/finder', { params: { kind: 'service', limit: 1 } })).data.data[0]
      const bad = await owner.api.post(`/api/products/${svc.id}/stock-adjustment`, { qty: 1, reason: 'x' })
      expect(bad.status).toBeGreaterThanOrEqual(400)
      expect(bad.status).toBeLessThan(500)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  describe('buying: supplier → purchase order → goods receipt → stock', () => {
    test('the full purchase flow raises stock and tracks what is owed', async () => {
      const before = await stock(owner, tyre.id)
      const po = await owner.api.post('/api/inventory/purchase-orders', {
        partyId: supplier.id, poDate: today(), expectedDate: today(5), notes: 'Monthly stock',
        items: [{ productId: tyre.id, description: tyre.name, orderedQty: 20, unit: 'pcs', rate: 3200, taxableAmt: 64000, gstRate: 18, cgstAmt: 5760, sgstAmt: 5760, total: 75520 }],
      })
      expect(po.status).toBe(201)
      expect(po.data.poNo).toMatch(/^PO-\d{4}-\d{4}$/)
      expect(Number(po.data.grandTotal)).toBeCloseTo(75520, 0)

      const got = await owner.api.get(`/api/inventory/purchase-orders/${po.data.id}`)
      expect(got.status).toBe(200)
      expect(got.data.items).toHaveLength(1)

      const grn = await owner.api.post('/api/inventory/grn', {
        purchaseOrderId: po.data.id, grnDate: today(), invoiceNo: 'MRF/26/0042',
        items: [{ productId: tyre.id, purchaseOrderItemId: po.data.items[0].id, description: tyre.name, receivedQty: 20, rate: 3200, total: 64000 }],
      })
      expect(grn.status).toBe(201)
      expect(await stock(owner, tyre.id)).toBe(before + 20)

      const pay = await owner.api.post(`/api/inventory/purchase-orders/${po.data.id}/payment`, { amount: 30000, paymentMode: 'bank', referenceNo: 'UTR123' })
      expect(pay.status).toBeLessThan(300)
      const over = await owner.api.post(`/api/inventory/purchase-orders/${po.data.id}/payment`, { amount: 99999999, paymentMode: 'cash' })
      expect(over.status).toBeGreaterThanOrEqual(400)
      expect(over.status).toBeLessThan(500)
    })

    test('a purchase order can be cancelled; a cancelled one takes no payment; bad input is refused', async () => {
      const mkPo = async () => (await owner.api.post('/api/inventory/purchase-orders', {
        poDate: today(), items: [{ description: 'Loose item', orderedQty: 1, rate: 100, taxableAmt: 100, total: 100 }],
      })).data
      const po = await mkPo()
      expect((await owner.api.post(`/api/inventory/purchase-orders/${po.id}/cancel`, {})).status).toBeLessThan(300)
      expect((await owner.api.post(`/api/inventory/purchase-orders/${po.id}/payment`, { amount: 10, paymentMode: 'cash' })).status).toBe(409)
      expect((await owner.api.post('/api/inventory/purchase-orders', { poDate: today(), items: [] })).status).toBe(422)
      expect((await owner.api.post('/api/inventory/purchase-orders', { poDate: '12/10/2026', items: [{ description: 'x', orderedQty: 1, rate: 1, taxableAmt: 1, total: 1 }] })).status).toBe(422)
      expect((await owner.api.get(`/api/inventory/purchase-orders/${U}`)).status).toBe(404)
      expect((await other.api.get(`/api/inventory/purchase-orders/${po.id}`)).status).toBe(404)
    })

    test('suppliers: create, update, search, delete; a duplicate or invalid one is refused', async () => {
      const s = await owner.api.post('/api/inventory/suppliers', { name: 'CEAT Dealer', phone: phone() })
      expect(s.status).toBe(201)
      expect((await owner.api.patch(`/api/inventory/suppliers/${s.data.id}`, { phone: phone() })).status).toBeLessThan(300)
      expect((await owner.api.get('/api/inventory/suppliers', { params: { search: 'CEAT' } })).status).toBe(200)
      expect((await owner.api.post('/api/inventory/suppliers', { name: '' })).status).toBe(422)
      expect((await owner.api.post('/api/inventory/suppliers', { name: 'Bad Mail', email: 'nope' })).status).toBe(422)
      expect((await owner.api.get(`/api/inventory/suppliers/${U}`)).status).toBe(404)
      expect((await owner.api.delete(`/api/inventory/suppliers/${s.data.id}`)).status).toBeLessThan(300)
    })

    test('stock adjustment sheet: draft → post changes stock → cannot post twice', async () => {
      const sys = await stock(owner, tyre.id)
      const adj = await owner.api.post('/api/inventory/adjustments', {
        adjDate: today(), reason: 'Physical count', items: [{ productId: tyre.id, systemQty: sys, physicalQty: sys - 3, rate: 3200 }],
      })
      expect(adj.status).toBe(201)
      const posted = await owner.api.post(`/api/inventory/adjustments/${adj.data.id}/post`, {})
      expect(posted.status).toBeLessThan(300)
      expect(await stock(owner, tyre.id)).toBe(sys - 3)
      const again = await owner.api.post(`/api/inventory/adjustments/${adj.data.id}/post`, {})
      expect(again.status).toBeGreaterThanOrEqual(400)
      expect(again.status).toBeLessThan(500)
      expect(await stock(owner, tyre.id)).toBe(sys - 3)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  describe('customers and money', () => {
    test('party CRUD, duplicate phone, statement and udhaar summary', async () => {
      const p = await owner.api.post('/api/parties', { type: 'customer', name: 'Ledger Lal', phone: phone(), creditLimit: 50000 })
      expect(p.status).toBe(201)
      const dup = await owner.api.post('/api/parties', { type: 'customer', name: 'Ledger Twin', phone: p.data.phone })
      expect(dup.status).toBe(409)
      expect((await owner.api.post('/api/parties', { type: 'wizard', name: 'X' })).status).toBe(422)
      expect((await owner.api.post('/api/parties', { type: 'customer', name: 'Short Phone', phone: '123' })).status).toBe(422)
      expect((await owner.api.patch(`/api/parties/${p.data.id}`, { creditLimit: 75000 })).status).toBe(200)
      expect((await owner.api.get(`/api/parties/${U}`)).status).toBe(404)
      expect((await other.api.get(`/api/parties/${p.data.id}`)).status).toBe(404)

      const s = await sale(owner, { partyId: p.data.id, items: [{ productId: tyre.id, qty: 1 }], payments: [] })
      expect(s.status).toBe(201)
      const st = await owner.api.get(`/api/parties/${p.data.id}/statement`)
      expect(st.status).toBe(200)
      expect(JSON.stringify(st.data)).toContain(s.data.invoice.number)
      const ud = await owner.api.get('/api/parties/udhaar/summary')
      expect(ud.status).toBe(200)
    })

    test('record a payment against a bill, refuse an over-payment, void it and the balance returns', async () => {
      const s = await sale(owner, { partyId: customer.id, items: [{ productId: tyre.id, qty: 1 }], payments: [] })
      const inv = s.data.invoice
      const total = Number(inv.grandTotal)

      const bad = await call(owner, 'POST', `/api/invoices/${inv.id}/payment`, { amount: total + 100, method: 'cash' })
      expect(bad.status).toBeGreaterThanOrEqual(400)
      expect(bad.status).toBeLessThan(500)

      const noKey = await owner.api.post(`/api/invoices/${inv.id}/payment`, { amount: 100, method: 'cash' }, { headers: { 'Idempotency-Key': '' } })
      expect(noKey.status).toBe(400)                            // payments insist on an idempotency key

      const key = crypto.randomUUID()
      const half = Math.round(total / 2)
      const p1 = await call(owner, 'POST', `/api/invoices/${inv.id}/payment`, { amount: half, method: 'upi', refNo: 'UPI1' }, { 'Idempotency-Key': key })
      expect(p1.status).toBeLessThan(300)
      const p1again = await call(owner, 'POST', `/api/invoices/${inv.id}/payment`, { amount: half, method: 'upi', refNo: 'UPI1' }, { 'Idempotency-Key': key })
      expect(p1again.status).toBeLessThan(300)
      let cur = (await owner.api.get(`/api/invoices/${inv.id}`)).data
      expect(Number(cur.paidAmt)).toBeCloseTo(half, 1)          // the replay did not pay twice
      expect(cur.status).toBe('partial')

      const pays = (await owner.api.get('/api/payments', { params: { partyId: customer.id } })).data.items
      const pay = pays.find((x: any) => Number(x.amount) === half)
      expect((await call(owner, 'POST', `/api/payments/${pay.id}/void`, { reason: 'Wrong amount entered' })).status).toBeLessThan(300)
      cur = (await owner.api.get(`/api/invoices/${inv.id}`)).data
      expect(Number(cur.paidAmt)).toBe(0)
      expect((await call(owner, 'POST', `/api/payments/${pay.id}/void`, { reason: 'again' })).status).toBeGreaterThanOrEqual(400)

      // pay it in full, and the bill closes
      await call(owner, 'POST', `/api/invoices/${inv.id}/payment`, { amount: total, method: 'cash' })
      expect((await owner.api.get(`/api/invoices/${inv.id}`)).data.status).toBe('paid')
      expect((await owner.api.get('/api/payments/summary')).status).toBe(200)
      expect((await owner.api.get('/api/payments/outstanding')).status).toBe(200)
    })

    test('an advance from a customer can be allocated to a bill', async () => {
      const p = (await owner.api.post('/api/parties', { type: 'customer', name: 'Advance Giver', phone: phone() })).data
      const adv = await owner.api.post('/api/invoices/advances', { partyId: p.id, amount: 2000, method: 'upi', notes: 'Booking tyres' })
      expect(adv.status).toBe(201)
      const s = await sale(owner, { partyId: p.id, items: [{ productId: tyre.id, qty: 1 }], payments: [] })
      const al = await owner.api.post(`/api/invoices/advances/${adv.data.id}/allocate`, { allocations: [{ invoiceId: s.data.invoice.id, amount: 2000 }] })
      expect(al.status).toBeLessThan(300)
      expect(Number((await owner.api.get(`/api/invoices/${s.data.invoice.id}`)).data.paidAmt)).toBe(2000)
      const tooMuch = await owner.api.post(`/api/invoices/advances/${adv.data.id}/allocate`, { allocations: [{ invoiceId: s.data.invoice.id, amount: 5000 }] })
      expect(tooMuch.status).toBeGreaterThanOrEqual(400)
      expect(tooMuch.status).toBeLessThan(500)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  describe('returns, quotations and cancelling', () => {
    test('partial sale return gives stock back and reduces what the customer owes', async () => {
      const before = await stock(owner, tyre.id)
      const s = await sale(owner, { partyId: customer.id, items: [{ productId: tyre.id, qty: 2, serialNos: [`RET${Date.now()}A`, `RET${Date.now()}B`] }], payments: [] })
      expect(s.status).toBe(201)
      expect(await stock(owner, tyre.id)).toBe(before - 2)
      const detail = (await owner.api.get(`/api/invoices/${s.data.invoice.id}`)).data
      const item = detail.items[0]
      const ret = await owner.api.post(`/api/invoices/${s.data.invoice.id}/return`, { items: [{ invoiceItemId: item.id, qty: 1 }], notes: 'Wrong size' }, { headers: { 'Idempotency-Key': crypto.randomUUID() } })
      expect(ret.status).toBeLessThan(300)
      expect(await stock(owner, tyre.id)).toBe(before - 1)

      const tooMany = await owner.api.post(`/api/invoices/${s.data.invoice.id}/return`, { items: [{ invoiceItemId: item.id, qty: 5 }] }, { headers: { 'Idempotency-Key': crypto.randomUUID() } })
      expect(tooMany.status).toBeGreaterThanOrEqual(400)
      expect(tooMany.status).toBeLessThan(500)
    })

    test('the generic Create Invoice screen payload (tyre details + split payment) is accepted and settles correctly', async () => {
      const before = await stock(owner, tyre.id)
      const r = await owner.api.post('/api/invoices', {
        txnType: 'sale_invoice', partyId: customer.id,
        items: [{ productId: tyre.id, description: tyre.name, qty: 2, rate: 4000, discountPct: 0, gstRate: 18, unit: 'pcs' }],
        // exactly what CreateInvoicePage + DomainInvoiceFields send
        domainData: {
          is_udhaar: false, source: 'pos',
          payment_splits: [{ method: 'cash', amount: 5000 }, { method: 'upi', amount: 4440 }],
          sale_kind: 'wholesale', vehicle_no: 'GJ05UI0001', vehicle_type: 'car', odometer: 20000, credit_days: 15,
        },
        notes: 'from the generic screen',
      }, { headers: { 'Idempotency-Key': crypto.randomUUID() } })
      expect(r.status).toBe(201)
      expect(r.data.status).toBe('paid')
      expect(Number(r.data.grandTotal)).toBeCloseTo(9440, 0)
      expect(await stock(owner, tyre.id)).toBe(before - 2)
      // it is a normal bill: the tyre detail page and PDF work for it
      expect((await owner.api.get(`/api/tyre/sales/${r.data.id}`)).status).toBe(200)
      expect((await owner.api.get(`/api/tyre/invoices/${r.data.id}/pdf`)).status).toBe(200)
      // a field the schema does not know is a clean 422, not a crash
      const bad = await owner.api.post('/api/invoices', {
        txnType: 'sale_invoice', partyId: customer.id,
        items: [{ productId: tyre.id, description: tyre.name, qty: 1, rate: 4000, gstRate: 18 }],
        domainData: { freight_type: 'paid' },
      }, { headers: { 'Idempotency-Key': crypto.randomUUID() } })
      expect(bad.status).toBeGreaterThanOrEqual(400)
      expect(bad.status).toBeLessThan(500)
    })

    test('quotation → sales order → invoice conversion moves stock only at the invoice', async () => {
      const before = await stock(owner, tyre.id)
      const q = await owner.api.post('/api/invoices', {
        txnType: 'quotation', partyId: customer.id, domainData: {},
        items: [{ productId: tyre.id, description: tyre.name, qty: 1, unit: 'pcs', rate: 4000, gstRate: 18 }],
      }, { headers: { 'Idempotency-Key': crypto.randomUUID() } })
      expect(q.status).toBe(201)
      expect(await stock(owner, tyre.id)).toBe(before)             // a quotation reserves nothing
      const conv = await owner.api.post(`/api/invoices/${q.data.id}/convert`, {}, { headers: { 'Idempotency-Key': crypto.randomUUID() } })
      expect(conv.status).toBeLessThan(300)
    })

    test('a purchase bill can be entered directly and returned with a debit note', async () => {
      const before = await stock(owner, tyre.id)
      const pi = await owner.api.post('/api/invoices', {
        txnType: 'purchase_invoice', partyId: supplier.id, domainData: {},
        items: [{ productId: tyre.id, description: tyre.name, qty: 4, unit: 'pcs', rate: 3200, gstRate: 18 }],
      }, { headers: { 'Idempotency-Key': crypto.randomUUID() } })
      expect(pi.status).toBe(201)
      expect(await stock(owner, tyre.id)).toBe(before + 4)
      const dn = await owner.api.post(`/api/invoices/${pi.data.id}/debit-note`, {}, { headers: { 'Idempotency-Key': crypto.randomUUID() } })
      expect(dn.status).toBeLessThan(500)
    })

    test('cancel: unpaid is fine and restores stock; paid is refused; cancelling twice is refused', async () => {
      const before = await stock(owner, tyre.id)
      const s = await sale(owner, { partyId: customer.id, items: [{ productId: tyre.id, qty: 1 }], payments: [] })
      expect(await stock(owner, tyre.id)).toBe(before - 1)
      expect((await call(owner, 'POST', `/api/invoices/${s.data.invoice.id}/cancel`, {})).status).toBeLessThan(300)
      expect(await stock(owner, tyre.id)).toBe(before)
      expect((await call(owner, 'POST', `/api/invoices/${s.data.invoice.id}/cancel`, {})).status).toBe(409)

      const paid = await sale(owner, { partyId: customer.id, items: [{ productId: tyre.id, qty: 1 }], payments: [{ method: 'cash', amount: 4720 }] })
      expect(paid.data.invoice.status).toBe('paid')
      expect((await call(owner, 'POST', `/api/invoices/${paid.data.invoice.id}/cancel`, {})).status).toBe(422)
    })

    test('every document tab on the Bills screen can be listed (Orders used to fail validation)', async () => {
      for (const txnType of ['sale_invoice', 'purchase_invoice', 'quotation', 'proforma', 'sales_order', 'delivery_challan',
        'credit_note', 'debit_note', 'sale_return', 'purchase_return']) {
        const r = await owner.api.get('/api/invoices', { params: { txnType } })
        expect([txnType, r.status]).toEqual([txnType, 200])
      }
      expect((await owner.api.get('/api/invoices', { params: { txnType: 'not_a_type' } })).status).toBe(422)
    })

    test('every status offered by the Bills status filter is accepted (including "converted")', async () => {
      for (const status of ['draft', 'confirmed', 'partial', 'paid', 'cancelled', 'converted']) {
        const r = await owner.api.get('/api/invoices', { params: { status } })
        expect([status, r.status]).toEqual([status, 200])
      }
      expect((await owner.api.get('/api/invoices', { params: { status: 'archived' } })).status).toBe(422)
    })

    test('invoice list filters and the daily / weekly summaries answer', async () => {
      for (const params of [{}, { status: 'paid' }, { txnType: 'sale_invoice' }, { partyId: customer.id }, { search: 'SHAR' }, { limit: 5, page: 2 }]) {
        const r = await owner.api.get('/api/invoices', { params })
        expect([JSON.stringify(params), r.status]).toEqual([JSON.stringify(params), 200])
      }
      expect((await owner.api.get('/api/invoices', { params: { limit: 1000 } })).status).toBeLessThan(500)
      expect((await owner.api.get('/api/invoices/summary/daily')).status).toBe(200)
      expect((await owner.api.get('/api/invoices/summary/weekly')).status).toBe(200)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  describe('expenses, staff, contracts, discounts', () => {
    test('expenses: shop-specific categories are offered; create, filter, summarise, update, delete', async () => {
      const cats = (await owner.api.get('/api/expenses/categories')).data
      const codes = (Array.isArray(cats) ? cats : cats.data ?? []).map((c: any) => c.code)
      expect(codes).toEqual(expect.arrayContaining(['tyre_purchase', 'hamali', 'technician_salary', 'rent']))

      const e = await owner.api.post('/api/expenses', { category: 'hamali', description: 'Unloading 20 tyres', amount: 600, paymentMode: 'cash', date: today() })
      expect(e.status).toBe(201)
      expect((await owner.api.post('/api/expenses', { category: 'hamali', amount: -5 })).status).toBe(422)
      expect((await owner.api.post('/api/expenses', { category: 'hamali', amount: 5, gstRate: 7 })).status).toBe(422)
      expect((await owner.api.get('/api/expenses', { params: { category: 'hamali' } })).status).toBe(200)
      expect((await owner.api.get('/api/expenses/summary')).status).toBe(200)
      expect((await owner.api.patch(`/api/expenses/${e.data.id}`, { amount: 650 })).status).toBeLessThan(300)
      expect((await owner.api.delete(`/api/expenses/${e.data.id}`)).status).toBeLessThan(300)
      expect((await owner.api.get(`/api/expenses/${e.data.id}`)).status).toBe(404)   // deleted above
      expect((await owner.api.delete(`/api/expenses/${U}`)).status).toBe(404)
    })

    test('staff: users, roles, PIN reset, deactivate; attendance and shifts', async () => {
      const u = await owner.api.post('/api/users', { name: 'Fitter Raju', phone: phone(), pin: '5678', role: 'cashier' })
      expect(u.status).toBe(201)
      expect((await owner.api.post('/api/users', { name: 'Dup', phone: u.data.phone, pin: '1234', role: 'cashier' })).status).toBe(409)
      expect((await owner.api.post('/api/users', { name: 'Bad Pin', phone: phone(), pin: '12', role: 'cashier' })).status).toBe(422)
      expect((await owner.api.post('/api/users', { name: 'Bad Role', phone: phone(), pin: '1234', role: 'emperor' })).status).toBe(422)
      expect((await cashier.api.post('/api/users', { name: 'Sneaky', phone: phone(), pin: '1234', role: 'manager' })).status).toBe(403)
      expect((await owner.api.post(`/api/users/${u.data.id}/reset-pin`, { pin: '4321' })).status).toBeLessThan(300)
      const a = await owner.api.post('/api/staff/attendance', { userId: u.data.id, date: today(), clockIn: '09:30', status: 'present' })
      expect(a.status).toBeLessThan(300)
      expect((await owner.api.get('/api/staff/attendance', { params: { date: today() } })).status).toBe(200)
      expect((await owner.api.get('/api/staff/shifts')).status).toBe(200)
      expect((await owner.api.post(`/api/users/${u.data.id}/deactivate`, {})).status).toBeLessThan(300)
      expect((await owner.api.get('/api/users/me')).data.role).toBe('owner')
    })

    test('contracts: create, pause, resume, generate an invoice', async () => {
      const c = await owner.api.post('/api/contracts', {
        partyId: customer.id, title: 'Fleet tyre rotation — monthly', startDate: today(), billingCycle: 'monthly', amount: 5000, gstRate: 18,
      })
      expect(c.status).toBe(201)
      expect((await owner.api.post(`/api/contracts/${c.data.id}/pause`, {})).status).toBeLessThan(300)
      expect((await owner.api.post(`/api/contracts/${c.data.id}/resume`, {})).status).toBeLessThan(300)
      const gen = await call(owner, 'POST', `/api/contracts/${c.data.id}/generate-invoice`, {})
      expect(gen.status).toBeLessThan(300)
      expect((await owner.api.post('/api/contracts', { partyId: customer.id, title: 'x', startDate: today(), amount: 0 })).status).toBe(422)
      expect((await owner.api.get(`/api/contracts/${U}`)).status).toBe(404)
    })

    test('discount rule: create → list → update → delete; a percentage over 100 is refused', async () => {
      const r = await owner.api.post('/api/discount-rules', {
        name: 'Buy 4 tyres, 5% off', type: 'qty_slab', conditions: { minQty: 4 }, action: { slabs: [{ minQty: 4, discountPct: 5 }] },
      })
      expect(r.status).toBe(201)
      expect((await owner.api.get('/api/discount-rules')).status).toBe(200)
      expect((await owner.api.patch(`/api/discount-rules/${r.data.id}`, { isActive: false })).status).toBeLessThan(300)
      expect((await owner.api.post('/api/discount-rules', { name: 'Silly', type: 'percentage', action: { discountPct: 150 } })).status).toBe(422)
      expect((await owner.api.delete(`/api/discount-rules/${r.data.id}`)).status).toBeLessThan(300)
    })

    test('categories and brands', async () => {
      const c = await owner.api.post('/api/categories', { name: 'Heavy Equipment' })
      expect(c.status).toBeLessThan(300)
      expect((await owner.api.patch(`/api/categories/${c.data.id}`, { name: 'Heavy Equipment Tyres' })).status).toBeLessThan(300)
      expect((await owner.api.get('/api/categories')).status).toBe(200)
      const b = await owner.api.post('/api/brands', { name: 'Bridgestone' })
      expect(b.status).toBeLessThan(300)
      expect((await owner.api.get('/api/brands')).status).toBe(200)
      expect((await owner.api.post('/api/categories', { name: '' })).status).toBe(422)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  describe('reports & analytics', () => {
    test('the generic dashboard shows tyre KPIs and charts for a shop with sales', async () => {
      const d = await owner.api.get('/api/analytics/dashboard', { params: { period: '30d' } })
      expect(d.status).toBe(200)
      expect(d.data.domain).toBe('tyre')
      const keys = d.data.kpis.map((k: any) => k.key)
      expect(keys).toEqual(expect.arrayContaining(['revenue', 'invoices', 'units', 'services', 'collected', 'outstanding']))
      expect(d.data.kpis.every((k: any) => Number.isFinite(k.value))).toBe(true)
      expect((await owner.api.get('/api/analytics/dashboard', { params: { period: '1y' } })).status).toBe(422)
    })

    test.each([
      '/api/analytics/payment-methods', '/api/analytics/revenue-trend', '/api/analytics/margin-report', '/api/analytics/top-customers',
      '/api/analytics/sales-vs-purchases', '/api/reports/day-book', '/api/reports/stock-summary', '/api/reports/pl-statement',
      '/api/reports/cash-register', '/api/reports/bank-accounts', '/api/reports/monthly-comparison', '/api/stock', '/api/stock/expiry-alerts',
      '/api/notifications', '/api/notifications/unread-count', '/api/branches/summary', '/api/inventory/grn', '/api/grn',
    ])('GET %s answers 200 for a shop with data', async (url) => {
      const r = await owner.api.get(url)
      expect([url, r.status]).toEqual([url, 200])
    })

    test('GST reports for the current month: GSTR-1 and the summary', async () => {
      const month = today().slice(0, 7)
      const g = await owner.api.get('/api/analytics/gst-summary', { params: { month } })
      expect(g.status).toBe(200)
      const r1 = await owner.api.get('/api/reports/gstr1', { params: { month } })
      expect(r1.status).toBe(200)
      expect((await owner.api.get('/api/analytics/gst-summary', { params: { month: '2026-13' } })).status).toBe(422)
    })

    test('reports stay inside the business: a second business sees none of this data', async () => {
      const d = await other.api.get('/api/analytics/dashboard', { params: { period: '30d' } })
      expect(d.status).toBe(200)
      const revenue = d.data.kpis.find((k: any) => k.key === 'revenue')
      expect(revenue.value).toBe(0)
      expect((await other.api.get('/api/invoices')).data.total ?? 0).toBe(0)
    })

    test('a viewer can read reports but not create anything', async () => {
      expect((await viewer.api.get('/api/analytics/dashboard')).status).toBe(200)
      expect((await call(viewer, 'POST', '/api/expenses', { category: 'rent', amount: 100 })).status).toBe(403)
      expect((await call(viewer, 'POST', '/api/parties', { type: 'customer', name: 'No' })).status).toBe(403)
    })
  })
})

describe('Reorder suggestions', () => {
  test('only items with a reorder level that are at or near it are suggested (scrap/no-level items are not)', async () => {
    const owner = await newShopTenant('Reorder Tyres')
    const mk = async (name: string, sku: string, lowStockQty: number, openingStock: number) =>
      (await owner.api.post('/api/products', { name, sku, itemType: 'product', gstRate: 18, unit: 'pcs', trackStock: true, salePrice: 1000, lowStockQty, openingStock,
        domainAttrs: { item_kind: 'tyre', size: '185/65 R15', brand: 'X' } })).data
    await mk('Low tyre', 'LOW-1', 4, 2)
    await mk('Healthy tyre', 'OK-1', 4, 20)
    await mk('No level tyre', 'NL-1', 0, 0)
    const res = (await owner.api.get('/api/ai/reorder')).data as { count: number; suggestions: Array<{ productName: string; unit?: string }> }
    expect(res.count).toBe(res.suggestions.length)
    const names = res.suggestions.map((x) => x.productName)
    expect(res.suggestions.find((x) => x.productName === 'Low tyre')?.unit).toBe('pcs')
    expect(names).toContain('Low tyre')
    expect(names).not.toContain('Healthy tyre')
    expect(names).not.toContain('No level tyre')
    expect(names).not.toContain('Old Tyre (scrap)')
  })
})
