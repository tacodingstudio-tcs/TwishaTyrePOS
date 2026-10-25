// Customers / suppliers from an Excel sheet (POST /api/parties/import).

import { newShopTenant, addStaff, type Session } from './helpers'

describe('Party import', () => {
  let owner: Session, cashier: Session, viewer: Session, other: Session
  const imp = (s: Session, rows: any[], dryRun = false) => s.api.post('/api/parties/import', { rows, dryRun })
  const parties = async (s: Session) => (await s.api.get('/api/parties', { params: { limit: 100 } })).data.data as any[]

  beforeAll(async () => {
    owner = await newShopTenant('Import Tyres')
    other = await newShopTenant('Other Import Tyres')
    cashier = await addStaff(owner, 'cashier')
    viewer = await addStaff(owner, 'viewer')
  })

  test('a check saves nothing; the import adds, and a repeat adds nothing', async () => {
    const rows = [
      { name: 'Bhavinbhai Parmar', phone: '+91 98765 01234', city: 'Veraval', address: 'Navagam', pincode: '362265' },
      { name: 'Apollo Dealer', type: 'Supplier', phone: '9898012345', gstin: '24AAFPS4321K1ZP' },
      { name: 'Walk-in Ramesh' },
    ]
    const dry = (await imp(owner, rows, true)).data
    expect(dry).toMatchObject({ dryRun: true, created: 3 })
    expect((await parties(owner)).length).toBe(0)

    const r = (await imp(owner, rows)).data
    expect(r.created).toBe(3)
    const all = await parties(owner)
    expect(all.find((p) => p.name === 'Bhavinbhai Parmar')).toMatchObject({ phone: '9876501234', type: 'customer' })
    expect(all.find((p) => p.name === 'Apollo Dealer')).toMatchObject({ type: 'supplier' })

    const again = (await imp(owner, rows)).data
    expect(again.created).toBe(0)
    expect(again.skipped.length).toBe(3)
  })

  test('bad mobile / GSTIN / email are left blank with a note — the row is kept; a repeated mobile in the file is skipped', async () => {
    const r = (await imp(owner, [
      { name: 'Long Mobile Man', phone: '98765012345678', gstin: 'NOTAGSTIN', email: 'nope', pincode: '12' },
      { name: 'Twin One', phone: '9811100011' },
      { name: 'Twin Two', phone: '9811100011' },
    ])).data
    expect(r.created).toBe(2)
    expect(r.skipped).toEqual([expect.objectContaining({ name: 'Twin Two' })])
    expect(r.warnings.length).toBe(4)
    const p = (await parties(owner)).find((x) => x.name === 'Long Mobile Man')
    expect(p.phone).toBeNull()
  })

  test('empty names and oversized files are refused; hostile text is stored as text', async () => {
    expect((await imp(owner, [])).status).toBe(422)
    expect((await imp(owner, new Array(2001).fill({ name: "x" }))).status).toBe(422)
    const r = (await imp(owner, [{ name: '' }, { name: `<script>alert(1)</script>'; DROP TABLE parties;--` }])).data
    expect(r.problems.length).toBe(1)
    expect(r.created).toBe(1)
  })

  test('owner / manager only; another business never sees these customers', async () => {
    expect((await imp(cashier, [{ name: 'X' }])).status).toBe(403)
    expect((await imp(viewer, [{ name: 'X' }])).status).toBe(403)
    expect((await parties(other)).length).toBe(0)
  })
})
