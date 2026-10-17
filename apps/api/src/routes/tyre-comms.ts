// apps/api/src/routes/tyre-comms.ts
// Server-side PDFs and WhatsApp notifications for the tyre module. Registered under /api/tyre.
//
//   GET  /invoices/:id/pdf              tax invoice PDF (+ warranty card page)
//   POST /invoices/:id/notify           send the invoice on WhatsApp now (manual, always allowed)
//   GET  /notifications                 delivery log (filter by status / ref)
//   POST /notifications/:id/retry       re-queue a failed or skipped message
//   GET/PUT /notify-settings            which automatic messages are on
//   POST /notify/run-alerts             run today's reminder/owner-alert job for this business now

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { nullableMobile } from '../lib/validators.js'
import { tbl, q, q1, httpError, requireWrite, requireManager, branchConfig, type Ctx } from '../lib/tyre-helpers.js'
import { invoicePdf } from '../lib/tyre-docs.js'
import { notifyInvoice, retryMessage, runDailyAlerts, notifySettings } from '../lib/tyre-notify.js'

const idParam = z.object({ id: z.string().uuid() })

export const tyreCommsRoutes: FastifyPluginAsync = async (app) => {

  // ── PDF ─────────────────────────────────────────────────────────────────────
  app.get('/invoices/:id/pdf', async (req, reply) => {
    const { id } = idParam.parse(req.params)
    // ?copy=duplicate | triplicate prints that word where the bill says "Original" (for reprints and the office copy)
    const { copy } = z.object({ copy: z.enum(['original', 'duplicate', 'triplicate']).optional() }).parse(req.query)
    const label = copy ? ((copy[0]!.toUpperCase() + copy.slice(1)) as 'Original' | 'Duplicate' | 'Triplicate') : undefined
    const { buffer, filename } = await invoicePdf(req, id, { copy: label })
    return reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `inline; filename="${filename}"`)
      .header('Cache-Control', 'private, no-store')
      .send(buffer)
  })

  // ── Manual send ─────────────────────────────────────────────────────────────
  app.post('/invoices/:id/notify', async (req, reply) => {
    requireWrite(req)
    const { id } = idParam.parse(req.params)
    const body = z.object({ toPhone: z.string().max(20).optional() }).parse(req.body ?? {})
    const r = await notifyInvoice(req, id, { force: true, toPhone: body.toPhone })
    if (!r) throw httpError(422, 'Only live sale invoices can be sent')
    return reply.status(r.status === 'skipped' ? 422 : 202).send(r)
  })

  // ── Delivery log ────────────────────────────────────────────────────────────
  app.get('/notifications', async (req) => {
    const qy = z.object({
      status:  z.enum(['queued', 'sent', 'failed', 'skipped']).optional(),
      refType: z.enum(['invoice', 'vehicle', 'warranty']).optional(),
      refId:   z.string().uuid().optional(),
      page:    z.coerce.number().int().min(1).default(1),
      limit:   z.coerce.number().int().min(1).max(100).default(30),
    }).parse(req.query)
    const params: unknown[] = [req.branchId]
    let where = `WHERE "branchId" = $1::uuid`
    if (qy.status)  { params.push(qy.status);  where += ` AND status = $${params.length}` }
    if (qy.refType) { params.push(qy.refType); where += ` AND "refType" = $${params.length}` }
    if (qy.refId)   { params.push(qy.refId);   where += ` AND "refId" = $${params.length}::uuid` }
    const [rows, total] = await Promise.all([
      q(req, `SELECT id, kind, "refType", "refId", "recipientName", "toPhone", message, attachment, status, error, attempts, "createdAt", "sentAt"
              FROM ${tbl(req.schemaName, 'tyre_notifications')} ${where}
              ORDER BY "createdAt" DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        ...params, qy.limit, (qy.page - 1) * qy.limit),
      q<{ count: number }>(req, `SELECT COUNT(*) AS count FROM ${tbl(req.schemaName, 'tyre_notifications')} ${where}`, ...params),
    ])
    return { data: rows, total: total[0]?.count ?? 0, page: qy.page, limit: qy.limit }
  })

  app.post('/notifications/:id/retry', async (req, reply) => {
    requireWrite(req)
    const { id } = idParam.parse(req.params)
    const n = await q1<any>(req,
      `SELECT status FROM ${tbl(req.schemaName, 'tyre_notifications')} WHERE id = $1::uuid AND "branchId" = $2::uuid`, id, req.branchId)
    if (!n) throw httpError(404, 'Notification not found')
    if (n.status === 'sent' || n.status === 'queued') throw httpError(422, `This message is already ${n.status}`)
    const r = await retryMessage(req, id)
    return reply.status(r.status === 'skipped' ? 422 : 202).send(r)
  })

  // ── Settings ────────────────────────────────────────────────────────────────
  app.get('/notify-settings', async (req) => notifySettings(await branchConfig(req)))

  app.put('/notify-settings', async (req) => {
    requireManager(req)
    const body = z.object({
      notify_invoice:             z.boolean().optional(),
      notify_payment_reminders:   z.boolean().optional(),
      notify_service_reminders:   z.boolean().optional(),
      notify_owner_alerts:        z.boolean().optional(),
      notify_reminder_every_days: z.number().int().min(1).max(60).optional(),
      notify_owner_phone:         nullableMobile,
    }).strict().parse(req.body ?? {})
    const patch = JSON.stringify(Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)))
    await req.db.$executeRawUnsafe(
      `UPDATE ${tbl(req.schemaName, 'branches')}
       SET "domainConfig" = COALESCE("domainConfig", '{}'::jsonb) || $2::jsonb, "updatedAt" = NOW()
       WHERE id = $1::uuid`, req.branchId, patch)
    return notifySettings(await branchConfig(req))
  })

  // Run today's reminder / owner-alert job for this business on demand (it is also a daily cron).
  app.post('/notify/run-alerts', async (req) => {
    requireManager(req)
    return runDailyAlerts(req as unknown as Ctx)
  })
}
