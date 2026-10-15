// apps/api/src/routes/stock.ts
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { Prisma } from '@billing/db'

export const stockRoutes: FastifyPluginAsync = async (app) => {

  // ── GET /api/stock ──────────────────────────────────────────────────────────
  // Stock balances for all products in this branch.
  // Returns shape expected by StockLevelsPage: { data: [{ id, productId, currentQty,
  // reservedQty, product: { name, unit, sku, lowStockQty, category: { name } } }] }
  app.get('/', async (req) => {
    const { branchId } = req
    const { q, status, limit, offset } = z.object({
      q:      z.string().trim().max(80).optional(),
      status: z.enum(['low', 'out']).optional(),
      limit:  z.coerce.number().int().min(1).max(1000).default(100),
      offset: z.coerce.number().int().min(0).default(0),
    }).parse(req.query)
    const likePattern = q ? `%${q.replace(/[%_]/g, '\\$&')}%` : null

    // Every tracked product with its balance, from ONE grouped pass over the ledger.
    const base = Prisma.sql`
      SELECT p.id, p.name, p.sku, p.unit, p."lowStockQty"::float AS low, p."purchasePrice"::float AS cost,
             c.name AS category, COALESCE(s.qty, 0)::float AS qty
      FROM products p
      LEFT JOIN (SELECT "productId", SUM(qty) AS qty FROM stock_ledger WHERE "branchId" = ${branchId}::uuid GROUP BY "productId") s
             ON s."productId" = p.id
      LEFT JOIN categories c ON c.id = p."categoryId"
      WHERE p."isActive" = true AND p."trackStock" = true AND p."branchId" = ${branchId}::uuid
        AND (${likePattern}::text IS NULL OR p.name ILIKE ${likePattern}::text OR p.sku ILIKE ${likePattern}::text)`

    const [sum] = await req.db.$queryRaw<Array<{ total: number; out: number; low: number; inStock: number; value: number }>>(Prisma.sql`
      WITH st AS (${base})
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE qty <= 0)::int AS out,
             COUNT(*) FILTER (WHERE qty > 0 AND qty <= low)::int AS low,
             COUNT(*) FILTER (WHERE qty > 0)::int AS "inStock",
             COALESCE(SUM(GREATEST(qty, 0) * COALESCE(cost, 0)), 0)::float AS value
      FROM st`)

    const where = status === 'out' ? Prisma.sql`WHERE qty <= 0` : status === 'low' ? Prisma.sql`WHERE qty > 0 AND qty <= low` : Prisma.empty
    const rows = await req.db.$queryRaw<Array<{
      id: string; name: string; sku: string | null; unit: string; low: number; cost: number | null; category: string | null; qty: number
    }>>(Prisma.sql`
      WITH st AS (${base})
      SELECT id::text AS id, name, sku, unit, low, cost, category, qty FROM st ${where}
      ORDER BY name ASC LIMIT ${limit} OFFSET ${offset}`)

    // Same nested shape the screen already reads, plus purchasePrice (the "inventory value" card needs it).
    const data = rows.map((r) => ({
      id: r.id, productId: r.id, currentQty: r.qty, reservedQty: 0,
      product: { name: r.name, sku: r.sku, unit: r.unit, lowStockQty: r.low, purchasePrice: r.cost, category: r.category ? { name: r.category } : null },
    }))
    const matching = status === 'out' ? sum!.out : status === 'low' ? sum!.low : sum!.total
    return {
      data,
      meta: { total: sum!.total, matching, limit, offset, out: sum!.out, low: sum!.low, inStock: sum!.inStock, inventoryValue: Math.round(sum!.value * 100) / 100 },
    }
  })

  // ── GET /api/stock/ledger/:productId ─────────────────────────────────────────
  // Recent stock ledger entries for one product (used by StockLevelsPage drill-down)
  app.get('/ledger/:productId', async (req) => {
    const { productId } = z.object({ productId: z.string().uuid() }).parse(req.params)
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query)
    const { branchId } = req

    const entries = await req.db.stockLedger.findMany({
      where:   { productId, branchId },
      orderBy: { createdAt: 'desc' },
      take:    limit,
    })
    return { data: entries }
  })

  // ── GET /api/stock/low ──────────────────────────────────────────────────────
  // Products currently at or below reorder level
  app.get('/low', async (req) => {
    const { branchId } = req

    const result = await req.db.$queryRaw<Array<{
      productId: string; name: string; sku: string | null; unit: string
      qtyOnHand: number; lowStockQty: number
    }>>`
      SELECT
        p.id::text                       AS "productId",
        p.name,
        p.sku,
        p.unit,
        COALESCE(SUM(sl.qty), 0)::float  AS "qtyOnHand",
        p."lowStockQty"::float           AS "lowStockQty"
      FROM products p
      LEFT JOIN stock_ledger sl
        ON sl."productId" = p.id
        AND sl."branchId" = ${branchId}::uuid
      WHERE p."isActive"   = true
        AND p."trackStock" = true
        AND p."lowStockQty" > 0
      GROUP BY p.id, p.name, p.sku, p.unit, p."lowStockQty"
      HAVING COALESCE(SUM(sl.qty), 0) <= p."lowStockQty"
      ORDER BY (COALESCE(SUM(sl.qty), 0) / NULLIF(p."lowStockQty", 0)) ASC
    `

    return { count: result.length, data: result }
  })

  // ── GET /api/stock/expiry-alerts ────────────────────────────────────────────
  // Batches expiring within ?days (default 90). Sorted by expiry date asc.
  // Designed for pharmacy but works for any domain using batch tracking.
  app.get('/expiry-alerts', async (req) => {
    const { branchId } = req
    const { days = '90' } = req.query as { days?: string }
    const daysAhead = Math.min(Math.max(parseInt(days, 10) || 90, 1), 365)

    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() + daysAhead)

    const batches = await req.db.$queryRaw<Array<{
      batchId: string; batchNo: string; productId: string; productName: string
      sku: string | null; unit: string; expDate: string; daysToExpiry: number
      qtyRemaining: number; urgency: string
    }>>`
      SELECT
        b.id::text                                          AS "batchId",
        b."batchNo",
        p.id::text                                          AS "productId",
        p.name                                              AS "productName",
        p.sku,
        p.unit,
        TO_CHAR(b."expDate", 'YYYY-MM-DD')                  AS "expDate",
        (b."expDate" - CURRENT_DATE)::int                   AS "daysToExpiry",
        b."qtyRemaining"::float                             AS "qtyRemaining",
        CASE
          WHEN b."expDate" < CURRENT_DATE                           THEN 'expired'
          WHEN b."expDate" <= CURRENT_DATE + INTERVAL '30 days'    THEN 'critical'
          WHEN b."expDate" <= CURRENT_DATE + INTERVAL '60 days'    THEN 'warning'
          ELSE                                                           'notice'
        END                                                 AS urgency
      FROM batches b
      JOIN products p ON p.id = b."productId"
      WHERE p."branchId" = ${branchId}::uuid
        AND b."qtyRemaining" > 0
        AND b."expDate" <= ${cutoff}::date
      ORDER BY b."expDate" ASC
    `

    const grouped = {
      expired:  batches.filter(b => b.urgency === 'expired'),
      critical: batches.filter(b => b.urgency === 'critical'),
      warning:  batches.filter(b => b.urgency === 'warning'),
      notice:   batches.filter(b => b.urgency === 'notice'),
    }

    return {
      daysAhead,
      totalBatches: batches.length,
      summary: {
        expired:  grouped.expired.length,
        critical: grouped.critical.length,
        warning:  grouped.warning.length,
        notice:   grouped.notice.length,
      },
      batches: grouped,
    }
  })
}
