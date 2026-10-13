// apps/api/src/lib/tyre-docs.ts
// Loads an invoice (+ its warranty rows) from the tenant schema and renders it to a PDF buffer.
// Shared by the PDF download route and the WhatsApp notifier so both produce identical documents.

import { tbl, q, q1, httpError, type Ctx } from './tyre-helpers.js'
import { renderInvoicePdf, type BusinessHeader, type InvoicePdfData } from './tyre-pdf.js'

const DEFAULT_TERMS = [
  'Goods once sold will not be taken back or exchanged. Tyres once fitted cannot be returned.',
  'Warranty, where applicable, is given by the tyre manufacturer and is subject to their terms; see the warranty card.',
  'Please check the tyre size, brand and serial number before leaving the counter.',
  'Subject to jurisdiction of the seller\'s city courts.',
]

function addrText(a: any): string {
  if (!a) return ''
  if (typeof a === 'string') return a
  return [a.line1, a.line2, a.city, /^\d+$/.test(String(a.state ?? '')) ? null : a.state, a.pincode].filter(Boolean).join(', ')
}

export async function loadBusiness(ctx: Ctx): Promise<{ header: BusinessHeader; config: Record<string, any> }> {
  const b = await q1<any>(ctx,
    `SELECT name, gstin, address, "domainConfig" FROM ${tbl(ctx.schemaName, 'branches')} WHERE id = $1::uuid`, ctx.branchId)
  const owner = await q1<any>(ctx,
    `SELECT phone FROM ${tbl(ctx.schemaName, 'users')} WHERE role = 'owner' AND "isActive" = true ORDER BY "createdAt" LIMIT 1`)
  const config = (b?.domainConfig ?? {}) as Record<string, any>
  return {
    config,
    header: {
      name: String(config['business_name'] ?? b?.name ?? 'Tyre Shop'),
      address: addrText(b?.address) || null,
      gstin: b?.gstin ?? null,
      phone: config['business_phone'] ?? owner?.phone ?? null,
    },
  }
}

/** Invoice + lines + warranty rows, shaped for the PDF. Throws 404 for another business's invoice. */
export async function loadInvoiceDoc(ctx: Ctx, invoiceId: string): Promise<{ data: InvoicePdfData; invoice: any }> {
  const inv = await q1<any>(ctx,
    `SELECT i.*, p.name AS "partyName", p.gstin AS "partyGstin", p.phone AS "partyPhone", p.address AS "partyAddress"
     FROM ${tbl(ctx.schemaName, 'invoices')} i
     LEFT JOIN ${tbl(ctx.schemaName, 'parties')} p ON p.id = i."partyId"
     WHERE i.id = $1::uuid AND i."branchId" = $2::uuid`, invoiceId, ctx.branchId)
  if (!inv) throw httpError(404, 'Invoice not found')

  const items = await q<any>(ctx,
    `SELECT description, "hsnSacCode", qty, unit, rate, "discountAmt", "taxableAmt", "gstRate", total, "itemMeta"
     FROM ${tbl(ctx.schemaName, 'invoice_items')}
     WHERE "invoiceId" = $1::uuid ORDER BY "sortOrder", id`, invoiceId)

  const warranty = await q<any>(ctx,
    `SELECT "itemName", size, "serialNo", "dotCode", position, "warrantyMonths", "warrantyUntil"
     FROM ${tbl(ctx.schemaName, 'tyre_warranty')}
     WHERE "invoiceId" = $1::uuid AND "branchId" = $2::uuid AND status <> 'void'
     ORDER BY "createdAt", id`, invoiceId, ctx.branchId).catch(() => [] as any[])

  const exch = await q1<{ amount: number }>(ctx,
    `SELECT COALESCE(SUM(pa.amount), 0) AS amount
     FROM ${tbl(ctx.schemaName, 'payment_allocations')} pa
     JOIN ${tbl(ctx.schemaName, 'payments')} p ON p.id = pa."paymentId"
     WHERE pa."invoiceId" = $1::uuid AND p.method = 'exchange' AND p.status = 'active'`, invoiceId)

  const dd = (inv.domainData ?? {}) as Record<string, any>
  const { config } = await loadBusiness(ctx)

  const data: InvoicePdfData = {
    number: inv.number, date: inv.date, dueDate: inv.dueDate, status: inv.status,
    partyName: inv.partyName ?? '', partyPhone: inv.partyPhone ?? null, partyGstin: inv.partyGstin ?? null,
    partyAddress: addrText(inv.partyAddress) || null,
    vehicleNo: dd['vehicle_no'] ?? null, odometer: dd['odometer'] ?? null, fittedBy: dd['fitted_by'] ?? null,
    lines: items.map((it) => {
      const m = (it.itemMeta ?? {}) as Record<string, any>
      const reading = (r: Record<string, string> | undefined) => r ? Object.entries(r).map(([k, v]) => `${k} ${v}`).join(', ') : ''
      const detail = [
        m['brand'], m['size'],
        m['wheels'] ? `${m['wheels']} wheel${m['wheels'] === 1 ? '' : 's'}` : null,
        m['readings']?.before ? `Before: ${reading(m['readings'].before)}` : null,
        m['readings']?.after ? `After: ${reading(m['readings'].after)}` : null,
      ].filter(Boolean).join(' · ')
      return {
        description: String(it.description ?? ''),
        hsn: it.hsnSacCode ?? null, qty: Number(it.qty), unit: it.unit ?? null, rate: Number(it.rate),
        discountAmt: Number(it.discountAmt ?? 0), taxable: Number(it.taxableAmt), gstRate: Number(it.gstRate), total: Number(it.total),
        detail: detail || null,
        serials: Array.isArray(m['serial_nos']) ? m['serial_nos'] : [],
        dots: Array.isArray(m['dot_codes']) ? m['dot_codes'] : [],
        positions: Array.isArray(m['positions']) ? m['positions'] : [],
      }
    }),
    subtotal: Number(inv.taxableAmt), discountTotal: Number(inv.discountAmt ?? 0),
    cgstTotal: Number(inv.cgstTotal), sgstTotal: Number(inv.sgstTotal), igstTotal: Number(inv.igstTotal),
    roundOff: Number(inv.roundOff ?? 0), grandTotal: Number(inv.grandTotal), paidAmt: Number(inv.paidAmt),
    exchangeValue: Number(exch?.amount ?? 0), exchangeQty: Number(dd['exchange_qty'] ?? 0),
    notes: inv.notes ?? null,
    terms: config['invoice_terms'] ? String(config['invoice_terms']).split('\n').filter(Boolean) : DEFAULT_TERMS,
    warranty: warranty.map((w) => ({
      itemName: w.itemName, size: w.size, serialNo: w.serialNo, dotCode: w.dotCode, position: w.position,
      warrantyMonths: Number(w.warrantyMonths), warrantyUntil: w.warrantyUntil,
    })),
  }
  return { data, invoice: inv }
}

export async function invoicePdf(ctx: Ctx, invoiceId: string): Promise<{ buffer: Buffer; filename: string; invoice: any; data: InvoicePdfData }> {
  const [{ data, invoice }, biz] = await Promise.all([loadInvoiceDoc(ctx, invoiceId), loadBusiness(ctx)])
  const buffer = await renderInvoicePdf(data, biz.header)
  return { buffer, filename: `Invoice-${String(invoice.number).replace(/[^A-Za-z0-9._-]+/g, '_')}.pdf`, invoice, data }
}
