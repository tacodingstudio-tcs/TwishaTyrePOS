// apps/api/src/routes/tyre-reports.ts
// Home-screen numbers and the three questions a tyre dealer asks: what sells (by size, by brand),
// what it earns, and what is sitting. Registered under /api/tyre.

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { tbl, q, q1, todayStr, addDays, r2, branchConfig } from '../lib/tyre-helpers.js'

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')

const SALE_ITEM_BASE = (s: string) => `
  FROM ${tbl(s, 'invoice_items')} ii
  JOIN ${tbl(s, 'invoices')} i ON i.id = ii."invoiceId"
  LEFT JOIN ${tbl(s, 'products')} p ON p.id = ii."productId"
  WHERE i."branchId" = $1::uuid AND i."txnType" = 'sale_invoice' AND i.status <> 'cancelled'
    AND i."date" BETWEEN $2::date AND $3::date`

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
         WHERE "branchId" = $1::uuid AND "txnType" = 'sale_invoice' AND status NOT IN ('cancelled','draft')`, b, today),
      q1<any>(req,
        `WITH st AS (
           SELECT p.id, p."lowStockQty"::float AS low, p."purchasePrice"::float AS cost,
                  COALESCE((SELECT SUM(sl.qty) FROM ${tbl(s, 'stock_ledger')} sl WHERE sl."productId" = p.id AND sl."branchId" = $1::uuid), 0)::float AS qty
           FROM ${tbl(s, 'products')} p
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
                COUNT(*) FILTER (WHERE status = 'claimed')::int AS claimed
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
      warranty: { active: warranty?.active ?? 0, expiring: warranty?.expiring ?? 0, claimed: warranty?.claimed ?? 0, alertDays: warnDays },
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
}
