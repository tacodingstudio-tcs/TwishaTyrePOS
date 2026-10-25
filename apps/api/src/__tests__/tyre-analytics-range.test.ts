// Dashboard / analytics periods: 7D, 30D, 90D, this month, this financial year, and a custom from–to.

import { newShopTenant, today as ymdToday, type Session } from './helpers'

describe('Analytics period selection', () => {
  let owner: Session
  const dash = (params: Record<string, string>) => owner.api.get('/api/analytics/dashboard', { params })
  const today = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10)       // IST

  beforeAll(async () => { owner = await newShopTenant('Range Tyres') })

  test('month starts on the 1st; year starts on 1 April; both end today', async () => {
    const t = today()
    const m = (await dash({ period: 'month' })).data
    expect(m).toMatchObject({ period: 'month', from: `${t.slice(0, 7)}-01`, to: t })
    const y = (await dash({ period: 'year' })).data
    const fy = Number(t.slice(5, 7)) >= 4 ? Number(t.slice(0, 4)) : Number(t.slice(0, 4)) - 1
    expect(y).toMatchObject({ period: 'year', from: `${fy}-04-01`, to: t })
  })

  test('a custom range is used as given (the end is held at today)', async () => {
    const r = (await dash({ period: 'custom', from: '2026-04-01', to: '2026-04-30' })).data
    expect(r).toMatchObject({ period: 'custom', from: '2026-04-01', to: '2026-04-30' })
    const open = (await dash({ period: 'custom', from: '2026-04-01', to: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10) })).data
    expect(open.to).toBe(today())
  })

  test('presets still work; the other analytics screens take the same period', async () => {
    for (const p of ['7d', '30d', '90d']) expect((await dash({ period: p })).status).toBe(200)
    for (const path of ['payment-methods', 'revenue-trend', 'margin-report', 'top-customers']) {
      for (const params of [{ period: 'year' }, { period: 'custom', from: '2026-04-01', to: '2026-05-01' }]) {
        const r = await owner.api.get(`/api/analytics/${path}`, { params })
        expect([path, params.period, r.status]).toEqual([path, params.period, 200])
      }
    }
  })

  test('bad custom ranges are refused with a message', async () => {
    for (const params of [
      { period: 'custom' }, { period: 'custom', from: '2026-04-01' }, { period: 'custom', from: '2026-05-01', to: '2026-04-01' },
      { period: 'custom', from: '2015-01-01', to: '2026-01-01' }, { period: 'custom', from: '2026-13-40', to: '2026-14-01' },
      { period: 'custom', from: '2099-01-01', to: '2099-02-01' }, { period: 'decade' },
    ]) {
      const r = await dash(params as Record<string, string>)
      expect([JSON.stringify(params), r.status >= 400 && r.status < 500]).toEqual([JSON.stringify(params), true])
    }
  })

  test('a cancelled bill is not counted anywhere: revenue, the daily chart, the payment split', async () => {
    const prod = (await owner.api.post('/api/products', { itemType: 'product', name: 'Range Tyre', gstRate: 18, unit: 'pcs', trackStock: false, salePrice: 1000, sellingPrice: 1000 })).data
    const sell = async (paid: boolean) => (await owner.api.post('/api/tyre/sales', { customer: { name: 'Range Customer', phone: '9825090001' }, items: [{ productId: prod.id, qty: 1 }], payments: paid ? [{ method: 'cash', amount: 1180 }] : [] },
      { headers: { 'Idempotency-Key': crypto.randomUUID() } }))
    const a = await sell(true); expect(a.status).toBe(201)
    const b = await sell(false); expect(b.status).toBe(201)
    const wk = (after: boolean): Record<string, string> => after ? { period: 'custom', from: ymdToday(-7), to: ymdToday() } : { period: '7d' }      // another cache key, so the second read is fresh
    const revenue = async (after = false) => Number(((await dash(wk(after))).data.kpis as any[]).find((k) => k.key === 'revenue')?.value ?? 0)
    const trendTotal = async (after = false) => ((await owner.api.get('/api/analytics/revenue-trend', { params: wk(after) })).data.rows as any[]).reduce((t, r) => t + r.revenue, 0)
    const before = [await revenue(), await trendTotal()]
    expect((await owner.api.post(`/api/invoices/${b.data.invoice.id}/cancel`, {})).status).toBeLessThan(300)
    const after = [await revenue(true), await trendTotal(true)]
    expect(before[0]! - after[0]!).toBeCloseTo(1180, 0)
    expect(before[1]! - after[1]!).toBeCloseTo(1180, 0)
  })
})
