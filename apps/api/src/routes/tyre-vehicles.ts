// apps/api/src/routes/tyre-vehicles.ts
// Customer vehicles (registration → owner, tyre size, last fitting, next due) and warranty claims.
// Registered under /api/tyre.

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { TYRE_VEHICLE_TYPES, CLAIM_OUTCOMES } from '@billing/domain-registry'
import {
  tbl, q, q1, insertRow, updateRow, httpError, requireWrite, requireManager, todayStr, addDays, branchConfig, ymd,
} from '../lib/tyre-helpers.js'
import { notifyServiceDue } from '../lib/tyre-notify.js'

const idParam = z.object({ id: z.string().uuid() })
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
const normReg = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '')

const VehicleBody = z.object({
  regNo:           z.string().trim().min(4).max(20).transform(normReg),
  partyId:         z.string().uuid().nullable().optional(),
  vehicleType:     z.enum(TYRE_VEHICLE_TYPES).default('car'),
  makeModel:       z.string().trim().max(60).nullable().optional(),
  tyreSize:        z.string().trim().max(30).nullable().optional(),
  ownerName:       z.string().trim().max(120).nullable().optional(),
  ownerPhone:      z.string().trim().max(15).nullable().optional(),
  lastServiceDate: dateStr.nullable().optional(),
  lastOdometer:    z.number().int().nonnegative().max(2_000_000).nullable().optional(),
  nextServiceDate: dateStr.nullable().optional(),
  nextServiceKm:   z.number().int().positive().max(2_500_000).nullable().optional(),
  nextServiceFor:  z.string().trim().max(60).nullable().optional(),
  remindersOff:    z.boolean().optional(),
  notes:           z.string().max(500).nullable().optional(),
})

export const tyreVehicleRoutes: FastifyPluginAsync = async (app) => {

  // ── Vehicles ────────────────────────────────────────────────────────────────

  // GET /api/tyre/vehicles?search=&due=true
  app.get('/vehicles', async (req) => {
    const qy = z.object({
      search: z.string().max(60).optional(),
      due:    z.enum(['true', 'false']).optional(),
      page:   z.coerce.number().int().min(1).default(1),
      limit:  z.coerce.number().int().min(1).max(100).default(25),
    }).parse(req.query)
    const params: unknown[] = [req.branchId]
    let where = `WHERE v."branchId" = $1::uuid AND v."isActive" = true`
    if (qy.search?.trim()) {
      params.push(`%${qy.search.trim()}%`)
      const n = params.length
      where += ` AND (v."regNo" ILIKE $${n} OR v."ownerName" ILIKE $${n} OR v."ownerPhone" ILIKE $${n} OR p.name ILIKE $${n} OR p.phone ILIKE $${n})`
    }
    if (qy.due === 'true') { params.push(todayStr()); where += ` AND v."nextServiceDate" IS NOT NULL AND v."nextServiceDate" <= $${params.length}::date` }
    const from = `FROM ${tbl(req.schemaName, 'tyre_vehicles')} v LEFT JOIN ${tbl(req.schemaName, 'parties')} p ON p.id = v."partyId"`
    const [rows, total] = await Promise.all([
      q(req, `SELECT v.*, p.name AS "partyName", p.phone AS "partyPhone" ${from} ${where}
              ORDER BY v."updatedAt" DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        ...params, qy.limit, (qy.page - 1) * qy.limit),
      q<{ count: number }>(req, `SELECT COUNT(*) AS count ${from} ${where}`, ...params),
    ])
    return { data: rows, total: total[0]?.count ?? 0, page: qy.page, limit: qy.limit }
  })

  // GET /api/tyre/vehicles/lookup?regNo= — exact registration, for the counter's vehicle field
  app.get('/vehicles/lookup', async (req) => {
    const { regNo } = z.object({ regNo: z.string().min(3).max(20) }).parse(req.query)
    const v = await q1(req,
      `SELECT v.*, p.name AS "partyName", p.phone AS "partyPhone"
       FROM ${tbl(req.schemaName, 'tyre_vehicles')} v LEFT JOIN ${tbl(req.schemaName, 'parties')} p ON p.id = v."partyId"
       WHERE v."branchId" = $1::uuid AND v."regNo" = $2`, req.branchId, normReg(regNo))
    return { vehicle: v }
  })

  // POST /api/tyre/vehicles
  app.post('/vehicles', async (req, reply) => {
    requireWrite(req)
    const body = VehicleBody.parse(req.body)
    const dup = await q1<any>(req, `SELECT id, "isActive" FROM ${tbl(req.schemaName, 'tyre_vehicles')} WHERE "branchId" = $1::uuid AND "regNo" = $2`, req.branchId, body.regNo)
    if (dup?.isActive) throw httpError(409, `Vehicle ${body.regNo} is already saved`)
    if (dup) {
      // deleted earlier — bring it back with the details just entered
      const { regNo: _r, ...fields } = body
      const back = await updateRow(req, 'tyre_vehicles', dup.id, { ...fields, isActive: true })
      return reply.status(200).send(back)
    }
    const row = await insertRow(req, 'tyre_vehicles', { ...body, branchId: req.branchId })
    return reply.status(201).send(row)
  })

  // GET /api/tyre/vehicles/:id — profile + every bill and tyre on it
  app.get('/vehicles/:id', async (req) => {
    const { id } = idParam.parse(req.params)
    const v = await q1<any>(req,
      `SELECT v.*, p.name AS "partyName", p.phone AS "partyPhone"
       FROM ${tbl(req.schemaName, 'tyre_vehicles')} v LEFT JOIN ${tbl(req.schemaName, 'parties')} p ON p.id = v."partyId"
       WHERE v.id = $1::uuid AND v."branchId" = $2::uuid`, id, req.branchId)
    if (!v) throw httpError(404, 'Vehicle not found')
    const [bills, warranty] = await Promise.all([
      q(req,
        `SELECT id, number, date, status, "grandTotal"::float AS "grandTotal", "paidAmt"::float AS "paidAmt",
                "domainData"->>'odometer' AS odometer
         FROM ${tbl(req.schemaName, 'invoices')}
         WHERE "branchId" = $1::uuid AND "txnType" = 'sale_invoice' AND status <> 'cancelled'
           AND "domainData"->>'vehicle_no' = $2
         ORDER BY date DESC, "createdAt" DESC LIMIT 50`, req.branchId, v.regNo),
      q(req,
        `SELECT * FROM ${tbl(req.schemaName, 'tyre_warranty')}
         WHERE "branchId" = $1::uuid AND "vehicleNo" = $2 AND status <> 'void'
         ORDER BY "soldOn" DESC, "createdAt" DESC`, req.branchId, v.regNo),
    ])
    return { ...v, bills, warranty }
  })

  // PATCH /api/tyre/vehicles/:id
  app.patch('/vehicles/:id', async (req) => {
    requireWrite(req)
    const { id } = idParam.parse(req.params)
    const body = VehicleBody.partial().parse(req.body)
    const row = await updateRow(req, 'tyre_vehicles', id, body)
    if (!row) throw httpError(404, 'Vehicle not found')
    return row
  })

  // DELETE /api/tyre/vehicles/:id — soft delete (history stays on the bills)
  app.delete('/vehicles/:id', async (req) => {
    requireManager(req)
    const { id } = idParam.parse(req.params)
    const row = await updateRow(req, 'tyre_vehicles', id, { isActive: false })
    if (!row) throw httpError(404, 'Vehicle not found')
    return { ok: true }
  })

  // POST /api/tyre/vehicles/:id/remind — send the "service due" WhatsApp now
  app.post('/vehicles/:id/remind', async (req, reply) => {
    requireWrite(req)
    const { id } = idParam.parse(req.params)
    const r = await notifyServiceDue(req, id, { force: true })
    if (!r) throw httpError(404, 'Vehicle not found')
    return reply.status(r.status === 'skipped' ? 422 : 202).send(r)
  })

  // GET /api/tyre/reminders?days=14 — vehicles due (or overdue) for a tyre check
  app.get('/reminders', async (req) => {
    const cfg = await branchConfig(req)
    const { days } = z.object({ days: z.coerce.number().int().min(0).max(120).default(14) }).parse(req.query)
    void cfg
    const horizon = addDays(todayStr(), days)
    const rows = await q<any>(req,
      `SELECT v.id, v."regNo", v."vehicleType", v."makeModel", v."tyreSize", v."lastServiceDate", v."nextServiceDate",
              v."nextServiceKm", v."nextServiceFor", v."lastOdometer", v."remindersOff",
              COALESCE(v."ownerName", p.name) AS "ownerName", COALESCE(v."ownerPhone", p.phone) AS "ownerPhone",
              (SELECT MAX(n."createdAt") FROM ${tbl(req.schemaName, 'tyre_notifications')} n
                WHERE n."refType" = 'vehicle' AND n."refId" = v.id AND n.kind = 'service_due') AS "lastReminded"
       FROM ${tbl(req.schemaName, 'tyre_vehicles')} v LEFT JOIN ${tbl(req.schemaName, 'parties')} p ON p.id = v."partyId"
       WHERE v."branchId" = $1::uuid AND v."isActive" = true AND v."nextServiceDate" IS NOT NULL AND v."nextServiceDate" <= $2::date
       ORDER BY v."nextServiceDate" ASC LIMIT 200`, req.branchId, horizon)
    const today = todayStr()
    return rows.map((r) => ({ ...r, overdueDays: Math.max(0, Math.round((Date.parse(today) - Date.parse(ymd(r.nextServiceDate))) / 86_400_000)) }))
  })

  // ── Warranty ────────────────────────────────────────────────────────────────

  // GET /api/tyre/warranty?serial=&vehicleNo=&phone=&invoiceNo=&status=&expiringDays=
  app.get('/warranty', async (req) => {
    const qy = z.object({
      serial:       z.string().max(40).optional(),
      vehicleNo:    z.string().max(20).optional(),
      phone:        z.string().max(15).optional(),
      invoiceNo:    z.string().max(40).optional(),
      search:       z.string().max(60).optional(),
      status:       z.enum(['active', 'claimed', 'void', 'any']).default('any'),
      expiringDays: z.coerce.number().int().min(1).max(365).optional(),
      page:         z.coerce.number().int().min(1).default(1),
      limit:        z.coerce.number().int().min(1).max(100).default(25),
    }).parse(req.query)

    const params: unknown[] = [req.branchId]
    let where = `WHERE w."branchId" = $1::uuid`
    const like = (col: string, v: string) => { params.push(`%${v.trim()}%`); where += ` AND ${col} ILIKE $${params.length}` }
    if (qy.serial)    like('w."serialNo"', qy.serial)
    if (qy.vehicleNo) like('w."vehicleNo"', normReg(qy.vehicleNo))
    if (qy.phone)     like('w."customerPhone"', qy.phone.replace(/\D/g, ''))
    if (qy.invoiceNo) like('w."invoiceNo"', qy.invoiceNo)
    if (qy.search?.trim()) {
      params.push(`%${qy.search.trim()}%`)
      const n = params.length
      where += ` AND (w."serialNo" ILIKE $${n} OR w."vehicleNo" ILIKE $${n} OR w."customerPhone" ILIKE $${n}
                  OR w."customerName" ILIKE $${n} OR w."invoiceNo" ILIKE $${n} OR w."itemName" ILIKE $${n} OR w."dotCode" ILIKE $${n})`
    }
    if (qy.status !== 'any') { params.push(qy.status); where += ` AND w.status = $${params.length}` }
    else where += ` AND w.status <> 'void'`
    if (qy.expiringDays) {
      params.push(todayStr(), addDays(todayStr(), qy.expiringDays))
      where += ` AND w.status = 'active' AND w."warrantyUntil" BETWEEN $${params.length - 1}::date AND $${params.length}::date`
    }
    const today = todayStr()
    const [rows, total] = await Promise.all([
      q(req, `SELECT w.*, (w."warrantyUntil" IS NOT NULL AND w."warrantyUntil" < '${today}'::date) AS "expired"
              FROM ${tbl(req.schemaName, 'tyre_warranty')} w ${where}
              ORDER BY w."soldOn" DESC, w."createdAt" DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        ...params, qy.limit, (qy.page - 1) * qy.limit),
      q<{ count: number }>(req, `SELECT COUNT(*) AS count FROM ${tbl(req.schemaName, 'tyre_warranty')} w ${where}`, ...params),
    ])
    return { data: rows, total: total[0]?.count ?? 0, page: qy.page, limit: qy.limit }
  })

  // POST /api/tyre/warranty/:id/claim { outcome, notes, claimAmount }
  app.post('/warranty/:id/claim', async (req) => {
    requireWrite(req)
    const { id } = idParam.parse(req.params)
    const body = z.object({
      outcome:     z.enum(CLAIM_OUTCOMES),
      notes:       z.string().trim().min(3).max(500),
      claimAmount: z.number().nonnegative().max(1e7).optional(),
    }).parse(req.body)
    const w = await q1<any>(req,
      `SELECT * FROM ${tbl(req.schemaName, 'tyre_warranty')} WHERE id = $1::uuid AND "branchId" = $2::uuid`, id, req.branchId)
    if (!w) throw httpError(404, 'Warranty record not found')
    if (w.status === 'void')    throw httpError(422, 'This record was voided (bill cancelled or tyre returned)')
    if (w.status === 'claimed') throw httpError(409, 'A claim has already been recorded on this tyre')
    const expired = w.warrantyUntil && ymd(w.warrantyUntil) < todayStr()
    if (expired && body.outcome !== 'rejected') {
      throw httpError(422, `Warranty ended on ${ymd(w.warrantyUntil)} — record the claim as "rejected", or void and re-issue if you are honouring it`)
    }
    return updateRow(req, 'tyre_warranty', id, {
      status: 'claimed', claimedAt: new Date(), claimOutcome: body.outcome, claimNotes: body.notes,
      claimAmount: body.claimAmount ?? null,
    })
  })

  // POST /api/tyre/warranty/:id/void { reason } — returned tyre / wrong entry; frees the serial number
  app.post('/warranty/:id/void', async (req) => {
    requireManager(req)
    const { id } = idParam.parse(req.params)
    const { reason } = z.object({ reason: z.string().trim().min(3).max(200) }).parse(req.body ?? {})
    const w = await q1<any>(req,
      `SELECT status, "claimNotes" FROM ${tbl(req.schemaName, 'tyre_warranty')} WHERE id = $1::uuid AND "branchId" = $2::uuid`, id, req.branchId)
    if (!w) throw httpError(404, 'Warranty record not found')
    if (w.status === 'void') throw httpError(422, 'Already voided')
    return updateRow(req, 'tyre_warranty', id, { status: 'void', claimNotes: [w.claimNotes, `Voided: ${reason}`].filter(Boolean).join(' | ') })
  })
}
