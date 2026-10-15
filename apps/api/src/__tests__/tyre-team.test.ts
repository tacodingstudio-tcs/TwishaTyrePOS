// Team & salary: people, daily marks, advances, payroll maths, salary payments → expenses.

import { newShopTenant, addStaff, type Session } from './helpers'

describe('Team & salary', () => {
  let owner: Session, manager: Session, cashier: Session, viewer: Session, other: Session
  let ramesh: any, dinesh: any

  beforeAll(async () => {
    owner = await newShopTenant('Team Tyres')
    other = await newShopTenant('Other Team Tyres')
    manager = await addStaff(owner, 'manager')
    cashier = await addStaff(owner, 'cashier')
    viewer = await addStaff(owner, 'viewer')
  })

  const MONTH = '2026-06'       // 30 days, Sundays on 7/14/21/28 → 26 working days
  const mark = (s: Session, staffId: string, date: string, status: string | null, overtimeHours = 0) =>
    s.api.put('/api/tyre/team/days', { staffId, date, status, overtimeHours })
  const pay = (s: Session, body: any) => s.api.post('/api/tyre/team/payroll/pay', body)
  const row = async (s: Session, staffId: string) =>
    (await s.api.get('/api/tyre/team/payroll', { params: { month: MONTH } })).data.data.find((r: any) => r.staffId === staffId)

  test('only owner/manager can see or change team data', async () => {
    for (const s of [cashier, viewer]) {
      expect((await s.api.get('/api/tyre/team/staff')).status).toBe(403)
      expect((await s.api.post('/api/tyre/team/staff', { name: 'X', baseSalary: 1 })).status).toBe(403)
      expect((await s.api.get('/api/tyre/team/payroll')).status).toBe(403)
    }
    expect((await manager.api.get('/api/tyre/team/staff')).status).toBe(200)
  })

  test('add people; duplicates and bad input are rejected', async () => {
    const a = await owner.api.post('/api/tyre/team/staff', { name: 'Ramesh Fitter', phone: '9811100001', designation: 'Fitter', baseSalary: 15600, joinDate: '2026-01-01' })
    expect(a.status).toBe(201)
    ramesh = a.data
    const b = await owner.api.post('/api/tyre/team/staff', { name: 'Dinesh Helper', salaryType: 'daily', baseSalary: 500, weeklyOff: -1 })
    expect(b.status).toBe(201)
    dinesh = b.data
    expect((await owner.api.post('/api/tyre/team/staff', { name: 'Ramesh Fitter', phone: '9811100001', baseSalary: 1 })).status).toBe(409)
    expect((await owner.api.post('/api/tyre/team/staff', { name: '', baseSalary: 1 })).status).toBe(422)
    expect((await owner.api.post('/api/tyre/team/staff', { name: 'Neg', baseSalary: -5 })).status).toBe(422)
    expect((await owner.api.post('/api/tyre/team/staff', { name: 'BadOff', baseSalary: 5, weeklyOff: 9 })).status).toBe(422)
  })

  test('monthly pay: unmarked days are present; absent and half days reduce it', async () => {
    let r = await row(owner, ramesh.id)
    expect(r).toMatchObject({ workingDays: 26, earned: 15600, due: 15600 })       // 15600 / 26 = 600 a day
    await mark(owner, ramesh.id, '2026-06-02', 'absent')
    await mark(owner, ramesh.id, '2026-06-03', 'half')
    await mark(owner, ramesh.id, '2026-06-04', 'leave')                           // paid leave
    r = await row(owner, ramesh.id)
    expect(r).toMatchObject({ absent: 1, half: 1, leave: 1, payableDays: 24.5, earned: 14700 })
    await mark(owner, ramesh.id, '2026-06-02', 'present')                         // a new mark overwrites
    expect((await row(owner, ramesh.id)).earned).toBe(15300)
    await mark(owner, ramesh.id, '2026-06-03', null)                              // null clears
    expect((await row(owner, ramesh.id)).earned).toBe(15600)
  })

  test('overtime, bonus and deductions flow into the net', async () => {
    await mark(owner, ramesh.id, '2026-06-10', 'present', 4)                      // 4h × (600 / 8) = 300
    await owner.api.post('/api/tyre/team/ledger', { staffId: ramesh.id, kind: 'bonus', amount: 500, month: MONTH, date: '2026-06-30' })
    await owner.api.post('/api/tyre/team/ledger', { staffId: ramesh.id, kind: 'deduction', amount: 200, month: MONTH, date: '2026-06-30', note: 'tyre damaged' })
    expect(await row(owner, ramesh.id)).toMatchObject({ overtimeHours: 4, overtimePay: 300, bonus: 500, deductions: 200, net: 16200 })
  })

  test('daily wage: only marked days are paid', async () => {
    for (const d of ['2026-06-01', '2026-06-02', '2026-06-03']) await mark(owner, dinesh.id, d, 'present')
    await mark(owner, dinesh.id, '2026-06-04', 'half')
    await mark(owner, dinesh.id, '2026-06-05', 'absent')
    expect(await row(owner, dinesh.id)).toMatchObject({ payableDays: 3.5, earned: 1750, net: 1750 })
  })

  test('advance is paid out (an expense), recovered from salary, and cannot be over-recovered', async () => {
    const adv = await owner.api.post('/api/tyre/team/ledger', { staffId: ramesh.id, kind: 'advance', amount: 3000, date: '2026-06-12', note: 'family function' })
    expect(adv.status).toBe(201)
    expect(JSON.stringify((await owner.api.get('/api/expenses', { params: { limit: 50 } })).data)).toContain('salary_advance')
    expect((await owner.api.get('/api/tyre/team/staff')).data.data.find((p: any) => p.id === ramesh.id).advanceOutstanding).toBe(3000)

    expect((await owner.api.post('/api/tyre/team/ledger', { staffId: ramesh.id, kind: 'recovery', amount: 5000, month: MONTH })).status).toBe(422)
    expect((await owner.api.post('/api/tyre/team/ledger', { staffId: ramesh.id, kind: 'recovery', amount: 1000, month: MONTH, date: '2026-06-30' })).status).toBe(201)
    expect(await row(owner, ramesh.id)).toMatchObject({ recovery: 1000, net: 15200, advanceOutstanding: 2000 })
  })

  test('salary payments: part payment, cannot exceed due, becomes an expense', async () => {
    expect((await pay(owner, { staffId: ramesh.id, month: MONTH, amount: 5200 })).status).toBe(201)
    expect(await row(owner, ramesh.id)).toMatchObject({ paid: 5200, due: 10000 })
    expect((await pay(owner, { staffId: ramesh.id, month: MONTH, amount: 10000.5 })).status).toBe(422)
    expect((await pay(owner, { staffId: ramesh.id, month: MONTH, amount: 0 })).status).toBe(422)
    expect((await pay(owner, { staffId: ramesh.id, month: MONTH, amount: 10000, method: 'upi' })).status).toBe(201)
    expect((await row(owner, ramesh.id)).due).toBe(0)
    expect((await pay(owner, { staffId: ramesh.id, month: MONTH, amount: 1 })).status).toBe(422)
    expect(JSON.stringify((await owner.api.get('/api/expenses', { params: { limit: 50 } })).data)).toContain('Salary 2026-06')
  })

  test('removing an advance removes its expense; one already recovered is protected', async () => {
    const adv = (await owner.api.post('/api/tyre/team/ledger', { staffId: dinesh.id, kind: 'advance', amount: 400, date: '2026-06-15' })).data
    expect((await owner.api.delete(`/api/tyre/team/ledger/${adv.id}`)).status).toBe(200)
    const led = (await owner.api.get('/api/tyre/team/ledger', { params: { staffId: ramesh.id } })).data.data
    const used = led.find((e: any) => e.kind === 'advance')
    expect((await owner.api.delete(`/api/tyre/team/ledger/${used.id}`)).status).toBe(409)
    expect((await owner.api.delete('/api/tyre/team/ledger/00000000-0000-4000-8000-0000000000aa')).status).toBe(404)
  })

  test('future days cannot be marked; unknown staff 404; another business sees nothing', async () => {
    expect((await mark(owner, ramesh.id, '2099-01-01', 'present')).status).toBe(422)
    expect((await mark(owner, '00000000-0000-4000-8000-0000000000bb', '2026-06-01', 'present')).status).toBe(404)
    expect((await mark(other, ramesh.id, '2026-06-01', 'present')).status).toBe(404)
    expect((await other.api.get('/api/tyre/team/staff')).data.data).toHaveLength(0)
    expect((await pay(other, { staffId: ramesh.id, month: MONTH, amount: 1 })).status).toBe(404)
    expect((await owner.api.get('/api/tyre/team/payroll', { params: { month: '2026-13' } })).status).toBe(422)
  })

  test('mid-month joiner is paid from the joining day only', async () => {
    const j = (await owner.api.post('/api/tyre/team/staff', { name: 'New Joiner', baseSalary: 7800, joinDate: '2026-06-16' })).data
    // 16th–30th = 15 days, minus Sundays 21 & 28 = 13 of the month's 26 working days → half
    expect(await row(owner, j.id)).toMatchObject({ workingDays: 13, earned: 3900 })
  })

  test('a deactivated person leaves the list but keeps history', async () => {
    expect((await owner.api.patch(`/api/tyre/team/staff/${dinesh.id}`, { isActive: false })).status).toBe(200)
    const active = (await owner.api.get('/api/tyre/team/staff')).data.data.map((p: any) => p.id)
    expect(active).not.toContain(dinesh.id)
    const all = (await owner.api.get('/api/tyre/team/staff', { params: { all: 'true' } })).data.data.map((p: any) => p.id)
    expect(all).toContain(dinesh.id)
  })
})
