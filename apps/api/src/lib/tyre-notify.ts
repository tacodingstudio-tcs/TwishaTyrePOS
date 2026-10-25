// apps/api/src/lib/tyre-notify.ts
// WhatsApp notifications for the tyre module.
//
// Every outbound message is a row in tyre_notifications (so staff can see what went out, what
// failed, and retry), and a job on the existing `whatsapp-send` BullMQ queue. The worker
// (workers/whatsapp.worker.ts) does the actual Cloud-API call and updates the row.
//
// Automatic sends are OPT-IN per event (branch config keys below, default off): a shop should
// decide whether customers start receiving messages from the system.
//
//   notify_invoice            → invoice PDF (+ warranty card) to the customer when a bill is made
//   notify_payment_reminders  → daily overdue-bill reminder (every `notify_reminder_every_days`)
//   notify_service_reminders  → "alignment / rotation due" to the vehicle owner
//   notify_owner_alerts       → daily digest to the owner: low stock, overdue money, dead stock
//
// A failure to notify must never fail the business operation — callers use `safely()`.

import { whatsappQueue, addJob } from './queues.js'
import { tbl, q, q1, run, todayStr, addDays, type Ctx } from './tyre-helpers.js'
import { invoicePdf, loadBusiness, loadInvoiceDoc } from './tyre-docs.js'

export type NotifyKind = 'invoice' | 'payment_reminder' | 'service_due' | 'owner_alerts' | 'manual'

export interface NotifySettings {
  notify_invoice: boolean
  notify_payment_reminders: boolean
  notify_service_reminders: boolean
  notify_owner_alerts: boolean
  notify_reminder_every_days: number
  notify_owner_phone: string | null
}

export function notifySettings(cfg: Record<string, any>): NotifySettings {
  return {
    notify_invoice:             cfg['notify_invoice'] === true,
    notify_payment_reminders:   cfg['notify_payment_reminders'] === true,
    notify_service_reminders:   cfg['notify_service_reminders'] === true,
    notify_owner_alerts:        cfg['notify_owner_alerts'] === true,
    notify_reminder_every_days: Math.min(60, Math.max(1, Number(cfg['notify_reminder_every_days'] ?? 7))),
    notify_owner_phone:         cfg['notify_owner_phone'] ? String(cfg['notify_owner_phone']) : null,
  }
}

/** Indian mobile → E.164 digits ("91XXXXXXXXXX"), or null if it does not look like a mobile number. */
export function toWhatsAppPhone(raw: string | null | undefined): string | null {
  if (!raw) return null
  let d = String(raw).replace(/\D/g, '')
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2)
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1)
  return /^[6-9]\d{9}$/.test(d) ? `91${d}` : null
}

/** Run a notification side-effect without ever failing the caller. */
export function safely(label: string, p: Promise<unknown>): void {
  p.catch((err) => console.error(`[tyre-notify] ${label} failed:`, (err as Error).message))
}

type Attachment = { spec: 'invoice_pdf'; id: string }

export interface SendArgs {
  kind: NotifyKind
  toPhone: string | null | undefined
  recipientName?: string | null
  message: string
  refType?: 'invoice' | 'vehicle' | 'warranty' | null
  refId?: string | null
  attachment?: Attachment | null
  /** Same key twice for one branch = send once (e.g. one overdue reminder per bill per bucket). */
  dedupeKey?: string | null
}

export interface SendResult { id: string | null; status: 'queued' | 'skipped' | 'duplicate'; reason?: string }

/**
 * Records the message and puts it on the queue. Returns `skipped` (with a reason, and a log row) when
 * the number is unusable, `duplicate` when the dedupe key was already used.
 */
export async function sendMessage(ctx: Ctx, a: SendArgs): Promise<SendResult> {
  const phone = toWhatsAppPhone(a.toPhone)
  const attachmentSpec = a.attachment ? `${a.attachment.spec}:${a.attachment.id}` : null

  const rows = await q<{ id: string }>(ctx,
    `INSERT INTO ${tbl(ctx.schemaName, 'tyre_notifications')}
       ("branchId","kind","refType","refId","recipientName","toPhone","message","attachment","dedupeKey","status","error","createdBy")
     VALUES ($1::uuid,$2,$3,$4::uuid,$5,$6,$7,$8,$9,$10,$11,$12::uuid)
     ON CONFLICT ("branchId","dedupeKey") WHERE "dedupeKey" IS NOT NULL DO NOTHING
     RETURNING id`,
    ctx.branchId, a.kind, a.refType ?? null, a.refId ?? null, a.recipientName ?? null,
    phone ?? String(a.toPhone ?? ''), a.message, attachmentSpec, a.dedupeKey ?? null,
    phone ? 'queued' : 'skipped', phone ? null : 'No valid mobile number for this recipient', ctx.userId ?? null)
  const id = rows[0]?.id
  if (!id) return { id: null, status: 'duplicate' }
  if (!phone) return { id, status: 'skipped', reason: 'No valid mobile number for this recipient' }

  try {
    await enqueue(ctx, { id, toPhone: phone, message: a.message, attachment: a.attachment ?? null })
  } catch (err) {
    const reason = `Could not queue the message: ${(err as Error).message}. Use Retry on WhatsApp Messages.`
    await q(ctx, `UPDATE ${tbl(ctx.schemaName, 'tyre_notifications')} SET status = 'failed', error = $2 WHERE id = $1::uuid`, id, reason).catch(() => {})
    return { id, status: 'skipped', reason }
  }
  return { id, status: 'queued' }
}

async function enqueue(ctx: Ctx, m: { id: string; toPhone: string; message: string; attachment: Attachment | null }) {
  let document: { base64: string; filename: string } | undefined
  if (m.attachment) {
    const built = await invoicePdf(ctx, m.attachment.id)
    document = { base64: built.buffer.toString('base64'), filename: built.filename }
  }
  await addJob(whatsappQueue, 'shop_message', {
    type: 'shop_message',
    notificationId: m.id,
    schemaName: ctx.schemaName,
    toPhone: m.toPhone,
    message: m.message,
    document,
  })
}

/** Re-queue a failed/skipped message (rebuilding its PDF so the attachment is current). */
export async function retryMessage(ctx: Ctx, id: string): Promise<SendResult> {
  const n = await q1<any>(ctx,
    `SELECT * FROM ${tbl(ctx.schemaName, 'tyre_notifications')} WHERE id = $1::uuid AND "branchId" = $2::uuid`, id, ctx.branchId)
  if (!n) return { id: null, status: 'skipped', reason: 'Notification not found' }
  const phone = toWhatsAppPhone(n.toPhone)
  if (!phone) return { id, status: 'skipped', reason: 'No valid mobile number for this recipient' }
  let attachment: Attachment | null = null
  if (n.attachment) {
    const [spec, refId] = String(n.attachment).split(':')
    attachment = { spec: spec as Attachment['spec'], id: refId! }
  }
  await run(ctx,
    `UPDATE ${tbl(ctx.schemaName, 'tyre_notifications')} SET status = 'queued', error = NULL WHERE id = $1::uuid`, id)
  await enqueue(ctx, { id, toPhone: phone, message: n.message, attachment })
  return { id, status: 'queued' }
}

// ── Message builders ──────────────────────────────────────────────────────────

const inr = (n: unknown) => `Rs. ${Number(n ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
const fmt = (v: unknown) => {
  const d = v instanceof Date ? v : new Date(String(v))
  return isNaN(d.getTime()) ? String(v ?? '') : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })
}

/** The invoice PDF (with warranty card) to the customer — a no-op unless switched on, or `force`. */
export async function notifyInvoice(ctx: Ctx, invoiceId: string, opts: { force?: boolean; toPhone?: string } = {}): Promise<SendResult | null> {
  const biz = await loadBusiness(ctx)
  if (!opts.force && !notifySettings(biz.config).notify_invoice) return null
  const { data, invoice } = await loadInvoiceDoc(ctx, invoiceId)
  if (invoice.status === 'cancelled' || invoice.txnType !== 'sale_invoice') return null
  const balance = Math.max(0, data.grandTotal - data.paidAmt)
  const message = [
    `*${biz.header.name}*`,
    `Invoice ${data.number} dated ${fmt(data.date)} — ${inr(data.grandTotal)}`,
    data.vehicleNo ? `Vehicle: ${data.vehicleNo}` : null,
    data.warranty.length ? `${data.warranty.length} tyre${data.warranty.length === 1 ? '' : 's'} registered for warranty — card attached.` : null,
    balance > 0.5 ? `Balance due: ${inr(balance)}${data.dueDate ? ` by ${fmt(data.dueDate)}` : ''}` : 'Paid in full. Thank you!',
  ].filter(Boolean).join('\n')
  return sendMessage(ctx, {
    kind: 'invoice', toPhone: opts.toPhone ?? invoice.partyPhone, recipientName: data.partyName, message,
    refType: 'invoice', refId: invoiceId, attachment: { spec: 'invoice_pdf', id: invoiceId },
    dedupeKey: opts.force ? null : `invoice:${invoiceId}`,
  })
}

export async function notifyServiceDue(ctx: Ctx, vehicleId: string, opts: { force?: boolean } = {}): Promise<SendResult | null> {
  const biz = await loadBusiness(ctx)
  const v = await q1<any>(ctx,
    `SELECT v.*, p.phone AS "partyPhone", p.name AS "partyName"
     FROM ${tbl(ctx.schemaName, 'tyre_vehicles')} v
     LEFT JOIN ${tbl(ctx.schemaName, 'parties')} p ON p.id = v."partyId"
     WHERE v.id = $1::uuid AND v."branchId" = $2::uuid`, vehicleId, ctx.branchId)
  if (!v) return null
  if (v.remindersOff && !opts.force) return null
  const name = v.ownerName ?? v.partyName ?? 'Customer'
  const message = [
    `*${biz.header.name}*`,
    `Hello ${name}, your vehicle ${v.regNo} is due for ${v.nextServiceFor ? String(v.nextServiceFor).toLowerCase() : 'a tyre check — wheel alignment / balancing / rotation'}.`,
    v.lastServiceDate ? `Last fitting: ${fmt(v.lastServiceDate)}.` : null,
    biz.header.phone ? `Call ${biz.header.phone} to book a slot.` : 'Drop in any time.',
  ].filter(Boolean).join('\n')
  return sendMessage(ctx, {
    kind: 'service_due', toPhone: v.ownerPhone ?? v.partyPhone, recipientName: name, message,
    refType: 'vehicle', refId: vehicleId,
    dedupeKey: opts.force ? null : `service_due:${vehicleId}:${v.nextServiceDate ? String(v.nextServiceDate).slice(0, 10) : 'x'}`,
  })
}

/**
 * Daily job body for one business: overdue-bill reminders, service-due reminders and a digest to
 * the owner. Dedupe keys make it safe to run more than once a day.
 */
export async function runDailyAlerts(ctx: Ctx): Promise<{ reminders: number; serviceDue: number; ownerAlerts: number }> {
  const biz = await loadBusiness(ctx)
  const s = notifySettings(biz.config)
  const today = todayStr()
  let reminders = 0, serviceDue = 0, ownerAlerts = 0

  if (s.notify_payment_reminders) {
    const due = await q<any>(ctx,
      `SELECT i.id, i.number, i."dueDate", i."grandTotal"::float AS "grandTotal", i."paidAmt"::float AS "paidAmt",
              p.name AS "partyName", p.phone AS "partyPhone",
              ($2::date - i."dueDate")::int AS "daysOverdue"
       FROM ${tbl(ctx.schemaName, 'invoices')} i
       JOIN ${tbl(ctx.schemaName, 'parties')} p ON p.id = i."partyId"
       WHERE i."branchId" = $1::uuid AND i."txnType" = 'sale_invoice'
         AND i.status NOT IN ('cancelled','draft','paid')
         AND i."dueDate" IS NOT NULL AND i."dueDate" < $2::date
         AND i."grandTotal" - i."paidAmt" > 0.5`,
      ctx.branchId, today)
    for (const b of due) {
      const bucket = Math.floor(b.daysOverdue / s.notify_reminder_every_days)
      const outstanding = b.grandTotal - b.paidAmt
      const r = await sendMessage(ctx, {
        kind: 'payment_reminder', toPhone: b.partyPhone, recipientName: b.partyName,
        message: [`*${biz.header.name}*`, `Payment reminder: invoice ${b.number} — ${inr(outstanding)} outstanding, overdue by ${b.daysOverdue} day${b.daysOverdue === 1 ? '' : 's'}.`,
                  'Please arrange payment at the earliest. Ignore if already paid.'].join('\n'),
        refType: 'invoice', refId: b.id, dedupeKey: `payment_reminder:${b.id}:${bucket}`,
      })
      if (r.status === 'queued') reminders++
    }
  }

  if (s.notify_service_reminders) {
    const vehicles = await q<{ id: string }>(ctx,
      `SELECT id FROM ${tbl(ctx.schemaName, 'tyre_vehicles')}
       WHERE "branchId" = $1::uuid AND "isActive" = true AND "remindersOff" = false
         AND "nextServiceDate" IS NOT NULL AND "nextServiceDate" <= $2::date
         AND "nextServiceDate" >= ($2::date - 60)`, ctx.branchId, today)
    for (const v of vehicles) {
      const r = await notifyServiceDue(ctx, v.id)
      if (r?.status === 'queued') serviceDue++
    }
  }

  if (s.notify_owner_alerts) {
    const ownerPhone = s.notify_owner_phone ?? biz.header.phone
    const lines: string[] = []

    const low = await q<any>(ctx,
      `SELECT p.name, COALESCE(SUM(sl.qty), 0)::float AS qty, p."lowStockQty"::float AS low
       FROM ${tbl(ctx.schemaName, 'products')} p
       LEFT JOIN ${tbl(ctx.schemaName, 'stock_ledger')} sl ON sl."productId" = p.id AND sl."branchId" = $1::uuid
       WHERE p."branchId" = $1::uuid AND p."isActive" = true AND p."trackStock" = true AND p."itemType" <> 'service'
         AND p."lowStockQty" > 0
       GROUP BY p.id, p.name, p."lowStockQty"
       HAVING COALESCE(SUM(sl.qty), 0) <= p."lowStockQty"
       ORDER BY qty ASC LIMIT 15`, ctx.branchId)
    for (const l of low) lines.push(`• Low stock: ${l.name} — ${l.qty} left (reorder at ${l.low})`)

    const overdue = await q1<{ n: number; amount: number }>(ctx,
      `SELECT COUNT(*)::int AS n, COALESCE(SUM("grandTotal" - "paidAmt"), 0)::float AS amount
       FROM ${tbl(ctx.schemaName, 'invoices')}
       WHERE "branchId" = $1::uuid AND "txnType" = 'sale_invoice' AND status NOT IN ('cancelled','draft','paid')
         AND "dueDate" IS NOT NULL AND "dueDate" < $2::date AND "grandTotal" - "paidAmt" > 0.5`, ctx.branchId, today)
    if (overdue && overdue.n > 0) lines.push(`• ${overdue.n} overdue bill${overdue.n === 1 ? '' : 's'} — ${inr(overdue.amount)} to collect`)

    const warr = await q1<{ n: number }>(ctx,
      `SELECT COUNT(*)::int AS n FROM ${tbl(ctx.schemaName, 'tyre_warranty')}
       WHERE "branchId" = $1::uuid AND status = 'active' AND "warrantyUntil" BETWEEN $2::date AND ($2::date + 30)`, ctx.branchId, today)
    if (warr && warr.n > 0) lines.push(`• ${warr.n} tyre warrant${warr.n === 1 ? 'y' : 'ies'} expire in the next 30 days`)

    if (lines.length) {
      const r = await sendMessage(ctx, {
        kind: 'owner_alerts', toPhone: ownerPhone, recipientName: 'Owner',
        message: [`*${biz.header.name} — daily alerts*`, ...lines].join('\n'),
        dedupeKey: `owner_alerts:${today}`,
      })
      if (r.status === 'queued') ownerAlerts = lines.length
    }
  }
  void addDays
  return { reminders, serviceDue, ownerAlerts }
}
