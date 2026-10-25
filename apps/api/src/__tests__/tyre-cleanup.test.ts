// The tyre-only clean-up: features no screen reaches are gone (a clean 404, never a 500), and everything the
// screens do use still answers.

import { newShopTenant, addStaff, type Session } from './helpers'

describe('Tyre-only clean-up', () => {
  let owner: Session, viewer: Session
  const U = '00000000-0000-4000-8000-000000000000'

  beforeAll(async () => { owner = await newShopTenant('Cleanup Tyres'); viewer = await addStaff(owner, 'viewer') })

  test.each([
    ['GET', '/api/contracts'], ['POST', '/api/contracts'], ['GET', `/api/contracts/${U}`],
    ['GET', '/api/staff/users'], ['GET', '/api/staff/attendance'], ['POST', '/api/staff/attendance'], ['GET', '/api/staff/shifts'],
    ['GET', '/api/broadcasts/contacts'],
    ['POST', `/api/invoices/${U}/payment-link`], ['POST', '/api/webhooks/razorpay'], ['GET', `/api/invoices/${U}/pdf`],
    ['POST', '/api/ai/extract-invoice'], ['POST', '/api/ai/scan-bill'], ['GET', '/api/ai/reminders/pending'], ['POST', '/api/ai/reminders/generate'],
    ['POST', '/api/ai/check-invoice'], ['GET', `/api/ai/credit-risk/${U}`], ['POST', '/api/ai/categorize-expense'], ['GET', '/api/ai/cashflow-forecast'],
    ['GET', '/api/ai/party-duplicates'], ['POST', '/api/ai/price-anomaly'], ['GET', '/api/ai/gst-summary'], ['GET', '/api/ai/demand-forecast'], ['POST', '/api/ai/chat'],
  ])('%s %s is gone (404)', async (method, path) => {
    const r = await owner.api.request({ method, url: path, data: method === 'POST' ? {} : undefined })
    expect([method + ' ' + path, r.status]).toEqual([method + ' ' + path, 404])
  })

  test('what the screens use is still there', async () => {
    for (const path of ['/api/ai/insight', '/api/ai/reorder', '/api/broadcasts/celebrations', '/api/invoices', '/api/parties', '/api/payments', '/api/tyre/dashboard', '/api/tyre/team/staff'])
      expect([path, (await owner.api.get(path)).status]).toEqual([path, 200])
    // the supplier-bill scan is still routed: it validates its input (and needs an AI key to go further)
    expect((await owner.api.post('/api/ai/extract-supplier-bill', {})).status).toBe(422)
  })

  test('a viewer is still read-only, and a bill saves without any background PDF job', async () => {
    expect((await viewer.api.post('/api/ai/extract-supplier-bill', {})).status).toBe(403)
    const prod = (await owner.api.post('/api/products', { itemType: 'product', name: 'Cleanup Tyre', gstRate: 18, unit: 'pcs', trackStock: false, salePrice: 1000, sellingPrice: 1000 })).data
    const sale = await owner.api.post('/api/tyre/sales', { customer: { name: 'Cleanup Customer', phone: '9825099001' }, items: [{ productId: prod.id, qty: 1 }], payments: [{ method: 'cash', amount: 1180 }] },
      { headers: { 'Idempotency-Key': crypto.randomUUID() } })
    expect(sale.status).toBe(201)
    const pdf = await owner.api.get(`/api/tyre/invoices/${sale.data.invoice.id}/pdf`, { responseType: 'arraybuffer' })
    expect(pdf.status).toBe(200)
    expect(Buffer.from(pdf.data).subarray(0, 4).toString()).toBe('%PDF')
  })
})
