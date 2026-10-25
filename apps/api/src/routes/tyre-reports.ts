// apps/api/src/routes/tyre-reports.ts
// Home-screen numbers and the three questions a tyre dealer asks: what sells (by size, by brand),
// what it earns, and what is sitting. Registered under /api/tyre.

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { tbl, q, q1, todayStr, addDays, r2, branchConfig, requireManager } from '../lib/tyre-helpers.js'
import { dateStr } from '../lib/validators.js'
import { ensureWarrantySchema } from '../lib/tyre-warranty.js'


const SALE_ITEM_BASE = (s: string) => `
  FROM ${tbl(s, 'invoice_items')} ii
  JOIN ${tbl(s, 'invoices')} i ON i.id = ii."invoiceId"
  LEFT JOIN ${tbl(s, 'products')} p ON p.id = ii."productId"
  WHERE i."branchId" = $1::uuid AND i."txnType" = 'sale_invoice' AND i.status <> 'cancelled'
    AND i."date" BETWEEN $2::date AND $3::date
    AND COALESCE(ii."itemMeta"->>'item_kind','') <> 'charge'`

export const tyreReportRoutes: FastifyPluginAsync = async (app) => {

  // GET /api/tyre/dashboard
  app.get('/dashboard', async (req) => {
    const s = req.schemaName, b = req.branchId
    const today = todayStr()
    const monthStart = `${today.slice(0, 8)}01`
    const cfg = await branchConfig(req)
    const warnDays = Number(cfg['warranty_alert_days'] ?? 30)

    const [day, month, receivable, stock, warranty, due, recent, topSizes] = await Promise.all([
      q1<any>(req,
        `SELECT COUNT(*)::int AS bills, COALESCE(SUM("grandTotal"),0)::float AS amount
         FROM ${tbl(s, 'invoices')} WHERE "branchId" = $1::uuid AND "txnType" = 'sale_invoice' AND status <> 'cancelled' AND date = $2::date`, b, today),
      q1<any>(req,
        `SELECT COUNT(*)::int AS bills, COALESCE(SUM("grandTotal"),0)::float AS amount, COALESCE(SUM("taxableAmt"),0)::float AS taxable
         FROM ${tbl(s, 'invoices')} WHERE "branchId" = $1::uuid AND "txnType" = 'sale_invoice' AND status <> 'cancelled' AND date >= $2::date`, b, monthStart),
      q1<any>(req,
        `SELECT COALESCE(SUM("grandTotal" - "paidAmt") FILTER (WHERE "grandTotal" - "paidAmt" > 0.5), 0)::float AS outstanding,
                COALESCE(SUM("grandTotal" - "paidAmt") FILTER (WHERE "grandTotal" - "paidAmt" > 0.5 AND "dueDate" IS NOT NULL AND "dueDate" < $2::date), 0)::float AS overdue,
                COUNT(*) FILTER (WHERE "grandTotal" - "paidAmt" > 0.5 AND "dueDate" IS NOT NULL AND "dueDate" < $2::date)::int AS "overdueBills"
         FROM ${tbl(s, 'invoices')}
         WHERE "branchId" = $1::uuid AND "txnType" = 'sale_invoice' AND status IN ('confirmed','partial')`, b, today),
      q1<any>(req,
        `WITH st AS (
           SELECT p.id, p."lowStockQty"::float AS low, p."purchasePrice"::float AS cost,
                  COALESCE(bal.qty, 0)::float AS qty
           FROM ${tbl(s, 'products')} p
           LEFT JOIN (SELECT "productId", SUM(qty) AS qty FROM ${tbl(s, 'stock_ledger')} WHERE "branchId" = $1::uuid GROUP BY "productId") bal ON bal."productId" = p.id
           WHERE p."branchId" = $1::uuid AND p."isActive" = true AND p."trackStock" = true AND p."itemType" <> 'service'
             AND COALESCE(p."domainAttrs"->>'item_kind','tyre') <> 'scrap')
         SELECT COALESCE(SUM(qty), 0)::float AS units,
                COALESCE(SUM(GREATEST(qty,0) * COALESCE(cost,0)), 0)::float AS value,
                COUNT(*) FILTER (WHERE low > 0 AND qty <= low AND qty > 0)::int AS "lowItems",
                COUNT(*) FILTER (WHERE qty <= 0)::int AS "outItems",
                COUNT(*)::int AS items
         FROM st`, b),
      q1<any>(req,
        `SELECT COUNT(*) FILTER (WHERE status = 'active')::int AS active,
                COUNT(*) FILTER (WHERE status = 'active' AND "warrantyUntil" BETWEEN $2::date AND $3::date)::int AS expiring,
                COUNT(*) FILTER (WHERE status = 'claimed')::int AS claimed,
                COUNT(*) FILTER (WHERE status = 'claimed' AND "claimOutcome" = 'pending')::int AS pending
         FROM ${tbl(s, 'tyre_warranty')} WHERE "branchId" = $1::uuid`, b, today, addDays(today, warnDays)),
      q1<any>(req,
        `SELECT COUNT(*)::int AS n FROM ${tbl(s, 'tyre_vehicles')}
         WHERE "branchId" = $1::uuid AND "isActive" = true AND "nextServiceDate" IS NOT NULL AND "nextServiceDate" <= $2::date`, b, today),
      q(req,
        `SELECT i.id, i.number, i.date, i.status, i."grandTotal"::float AS "grandTotal", i."paidAmt"::float AS "paidAmt",
                i."domainData"->>'vehicle_no' AS "vehicleNo", p.name AS "partyName"
         FROM ${tbl(s, 'invoices')} i LEFT JOIN ${tbl(s, 'parties')} p ON p.id = i."partyId"
         WHERE i."branchId" = $1::uuid AND i."txnType" = 'sale_invoice' AND i.status <> 'cancelled'
         ORDER BY i.date DESC, i."createdAt" DESC LIMIT 8`, b),
      q(req,
        `SELECT COALESCE(NULLIF(p."domainAttrs"->>'size',''), 'Other') AS size, SUM(ii.qty)::float AS units
         ${SALE_ITEM_BASE(s)} AND p."itemType" <> 'service'
         GROUP BY 1 ORDER BY units DESC LIMIT 5`, b, monthStart, today),
    ])

    const unitRow = await q1<any>(req,
      `SELECT COALESCE(SUM(ii.qty) FILTER (WHERE i.date = $3::date), 0)::float AS today,
              COALESCE(SUM(ii.qty), 0)::float AS month
       ${SALE_ITEM_BASE(s)} AND p."itemType" <> 'service'`, b, monthStart, today)

    return {
      today: { bills: day?.bills ?? 0, amount: day?.amount ?? 0, tyres: unitRow?.today ?? 0 },
      month: { bills: month?.bills ?? 0, amount: month?.amount ?? 0, taxable: month?.taxable ?? 0, tyres: unitRow?.month ?? 0 },
      receivable: { outstanding: receivable?.outstanding ?? 0, overdue: receivable?.overdue ?? 0, overdueBills: receivable?.overdueBills ?? 0 },
      stock: { units: stock?.units ?? 0, value: r2(stock?.value ?? 0), lowItems: stock?.lowItems ?? 0, outItems: stock?.outItems ?? 0, items: stock?.items ?? 0 },
      warranty: { active: warranty?.active ?? 0, expiring: warranty?.expiring ?? 0, claimed: warranty?.claimed ?? 0, pendingClaims: warranty?.pending ?? 0, alertDays: warnDays },
      remindersDue: due?.n ?? 0,
      recent, topSizes,
    }
  })

  // GET /api/tyre/reports/sales?by=size|brand|product|vehicle_type&from=&to=
  app.get('/reports/sales', async (req) => {
    const qy = z.object({
      by:   z.enum(['size', 'brand', 'product', 'vehicle_type']).default('size'),
      from: dateStr.optional(),
      to:   dateStr.optional(),
    }).parse(req.query)
    const today = todayStr()
    const from = qy.from ?? `${today.slice(0, 8)}01`
    const to = qy.to ?? today

    const key = {
      size:         `COALESCE(NULLIF(p."domainAttrs"->>'size',''), 'Other')`,
      brand:        `COALESCE(NULLIF(p."domainAttrs"->>'brand',''), 'Other')`,
      product:      `COALESCE(p.name, ii.description)`,
      vehicle_type: `COALESCE(NULLIF(p."domainAttrs"->>'vehicle_type',''), 'other')`,
    }[qy.by]

    const rows = await q<any>(req,
      `SELECT ${key} AS label,
              SUM(ii.qty)::float                                   AS units,
              COALESCE(SUM(ii."taxableAmt"), 0)::float             AS revenue,
              COALESCE(SUM(ii.qty * COALESCE(p."purchasePrice", 0)), 0)::float AS cost,
              COUNT(DISTINCT i.id)::int                            AS bills
       ${SALE_ITEM_BASE(req.schemaName)} AND COALESCE(p."itemType",'product') <> 'service'
       GROUP BY 1 ORDER BY revenue DESC LIMIT 100`, req.branchId, from, to)

    const data = rows.map((r) => ({
      ...r,
      margin: r2(r.revenue - r.cost),
      marginPct: r.revenue > 0 ? Math.round(((r.revenue - r.cost) / r.revenue) * 1000) / 10 : 0,
    }))
    const total = data.reduce((a, r) => ({ units: a.units + r.units, revenue: a.revenue + r.revenue, cost: a.cost + r.cost }), { units: 0, revenue: 0, cost: 0 })
    return {
      by: qy.by, from, to, data,
      totals: { units: total.units, revenue: r2(total.revenue), margin: r2(total.revenue - total.cost),
                marginPct: total.revenue > 0 ? Math.round(((total.revenue - total.cost) / total.revenue) * 1000) / 10 : 0 },
      note: 'Cost uses each item\'s current purchase price from the catalogue — an estimate, not FIFO/average cost.',
    }
  })

  // GET /api/tyre/reports/claims?from=&to= — warranty claims in a period: how many, what outcome, what they cost, by brand
  // and month, and every claim still waiting for the tyre company (all time). Owner / manager only (it shows amounts).
  app.get('/reports/claims', async (req) => {
    requireManager(req)
    await ensureWarrantySchema(req)
    const qy = z.object({ from: dateStr.optional(), to: dateStr.optional() }).parse(req.query)
    const today = todayStr()
    const from = qy.from ?? `${today.slice(0, 4)}-04-01`
    const to = qy.to ?? today
    const s = req.schemaName
    const IN_RANGE = `w."branchId" = $1::uuid AND w.status = 'claimed' AND (w."claimedAt" AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $2::date AND $3::date`
    const W = tbl(s, 'tyre_warranty')
    const [totals, byOutcome, byBrand, byMonth, rows, pending] = await Promise.all([
      q1<any>(req, `SELECT COUNT(*)::int AS claims, COALESCE(SUM(w."claimAmount"), 0)::float AS amount,
                           COUNT(*) FILTER (WHERE w."claimOutcome" = 'pending')::int AS pending,
                           COUNT(*) FILTER (WHERE w."replacementId" IS NOT NULL)::int AS "replacementsGiven",
                           ROUND(AVG(EXTRACT(EPOCH FROM (w."claimSettledAt" - w."claimedAt")) / 86400) FILTER (WHERE w."claimSettledAt" IS NOT NULL)::numeric, 1)::float AS "avgDaysToDecide"
                    FROM ${W} w WHERE ${IN_RANGE}`, req.branchId, from, to),
      q(req, `SELECT w."claimOutcome" AS outcome, COUNT(*)::int AS claims, COALESCE(SUM(w."claimAmount"), 0)::float AS amount
              FROM ${W} w WHERE ${IN_RANGE} GROUP BY 1 ORDER BY claims DESC`, req.branchId, from, to),
      q(req, `SELECT COALESCE(NULLIF(w.brand, ''), 'Unknown') AS brand, COUNT(*)::int AS claims, COALESCE(SUM(w."claimAmount"), 0)::float AS amount,
                     COUNT(*) FILTER (WHERE w."claimOutcome" = 'rejected')::int AS rejected
              FROM ${W} w WHERE ${IN_RANGE} GROUP BY 1 ORDER BY claims DESC, brand`, req.branchId, from, to),
      q(req, `SELECT to_char(w."claimedAt" AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM') AS month, COUNT(*)::int AS claims, COALESCE(SUM(w."claimAmount"), 0)::float AS amount
              FROM ${W} w WHERE ${IN_RANGE} GROUP BY 1 ORDER BY 1`, req.branchId, from, to),
      q(req, `SELECT w.id, w."serialNo", w."itemName", w.brand, w.size, w."customerName", w."customerPhone", w."invoiceNo",
                     w."claimOutcome" AS outcome, w."claimAmount"::float AS amount, w."claimRef", w."claimNotes",
                     to_char(w."claimedAt" AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS "claimedOn",
                     to_char(w."claimSettledAt" AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS "decidedOn",
                     w."replacementId" IS NOT NULL AS "replacementGiven"
              FROM ${W} w WHERE ${IN_RANGE} ORDER BY w."claimedAt" DESC LIMIT 500`, req.branchId, from, to),
      q(req, `SELECT w.id, w."serialNo", w."itemName", w.brand, w."customerName", w."claimRef",
                     to_char(w."claimedAt" AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS "claimedOn",
                     (CURRENT_DATE - (w."claimedAt" AT TIME ZONE 'Asia/Kolkata')::date)::int AS "waitingDays"
              FROM ${W} w WHERE w."branchId" = $1::uuid AND w.status = 'claimed' AND w."claimOutcome" = 'pending'
              ORDER BY w."claimedAt" LIMIT 200`, req.branchId),
    ])
    return { from, to, totals, byOutcome, byBrand, byMonth, rows, pendingNow: pending }
  })

  // GET /api/tyre/reports/register?from=&to=&series=&format=csv|json
  // The bill register in the order a paper/Excel register keeps it: one row per tyre line,
  // the typed price ("Data Entry") and the four typed charges beside the computed GST columns.
  app.get('/reports/register', async (req, reply) => {
    const qy = z.object({
      from:   dateStr.optional(),
      to:     dateStr.optional(),
      series: z.string().regex(/^[a-z_]{1,20}$/).optional(),
      format: z.enum(['csv', 'json']).default('json'),
    }).parse(req.query)
    const today = todayStr()
    const from = qy.from ?? `${today.slice(0, 4)}-04-01`
    const to = qy.to ?? today
    const s = req.schemaName

    const bills = await q<any>(req,
      `SELECT i.id, i.number, to_char(i.date, 'YYYY-MM-DD') AS date, i.status, i."grandTotal"::float AS "grandTotal", i."domainData" AS dd,
              p.name AS "partyName", p.phone AS "partyPhone", p.gstin AS "partyGstin", p.address AS "partyAddress"
       FROM ${tbl(s, 'invoices')} i LEFT JOIN ${tbl(s, 'parties')} p ON p.id = i."partyId"
       WHERE i."branchId" = $1::uuid AND i."txnType" = 'sale_invoice' AND i.status <> 'cancelled'
         AND i.date BETWEEN $2::date AND $3::date
         AND ($4::text IS NULL OR i."domainData"->>'bill_series' = $4)
       ORDER BY i.date, NULLIF(substring(i.number from '[0-9]+$'), '')::bigint NULLS LAST, i.number LIMIT 5000`,
      req.branchId, from, to, qy.series ?? null)

    const ids = bills.map((b) => b.id)
    const items = ids.length ? await q<any>(req,
      `SELECT "invoiceId", description, "hsnSacCode" AS hsn, qty::float, rate::float, "discountAmt"::float AS disc,
              "taxableAmt"::float AS taxable, "gstRate"::float AS "gstRate", "cgstAmt"::float AS cgst, "sgstAmt"::float AS sgst,
              "igstAmt"::float AS igst, total::float, "itemMeta" AS meta
       FROM ${tbl(s, 'invoice_items')} WHERE "invoiceId" = ANY($1::uuid[]) ORDER BY "invoiceId", "sortOrder", id`, ids) : []
    const byBill = new Map<string, any[]>()
    for (const it of items) { const a = byBill.get(it.invoiceId) ?? []; a.push(it); byBill.set(it.invoiceId, a) }

    const addr = (a: any) => !a ? '' : typeof a === 'string' ? a : [a.line1, a.line2, a.city, a.pincode].filter(Boolean).join(', ')
    // typed charges (imported bills) and service cards (today's bills) both fill those four columns
    const isCharge = (l: any) => l.meta?.item_kind === 'charge' || l.meta?.item_kind === 'service'
    const wordOf = (l: any) => {
      const t = String(l.meta?.service_type ?? '')
      const d = String(l.description).toLowerCase()
      if (/weight/.test(d)) return 'weight'
      if (/labou?r/.test(d)) return 'labour'
      if (t === 'alignment' || /align/.test(d)) return 'align'
      if (t === 'balancing' || /balanc/.test(d)) return 'balanc'
      return 'other'
    }
    const chargeOf = (list: any[], word: string) => r2(list.filter((c) => isCharge(c) && wordOf(c) === word).reduce((t, c) => t + c.total, 0))

    const rows: Array<Record<string, string | number>> = []
    for (const b of bills) {
      const list = byBill.get(b.id) ?? []
      const tyres = list.filter((l) => !isCharge(l))
      const chargeLines = list.filter(isCharge)
      const otherCharges = chargeOf(chargeLines, 'other')
      const lines = tyres.length ? tyres : [null]
      lines.forEach((t, n) => {
        const qty = t?.qty ?? 0
        const unitTaxable = qty > 0 ? r2((t.taxable + t.disc) / qty) : 0
        rows.push({
          'Date': b.date, 'Bill No': b.number, 'Series': b.dd?.bill_series ?? '',
          'Customer': b.partyName ?? b.dd?.customer_name ?? '', 'Mobile': b.partyPhone ?? '', 'Address': addr(b.partyAddress) || (b.dd?.customer_address ?? ''),
          'Vehicle Make': b.dd?.vehicle_make ?? '', 'Vehicle No': b.dd?.vehicle_no ?? '', 'KM': b.dd?.odometer ?? '',
          'Tyre': t?.meta?.brand ?? t?.description ?? '', 'Size': t?.meta?.size ?? '', 'HSN': t?.hsn ?? '',
          'Qty': qty, 'Unit Rate': unitTaxable, 'Discount': t?.disc ?? 0, 'Taxable': t?.taxable ?? 0,
          'CGST %': t ? t.gstRate / 2 : 0, 'CGST': t?.cgst ?? 0, 'SGST %': t ? t.gstRate / 2 : 0, 'SGST': t?.sgst ?? 0,
          'IGST': t?.igst ?? 0, 'Total GST': t ? r2(t.cgst + t.sgst + t.igst) : 0,
          'Tyre Total': t?.total ?? 0,
          'Data Entry': qty > 0 && b.dd?.prices_include_gst ? r2(t.total / qty) : (t?.rate ?? 0),
          'Alignment': n === 0 ? chargeOf(chargeLines, 'align') : 0, 'Balancing': n === 0 ? chargeOf(chargeLines, 'balanc') : 0,
          'Weight': n === 0 ? chargeOf(chargeLines, 'weight') : 0, 'Labour': n === 0 ? chargeOf(chargeLines, 'labour') : 0,
          'Other charges': n === 0 ? otherCharges : 0,
          'Bill Total': n === 0 ? b.grandTotal : '',
          'Customer GST No': b.partyGstin ?? '',
          'GST Bill': b.dd?.gst_bill === false ? 'No' : 'Yes',
        })
      })
    }

    if (qy.format === 'json') return { from, to, count: rows.length, rows }
    const heads = rows[0] ? Object.keys(rows[0]) : ['Date', 'Bill No']
    // A leading apostrophe-free CSV: quote everything with a comma/quote/newline, and neutralise formulas.
    const cell = (v: unknown) => {
      let t = String(v ?? '')
      if (/^[=+\-@\t\r]/.test(t) && !/^-?\d+(\.\d+)?$/.test(t)) t = "'" + t
      return /[",\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t
    }
    const csv = [heads.map(cell).join(','), ...rows.map((r) => heads.map((h) => cell(r[h])).join(','))].join('\r\n')
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="bill-register-${from}-to-${to}.csv"`)
      .send('\uFEFF' + csv)
  })
}
