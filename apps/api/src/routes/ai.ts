// apps/api/src/routes/ai.ts
// The AI-powered endpoints the screens use: the Home insight card, reorder suggestions and the supplier-bill scan. Every response here is a DRAFT requiring
// human confirmation before it touches invoices, products, or sends
// any message — consistent with the rest of the platform's safety model.

import type { FastifyPluginAsync } from 'fastify'
import { cacheKey, getOrSet } from '../lib/cache.js'
import { redis } from '../lib/redis.js'
import { z } from 'zod'
import { scanBillImage } from '../services/ai/ocrScanner.js'
import { generateDashboardInsight, getReorderSuggestions } from '../services/ai/insights.js'
import { db } from '@billing/db'

export const aiRoutes: FastifyPluginAsync = async (app) => {

  // ── POST /api/ai/extract-supplier-bill ───────────────────────────────────
  // Scans a supplier bill image, extracts supplier + line items, auto-upserts
  // the supplier into the suppliers table, and returns a structured PO draft.
  app.post('/extract-supplier-bill', async (req, reply) => {
    const input = z.object({
      imageBase64: z.string().min(100),
      mediaType:   z.enum(['image/jpeg', 'image/png', 'image/webp']).default('image/jpeg'),
    }).parse(req.body)

    const db       = req.db
    const branchId = req.branchId

    // 1. Vision extraction
    const bill = await scanBillImage(input.imageBase64, input.mediaType)

    // 2. Auto-upsert supplier by GSTIN (most reliable) or fuzzy name match
    let supplier: { id: string; name: string; isNew: boolean } | null = null

    if (bill.supplierName || bill.supplierGstin) {
      // Try GSTIN match first
      if (bill.supplierGstin) {
        const existing = await db.party.findFirst({
          where: { branchId, gstin: bill.supplierGstin, type: 'supplier' },
          select: { id: true, name: true },
        })
        if (existing) {
          supplier = { ...existing, isNew: false }
        }
      }

      // Fuzzy name match if no GSTIN hit
      if (!supplier && bill.supplierName) {
        const candidates = await db.party.findMany({
          where: { branchId, isActive: true, type: 'supplier' },
          select: { id: true, name: true },
        })
        const name = bill.supplierName.toLowerCase()
        const match = candidates.find((s) =>
          s.name.toLowerCase().includes(name) || name.includes(s.name.toLowerCase())
        )
        if (match) supplier = { ...match, isNew: false }
      }

      // Auto-create supplier if not found
      if (!supplier && bill.supplierName) {
        const created = await db.party.create({
          data: {
            branchId,
            type:    'supplier',
            name:    bill.supplierName.trim(),
            gstin:   bill.supplierGstin ?? null,
            phone:   (bill as any).supplierPhone ?? null,
            address: (bill as any).supplierAddress
              ? { line1: (bill as any).supplierAddress }
              : undefined,
            meta: {},
          },
          select: { id: true, name: true },
        })
        supplier = { ...created, isNew: true }
      }
    }

    // 3. Match each item against existing products (by name similarity)
    const items = await Promise.all(
      bill.items.map(async (item) => {
        const products = await db.product.findMany({
          where:  { isActive: true },
          select: { id: true, name: true, unit: true, purchasePrice: true, gstRate: true },
          take:   200,
        })
        const nameLc  = item.name.toLowerCase()
        const matched = products.find(
          (p) => p.name.toLowerCase().includes(nameLc) || nameLc.includes(p.name.toLowerCase())
        )
        const gstRate  = item.gstRate  ?? Number(matched?.gstRate  ?? 0)
        const rate     = item.rate     ?? Number(matched?.purchasePrice ?? 0)
        const qty      = item.qty      ?? 1
        const taxable  = qty * rate
        const cgst     = taxable * gstRate / 200
        return {
          productId:   matched?.id ?? null,
          productName: matched?.name ?? item.name,
          isNewProduct:!matched,
          description: item.name,
          orderedQty:  qty,
          unit:        item.unit   ?? matched?.unit ?? 'pcs',
          rate,
          gstRate,
          taxableAmt:  taxable,
          cgstAmt:     cgst,
          sgstAmt:     cgst,
          igstAmt:     0,
          total:       taxable + cgst * 2,
          hsnCode:     item.hsnCode ?? null,
        }
      })
    )

    return reply.send({
      supplier,
      billNo:      bill.billNo,
      billDate:    bill.billDate,
      items,
      grandTotal:  bill.grandTotal,
      confidence:  bill.confidence,
      needsReview: bill.confidence < 0.75 || items.some((i) => i.isNewProduct) || !supplier,
      newProductCount: items.filter((i) => i.isNewProduct).length,
    })
  })

  // ── GET /api/ai/insight ────────────────────────────────────────────────────
  // Natural language dashboard summary for today
  app.get('/insight', async (req) => {
    // Tenant settings live in the public schema — use the global db client
    const tenant = await db.tenant.findUniqueOrThrow({
      where: { id: req.tenantId }, select: { settings: true },
    })
    const lang = ((tenant.settings as Record<string, unknown>)?.['lang'] as
      'hi' | 'gu' | 'en' | 'mr' | 'ta') ?? 'en'
    try {
      // One model call per branch per 15 minutes (the Home screen asks on every visit); a failure is remembered for 3.
      const downKey = cacheKey(req.schemaName, req.branchId, 'ai', 'insight-down')
      if (await redis.get(downKey).catch(() => null)) return { insights: [], aiUnavailable: true }
      return await getOrSet(cacheKey(req.schemaName, req.branchId, 'ai', 'insight', lang), 900,
        () => generateDashboardInsight(req.tenantId, req.branchId, lang, req.db))
    } catch (err) {
      await redis.setex(cacheKey(req.schemaName, req.branchId, 'ai', 'insight-down'), 180, '1').catch(() => {})
      // No AI provider key / provider outage: the dashboard simply shows no insight card.
      req.log.warn({ err }, 'AI insight unavailable')
      return { insights: [], aiUnavailable: true }
    }
  })

  // ── GET /api/ai/reorder ────────────────────────────────────────────────────
  // Smart reorder suggestions based on stock + sales velocity
  app.get('/reorder', async (req) => {
    const suggestions = await getReorderSuggestions(req.tenantId, req.branchId, req.db)
    // the Stock Levels and Home screens read `.suggestions` — a bare array showed "nothing to reorder"
    return { count: suggestions.length, suggestions }
  })
}
