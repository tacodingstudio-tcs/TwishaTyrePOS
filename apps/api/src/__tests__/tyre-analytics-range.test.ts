// Dashboard / analytics periods: 7D, 30D, 90D, this month, this financial year, and a custom from–to.

import { newShopTenant, type Session } from './helpers'

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
})
