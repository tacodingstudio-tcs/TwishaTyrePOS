// apps/api/src/routes/tyre-catalog.ts
// Counter lookups over the shared product catalogue: the size finder, available sizes/brands, and
// the stock-ageing ("dead stock") view. Registered under /api/tyre.
//
// Products live in the billing core's `products` table; tyre attributes are in `domainAttrs` JSON
// (see the registry). Stock on hand is the sum of the core's stock ledger — the same figure the
// invoice service checks before it lets a sale through.

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { normalizeTyreSize, TYRE_VEHICLE_TYPES, ITEM_KINDS, defaultHsn } from '@billing/domain-registry'
import { tbl, q, branchConfig } from '../lib/tyre-helpers.js'

// SQL expression: a stored size reduced to the same canonical spelling normalizeTyreSize() produces.
//   "205/55 ZR16" → 205/55R16 ·  "90/90-17" → 90/90R17 · "10.00 R20" → 10.00R20
const SIZE_KEY = `UPPER(REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(COALESCE(p."domainAttrs"->>'size',''),
  '(?i)[zvhst]r', 'R', 'g'), '-r?', 'R', 'gi'), '[^A-Za-z0-9./]', '', 'g'))`
const SIZE_DIGITS = `REGEXP_REPLACE(COALESCE(p."domainAttrs"->>'size',''), '[^0-9]', '', 'g')`

export const tyreCatalogRoutes: FastifyPluginAsync = async (app) => {

  // GET /api/tyre/finder?size=205/55R16&brand=&vehicleType=&kind=&q=&inStock=true
  // "What have I got in this size, and at what price?" — the question asked at the counter.
  app.get('/finder', async (req) => {
    const qy = z.object({
      size:        z.string().max(30).optional(),
      brand:       z.string().max(60).optional(),
      vehicleType: z.enum(TYRE_VEHICLE_TYPES).optional(),
      kind:        z.enum([...ITEM_KINDS, 'any'] as [string, ...string[]]).default('tyre'),
      q:           z.string().max(80).optional(),
      id:          z.string().uuid().optional(),
      inStock:     z.enum(['true', 'false']).default('false'),
      limit:       z.coerce.number().int().min(1).max(100).default(40),
    }).parse(req.query)

    const params: unknown[] = [req.branchId]
    // kind=service lists the fitting services; every other kind excludes them
    let where = `WHERE p."branchId" = $1::uuid AND p."isActive" = true AND p."itemType" ${qy.kind === 'service' ? '=' : '<>'} 'service'`
    if (qy.id) { params.push(qy.id); where += ` AND p.id = $${params.length}::uuid` }

    if (qy.kind !== 'any' && qy.kind !== 'service') {
      params.push(qy.kind)
      where += ` AND COALESCE(p."domainAttrs"->>'item_kind','tyre') = $${params.length}`
    }
    if (qy.size?.trim()) {
      const key = normalizeTyreSize(qy.size)
      const digits = qy.size.replace(/\D/g, '')
      params.push(`%${key}%`)
      let cond = `${SIZE_KEY} LIKE $${params.length}`
      if (digits.length >= 3) { params.push(`${digits}%`); cond += ` OR ${SIZE_DIGITS} LIKE $${params.length}` }
      where += ` AND (${cond})`
    }
    if (qy.brand?.trim()) { params.push(`%${qy.brand.trim()}%`); where += ` AND p."domainAttrs"->>'brand' ILIKE $${params.length}` }
    if (qy.vehicleType)   { params.push(qy.vehicleType); where += ` AND p."domainAttrs"->>'vehicle_type' = $${params.length}` }
    if (qy.q?.trim()) {
      params.push(`%${qy.q.trim()}%`)
      const n = params.length
      where += ` AND (p.name ILIKE $${n} OR p.sku ILIKE $${n} OR p.barcode ILIKE $${n}
                  OR p."domainAttrs"->>'pattern' ILIKE $${n} OR p."domainAttrs"->>'brand' ILIKE $${n})`
    }

    const having = qy.inStock === 'true' ? `HAVING COALESCE(SUM(sl.qty), 0) > 0` : ''
    params.push(qy.limit)
    const rows = await q(req,
      `SELECT p.id, p.name, p.sku, p.barcode, p."hsnSacCode", p."gstRate"::float AS "gstRate", p.unit,
              p."salePrice"::float AS "salePrice", p.mrp::float AS mrp, p."purchasePrice"::float AS "purchasePrice",
              p."lowStockQty"::float AS "lowStockQty", p."domainAttrs",
              COALESCE(SUM(sl.qty), 0)::float AS stock
       FROM ${tbl(req.schemaName, 'products')} p
       LEFT JOIN ${tbl(req.schemaName, 'stock_ledger')} sl ON sl."productId" = p.id AND sl."branchId" = $1::uuid
       ${where}
       GROUP BY p.id
       ${having}
       ORDER BY (COALESCE(SUM(sl.qty), 0) > 0) DESC, p."domainAttrs"->>'brand', p."salePrice"
       LIMIT $${params.length}`, ...params)

    return {
      data: rows.map((r: any) => ({
        ...r,
        // the HSN this tyre will print under: its own, else the standard one for its vehicle class
        hsn: r.hsnSacCode || defaultHsn(r.domainAttrs?.item_kind ?? 'tyre', r.domainAttrs?.vehicle_type),
        // price floor hint for the counter: never show a margin figure to read-only users
        marginPct: req.role === 'viewer' || !r.purchasePrice || !r.salePrice
          ? null : Math.round(((r.salePrice - r.purchasePrice) / r.salePrice) * 1000) / 10,
      })),
      sizeKey: qy.size ? normalizeTyreSize(qy.size) : null,
    }
  })

  // GET /api/tyre/sizes — distinct sizes in the catalogue, with stock (for filter chips / quick pick)
  app.get('/sizes', async (req) => {
    return q(req,
      // grouped on the canonical key so "155/70 R13" and "155/70R13" are one size, not two chips
      `SELECT COALESCE(NULLIF(MIN(p."domainAttrs"->>'size'),''), '—') AS size,
              COUNT(DISTINCT p.id)::int AS models,
              COALESCE(SUM(sl.qty), 0)::float AS stock
       FROM ${tbl(req.schemaName, 'products')} p
       LEFT JOIN (SELECT "productId", SUM(qty) AS qty FROM ${tbl(req.schemaName, 'stock_ledger')}
                   WHERE "branchId" = $1::uuid GROUP BY "productId") sl ON sl."productId" = p.id
       WHERE p."branchId" = $1::uuid AND p."isActive" = true AND p."itemType" <> 'service'
         AND COALESCE(p."domainAttrs"->>'item_kind','tyre') = 'tyre'
       GROUP BY ${SIZE_DIGITS} ORDER BY stock DESC, size LIMIT 200`, req.branchId)
  })

  // GET /api/tyre/brands — brands in the catalogue (for pickers)
  app.get('/brands', async (req) => {
    return q(req,
      `SELECT p."domainAttrs"->>'brand' AS brand, COUNT(*)::int AS models
       FROM ${tbl(req.schemaName, 'products')} p
       WHERE p."branchId" = $1::uuid AND p."isActive" = true AND COALESCE(p."domainAttrs"->>'brand','') <> ''
       GROUP BY 1 ORDER BY 1`, req.branchId)
  })

  // GET /api/tyre/dead-stock?days=90 — stock that has not sold for N days (money sitting on the shelf)
  app.get('/dead-stock', async (req) => {
    const cfg = await branchConfig(req)
    const qy = z.object({
      days: z.coerce.number().int().min(7).max(720).default(Number(cfg['dead_stock_days'] ?? 90)),
      limit: z.coerce.number().int().min(1).max(1000).default(200),
      offset: z.coerce.number().int().min(0).default(0),
    }).parse(req.query)
    // Tyres that sold inside the window are not dead, so they are ruled out with one cheap date-indexed look-up;
    // only the few that did not sell are then asked for their last sale date. Stock and first receipt come from a
    // single grouped pass over the ledger (the old query probed invoices once per product: 200+ ms at 3,000 tyres).
    const sinceIso = new Date(Date.now() - qy.days * 86_400_000).toISOString().slice(0, 10)
    const rows = await q<any>(req,
      `WITH bal AS (
         SELECT "productId", SUM(qty) AS stock, MIN("createdAt") FILTER (WHERE qty > 0) AS "firstIn"
           FROM ${tbl(req.schemaName, 'stock_ledger')} WHERE "branchId" = $1::uuid GROUP BY "productId"),
       recent AS (
         SELECT DISTINCT ii."productId"
           FROM ${tbl(req.schemaName, 'invoices')} i JOIN ${tbl(req.schemaName, 'invoice_items')} ii ON ii."invoiceId" = i.id
          WHERE i."branchId" = $1::uuid AND i."txnType" = 'sale_invoice' AND i.status <> 'cancelled' AND i.date >= $2::date
            AND ii."productId" IS NOT NULL)
       SELECT p.id, p.name, p."domainAttrs"->>'brand' AS brand, p."domainAttrs"->>'size' AS size,
              bal.stock::float AS stock, p."purchasePrice"::float AS "purchasePrice",
              (bal.stock * COALESCE(p."purchasePrice", 0))::float AS "stockValue",
              ls."lastSold", bal."firstIn",
              COUNT(*) OVER()::int AS "deadCount", (SUM(bal.stock * COALESCE(p."purchasePrice", 0)) OVER())::float AS "deadValue"
       FROM ${tbl(req.schemaName, 'products')} p
       JOIN bal ON bal."productId" = p.id
       LEFT JOIN (
         SELECT ii."productId", MAX(i.date) AS "lastSold"
           FROM ${tbl(req.schemaName, 'invoice_items')} ii JOIN ${tbl(req.schemaName, 'invoices')} i ON i.id = ii."invoiceId"
          WHERE i."txnType" = 'sale_invoice' AND i.status <> 'cancelled' AND ii."productId" IS NOT NULL
          GROUP BY ii."productId") ls ON ls."productId" = p.id
       WHERE p."branchId" = $1::uuid AND p."isActive" = true AND p."trackStock" = true AND p."itemType" <> 'service'
         AND COALESCE(p."domainAttrs"->>'item_kind','tyre') <> 'scrap' AND bal.stock > 0
         AND NOT EXISTS (SELECT 1 FROM recent r WHERE r."productId" = p.id)
         AND COALESCE(ls."lastSold"::timestamptz, bal."firstIn") < $2::date
       ORDER BY "stockValue" DESC, p.id LIMIT $3 OFFSET $4`, req.branchId, sinceIso, qy.limit, qy.offset)

    const dead = rows.map((r) => {
      const ref = r.lastSold ?? r.firstIn
      const t = ref ? new Date(ref).getTime() : 0
      const { deadCount, deadValue, ...row } = r
      return { ...row, idleDays: t ? Math.floor((Date.now() - t) / 86_400_000) : null, neverSold: !r.lastSold }
    })
    return {
      days: qy.days,
      count: rows[0]?.deadCount ?? 0,
      stockValue: Math.round((rows[0]?.deadValue ?? 0) * 100) / 100,
      // the totals above cover every dead tyre; the list is one page of them, biggest money first
      limit: qy.limit, offset: qy.offset,
      data: dead,
    }
  })
}
