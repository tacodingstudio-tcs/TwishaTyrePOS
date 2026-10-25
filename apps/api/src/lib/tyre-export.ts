// Excel export for the shop's accountant (CA): one workbook with a sheet per register, live SUM totals, real dates and
// numbers (so the CA can filter / pivot / paste into GST software), and the shop's name, GSTIN and period on the first
// sheet. Built from the same tables the screens read; cancelled and draft bills never count.
//
//   buildWorkbook(ctx, from, to, only?)   only = a subset of SHEETS; unset = the full "CA pack"

import ExcelJS from 'exceljs'
import { tbl, q, q1, todayStr, type Ctx } from './tyre-helpers.js'
import { loadBusiness } from './tyre-docs.js'

export const SHEETS = ['sales', 'items', 'gstr1', 'hsn', 'notes', 'cancelled', 'purchases', 'expenses', 'payments', 'receivables', 'stock'] as const
export type SheetKey = typeof SHEETS[number]

type Col = { header: string; key: string; width: number; kind?: 'text' | 'date' | 'money' | 'qty' | 'int' | 'rate'; total?: boolean }

const FMT = { money: '#,##0.00;[Red]-#,##0.00', qty: '#,##0.###', int: '0', rate: '0.##"%"', date: 'dd-mm-yyyy' } as const
const dt = (v: unknown): Date | null => { const s = String(v ?? '').slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00Z`) : null }

function sheet(wb: ExcelJS.Workbook, name: string, title: string, cols: Col[], rows: Array<Record<string, unknown>>) {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 3 }], properties: { tabColor: { argb: 'FF16A34A' } } })
  ws.columns = cols.map((c) => ({ key: c.key, width: c.width }))
  ws.mergeCells(1, 1, 1, Math.max(cols.length, 2))
  ws.getCell(1, 1).value = title
  ws.getCell(1, 1).font = { bold: true, size: 13 }
  const head = ws.getRow(3)
  cols.forEach((c, i) => { head.getCell(i + 1).value = c.header })
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } }
  head.alignment = { vertical: 'middle', wrapText: true }
  head.height = 30
  head.eachCell((cell) => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF166534' } } })
  for (const r of rows) {
    const row = ws.addRow(cols.map((c) => (c.kind === 'date' ? dt(r[c.key]) : r[c.key] ?? null)))
    cols.forEach((c, i) => { const cell = row.getCell(i + 1); const f = c.kind && c.kind !== 'text' ? FMT[c.kind] : undefined; if (f) cell.numFmt = f })
  }
  const first = 4, last = 3 + rows.length
  const money = cols.map((c, i) => ({ c, i })).filter((x) => x.c.total)
  if (rows.length && money.length) {
    const t = ws.addRow(cols.map(() => null))
    t.getCell(1).value = 'TOTAL'
    for (const { c, i } of money) {
      const col = ws.getColumn(i + 1).letter
      t.getCell(i + 1).value = { formula: `SUBTOTAL(9,${col}${first}:${col}${last})`, result: rows.reduce((s, r) => s + Number(r[c.key] ?? 0), 0) }
      t.getCell(i + 1).numFmt = FMT[c.kind === 'qty' ? 'qty' : 'money']
    }
    t.font = { bold: true }; t.eachCell((cell) => { cell.border = { top: { style: 'thin' }, bottom: { style: 'double' } } })
  }
  if (rows.length) ws.autoFilter = { from: { row: 3, column: 1 }, to: { row: last, column: cols.length } }
  if (!rows.length) ws.addRow(['No records in this period.'])
  return ws
}

export async function buildWorkbook(ctx: Ctx, from: string, to: string, only?: SheetKey[]): Promise<{ buffer: Buffer; filename: string }> {
  const S = ctx.schemaName
  const want = (k: SheetKey) => !only || only.includes(k)
  const { header } = await loadBusiness(ctx)
  const branch = await q1<any>(ctx, `SELECT "stateCode" FROM ${tbl(S, 'branches')} WHERE id = $1::uuid`, ctx.branchId)
  const homeState = String(branch?.stateCode ?? header.gstin?.slice(0, 2) ?? '24')
  const I = tbl(S, 'invoices'), II = tbl(S, 'invoice_items'), P = tbl(S, 'parties')
  const period = `${from} to ${to}`
  const live = `i."branchId" = $1::uuid AND i.status NOT IN ('draft','cancelled') AND i.date BETWEEN $2::date AND $3::date`
  const gstOnly = `COALESCE(i."domainData"->>'gst_bill','true') <> 'false'`
  const pos = `COALESCE(p.address->>'stateCode', NULLIF(LEFT(p.gstin, 2), ''), '${homeState.replace(/\D/g, '')}')`

  const wb = new ExcelJS.Workbook()
  wb.creator = 'Twisha POS'; wb.created = new Date()
  const summary = wb.addWorksheet('Summary', { properties: { tabColor: { argb: 'FF166534' } } })

  // ── sales register: one row per sale bill ────────────────────────────────────────────────────────────────────
  const sales = await q<any>(ctx, `
    SELECT to_char(i.date, 'YYYY-MM-DD') AS date, i.number, COALESCE(i."domainData"->>'bill_series', '') AS series,
           CASE WHEN ${gstOnly} THEN 'Tax Invoice' ELSE 'Cash Memo (no GST)' END AS kind,
           COALESCE(p.name, i."domainData"->>'customer_name', 'Walk-in') AS customer, COALESCE(p.gstin, '') AS gstin, COALESCE(p.phone, '') AS phone,
           ${pos} AS pos, i."taxableAmt"::float AS taxable, i."cgstTotal"::float AS cgst, i."sgstTotal"::float AS sgst,
           i."igstTotal"::float AS igst, i."roundOff"::float AS round_off, i."grandTotal"::float AS total, i."paidAmt"::float AS paid,
           (i."grandTotal" - i."paidAmt")::float AS balance, i.status
      FROM ${I} i LEFT JOIN ${P} p ON p.id = i."partyId"
     WHERE ${live} AND i."txnType" = 'sale_invoice' ORDER BY i.date, NULLIF(substring(i.number from '[0-9]+$'), '')::bigint NULLS LAST, i.number`, ctx.branchId, from, to)

  if (want('sales')) sheet(wb, 'Sales Register', `Sales register — ${header.name} — ${period}`, [
    { header: 'Date', key: 'date', width: 12, kind: 'date' }, { header: 'Bill No.', key: 'number', width: 16 }, { header: 'Series', key: 'series', width: 9 },
    { header: 'Type', key: 'kind', width: 18 }, { header: 'Customer', key: 'customer', width: 26 }, { header: 'Customer GSTIN', key: 'gstin', width: 18 },
    { header: 'Mobile', key: 'phone', width: 13 }, { header: 'Place of supply (state code)', key: 'pos', width: 12 },
    { header: 'Taxable value', key: 'taxable', width: 14, kind: 'money', total: true }, { header: 'CGST', key: 'cgst', width: 12, kind: 'money', total: true },
    { header: 'SGST', key: 'sgst', width: 12, kind: 'money', total: true }, { header: 'IGST', key: 'igst', width: 12, kind: 'money', total: true },
    { header: 'Round off', key: 'round_off', width: 10, kind: 'money', total: true }, { header: 'Invoice total', key: 'total', width: 14, kind: 'money', total: true },
    { header: 'Received', key: 'paid', width: 13, kind: 'money', total: true }, { header: 'Balance', key: 'balance', width: 13, kind: 'money', total: true },
    { header: 'Status', key: 'status', width: 10 },
  ], sales)

  // ── item lines with HSN ────────────────────────────────────────────────────────────────────────────────────
  const lineSql = (types: string) => `
    SELECT to_char(i.date, 'YYYY-MM-DD') AS date, i.number, COALESCE(p.name, i."domainData"->>'customer_name', 'Walk-in') AS customer,
           ii.description, COALESCE(ii."hsnSacCode", '') AS hsn, ii.qty::float AS qty, COALESCE(ii.unit, 'pcs') AS unit, ii.rate::float AS rate,
           ii."taxableAmt"::float AS taxable, ii."gstRate"::float AS gst_rate, ii."cgstAmt"::float AS cgst, ii."sgstAmt"::float AS sgst,
           ii."igstAmt"::float AS igst, ii.total::float AS total
      FROM ${II} ii JOIN ${I} i ON i.id = ii."invoiceId" LEFT JOIN ${P} p ON p.id = i."partyId"
     WHERE ${live} AND i."txnType" IN (${types}) ORDER BY i.date, i.number, ii."sortOrder"`
  const lines = (want('items') || want('hsn')) ? await q<any>(ctx, lineSql(`'sale_invoice'`), ctx.branchId, from, to) : []
  if (want('items')) sheet(wb, 'Sales Items (HSN)', `Sales — item lines — ${header.name} — ${period}`, [
    { header: 'Date', key: 'date', width: 12, kind: 'date' }, { header: 'Bill No.', key: 'number', width: 16 }, { header: 'Customer', key: 'customer', width: 24 },
    { header: 'Item', key: 'description', width: 34 }, { header: 'HSN / SAC', key: 'hsn', width: 11 }, { header: 'Qty', key: 'qty', width: 8, kind: 'qty', total: true },
    { header: 'Unit', key: 'unit', width: 7 }, { header: 'Rate', key: 'rate', width: 12, kind: 'money' }, { header: 'Taxable value', key: 'taxable', width: 14, kind: 'money', total: true },
    { header: 'GST %', key: 'gst_rate', width: 8, kind: 'rate' }, { header: 'CGST', key: 'cgst', width: 12, kind: 'money', total: true }, { header: 'SGST', key: 'sgst', width: 12, kind: 'money', total: true },
    { header: 'IGST', key: 'igst', width: 12, kind: 'money', total: true }, { header: 'Line total', key: 'total', width: 14, kind: 'money', total: true },
  ], lines)

  // ── GSTR-1 working: B2B (registered buyers) and B2C (everyone else, by rate and state) ─────────────────────────
  if (want('gstr1')) {
    const gst = sales.filter((r) => r.kind === 'Tax Invoice')
    sheet(wb, 'GSTR-1 B2B', `GSTR-1 — B2B (buyers with a GSTIN) — ${header.name} (${header.gstin ?? ''}) — ${period}`, [
      { header: 'GSTIN of buyer', key: 'gstin', width: 18 }, { header: 'Buyer name', key: 'customer', width: 28 }, { header: 'Invoice no.', key: 'number', width: 16 },
      { header: 'Invoice date', key: 'date', width: 12, kind: 'date' }, { header: 'Invoice value', key: 'total', width: 14, kind: 'money', total: true },
      { header: 'Place of supply', key: 'pos', width: 10 }, { header: 'Taxable value', key: 'taxable', width: 14, kind: 'money', total: true },
      { header: 'IGST', key: 'igst', width: 12, kind: 'money', total: true }, { header: 'CGST', key: 'cgst', width: 12, kind: 'money', total: true }, { header: 'SGST', key: 'sgst', width: 12, kind: 'money', total: true },
    ], gst.filter((r) => r.gstin))
    const b2c = await q<any>(ctx, `
      SELECT ${pos} AS pos, ii."gstRate"::float AS gst_rate, COALESCE(SUM(ii."taxableAmt"), 0)::float AS taxable, COALESCE(SUM(ii."cgstAmt"), 0)::float AS cgst,
             COALESCE(SUM(ii."sgstAmt"), 0)::float AS sgst, COALESCE(SUM(ii."igstAmt"), 0)::float AS igst, COUNT(DISTINCT i.id)::int AS bills
        FROM ${II} ii JOIN ${I} i ON i.id = ii."invoiceId" LEFT JOIN ${P} p ON p.id = i."partyId"
       WHERE ${live} AND i."txnType" = 'sale_invoice' AND ${gstOnly} AND COALESCE(p.gstin, '') = ''
       GROUP BY 1, 2 ORDER BY 1, 2`, ctx.branchId, from, to)
    sheet(wb, 'GSTR-1 B2C', `GSTR-1 — B2C (no GSTIN), by place of supply and rate — ${header.name} — ${period}`, [
      { header: 'Place of supply', key: 'pos', width: 12 }, { header: 'GST %', key: 'gst_rate', width: 8, kind: 'rate' }, { header: 'Bills', key: 'bills', width: 8, kind: 'int' },
      { header: 'Taxable value', key: 'taxable', width: 15, kind: 'money', total: true }, { header: 'IGST', key: 'igst', width: 12, kind: 'money', total: true },
      { header: 'CGST', key: 'cgst', width: 12, kind: 'money', total: true }, { header: 'SGST', key: 'sgst', width: 12, kind: 'money', total: true },
    ], b2c)
  }

  // ── HSN summary ─────────────────────────────────────────────────────────────────────────────────────────────
  if (want('hsn')) {
    const map = new Map<string, any>()
    for (const l of lines) {
      const k = `${l.hsn || '—'}|${l.gst_rate}`
      const m = map.get(k) ?? { hsn: l.hsn || '(no HSN)', description: l.description, uqc: 'NOS', gst_rate: l.gst_rate, qty: 0, total: 0, taxable: 0, igst: 0, cgst: 0, sgst: 0 }
      m.qty += l.qty; m.total += l.total; m.taxable += l.taxable; m.igst += l.igst; m.cgst += l.cgst; m.sgst += l.sgst; map.set(k, m)
    }
    sheet(wb, 'HSN Summary', `HSN-wise summary of outward supplies — ${header.name} — ${period}`, [
      { header: 'HSN / SAC', key: 'hsn', width: 12 }, { header: 'Description (first item)', key: 'description', width: 34 }, { header: 'UQC', key: 'uqc', width: 7 },
      { header: 'Total quantity', key: 'qty', width: 12, kind: 'qty', total: true }, { header: 'Total value', key: 'total', width: 15, kind: 'money', total: true },
      { header: 'Taxable value', key: 'taxable', width: 15, kind: 'money', total: true }, { header: 'GST %', key: 'gst_rate', width: 8, kind: 'rate' },
      { header: 'IGST', key: 'igst', width: 12, kind: 'money', total: true }, { header: 'CGST', key: 'cgst', width: 12, kind: 'money', total: true }, { header: 'SGST', key: 'sgst', width: 12, kind: 'money', total: true },
    ], [...map.values()].sort((a, b) => String(a.hsn).localeCompare(String(b.hsn))))
  }

  // ── credit notes / sale returns (shown as negatives) ─────────────────────────────────────────────────────────
  const notes = want('notes') || true ? await q<any>(ctx, `
    SELECT to_char(i.date, 'YYYY-MM-DD') AS date, i.number, CASE i."txnType" WHEN 'credit_note' THEN 'Credit note' ELSE 'Sale return' END AS kind,
           COALESCE(p.name, 'Walk-in') AS customer, COALESCE(p.gstin, '') AS gstin, COALESCE(l.number, '') AS against,
           -i."taxableAmt"::float AS taxable, -i."cgstTotal"::float AS cgst, -i."sgstTotal"::float AS sgst, -i."igstTotal"::float AS igst, -i."grandTotal"::float AS total
      FROM ${I} i LEFT JOIN ${P} p ON p.id = i."partyId" LEFT JOIN ${I} l ON l.id = i."linkedInvoiceId"
     WHERE ${live} AND i."txnType" IN ('credit_note', 'sale_return') ORDER BY i.date, i.number`, ctx.branchId, from, to) : []
  if (want('notes')) sheet(wb, 'Credit Notes & Returns', `Credit notes and sale returns (amounts reduce sales) — ${header.name} — ${period}`, [
    { header: 'Date', key: 'date', width: 12, kind: 'date' }, { header: 'Note no.', key: 'number', width: 16 }, { header: 'Type', key: 'kind', width: 12 },
    { header: 'Customer', key: 'customer', width: 26 }, { header: 'GSTIN', key: 'gstin', width: 18 }, { header: 'Against bill', key: 'against', width: 16 },
    { header: 'Taxable value', key: 'taxable', width: 14, kind: 'money', total: true }, { header: 'CGST', key: 'cgst', width: 12, kind: 'money', total: true },
    { header: 'SGST', key: 'sgst', width: 12, kind: 'money', total: true }, { header: 'IGST', key: 'igst', width: 12, kind: 'money', total: true }, { header: 'Total', key: 'total', width: 14, kind: 'money', total: true },
  ], notes)

  // ── cancelled bills (so a gap in the numbering is explained) ───────────────────────────────────────────────────
  if (want('cancelled')) {
    const rows = await q<any>(ctx, `
      SELECT to_char(i.date, 'YYYY-MM-DD') AS date, i.number, COALESCE(p.name, 'Walk-in') AS customer, i."grandTotal"::float AS total,
             COALESCE(to_char(i."cancelledAt" AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD'), '') AS cancelled_on
        FROM ${I} i LEFT JOIN ${P} p ON p.id = i."partyId"
       WHERE i."branchId" = $1::uuid AND i.status = 'cancelled' AND i."txnType" = 'sale_invoice' AND i.date BETWEEN $2::date AND $3::date ORDER BY i.date, i.number`, ctx.branchId, from, to)
    sheet(wb, 'Cancelled Bills', `Cancelled bills (not counted anywhere else) — ${header.name} — ${period}`, [
      { header: 'Bill date', key: 'date', width: 12, kind: 'date' }, { header: 'Bill no.', key: 'number', width: 16 }, { header: 'Customer', key: 'customer', width: 26 },
      { header: 'Bill value', key: 'total', width: 14, kind: 'money', total: true }, { header: 'Cancelled on', key: 'cancelled_on', width: 13, kind: 'date' },
    ], rows)
  }

  // ── purchases (input tax credit) ────────────────────────────────────────────────────────────────────────────
  const purchases = await q<any>(ctx, `
    SELECT to_char(i.date, 'YYYY-MM-DD') AS date, i.number, COALESCE(p.name, '') AS supplier, COALESCE(p.gstin, '') AS gstin,
           i."taxableAmt"::float AS taxable, i."cgstTotal"::float AS cgst, i."sgstTotal"::float AS sgst, i."igstTotal"::float AS igst,
           i."grandTotal"::float AS total, i."paidAmt"::float AS paid, (i."grandTotal" - i."paidAmt")::float AS balance
      FROM ${I} i LEFT JOIN ${P} p ON p.id = i."partyId"
     WHERE ${live} AND i."txnType" = 'purchase_invoice' ORDER BY i.date, i.number`, ctx.branchId, from, to)
  if (want('purchases')) sheet(wb, 'Purchase Register', `Purchase register (input tax credit) — ${header.name} — ${period}`, [
    { header: 'Date', key: 'date', width: 12, kind: 'date' }, { header: 'Supplier bill no.', key: 'number', width: 18 }, { header: 'Supplier', key: 'supplier', width: 28 },
    { header: 'Supplier GSTIN', key: 'gstin', width: 18 }, { header: 'Taxable value', key: 'taxable', width: 14, kind: 'money', total: true },
    { header: 'CGST', key: 'cgst', width: 12, kind: 'money', total: true }, { header: 'SGST', key: 'sgst', width: 12, kind: 'money', total: true }, { header: 'IGST', key: 'igst', width: 12, kind: 'money', total: true },
    { header: 'Bill total', key: 'total', width: 14, kind: 'money', total: true }, { header: 'Paid', key: 'paid', width: 13, kind: 'money', total: true }, { header: 'Balance', key: 'balance', width: 13, kind: 'money', total: true },
  ], purchases)

  // ── expenses ────────────────────────────────────────────────────────────────────────────────────────────────
  const expenses = await q<any>(ctx, `
    SELECT to_char(e.date, 'YYYY-MM-DD') AS date, e.category, COALESCE(e.description, '') AS description, e.amount::float AS amount,
           COALESCE(e."gstAmount", 0)::float AS gst, e."paymentMode" AS mode, COALESCE(e."referenceNo", '') AS ref
      FROM ${tbl(S, 'expenses')} e WHERE e."branchId" = $1::uuid AND e.date BETWEEN $2::date AND $3::date ORDER BY e.date, e."createdAt"`, ctx.branchId, from, to)
  if (want('expenses')) sheet(wb, 'Expenses', `Expenses — ${header.name} — ${period}`, [
    { header: 'Date', key: 'date', width: 12, kind: 'date' }, { header: 'Category', key: 'category', width: 22 }, { header: 'Description', key: 'description', width: 36 },
    { header: 'Amount', key: 'amount', width: 14, kind: 'money', total: true }, { header: 'GST included', key: 'gst', width: 13, kind: 'money', total: true },
    { header: 'Paid by', key: 'mode', width: 12 }, { header: 'Reference', key: 'ref', width: 16 },
  ], expenses)

  // ── money received ─────────────────────────────────────────────────────────────────────────────────────────
  const payments = await q<any>(ctx, `
    SELECT to_char(pm."paymentDate", 'YYYY-MM-DD') AS date, COALESCE(p.name, 'Walk-in') AS customer, pm.method, pm.amount::float AS amount, COALESCE(pm."refNo", '') AS ref
      FROM ${tbl(S, 'payments')} pm LEFT JOIN ${P} p ON p.id = pm."partyId"
     WHERE pm."branchId" = $1::uuid AND pm.status = 'active' AND pm."paymentDate" BETWEEN $2::date AND $3::date ORDER BY pm."paymentDate", pm."createdAt"`, ctx.branchId, from, to)
  if (want('payments')) sheet(wb, 'Payments Received', `Payments received / paid — ${header.name} — ${period}`, [
    { header: 'Date', key: 'date', width: 12, kind: 'date' }, { header: 'Party', key: 'customer', width: 28 }, { header: 'Mode', key: 'method', width: 14 },
    { header: 'Amount', key: 'amount', width: 14, kind: 'money', total: true }, { header: 'Reference', key: 'ref', width: 18 },
  ], payments)

  // ── customers who still owe money (as of today) ──────────────────────────────────────────────────────────────
  if (want('receivables')) {
    const rows = await q<any>(ctx, `
      SELECT p.name, COALESCE(p.phone, '') AS phone, COALESCE(p.gstin, '') AS gstin, p.balance::float AS balance,
             (SELECT to_char(MIN(i.date), 'YYYY-MM-DD') FROM ${I} i WHERE i."partyId" = p.id AND i."txnType" = 'sale_invoice' AND i.status IN ('confirmed', 'partial')) AS oldest_unpaid
        FROM ${P} p WHERE p."isActive" = true AND p.type IN ('customer', 'both') AND p.balance > 0.5 ORDER BY p.balance DESC`)
    sheet(wb, 'Receivables', `Customers who owe money — as on ${todayStr()} — ${header.name}`, [
      { header: 'Customer', key: 'name', width: 30 }, { header: 'Mobile', key: 'phone', width: 13 }, { header: 'GSTIN', key: 'gstin', width: 18 },
      { header: 'Amount due', key: 'balance', width: 15, kind: 'money', total: true }, { header: 'Oldest unpaid bill', key: 'oldest_unpaid', width: 16, kind: 'date' },
    ], rows)
  }

  // ── stock valuation (as of today) ───────────────────────────────────────────────────────────────────────────
  if (want('stock')) {
    const rows = await q<any>(ctx, `
      SELECT p.name, COALESCE(p."domainAttrs"->>'brand', '') AS brand, COALESCE(p."domainAttrs"->>'size', '') AS size, COALESCE(p.sku, '') AS sku,
             COALESCE(l.qty, 0)::float AS qty, COALESCE(p."purchasePrice", 0)::float AS cost, (COALESCE(l.qty, 0) * COALESCE(p."purchasePrice", 0))::float AS value
        FROM ${tbl(S, 'products')} p
        LEFT JOIN (SELECT "productId", SUM(qty) AS qty FROM ${tbl(S, 'stock_ledger')} WHERE "branchId" = $1::uuid GROUP BY "productId") l ON l."productId" = p.id
       WHERE p."branchId" = $1::uuid AND p."isActive" = true AND p."trackStock" = true AND p."itemType" <> 'service' AND COALESCE(l.qty, 0) <> 0
       ORDER BY value DESC, p.name LIMIT 20000`, ctx.branchId)
    sheet(wb, 'Stock Valuation', `Closing stock at purchase cost — as on ${todayStr()} — ${header.name}`, [
      { header: 'Item', key: 'name', width: 36 }, { header: 'Brand', key: 'brand', width: 14 }, { header: 'Size', key: 'size', width: 14 }, { header: 'SKU', key: 'sku', width: 14 },
      { header: 'Quantity', key: 'qty', width: 10, kind: 'qty', total: true }, { header: 'Cost / unit', key: 'cost', width: 13, kind: 'money' }, { header: 'Stock value', key: 'value', width: 15, kind: 'money', total: true },
    ], rows)
  }

  // ── first sheet: the shop, the period, and the headline numbers ────────────────────────────────────────────────
  const sum = (rs: any[], k: string) => rs.reduce((s, r) => s + Number(r[k] ?? 0), 0)
  const gstSales = sales.filter((r) => r.kind === 'Tax Invoice')
  const outTax = sum(gstSales, 'cgst') + sum(gstSales, 'sgst') + sum(gstSales, 'igst') + sum(notes, 'cgst') + sum(notes, 'sgst') + sum(notes, 'igst')
  const inTax = sum(purchases, 'cgst') + sum(purchases, 'sgst') + sum(purchases, 'igst')
  const rowsOut: Array<[string, string | number | null, string?]> = [
    ['Business', header.name], ['GSTIN', header.gstin ?? ''], ['Address', header.address ?? ''], ['Period', period], ['Prepared on', todayStr()], ['', null],
    ['SALES', null], ['Tax invoices (count)', gstSales.length], ['Cash memos without GST (count)', sales.length - gstSales.length],
    ['Taxable value of tax invoices', sum(gstSales, 'taxable'), 'money'], ['CGST collected', sum(gstSales, 'cgst'), 'money'], ['SGST collected', sum(gstSales, 'sgst'), 'money'], ['IGST collected', sum(gstSales, 'igst'), 'money'],
    ['Total billed (all sale bills)', sum(sales, 'total'), 'money'], ['Credit notes / returns (tax)', sum(notes, 'cgst') + sum(notes, 'sgst') + sum(notes, 'igst'), 'money'], ['', null],
    ['PURCHASES', null], ['Purchase bills (count)', purchases.length], ['Taxable value of purchases', sum(purchases, 'taxable'), 'money'], ['Input tax (CGST + SGST + IGST)', inTax, 'money'], ['', null],
    ['GST POSITION', null], ['Output tax (after credit notes)', outTax, 'money'], ['Input tax credit', inTax, 'money'], ['Net GST payable / (credit)', outTax - inTax, 'money'], ['', null],
    ['MONEY', null], ['Received in the period', sum(payments, 'amount'), 'money'], ['Expenses in the period', sum(expenses, 'amount'), 'money'],
    ['', null], ['Sheets in this file', 'Sales Register · Sales Items (HSN) · GSTR-1 B2B / B2C · HSN Summary · Credit Notes · Cancelled Bills · Purchase Register · Expenses · Payments · Receivables · Stock Valuation'],
    ['Note', 'Prepared from the shop’s billing data for the accountant to check; filing is done on the GST portal. Cancelled and draft bills are never counted.'],
  ]
  summary.getColumn(1).width = 36; summary.getColumn(2).width = 70
  summary.mergeCells('A1:B1'); summary.getCell('A1').value = `${header.name} — accountant pack`; summary.getCell('A1').font = { bold: true, size: 15, color: { argb: 'FF166534' } }
  let r = 3
  for (const [k, v, f] of rowsOut) {
    const row = summary.getRow(r++); row.getCell(1).value = k; if (v !== null) row.getCell(2).value = v as any
    if (v === null && k) { row.getCell(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }; row.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF166534' } }; row.getCell(2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF166534' } } }
    else { row.getCell(1).font = { bold: /Net GST/.test(k) }; if (f === 'money') { row.getCell(2).numFmt = FMT.money; row.getCell(2).alignment = { horizontal: 'left' } } }
    if (/Note|Sheets|Address/.test(k)) row.getCell(2).alignment = { wrapText: true, vertical: 'top' }
  }

  const safe = header.name.replace(/[^A-Za-z0-9 _-]/g, '').trim().replace(/\s+/g, ' ') || 'Shop'
  const buffer = Buffer.from(await wb.xlsx.writeBuffer())
  return { buffer, filename: `${safe} - ${only?.length === 1 ? only[0] : 'CA pack'} ${from} to ${to}.xlsx` }
}
