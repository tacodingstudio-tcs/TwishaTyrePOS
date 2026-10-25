// "Export for CA" — the accountant's Excel workbook (GET /api/tyre/reports/ca-pack).

import ExcelJS from 'exceljs'
import { newShopTenant, addStaff, type Session } from './helpers'

describe('CA pack (Excel export)', () => {
  let owner: Session, manager: Session, cashier: Session, viewer: Session
  const get = (s: Session, params: Record<string, string> = {}) =>
    s.api.get('/api/tyre/reports/ca-pack', { params, responseType: 'arraybuffer' })
  const sheets = async (buf: ArrayBuffer) => {
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf)
    return wb.worksheets.map((w) => w.name)
  }

  beforeAll(async () => {
    owner = await newShopTenant('CA Pack Tyres')
    manager = await addStaff(owner, 'manager')
    cashier = await addStaff(owner, 'cashier')
    viewer = await addStaff(owner, 'viewer')
  })

  test('the full pack is a real workbook with a sheet per register', async () => {
    const r = await get(owner)
    expect(r.status).toBe(200)
    expect(r.headers['content-type']).toContain('spreadsheetml')
    expect(r.headers['content-disposition']).toContain('.xlsx')
    const names = await sheets(r.data)
    for (const n of ['Sales Register', 'GSTR-1 B2B', 'HSN Summary', 'Purchase Register', 'Expenses', 'Stock Valuation']) expect(names).toContain(n)
  })

  test('only= limits the sheets; an unknown sheet or a bad period is refused', async () => {
    const one = await get(owner, { only: 'expenses', from: '2026-04-01', to: '2026-10-25' })
    expect(one.status).toBe(200)
    expect(await sheets(one.data)).toEqual(['Summary', 'Expenses'])
    expect((await get(owner, { only: 'nope' })).status).toBe(422)
    expect((await get(owner, { from: '2026-10-25', to: '2026-04-01' })).status).toBe(422)
    expect((await get(owner, { from: '2020-01-01', to: '2026-10-25' })).status).toBe(422)         // more than 3 years
    expect((await get(owner, { from: '2026-13-40' })).status).toBeGreaterThanOrEqual(400)
  })

  test('owner and manager only: it holds every customer, amount and GSTIN', async () => {
    expect((await get(manager)).status).toBe(200)
    expect((await get(cashier)).status).toBe(403)
    expect((await get(viewer)).status).toBe(403)
  })
})
