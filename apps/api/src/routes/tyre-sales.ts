// apps/api/src/routes/tyre-sales.ts
// The counter sale: tyres (with serial / DOT / fitted position), fitting services, old-tyre exchange,
// split payment — in one call. Registered under /api/tyre.
//
// A sale is a normal `sale_invoice` created through the shared invoice service, so numbering, GST
// split, stock deduction, party balance, payments, aging and GSTR-1 all come for free. This route
// adds what is specific to a tyre shop around it:
//   • warranty register rows — one per serial-numbered unit sold   (tyre_warranty)
//   • the customer's vehicle + "next service due" date             (tyre_vehicles)
//   • old-tyre exchange: allowance settled as a payment of method "exchange", scrap taken into stock
//   • guards: stock check, duplicate serials, selling below cost

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { createHash } from 'crypto'
import {
  DOMAIN_REGISTRY, SERIALISED_KINDS, TYRE_POSITIONS, TYRE_VEHICLE_TYPES, SALE_KINDS, defaultHsn,
} from '@billing/domain-registry'
import { createInvoice, recordPayment } from '../services/invoice.service.js'
import { createParty } from '../services/party.service.js'
import { withIdempotency, IdempotencyConflictError } from '../lib/idempotency.js'
import {
  tbl, q, q1, run, httpError, requireWrite, branchConfig, todayStr, addDays, r2, ymd, type Ctx,
} from '../lib/tyre-helpers.js'
import { notifyInvoice, safely } from '../lib/tyre-notify.js'
import { loadInvoiceDoc } from '../lib/tyre-docs.js'

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
const idParam = z.object({ id: z.string().uuid() })

const SaleItem = z.object({
  productId:      z.string().uuid(),
  qty:            z.number().positive().max(1000),
  rate:           z.number().nonnegative().max(1e7).optional(),      // defaults to the catalogue sale price
  discountPct:    z.number().min(0).max(100).default(0),
  /** the price actually charged per unit (the "Data Entry" box). When it is below the list rate the
   *  difference is recorded as the discount; it wins over discountPct. */
  finalPrice:     z.number().nonnegative().max(1e7).optional(),
  serialNos:      z.array(z.string().trim().min(1).max(40)).max(50).default([]),
  dotCodes:       z.array(z.string().trim().regex(/^\d{4}$/, 'DOT is week + year, e.g. 2325')).max(50).default([]),
  positions:      z.array(z.enum(TYRE_POSITIONS)).max(50).default([]),
  warrantyMonths: z.number().int().min(0).max(120).optional(),
  // service lines (alignment / balancing): wheels done and the readings taken
  wheels:         z.number().int().min(1).max(30).optional(),
  readings:       z.object({
    before: z.record(z.string().max(30), z.string().max(20)).optional(),
    after:  z.record(z.string().max(30), z.string().max(20)).optional(),
  }).optional(),
})

const SaleBody = z.object({
  partyId:    z.string().uuid().optional(),
  customer:   z.object({
    name:  z.string().trim().min(1).max(120),
    phone: z.string().trim().max(15).optional(),
    address: z.string().trim().max(300).optional(),
    gstin: z.string().trim().toUpperCase().max(15).optional(),
  }).optional(),
  vehicleNo:  z.string().trim().max(20).optional(),
  vehicleType: z.enum(TYRE_VEHICLE_TYPES).optional(),
  makeModel:  z.string().trim().max(60).optional(),
  odometer:   z.number().int().nonnegative().max(2_000_000).optional(),
  fittedBy:   z.string().trim().max(80).optional(),
  saleKind:   z.enum(SALE_KINDS).default('retail'),
  /** true = every price typed is what the customer pays per unit, GST included (Data Entry style) */
  /** false = a bill with no GST at all (cash memo): the typed price is the final price, nothing is added or taken out */
  withGst:    z.boolean().default(true),
  pricesIncludeGst: z.boolean().optional(),
  /** register the bill number comes from, e.g. 'car' | 'two_wheel' (see config bill_series) */
  billSeries: z.string().trim().regex(/^[a-z_]{1,20}$/).optional(),
  poNo:       z.string().trim().max(40).optional(),
  poDate:     dateStr.optional(),
  /** free-amount lines added to the bill with no GST: alignment, balancing, weight, labour … */
  charges:    z.array(z.object({
    label:  z.string().trim().min(1).max(60),
    amount: z.number().nonnegative().max(1e6),
  })).max(10).default([]),
  date:       dateStr.optional(),
  creditDays: z.number().int().min(0).max(180).optional(),
  items:      z.array(SaleItem).min(1).max(60),
  exchange:   z.object({
    qty:   z.number().int().min(1).max(50),
    value: z.number().positive().max(1e7),
    note:  z.string().max(200).optional(),
  }).optional(),
  payments:   z.array(z.object({
    method: z.enum(['cash', 'upi', 'card', 'cheque', 'bank_transfer']),
    amount: z.number().positive().max(1e8),
  })).max(5).default([]),
  nextServiceKm:   z.number().int().positive().max(100000).optional(),
  nextServiceDate: dateStr.optional(),
  notes:      z.string().max(500).optional(),
})

const normReg = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '')
const tenDigits = (s: string) => {
  const d = s.replace(/\D/g, '')
  return d.length === 12 && d.startsWith('91') ? d.slice(2) : d.length === 11 && d.startsWith('0') ? d.slice(1) : d
}

function addMonths(dateStrYmd: string, months: number): string {
  const d = new Date(`${dateStrYmd}T00:00:00Z`)
  d.setUTCMonth(d.getUTCMonth() + months)
  return d.toISOString().slice(0, 10)
}

/**
 * When is the next check due, and for what? Each line that implies a follow-up proposes (days, km, label);
 * the earliest wins, so a bill with alignment + balancing reminds for balancing first (3 months).
 * Puncture repair and nitrogen do not start a reminder.
 */
function nextDue(lines: Array<{ kind: string; a: Record<string, any> }>, conf: (k: string) => any):
  { days: number; km: number; label: string } | null {
  const cands: Array<{ days: number; km: number; label: string }> = []
  for (const l of lines) {
    const st = l.a['service_type'] as string | undefined
    if (l.kind === 'tyre') cands.push({ days: Number(conf('service_reminder_days')), km: Number(conf('service_reminder_km')), label: 'Tyre check & alignment' })
    else if (l.kind === 'service' && st === 'alignment') cands.push({ days: Number(conf('alignment_reminder_days')), km: Number(conf('alignment_reminder_km')), label: 'Wheel alignment' })
    else if (l.kind === 'service' && st === 'balancing') cands.push({ days: Number(conf('balancing_reminder_days')), km: Number(conf('balancing_reminder_km')), label: 'Wheel balancing' })
    else if (l.kind === 'service' && (st === 'fitting' || st === 'rotation')) cands.push({ days: Number(conf('service_reminder_days')), km: Number(conf('service_reminder_km')), label: 'Tyre rotation & check' })
  }
  // 0 (or blank) days in the settings means "no reminder for this" — never "due today"
  const live = cands.filter((c) => Number.isFinite(c.days) && c.days > 0)
  if (!live.length) return null
  return live.reduce((a, b) => (b.days < a.days ? b : a))
}

export const tyreSalesRoutes: FastifyPluginAsync = async (app) => {

  // POST /api/tyre/sales
  app.post('/sales', async (req, reply) => {
    requireWrite(req)
    const body = SaleBody.parse(req.body)
    const cfg  = await branchConfig(req)

    const run_ = () => createSale(req, body, cfg)
    const headerKey = (req.headers['idempotency-key'] as string | undefined)?.trim() || undefined
    // Without a client key a double-click must still not sell (and deduct) twice: key on the content
    // plus a 20-second window. A deliberate repeat of the *same* sale a minute later is a new sale.
    const derivedKey = 'tsale:' + createHash('sha1').update(
      JSON.stringify([req.userId, body]) + '|' + Math.floor(Date.now() / 20_000)).digest('hex')
    try {
      const { result, replayed } = await withIdempotency(
        { branchId: req.branchId, endpoint: 'POST /tyre/sales', key: headerKey ?? derivedKey }, run_)
      return reply.status(replayed ? 200 : 201).send(result)
    } catch (err) {
      if (err instanceof IdempotencyConflictError) throw httpError(409, 'This sale is already being saved — wait a moment')
      throw err
    }
  })

  // GET /api/tyre/sales/:id — the bill as the counter sees it: lines, warranty rows, vehicle
  app.get('/sales/:id', async (req) => {
    const { id } = idParam.parse(req.params)
    const { data, invoice } = await loadInvoiceDoc(req, id)
    const warranty = await q(req,
      `SELECT * FROM ${tbl(req.schemaName, 'tyre_warranty')} WHERE "invoiceId" = $1::uuid AND "branchId" = $2::uuid ORDER BY "createdAt", id`,
      id, req.branchId)
    const vehicle = data.vehicleNo
      ? await q1(req, `SELECT * FROM ${tbl(req.schemaName, 'tyre_vehicles')} WHERE "branchId" = $1::uuid AND "regNo" = $2`, req.branchId, normReg(data.vehicleNo))
      : null
    return { invoiceId: id, number: invoice.number, status: invoice.status, summary: data, warranty, vehicle }
  })
}

// ── The sale ──────────────────────────────────────────────────────────────────

async function createSale(req: any, body: z.infer<typeof SaleBody>, cfg: Record<string, any>) {
  const defaults = DOMAIN_REGISTRY.tyre.defaultDomainConfig as Record<string, any>
  const conf = (k: string) => cfg[k] ?? defaults[k]
  const date = body.date ?? todayStr()
  const warnings: string[] = []
  const ctx: Ctx = req

  // ── Products ────────────────────────────────────────────────────────────────
  const ids = [...new Set(body.items.map((i) => i.productId))]
  const prods = await q<any>(req,
    `SELECT p.id, p.name, p.sku, p."hsnSacCode", p."gstRate"::float AS "gstRate", p."gstExempt", p.unit,
            p."salePrice"::float AS "salePrice", p."purchasePrice"::float AS "purchasePrice", p."itemType",
            p."trackStock", p."domainAttrs",
            COALESCE((SELECT SUM(sl.qty) FROM ${tbl(req.schemaName, 'stock_ledger')} sl
                      WHERE sl."productId" = p.id AND sl."branchId" = $1::uuid), 0)::float AS stock
     FROM ${tbl(req.schemaName, 'products')} p
     WHERE p."branchId" = $1::uuid AND p."isActive" = true AND p.id = ANY($2::uuid[])`, req.branchId, ids)
  const byId = new Map(prods.map((p: any) => [p.id, p]))
  const missing = ids.filter((id) => !byId.has(id))
  if (missing.length) throw httpError(404, 'One or more items are not in the catalogue (or are archived)')

  // Stock — aggregated per product, since the same tyre can appear on two lines.
  const wanted = new Map<string, number>()
  for (const it of body.items) wanted.set(it.productId, (wanted.get(it.productId) ?? 0) + it.qty)
  for (const [pid, qty] of wanted) {
    const p = byId.get(pid)
    if (p.itemType === 'service' || !p.trackStock) continue
    if (p.stock < qty) throw httpError(409, `Only ${p.stock} of "${p.name}" in stock — ${qty} requested`)
  }

  // ── Serials ─────────────────────────────────────────────────────────────────
  const seen = new Set<string>()
  for (const it of body.items) {
    const p = byId.get(it.productId)
    const kind = (p.domainAttrs?.item_kind as string | undefined) ?? 'tyre'
    const serialised = p.itemType !== 'service' && SERIALISED_KINDS.includes(kind)
    if (it.serialNos.length > it.qty) throw httpError(422, `"${p.name}": ${it.serialNos.length} serial numbers for ${it.qty} item(s)`)
    if (it.dotCodes.length > it.qty)  throw httpError(422, `"${p.name}": ${it.dotCodes.length} DOT codes for ${it.qty} item(s)`)
    if (!serialised && (it.serialNos.length || it.dotCodes.length || it.positions.length)) {
      throw httpError(422, `"${p.name}" is not a serial-tracked item — remove its serial / DOT / position`)
    }
    if (serialised && conf('serial_required') && kind === 'tyre' && it.serialNos.length !== it.qty) {
      throw httpError(422, `Serial number is required for every unit of "${p.name}" (${it.serialNos.length} of ${it.qty} given)`)
    }
    if (serialised && !Number.isInteger(it.qty)) throw httpError(422, `"${p.name}" must be sold in whole units`)
    for (const s of it.serialNos) {
      const k = `${it.productId}:${s.toUpperCase()}`
      if (seen.has(k)) throw httpError(422, `Serial number ${s} is entered twice`)
      seen.add(k)
    }
  }
  if (seen.size) {
    const serials = body.items.flatMap((i) => i.serialNos.map((s) => s.toUpperCase()))
    const clash = await q<any>(req,
      `SELECT "serialNo", "invoiceNo", "soldOn" FROM ${tbl(req.schemaName, 'tyre_warranty')}
       WHERE "branchId" = $1::uuid AND status <> 'void' AND "productId" = ANY($2::uuid[]) AND UPPER("serialNo") = ANY($3::text[])`,
      req.branchId, ids, serials)
    if (clash.length) {
      throw httpError(409, `Already sold: serial ${clash.map((c: any) => `${c.serialNo} (bill ${c.invoiceNo ?? '—'})`).join(', ')}`)
    }
  }

  // ── Pricing / GST ───────────────────────────────────────────────────────────
  const vehicleType = body.vehicleType
  const inclusive = body.pricesIncludeGst ?? !!conf('prices_include_gst')
  const chargeLines = body.charges.filter((c) => c.amount > 0)
  const chargesTotal = r2(chargeLines.reduce((s, c) => s + c.amount, 0))
  const lines = body.items.map((it) => {
    const p = byId.get(it.productId)
    const a = (p.domainAttrs ?? {}) as Record<string, any>
    const kind: string = p.itemType === 'service' ? 'service' : (a['item_kind'] ?? 'tyre')
    let rate = it.rate ?? p.salePrice
    let discountPct = it.discountPct
    if (it.finalPrice !== undefined) {
      if (rate > 0 && it.finalPrice < rate) discountPct = ((rate - it.finalPrice) / rate) * 100
      else { rate = it.finalPrice; discountPct = 0 }          // charged at or above list: no discount
    }
    // A catalogue GST of 0 on a non-exempt item means "never set" — fall back to the shop default.
    const gstRate = !body.withGst || p.gstExempt ? 0 : p.gstRate > 0 ? p.gstRate
      : Number(kind === 'service' ? conf('default_service_gst') : conf('default_tyre_gst'))
    const warrantyMonths = it.warrantyMonths ?? (Number(a['warranty_months'] ?? 0) || Number(conf('default_warranty_months') ?? 0))
    // net = what one unit costs the shop to compare against purchase price, i.e. without GST
    const net = rate * (1 - discountPct / 100) / (inclusive && gstRate > 0 ? 1 + gstRate / 100 : 1)
    return { it, p, a, kind, rate, discountPct, gstRate, warrantyMonths, net }
  })

  for (const l of lines) {
    if (l.kind !== 'service' && l.p.purchasePrice && l.net < l.p.purchasePrice - 0.005) {
      if (req.role === 'cashier' && !conf('allow_below_cost')) {
        throw httpError(403, `"${l.p.name}" would sell below cost (₹${l.net.toFixed(2)} < ₹${l.p.purchasePrice}) — ask the owner or manager`)
      }
      warnings.push(`"${l.p.name}" is sold below cost (₹${l.net.toFixed(2)} vs ₹${l.p.purchasePrice})`)
    }
  }

  // ── Customer ────────────────────────────────────────────────────────────────
  let partyId = body.partyId
  let customerName: string | null = body.customer?.name ?? null
  let customerPhone: string | null = body.customer?.phone ? tenDigits(body.customer.phone) : null
  if (partyId) {
    const p = await q1<any>(req, `SELECT id, name, phone FROM ${tbl(req.schemaName, 'parties')} WHERE id = $1::uuid`, partyId)
    if (!p) throw httpError(404, 'Customer not found')
    customerName = p.name; customerPhone = p.phone ?? customerPhone
  } else if (body.customer?.phone && customerPhone && /^[6-9]\d{9}$/.test(customerPhone)) {
    const existing = await q1<any>(req, `SELECT id, name FROM ${tbl(req.schemaName, 'parties')} WHERE phone = $1 AND "isActive" = true`, customerPhone)
    if (existing) { partyId = existing.id; customerName = existing.name }
    else {
      const created = await createParty({ type: 'customer', name: body.customer.name, phone: customerPhone, creditLimit: 0, meta: {},
          ...(body.customer.address ? { address: { line1: body.customer.address } } : {}),
          ...(body.customer.gstin?.length === 15 ? { gstin: body.customer.gstin } : {}) },
        { db: req.db, branchId: req.branchId, userId: req.userId, role: req.role } as any)
      partyId = created.id
    }
  }

  // Cheap pre-check so a credit sale never lands on "no customer" — rounding is the core's job.
  const approxTotal = r2(lines.reduce((s, l) => s + l.it.qty * l.net * (1 + l.gstRate / 100), 0) + chargesTotal)
  const paidNow = r2(body.payments.reduce((s, p) => s + p.amount, 0))
  const exchangeValue = body.exchange?.value ?? 0
  if (exchangeValue > approxTotal + 1) throw httpError(422, `Old-tyre allowance (₹${exchangeValue}) is more than the bill (₹${approxTotal})`)
  if (!partyId && paidNow + exchangeValue < approxTotal - 1.5) {
    throw httpError(422, 'Add the customer (name + mobile) to leave a balance on credit — otherwise take the full payment')
  }
  if (paidNow + exchangeValue > approxTotal + 1.5) throw httpError(422, 'Payments are more than the bill total')

  // ── Create the invoice ──────────────────────────────────────────────────────
  const regNo = body.vehicleNo ? normReg(body.vehicleNo) : undefined
  const creditDays = body.creditDays ?? undefined
  const due = nextDue(lines, conf)
  const nextServiceDate = body.nextServiceDate
    ?? (due && regNo ? addDays(date, due.days) : undefined)
  const nextServiceFor = nextServiceDate ? (body.nextServiceDate ? 'Tyre check' : due?.label) : undefined

  let numberSeries: { key: string; prefix: string; start: number } | undefined
  if (body.billSeries) {
    const all = (conf('bill_series') ?? {}) as Record<string, { prefix?: string; start?: number }>
    const one = all[body.billSeries]
    if (!one) throw httpError(422, `Bill series "${body.billSeries}" is not set up — add it in settings (bill_series)`)
    numberSeries = { key: body.billSeries, prefix: one.prefix ?? '', start: Math.max(1, Number(one.start ?? 1)) }
  }

  let invoice: Awaited<ReturnType<typeof createInvoice>>
  try {
  invoice = await createInvoice({
    txnType: 'sale_invoice',
    partyId,
    date,
    dueDate: creditDays != null ? addDays(date, creditDays) : undefined,
    notes: body.notes,
    domainData: {
      sale_kind: body.saleKind,
      vehicle_no: regNo, vehicle_type: vehicleType, odometer: body.odometer, fitted_by: body.fittedBy,
      exchange_qty: body.exchange?.qty ?? 0, exchange_value: exchangeValue,
      next_service_km: body.nextServiceKm ?? (body.odometer && due && due.km > 0 ? body.odometer + due.km : undefined),
      next_service_date: nextServiceDate,
      credit_days: creditDays,
      payment_splits: body.payments,
      source: 'tyre_counter',
      gst_bill: body.withGst ? undefined : false, bill_series: body.billSeries, po_no: body.poNo, po_date: body.poDate,
      vehicle_make: body.makeModel, prices_include_gst: inclusive || undefined,
    },
    aiMeta: {},
    items: [...lines.map((l) => {
      const warrantyUntil = l.warrantyMonths > 0 && l.kind !== 'service' ? addMonths(date, l.warrantyMonths) : undefined
      const sizeLabel = l.a['size'] ? String(l.a['size']) : undefined
      return {
        productId: l.p.id,
        description: l.p.name,
        qty: l.it.qty, unit: l.p.unit ?? 'pcs', rate: l.rate,
        discountPct: l.discountPct, gstRate: l.gstRate, gstExempt: !!l.p.gstExempt || !body.withGst, priceIncludesGst: inclusive,
        hsnSacCode: l.p.hsnSacCode ?? defaultHsn(l.kind, vehicleType ?? l.a['vehicle_type'], String(conf('default_service_sac'))),
        itemMeta: {
          item_kind: l.kind,
          serial_nos: l.it.serialNos, dot_codes: l.it.dotCodes, positions: l.it.positions,
          brand: l.a['brand'], size: sizeLabel,
          warranty_months: l.warrantyMonths || undefined, warranty_until: warrantyUntil,
          service_type: l.kind === 'service' ? l.a['service_type'] : undefined,
          wheels: l.kind === 'service' ? (l.it.wheels ?? undefined) : undefined,
          readings: l.kind === 'service' ? l.it.readings : undefined,
        },
      }
    }), ...chargeLines.map((c) => ({
      description: c.label, qty: 1, unit: 'job', rate: c.amount, discountPct: 0, gstRate: 0, gstExempt: true,
      priceIncludesGst: false, itemMeta: { item_kind: 'charge' },
    }))],
  } as Parameters<typeof createInvoice>[0], {
    db: req.db, branchId: req.branchId, schemaName: req.schemaName,
    userId: req.userId, role: req.role, branchDomainType: 'tyre', numberSeries,
  })
  } catch (err) {
    // Two counters sold the last unit at the same moment: the core's row lock lets one through and
    // rejects the other with a plain Error — report it as a conflict, not a server fault.
    if (/insufficient stock/i.test((err as Error).message)) throw httpError(409, (err as Error).message)
    throw err
  }

  // ── After-sale records — never allowed to lose a sale that is already on the books ─────────
  const result: Record<string, unknown> = { invoice, warnings }

  // Warranty register
  const warrantyRows: any[] = []
  try {
    for (const l of lines) {
      if (l.kind === 'service' || !SERIALISED_KINDS.includes(l.kind)) continue
      if (!(l.warrantyMonths > 0) && l.it.serialNos.length === 0) continue
      const units = Math.round(l.it.qty)
      const until = l.warrantyMonths > 0 ? addMonths(date, l.warrantyMonths) : null
      for (let u = 0; u < units; u++) {
        const dot = l.it.dotCodes[u] ?? (l.it.dotCodes.length === 1 ? l.it.dotCodes[0] : null)
        const row = await q1(req,
          `INSERT INTO ${tbl(req.schemaName, 'tyre_warranty')}
             ("branchId","invoiceId","invoiceNo","productId","itemName","itemKind","brand","size","serialNo","dotCode","position",
              "partyId","customerName","customerPhone","vehicleNo","soldOn","warrantyMonths","warrantyUntil","createdBy")
           VALUES ($1::uuid,$2::uuid,$3,$4::uuid,$5,$6,$7,$8,$9,$10,$11,$12::uuid,$13,$14,$15,$16::date,$17,$18::date,$19::uuid)
           RETURNING *`,
          req.branchId, (invoice as any).id, (invoice as any).number, l.p.id, l.p.name, l.kind,
          l.a['brand'] ?? null, l.a['size'] ?? null, l.it.serialNos[u] ?? null, dot ?? null, l.it.positions[u] ?? null,
          partyId ?? null, customerName, customerPhone, regNo ?? null, date, l.warrantyMonths, until, req.userId)
        warrantyRows.push(row)
      }
    }
  } catch (err) {
    warnings.push(`Warranty register could not be updated: ${(err as Error).message}`)
  }
  result['warranty'] = warrantyRows

  // Vehicle + next-service date
  try {
    if (regNo) {
      const tyreLine = lines.find((l) => l.kind === 'tyre')
      result['vehicle'] = await q1(req,
        `INSERT INTO ${tbl(req.schemaName, 'tyre_vehicles')}
           ("branchId","regNo","partyId","vehicleType","makeModel","tyreSize","ownerName","ownerPhone",
            "lastServiceDate","lastOdometer","nextServiceDate","nextServiceKm","nextServiceFor")
         VALUES ($1::uuid,$2,$3::uuid,$4,$5,$6,$7,$8,$9::date,$10,$11::date,$12,$14)
         ON CONFLICT ("branchId","regNo") DO UPDATE SET
           "partyId"         = COALESCE(EXCLUDED."partyId", ${tbl(req.schemaName, 'tyre_vehicles')}."partyId"),
           "vehicleType"     = COALESCE($13::text, ${tbl(req.schemaName, 'tyre_vehicles')}."vehicleType"),
           "makeModel"       = COALESCE(EXCLUDED."makeModel", ${tbl(req.schemaName, 'tyre_vehicles')}."makeModel"),
           "tyreSize"        = COALESCE(EXCLUDED."tyreSize", ${tbl(req.schemaName, 'tyre_vehicles')}."tyreSize"),
           "ownerName"       = COALESCE(EXCLUDED."ownerName", ${tbl(req.schemaName, 'tyre_vehicles')}."ownerName"),
           "ownerPhone"      = COALESCE(EXCLUDED."ownerPhone", ${tbl(req.schemaName, 'tyre_vehicles')}."ownerPhone"),
           "lastServiceDate" = GREATEST(EXCLUDED."lastServiceDate", ${tbl(req.schemaName, 'tyre_vehicles')}."lastServiceDate"),
           "lastOdometer"    = COALESCE(EXCLUDED."lastOdometer", ${tbl(req.schemaName, 'tyre_vehicles')}."lastOdometer"),
           "nextServiceDate" = COALESCE(EXCLUDED."nextServiceDate", ${tbl(req.schemaName, 'tyre_vehicles')}."nextServiceDate"),
           "nextServiceKm"   = COALESCE(EXCLUDED."nextServiceKm", ${tbl(req.schemaName, 'tyre_vehicles')}."nextServiceKm"),
           "nextServiceFor"  = CASE WHEN EXCLUDED."nextServiceDate" IS NOT NULL THEN EXCLUDED."nextServiceFor" ELSE ${tbl(req.schemaName, 'tyre_vehicles')}."nextServiceFor" END,
           "isActive"        = true,
           "updatedAt"       = NOW()
         RETURNING *`,
        req.branchId, regNo, partyId ?? null, vehicleType ?? 'car', body.makeModel ?? null,
        tyreLine?.a['size'] ?? null, customerName, customerPhone,
        date, body.odometer ?? null, nextServiceDate ?? null,
        (invoice as any).domainData?.next_service_km ?? null, vehicleType ?? null, nextServiceFor ?? null)
    }
  } catch (err) {
    warnings.push(`Vehicle record could not be updated: ${(err as Error).message}`)
  }

  // Old-tyre exchange: allowance as a payment, scrap into stock
  let finalInvoice: any = invoice
  if (body.exchange) {
    try {
      const paid = await recordPayment({
        invoiceId: (invoice as any).id, amount: Math.min(exchangeValue, Number((invoice as any).grandTotal)),
        method: 'exchange', refNo: 'OLD-TYRE',
        notes: `Old tyre exchange ×${body.exchange.qty}${body.exchange.note ? ` — ${body.exchange.note}` : ''}`,
      }, { db: req.db, branchId: req.branchId, schemaName: req.schemaName, userId: req.userId, role: req.role } as any)
      result['exchange'] = { qty: body.exchange.qty, value: exchangeValue, invoiceStatus: paid.invoiceStatus }
      finalInvoice = { ...(invoice as any), paidAmt: (await q1<any>(req, `SELECT "paidAmt" FROM ${tbl(req.schemaName, 'invoices')} WHERE id = $1::uuid`, (invoice as any).id))?.paidAmt, status: paid.invoiceStatus }
      const scrap = await q1<any>(req,
        `SELECT id FROM ${tbl(req.schemaName, 'products')} WHERE "branchId" = $1::uuid AND "isActive" = true
           AND "domainAttrs"->>'item_kind' = 'scrap' ORDER BY "createdAt" LIMIT 1`, req.branchId)
      if (scrap) {
        await run(req,
          `INSERT INTO ${tbl(req.schemaName, 'stock_ledger')} ("id","branchId","productId","txnType",qty,rate,"refType","refId",notes,"createdBy","createdAt")
           VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'adjustment', $3, $4, 'old_tyre_exchange', $5::uuid, $6, $7::uuid, NOW())`,
          req.branchId, scrap.id, body.exchange.qty, r2(exchangeValue / body.exchange.qty), (invoice as any).id,
          `Old tyres taken in against bill ${(invoice as any).number}`, req.userId)
      } else {
        warnings.push('Old tyres were not added to stock — no "scrap" item in the catalogue')
      }
    } catch (err) {
      warnings.push(`Old-tyre allowance could not be recorded: ${(err as Error).message}`)
    }
  }

  // Customer-facing message (opt-in per business; never blocks the sale)
  safely('invoice', notifyInvoice(ctx, (invoice as any).id))

  result['invoice'] = finalInvoice
  void ymd
  return result
}
