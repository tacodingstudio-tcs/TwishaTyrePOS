// apps/api/src/routes/tyre-team.ts
// The shop's own people: fitters, helpers, counter staff — with or without a login.
// Daily marks, advances, bonus/deductions, monthly payroll and salary payments.
// Registered under /api/tyre/team. Owner and manager only (salary is private).
//
// Pay rules (kept deliberately plain so the owner can check the numbers by hand):
//   monthly staff : earned = base × payable days ÷ working days
//                   working days = days in month − weekly-off days; a mid-month joiner is paid only from the joining day
//                   a day with no mark counts as PRESENT; mark only absences / half days / leave
//   daily staff   : earned = rate × days marked present (+ ½ per half day); no mark = not paid
//   overtime      : hours × (base ÷ working days ÷ 8)    (daily staff: rate ÷ 8)
//   net           : earned + overtime + bonus − deductions − advance recovered this month
//   cash          : advances and salary payments are written to Expenses when the money leaves.

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { nullableMobile, dateStr } from '../lib/validators.js'
import { tbl, q, q1, run, insertRow, updateRow, httpError, requireManager, todayStr, r2, ymd } from '../lib/tyre-helpers.js'

const idParam = z.object({ id: z.string().uuid() })
const monthStr = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM')
const METHODS = ['cash', 'upi', 'bank_transfer', 'cheque'] as const
const DAY_STATUS = ['present', 'half', 'absent', 'leave'] as const

const StaffBody = z.object({
  name:        z.string().trim().min(1).max(100),
  phone:       nullableMobile,
  designation: z.string().trim().max(60).nullable().optional(),
  joinDate:    dateStr.nullable().optional(),
  salaryType:  z.enum(['monthly', 'daily']).default('monthly'),
  baseSalary:  z.number().nonnegative().max(1e7),
  weeklyOff:   z.number().int().min(-1).max(6).default(0),      // 0 = Sunday … 6 = Saturday, -1 = none
  userId:      z.string().uuid().nullable().optional(),
  isActive:    z.boolean().optional(),
  notes:       z.string().max(500).nullable().optional(),
})

const LedgerBody = z.object({
  staffId: z.string().uuid(),
  kind:    z.enum(['advance', 'bonus', 'deduction', 'recovery']),
  amount:  z.number().positive().max(1e7),
  date:    dateStr.optional(),
  month:   monthStr.optional(),                                  // which payroll month it applies to
  method:  z.enum(METHODS).default('cash'),
  note:    z.string().trim().max(200).optional(),
})

const monthRange = (m: string) => {
  const [y, mo] = m.split('-').map(Number) as [number, number]
  const days = new Date(Date.UTC(y, mo, 0)).getUTCDate()
  return { y, mo, days, from: `${m}-01`, to: `${m}-${String(days).padStart(2, '0')}` }
}

/** Number of days in [from, to] (inclusive) that are not the weekly-off weekday. */
function workingDays(from: string, to: string, weeklyOff: number): number {
  let n = 0
  for (let t = Date.parse(from); t <= Date.parse(to); t += 86_400_000) {
    if (weeklyOff < 0 || new Date(t).getUTCDay() !== weeklyOff) n++
  }
  return n
}

interface PayrollRow {
  staffId: string; name: string; designation: string | null; salaryType: string; baseSalary: number
  workingDays: number; present: number; half: number; absent: number; leave: number; unmarked: number
  payableDays: number; earned: number; overtimeHours: number; overtimePay: number
  bonus: number; deductions: number; recovery: number; net: number; paid: number; due: number
  advanceOutstanding: number
}

async function payroll(req: any, month: string, onlyStaffId?: string): Promise<PayrollRow[]> {
  const s = req.schemaName
  const { from, to } = monthRange(month)
  const staff = await q<any>(req,
    `SELECT id, name, designation, "salaryType", "baseSalary"::float AS "baseSalary", "weeklyOff", "joinDate"
     FROM ${tbl(s, 'tyre_staff')}
     WHERE "branchId" = $1::uuid AND ($2::uuid IS NULL OR id = $2::uuid)
       AND ("isActive" = true OR EXISTS (SELECT 1 FROM ${tbl(s, 'tyre_staff_ledger')} l WHERE l."staffId" = tyre_staff.id AND l.month = $3))
     ORDER BY name`, req.branchId, onlyStaffId ?? null, month)
  if (!staff.length) return []

  const [days, ledger, adv] = await Promise.all([
    q<any>(req,
      `SELECT "staffId", status, COUNT(*)::int AS n, COALESCE(SUM("overtimeHours"),0)::float AS ot
       FROM ${tbl(s, 'tyre_staff_days')} WHERE "branchId" = $1::uuid AND date BETWEEN $2::date AND $3::date
       GROUP BY 1, 2`, req.branchId, from, to),
    q<any>(req,
      `SELECT "staffId", kind, COALESCE(SUM(amount),0)::float AS amt
       FROM ${tbl(s, 'tyre_staff_ledger')} WHERE "branchId" = $1::uuid AND month = $2 GROUP BY 1, 2`, req.branchId, month),
    q<any>(req,
      `SELECT "staffId",
              COALESCE(SUM(amount) FILTER (WHERE kind = 'advance'), 0)::float
            - COALESCE(SUM(amount) FILTER (WHERE kind = 'recovery'), 0)::float AS outstanding
       FROM ${tbl(s, 'tyre_staff_ledger')} WHERE "branchId" = $1::uuid GROUP BY 1`, req.branchId),
  ])

  return staff.map((p) => {
    const mine = days.filter((d) => d.staffId === p.id)
    const cnt = (st: string) => mine.find((d) => d.status === st)?.n ?? 0
    const otHours = r2(mine.reduce((a, d) => a + d.ot, 0))
    const led = (k: string) => ledger.find((l) => l.staffId === p.id && l.kind === k)?.amt ?? 0
    const joined = p.joinDate ? ymd(p.joinDate) : null
    const start = joined && joined > from ? joined : from
    const wd = start > to ? 0 : workingDays(start, to, p.weeklyOff)            // days he could work this month
    const fullWd = workingDays(from, to, p.weeklyOff)                          // the divisor: whole-month working days

    const present = cnt('present'), half = cnt('half'), absent = cnt('absent'), leave = cnt('leave')
    const marked = present + half + absent + leave
    let payable: number, earned: number, hourly: number, unmarked = 0
    if (p.salaryType === 'daily') {
      payable = present + half * 0.5
      earned = r2(p.baseSalary * payable)
      hourly = p.baseSalary / 8
    } else {
      unmarked = Math.max(0, wd - marked)
      payable = Math.min(wd, wd - absent - half * 0.5)           // unmarked and leave days are paid
      earned = fullWd > 0 ? r2(p.baseSalary * Math.max(0, payable) / fullWd) : 0
      hourly = fullWd > 0 ? p.baseSalary / fullWd / 8 : 0
    }
    const overtimePay = r2(otHours * hourly)
    const bonus = led('bonus'), deductions = led('deduction'), recovery = led('recovery'), paid = led('salary')
    const net = r2(earned + overtimePay + bonus - deductions - recovery)
    return {
      staffId: p.id, name: p.name, designation: p.designation, salaryType: p.salaryType, baseSalary: p.baseSalary,
      workingDays: wd, present, half, absent, leave, unmarked, payableDays: r2(Math.max(0, payable)),
      earned, overtimeHours: otHours, overtimePay, bonus, deductions, recovery, net, paid, due: r2(net - paid),
      advanceOutstanding: r2(adv.find((a) => a.staffId === p.id)?.outstanding ?? 0),
    }
  })
}

async function addExpense(req: any, a: { date: string; category: string; description: string; amount: number; method: string }) {
  const row = await q1<{ id: string }>(req,
    `INSERT INTO ${tbl(req.schemaName, 'expenses')}
       ("branchId","date","category","description","amount","gstAmount","gstRate","paymentMode","createdBy")
     VALUES ($1::uuid,$2::date,$3,$4,$5,0,0,$6,$7::uuid) RETURNING id`,
    req.branchId, a.date, a.category, a.description, a.amount, a.method, req.userId)
  return row!.id
}

export const tyreTeamRoutes: FastifyPluginAsync = async (app) => {
  const guard = async (req: any) => requireManager(req)

  // ── People ──────────────────────────────────────────────────────────────────
  app.get('/team/staff', { preHandler: guard }, async (req: any) => {
    const qy = z.object({ all: z.enum(['true', 'false']).default('false') }).parse(req.query)
    const rows = await q<any>(req,
      `SELECT st.*, st."baseSalary"::float AS "baseSalary",
              COALESCE((SELECT SUM(amount) FILTER (WHERE kind='advance') - COALESCE(SUM(amount) FILTER (WHERE kind='recovery'),0)
                        FROM ${tbl(req.schemaName, 'tyre_staff_ledger')} l WHERE l."staffId" = st.id), 0)::float AS "advanceOutstanding"
       FROM ${tbl(req.schemaName, 'tyre_staff')} st
       WHERE st."branchId" = $1::uuid AND ($2 = 'true' OR st."isActive" = true) ORDER BY st."isActive" DESC, st.name`,
      req.branchId, qy.all)
    return { data: rows }
  })

  app.post('/team/staff', { preHandler: guard }, async (req: any, reply) => {
    const b = StaffBody.parse(req.body)
    const dup = await q1(req, `SELECT 1 FROM ${tbl(req.schemaName, 'tyre_staff')}
      WHERE "branchId" = $1::uuid AND lower(name) = lower($2) AND COALESCE(phone,'') = COALESCE($3,'') AND "isActive" = true`,
      req.branchId, b.name, b.phone ?? null)
    if (dup) throw httpError(409, 'A team member with this name and phone already exists')
    const row = await insertRow(req, 'tyre_staff', { branchId: req.branchId, ...b })
    return reply.status(201).send(row)
  })

  app.patch('/team/staff/:id', { preHandler: guard }, async (req: any) => {
    const { id } = idParam.parse(req.params)
    const b = StaffBody.partial().parse(req.body)
    const row = await updateRow(req, 'tyre_staff', id, b)
    if (!row) throw httpError(404, 'Team member not found')
    return row
  })

  // ── Daily marks ─────────────────────────────────────────────────────────────
  app.get('/team/days', { preHandler: guard }, async (req: any) => {
    const qy = z.object({ month: monthStr.optional(), date: dateStr.optional() }).parse(req.query)
    const { from, to } = monthRange(qy.month ?? (qy.date ?? todayStr()).slice(0, 7))
    const rows = await q<any>(req,
      `SELECT id, "staffId", to_char(date,'YYYY-MM-DD') AS date, status, "overtimeHours"::float AS "overtimeHours", note
       FROM ${tbl(req.schemaName, 'tyre_staff_days')}
       WHERE "branchId" = $1::uuid AND date BETWEEN $2::date AND $3::date ORDER BY date`, req.branchId, qy.date ?? from, qy.date ?? to)
    return { data: rows }
  })

  const DayBody = z.object({
    staffId: z.string().uuid(), date: dateStr,
    status: z.enum(DAY_STATUS).nullable(),                         // null clears the mark
    overtimeHours: z.number().min(0).max(16).default(0),
    note: z.string().trim().max(120).optional(),
  })
  const putDay = async (req: any, d: z.infer<typeof DayBody>) => {
    const st = await q1<any>(req, `SELECT "joinDate" FROM ${tbl(req.schemaName, 'tyre_staff')} WHERE id = $1::uuid AND "branchId" = $2::uuid`, d.staffId, req.branchId)
    if (!st) throw httpError(404, 'Team member not found')
    if (d.date > todayStr()) throw httpError(422, 'Cannot mark a day that has not happened yet')
    if (d.status === null) {
      await run(req, `DELETE FROM ${tbl(req.schemaName, 'tyre_staff_days')} WHERE "staffId" = $1::uuid AND date = $2::date AND "branchId" = $3::uuid`, d.staffId, d.date, req.branchId)
      return null
    }
    return q1(req,
      `INSERT INTO ${tbl(req.schemaName, 'tyre_staff_days')} ("branchId","staffId",date,status,"overtimeHours",note)
       VALUES ($1::uuid,$2::uuid,$3::date,$4,$5,$6)
       ON CONFLICT ("staffId", date) DO UPDATE SET status = EXCLUDED.status, "overtimeHours" = EXCLUDED."overtimeHours", note = EXCLUDED.note
       RETURNING id, "staffId", status`, req.branchId, d.staffId, d.date, d.status, d.overtimeHours, d.note ?? null)
  }
  app.put('/team/days', { preHandler: guard }, async (req: any) => ({ day: await putDay(req, DayBody.parse(req.body)) }))
  app.post('/team/days/bulk', { preHandler: guard }, async (req: any) => {
    const b = z.object({ date: dateStr, marks: z.array(z.object({ staffId: z.string().uuid(), status: z.enum(DAY_STATUS).nullable() })).min(1).max(200) }).parse(req.body)
    for (const m of b.marks) await putDay(req, { ...m, date: b.date, overtimeHours: 0 })
    return { saved: b.marks.length }
  })

  // ── Advances, bonus, deductions ─────────────────────────────────────────────
  app.get('/team/ledger', { preHandler: guard }, async (req: any) => {
    const qy = z.object({ staffId: z.string().uuid().optional(), month: monthStr.optional() }).parse(req.query)
    const rows = await q<any>(req,
      `SELECT l.id, l."staffId", st.name, l.kind, l.amount::float AS amount, to_char(l.date,'YYYY-MM-DD') AS date, l.month, l.method, l.note
       FROM ${tbl(req.schemaName, 'tyre_staff_ledger')} l JOIN ${tbl(req.schemaName, 'tyre_staff')} st ON st.id = l."staffId"
       WHERE l."branchId" = $1::uuid AND ($2::uuid IS NULL OR l."staffId" = $2::uuid) AND ($3::text IS NULL OR l.month = $3)
       ORDER BY l.date DESC, l."createdAt" DESC LIMIT 500`, req.branchId, qy.staffId ?? null, qy.month ?? null)
    return { data: rows }
  })

  app.post('/team/ledger', { preHandler: guard }, async (req: any, reply) => {
    const b = LedgerBody.parse(req.body)
    const st = await q1<any>(req, `SELECT id, name, "isActive" FROM ${tbl(req.schemaName, 'tyre_staff')} WHERE id = $1::uuid AND "branchId" = $2::uuid`, b.staffId, req.branchId)
    if (!st) throw httpError(404, 'Team member not found')
    const date = b.date ?? todayStr()
    const month = b.month ?? date.slice(0, 7)
    if (b.kind === 'recovery') {
      const out = await q1<any>(req,
        `SELECT COALESCE(SUM(amount) FILTER (WHERE kind='advance'),0) - COALESCE(SUM(amount) FILTER (WHERE kind='recovery'),0) AS o
         FROM ${tbl(req.schemaName, 'tyre_staff_ledger')} WHERE "staffId" = $1::uuid`, b.staffId)
      if (b.amount > Number(out?.o ?? 0) + 0.005) throw httpError(422, `Only ₹${Number(out?.o ?? 0)} of advance is outstanding for ${st.name}`)
    }
    let expenseId: string | undefined
    if (b.kind === 'advance') {
      expenseId = await addExpense(req, { date, category: 'staff_advance', description: `Advance to ${st.name}${b.note ? ` — ${b.note}` : ''}`, amount: b.amount, method: b.method })
    }
    const row = await insertRow(req, 'tyre_staff_ledger', {
      branchId: req.branchId, staffId: b.staffId, kind: b.kind, amount: b.amount, date, month, method: b.method,
      note: b.note, expenseId, createdBy: req.userId,
    })
    return reply.status(201).send(row)
  })

  app.delete('/team/ledger/:id', { preHandler: guard }, async (req: any) => {
    const { id } = idParam.parse(req.params)
    const row = await q1<any>(req, `SELECT id, kind, "staffId", amount::float AS amount, "expenseId" FROM ${tbl(req.schemaName, 'tyre_staff_ledger')} WHERE id = $1::uuid AND "branchId" = $2::uuid`, id, req.branchId)
    if (!row) throw httpError(404, 'Entry not found')
    if (row.kind === 'advance') {
      const out = await q1<any>(req,
        `SELECT COALESCE(SUM(amount) FILTER (WHERE kind='advance'),0) - COALESCE(SUM(amount) FILTER (WHERE kind='recovery'),0) AS o
         FROM ${tbl(req.schemaName, 'tyre_staff_ledger')} WHERE "staffId" = $1::uuid`, row.staffId)
      if (Number(out?.o ?? 0) - row.amount < -0.005) throw httpError(409, 'Part of this advance has already been recovered from salary — remove that recovery first')
    }
    await run(req, `DELETE FROM ${tbl(req.schemaName, 'tyre_staff_ledger')} WHERE id = $1::uuid`, id)
    if (row.expenseId) await run(req, `DELETE FROM ${tbl(req.schemaName, 'expenses')} WHERE id = $1::uuid AND "branchId" = $2::uuid`, row.expenseId, req.branchId)
    return { deleted: true }
  })

  // ── Payroll ─────────────────────────────────────────────────────────────────
  app.get('/team/payroll', { preHandler: guard }, async (req: any) => {
    const { month } = z.object({ month: monthStr.default(todayStr().slice(0, 7)) }).parse(req.query)
    const rows = await payroll(req, month)
    const sum = (k: keyof PayrollRow) => r2(rows.reduce((a, r) => a + Number(r[k]), 0))
    return { month, data: rows, totals: { earned: sum('earned'), overtimePay: sum('overtimePay'), net: sum('net'), paid: sum('paid'), due: sum('due'), advanceOutstanding: sum('advanceOutstanding') } }
  })

  app.post('/team/payroll/pay', { preHandler: guard }, async (req: any, reply) => {
    const b = z.object({
      staffId: z.string().uuid(), month: monthStr, amount: z.number().positive().max(1e7),
      method: z.enum(METHODS).default('cash'), date: dateStr.optional(), note: z.string().trim().max(200).optional(),
    }).parse(req.body)
    const [row] = await payroll(req, b.month, b.staffId)
    if (!row) throw httpError(404, 'Team member not found')
    if (b.amount > row.due + 0.005) throw httpError(422, `Only ₹${row.due} is due to ${row.name} for ${b.month}`)
    const date = b.date ?? todayStr()
    const expenseId = await addExpense(req, { date, category: 'staff', description: `Salary ${b.month} — ${row.name}`, amount: b.amount, method: b.method })
    const entry = await insertRow(req, 'tyre_staff_ledger', {
      branchId: req.branchId, staffId: b.staffId, kind: 'salary', amount: b.amount, date, month: b.month, method: b.method,
      note: b.note, expenseId, createdBy: req.userId,
    })
    return reply.status(201).send({ entry, due: r2(row.due - b.amount) })
  })
}
