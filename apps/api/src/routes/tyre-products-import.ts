// apps/api/src/routes/tyre-products-import.ts
// Add many tyres (or tubes, wheels …) at once from an Excel sheet.
//
//   POST /api/tyre/import/products   { rows[], dryRun? }
//
// One row = one item. Rows that match an existing item (same SKU, else same name) are UPDATED
// (prices, reorder level) and the Stock column is ADDED to what is on the shelf; new rows are
// created with that stock as opening stock. dryRun returns the same report without saving, so the
// screen can show a preview before anything changes.

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { ITEM_KINDS, TYRE_VEHICLE_TYPES, normalizeTyreSize, defaultHsn, tyreCategorySlug } from '@billing/domain-registry'
import { createProduct, updateProduct, adjustStock } from '../services/product.service.js'
import { tbl, q, q1, requireManager, branchConfig, httpError } from '../lib/tyre-helpers.js'
import { scanBillImage } from '../services/ai/ocrScanner.js'
import { parseTyreLine } from '../lib/tyre-parse.js'

/** 195/65R15 → "195/65 R15" (the way the catalogue and the bills show it). */
const prettySize = (n: string): string => n.replace(/^(\d{3}\/\d{2})R(\d{2})$/, '$1 R$2')

const KINDS = ITEM_KINDS.filter((k) => !['service', 'scrap', 'charge'].includes(k)) as unknown as [string, ...string[]]

const Row = z.object({
  brand:         z.string().trim().max(60).optional(),
  pattern:       z.string().trim().max(60).optional(),
  size:          z.string().trim().max(40).optional(),
  name:          z.string().trim().max(200).optional(),          // if blank: brand + size + pattern
  kind:          z.enum(KINDS).default('tyre'),
  vehicleType:   z.enum(TYRE_VEHICLE_TYPES).default('car'),
  salePrice:     z.number().nonnegative().max(1e7).optional(),   // GST-inclusive price he types on a bill
  purchasePrice: z.number().nonnegative().max(1e7).optional(),   // before GST
  mrp:           z.number().nonnegative().max(1e7).optional(),
  gstRate:       z.number().min(0).max(28).optional(),
  hsn:           z.string().trim().max(10).optional(),
  stock:         z.number().min(0).max(100000).optional(),       // received now → added to the shelf
  reorderLevel:  z.number().min(0).max(100000).optional(),
  warrantyMonths: z.number().int().min(0).max(120).optional(),
  sku:           z.string().trim().max(60).optional(),
})

const Body = z.object({
  rows:   z.array(Row).min(1).max(500),
  dryRun: z.boolean().default(false),
})

// ── AI scan of a supplier bill ──────────────────────────────────────────────────
/** Is the AI option usable? Switched on in settings AND the server has a way to reach a model. */
function aiConfigured(): boolean {
  switch (process.env['AI_PROVIDER'] ?? 'anthropic') {
    case 'anthropic': return !!process.env['ANTHROPIC_API_KEY']
    case 'gemini':    return !!process.env['GEMINI_API_KEY']
    case 'openai':    return !!process.env['OPENAI_API_KEY']
    default:          return true   // ollama / custom_http run on the shop's own machine or network
  }
}

export const tyreProductImportRoutes: FastifyPluginAsync = async (app) => {
  // GET /api/tyre/import/ai-status — does the screen offer "Scan a bill"?
  app.get('/import/ai-status', async (req: any) => {
    const cfg = await branchConfig(req)
    const enabled = cfg['ai_enabled'] !== false
    return { enabled, configured: aiConfigured(), available: enabled && aiConfigured() }
  })

  // POST /api/tyre/import/scan-bill  { imageBase64, mediaType }
  // Reads a photographed supplier bill into import rows. Nothing is saved: the screen shows them for
  // checking and sends the confirmed rows to /import/products, which does the matching and stock-add.
  app.post('/import/scan-bill', { bodyLimit: 12 * 1024 * 1024 }, async (req: any) => {
    requireManager(req)
    const cfg = await branchConfig(req)
    if (cfg['ai_enabled'] === false) throw httpError(403, 'AI features are switched off for this business (My Business → Edit business)')
    if (!aiConfigured()) throw httpError(503, 'AI is not set up on this server — add the Excel sheet instead')
    const input = z.object({
      imageBase64: z.string().min(100).max(10 * 1024 * 1024),
      mediaType: z.enum(['image/jpeg', 'image/png', 'image/webp']).default('image/jpeg'),
    }).parse(req.body)

    let bill
    try {
      bill = await scanBillImage(input.imageBase64.replace(/^data:[^,]+,/, ''), input.mediaType)
    } catch (err: any) {
      if (err?.statusCode === 422) throw httpError(422, err.message)
      req.log.warn({ err }, 'bill scan failed')
      throw httpError(503, 'Could not reach the AI service (is the internet on?). You can still import from Excel.')
    }

    const rows = bill.items.map((it) => {
      const p = parseTyreLine(it.name)
      const gst = it.gstRate ?? 18
      return {
        brand: p.brand ?? '', size: p.size, pattern: p.pattern ?? '', name: p.brand && p.size ? '' : it.name,
        kind: p.kind, vehicleType: p.vehicleType,
        stock: it.qty ?? 0,
        purchasePrice: it.rate ?? undefined,       // as printed on the supplier's bill (before GST)
        gstRate: gst, hsn: it.hsnCode ?? '',
        billedAs: it.name,
      }
    })
    return {
      supplier: bill.supplierName, billNo: bill.billNo, billDate: bill.billDate,
      grandTotal: bill.grandTotal, confidence: bill.confidence, rows,
      note: 'Check every row before importing — scanned text can be misread. Sale price is left blank for new tyres.',
    }
  })

  app.post('/import/products', async (req: any) => {
    requireManager(req)
    const body = Body.parse(req.body)
    const cfg = await branchConfig(req)
    const defaultGst = Number(cfg['default_tyre_gst'] ?? 18)
    const branch = await req.db.branch.findUniqueOrThrow({ where: { id: req.branchId }, select: { domainType: true } })
    const ctx = { db: req.db, branchId: req.branchId, userId: req.userId, role: req.role, branchDomainType: branch.domainType }
    const P = tbl(req.schemaName, 'products')

    const results: Array<{
      row: number; name: string; action: 'create' | 'update' | 'error'; stockAdded: number; error?: string; productId?: string
    }> = []
    const seen = new Set<string>()

    for (let i = 0; i < body.rows.length; i++) {
      const r = body.rows[i]!
      const isRadial = /^\s*\d{3}\s*[\/\- ]?\s*\d{2}\s*[\/\- ]?\s*[ZVHST]?R?\s*[\/\- ]?\s*\d{2}\s*$/i.test(r.size ?? '')
      const size = r.size ? (r.kind === 'tyre' && isRadial ? prettySize(normalizeTyreSize(r.size) || r.size) : r.size.trim()) : ''
      const name = r.name || [r.brand, size, r.pattern].filter(Boolean).join(' ')
      try {
        if (!name) throw new Error('Needs a name, or a brand and size')
        if (r.kind === 'tyre' && !size && !r.name) throw new Error('Tyre needs a size')
        const sku = r.sku || [r.brand?.slice(0, 3), size.replace(/[^A-Za-z0-9]/g, ''), r.pattern?.slice(0, 3)].filter(Boolean).join('-').toUpperCase() || undefined
        const dupKey = (sku ?? name).toLowerCase()
        if (seen.has(dupKey)) throw new Error('Appears twice in this sheet')
        seen.add(dupKey)

        let existing = await q1<any>(req,
          `SELECT id, name, "salePrice"::float AS "salePrice", "purchasePrice"::float AS "purchasePrice"
           FROM ${P} WHERE "branchId" = $1::uuid AND "isActive" = true
             AND (($2::text IS NOT NULL AND lower(sku) = lower($2)) OR lower(name) = lower($3)) LIMIT 1`,
          req.branchId, sku ?? null, name)

        // same brand + same size written another way (185/65R15 vs 185 65 15) is still the same tyre
        if (!existing && r.brand && size) {
          const want = normalizeTyreSize(size), pat = (r.pattern ?? '').toLowerCase()
          const cands = await q<any>(req,
            `SELECT id, name, "domainAttrs" FROM ${P} WHERE "branchId" = $1::uuid AND "isActive" = true
               AND lower("domainAttrs"->>'brand') = lower($2) AND "domainAttrs"->>'item_kind' = $3`, req.branchId, r.brand, r.kind)
          existing = cands.find((c) => normalizeTyreSize(c.domainAttrs?.size) === want
            && String(c.domainAttrs?.pattern ?? '').toLowerCase() === pat) ?? null
        }

        const stock = r.stock ?? 0
        if (existing) {
          if (!body.dryRun) {
            const patch: Record<string, unknown> = {}
            if (r.salePrice !== undefined) patch['salePrice'] = r.salePrice
            if (r.purchasePrice !== undefined) patch['purchasePrice'] = r.purchasePrice
            if (r.mrp !== undefined) patch['mrp'] = r.mrp
            if (r.reorderLevel !== undefined) patch['lowStockQty'] = r.reorderLevel
            if (Object.keys(patch).length) await updateProduct(existing.id, patch as any, ctx as any)
            if (stock > 0) await adjustStock({ productId: existing.id, qty: stock, reason: 'Stock received', notes: 'Excel import' }, ctx as any)
          }
          results.push({ row: i + 1, name: existing.name, action: 'update', stockAdded: stock, productId: existing.id })
          continue
        }

        if (r.salePrice === undefined) throw new Error('New item needs a sale price')
        const gst = r.gstRate ?? defaultGst
        const attrs: Record<string, unknown> = {
          item_kind: r.kind, brand: r.brand || undefined, size: size || undefined, pattern: r.pattern || undefined,
          vehicle_type: r.vehicleType, ...(r.warrantyMonths !== undefined ? { warranty_months: r.warrantyMonths } : {}),
        }
        if (!body.dryRun) {
          const slug = tyreCategorySlug({ item_kind: r.kind, vehicle_type: r.vehicleType })
          const cat = slug ? await req.db.category.findFirst({ where: { slug, isActive: true }, select: { id: true } }) : null
          const created = await createProduct({
            itemType: 'product', name, sku, unit: 'pcs', trackStock: true, gstRate: gst, gstExempt: false,
            hsnSacCode: r.hsn || defaultHsn(r.kind, r.vehicleType), salePrice: r.salePrice, purchasePrice: r.purchasePrice, mrp: r.mrp,
            lowStockQty: r.reorderLevel ?? 0, openingStock: stock > 0 ? stock : undefined,
            openingRate: r.purchasePrice, categoryId: cat?.id, domainAttrs: attrs,
          } as any, ctx as any)
          results.push({ row: i + 1, name, action: 'create', stockAdded: stock, productId: created.id })
        } else {
          results.push({ row: i + 1, name, action: 'create', stockAdded: stock })
        }
      } catch (err) {
        results.push({ row: i + 1, name: name || `Row ${i + 1}`, action: 'error', stockAdded: 0, error: (err as Error).message.slice(0, 200) })
      }
    }

    const count = (a: string) => results.filter((x) => x.action === a).length
    return {
      dryRun: body.dryRun,
      created: count('create'), updated: count('update'), failed: count('error'),
      stockAdded: results.filter((x) => x.action !== 'error').reduce((s, x) => s + x.stockAdded, 0),
      rows: results,
    }
  })
}

