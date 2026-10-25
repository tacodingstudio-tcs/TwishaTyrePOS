// apps/api/src/services/ai/insights.ts
//
// Four AI features:
//   1. dashboardInsight   — natural language daily summary for the owner
//   2. reorderSuggestions — what to reorder and how much based on sales velocity
//   3. anomalyDetection   — duplicate/suspicious invoices flagged before saving
//   4. creditRisk         — per-customer payment reliability score

import { db } from '@billing/db'
import { ai, parseAIJson } from '../../lib/ai-provider.js'
import { z } from 'zod'

// ─────────────────────────────────────────────────────────────────────────────
// 1. Dashboard Insight — natural language summary
// ─────────────────────────────────────────────────────────────────────────────

const DashboardInsightSchema = z.object({
  headline:  z.string().max(120),
  insights:  z.array(z.string().max(200)).max(4),
  alert:     z.string().max(200).nullable(),
})

export type DashboardInsight = z.infer<typeof DashboardInsightSchema>

export async function generateDashboardInsight(
  tenantId: string,
  branchId: string,
  lang: 'hi' | 'gu' | 'en' | 'mr' | 'ta' = 'en',
  tenantDb?: typeof db,
): Promise<DashboardInsight> {
  const client = tenantDb ?? db
  // Gather last 7 days revenue + today stats
  const [weekly, today, topProducts, overdueCount] = await Promise.all([
    client.$queryRaw<Array<{ day: string; revenue: number; count: number }>>`
      SELECT
        DATE("date")::text AS day,
        COALESCE(SUM("grandTotal"), 0)::float AS revenue,
        COUNT(*)::int AS count
      FROM invoices
      WHERE "branchId" = ${branchId}::uuid
        AND "date" >= NOW() - INTERVAL '7 days'
        AND "txnType" = 'sale_invoice'
      GROUP BY DATE("date")
      ORDER BY day DESC
    `,
    client.$queryRaw<Array<{ total: number; count: number; received: number }>>`
      SELECT
        COALESCE(SUM("grandTotal"), 0)::float AS total,
        COUNT(*)::int AS count,
        COALESCE(SUM("paidAmt"), 0)::float AS received
      FROM invoices
      WHERE "branchId" = ${branchId}::uuid
        AND DATE("date") = CURRENT_DATE
        AND "txnType" = 'sale_invoice'
    `,
    client.$queryRaw<Array<{ name: string; qty: number; revenue: number }>>`
      SELECT p.name, SUM(ii.qty)::float AS qty, SUM(ii.total)::float AS revenue
      FROM "invoice_items" ii
      JOIN products p ON p.id = ii."productId"
      JOIN invoices i ON i.id = ii."invoiceId"
      WHERE i."branchId" = ${branchId}::uuid
        AND i."date" >= NOW() - INTERVAL '7 days'
      GROUP BY p.name
      ORDER BY revenue DESC
      LIMIT 3
    `,
    client.$queryRaw<Array<{ cnt: number }>>`
      SELECT COUNT(*)::int AS cnt FROM parties
      WHERE balance > 0
    `,
  ])

  const todayData  = today[0] ?? { total: 0, count: 0, received: 0 }
  const prevDay    = weekly[1]
  const pctChange  = prevDay && prevDay.revenue > 0
    ? Math.round(((weekly[0]?.revenue ?? 0) - prevDay.revenue) / prevDay.revenue * 100)
    : null

  const context = `
Today: ₹${todayData.total.toFixed(0)} revenue, ${todayData.count} invoices, ₹${todayData.received.toFixed(0)} collected.
${pctChange !== null ? `vs yesterday: ${pctChange > 0 ? '+' : ''}${pctChange}%` : ''}
Top products (7d): ${topProducts.map((p) => `${p.name} ₹${p.revenue.toFixed(0)}`).join(', ')}
Customers with pending balance: ${overdueCount[0]?.cnt ?? 0}
`

  const raw = await ai.chat({
    system: `You are a business intelligence assistant for an Indian small business billing app.
Given today's sales data, write a brief, friendly, actionable summary for the shop owner.
Respond in ${lang === 'en' ? 'English' : lang === 'hi' ? 'Hindi' : lang === 'gu' ? 'Gujarati' : lang}.
Return ONLY JSON: { "headline": "one short sentence summary", "insights": ["up to 4 bullet observations"], "alert": "one urgent alert if any, else null" }
Keep each insight under 15 words. Be specific with numbers. Sound like a helpful colleague, not a robot.`,
    prompt: context,
    maxTokens: 400,
    quality: 'fast',
  })

  try {
    const parsed = parseAIJson<unknown>(raw)
    const result = DashboardInsightSchema.safeParse(parsed)
    if (result.success) return result.data
  } catch {}

  return {
    headline: `Today's revenue: ₹${todayData.total.toFixed(0)} from ${todayData.count} invoices`,
    insights: [],
    alert: null,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Reorder Suggestions
// ─────────────────────────────────────────────────────────────────────────────

const ReorderSuggestionSchema = z.object({
  productId:   z.string(),
  productName: z.string(),
  currentStock:z.number(),
  lowStockQty: z.number(),
  avgDailySales:z.number(),
  daysLeft:    z.number(),
  suggestedQty:z.number(),
  unit:        z.string().optional(),
  purchasePrice:z.number().optional(),
  reason:      z.string(),
  urgency:     z.enum(['critical', 'high', 'medium']),
})

export type ReorderSuggestion = z.infer<typeof ReorderSuggestionSchema>

export async function getReorderSuggestions(
  tenantId: string,
  branchId: string,
  tenantDb?: typeof db,
): Promise<ReorderSuggestion[]> {
  // Use tenant-scoped db when available (avoids cross-schema query issues)
  const client = tenantDb ?? db
  // Get low-stock products with 7-day sales velocity
  const products = await client.$queryRaw<Array<{
    id: string; name: string; unit: string | null; purchase_price: number | null; stock: number; low_stock_qty: number
    avg_daily_sales: number
  }>>`
    SELECT
      p.id::text,
      p.name,
      p.unit,
      p."purchasePrice"::float AS purchase_price,
      COALESCE(SUM(sl.qty), 0)::float AS stock,
      p."lowStockQty"::float AS low_stock_qty,
      COALESCE(
        ABS(SUM(CASE WHEN sl."txnType" = 'sale' AND sl."createdAt" >= NOW() - INTERVAL '7 days'
                THEN sl.qty ELSE 0 END)) / 7.0,
        0
      )::float AS avg_daily_sales
    FROM products p
    LEFT JOIN stock_ledger sl ON sl."productId" = p.id AND sl."branchId" = ${branchId}::uuid
    WHERE p."branchId" = ${branchId}::uuid
      AND p."trackStock" = true
      AND p."isActive" = true
      AND p."lowStockQty" > 0          -- no reorder level set = not something to reorder (e.g. scrap)
    GROUP BY p.id, p.name, p.unit, p."purchasePrice", p."lowStockQty"
    HAVING COALESCE(SUM(sl.qty), 0) <= p."lowStockQty" * 1.5
    ORDER BY stock ASC
    LIMIT 20
  `

  return products.map((p) => {
    const daysLeft   = p.avg_daily_sales > 0 ? Math.floor(p.stock / p.avg_daily_sales) : 999
    // Suggest enough stock for 14 days of sales
    const suggestedQty = Math.max(
      Math.ceil(p.avg_daily_sales * 14) - p.stock,
      Math.ceil(p.low_stock_qty * 2),
    )
    const urgency: ReorderSuggestion['urgency'] =
      daysLeft <= 2 ? 'critical' : daysLeft <= 5 ? 'high' : 'medium'

    const reason =
      daysLeft <= 2
        ? `Only ${daysLeft} day${daysLeft === 1 ? '' : 's'} of stock left at current sales rate`
        : p.avg_daily_sales > 0
        ? `Selling ~${p.avg_daily_sales.toFixed(1)} units/day, ${daysLeft} days left`
        : `Below low stock threshold (${p.low_stock_qty} ${p.stock < p.low_stock_qty ? '— already below' : '— close'})`

    return {
      productId:    p.id,
      productName:  p.name,
      currentStock: p.stock,
      lowStockQty:  p.low_stock_qty,
      avgDailySales:+p.avg_daily_sales.toFixed(2),
      daysLeft:     daysLeft === 999 ? -1 : daysLeft,
      suggestedQty,
      unit:         p.unit ?? undefined,
      purchasePrice: p.purchase_price ?? undefined,
      reason,
      urgency,
    }
  })
}
