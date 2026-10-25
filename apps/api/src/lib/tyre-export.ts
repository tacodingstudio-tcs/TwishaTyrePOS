// Excel export for the shop's accountant (CA): one workbook with a sheet per register, live SUM totals, real dates and
// numbers (so the CA can filter / pivot / paste into GST software), and the shop's name, GSTIN and period on the first
// sheet. Built from the same tables the screens read; cancelled and draft bills never count.
//
//   buildWorkbook(ctx, from, to, only?)   only = a subset of SHEETS; unset = the full "CA pack"
//
// Memory: a busy shop has tens of thousands of bills a year, so nothing is held whole. Every register is read from the
// database in pages of PAGE rows and written straight into a streaming workbook (a temporary file), and the Summary
// sheet comes from SQL totals — a 60,000-bill year stays within a few tens of MB instead of about 1 GB.

import ExcelJS from 'exceljs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFile, unlink } from 'node:fs/promises'
import { tbl, q, q1, todayStr, type Ctx } from './tyre-helpers.js'
import { loadBusiness } from './tyre-docs.js'

export const SHEETS = ['sales', 'items', 'gstr1', 'hsn', 'notes', 'cancelled', 'purchases', 'expenses', 'payments', 'receivables', 'stock'] as const
export type SheetKey = typeof SHEETS[number]

type Col = { header: string; key: string; width: number; kind?: 'text' | 'date' | 'money' | 'qty' | 'int' | 'rate'; total?: boolean }
type Row = Record<string, unknown>
/** reads one page of a register (offset, limit) — an empty page ends it */
type Page = (offset: number, limit: number) => Promise<Row[]>

const PAGE = 5000
const FMT = { money: '#,##0.00;[Red]-#,##0.00', qty: '#,##0.###', int: '0', rate: '0.##"%"', date: 'dd-mm-yyyy' } as const
const dt = (v: unknown): Date | null => { const s = String(v ?? '').slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00Z`) : null }
const GREEN = 'FF166534'

type Writer = ExcelJS.stream.xlsx.WorkbookWriter

/** one register: title, header, rows written as they are read, a SUBTOTAL row, filter — then the sheet is closed */
async function streamSheet(wb: Writer, name: string, title: string, cols: Col[], page: Page): Promise<void> {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 3 }], properties: { tabColor: { argb: 'FF16A34A' } } })
  ws.columns = cols.map((c) => ({ key: c.key, width: c.width }))
  const t = ws.addRow([title]); t.getCell(1).font = { bold: true, size: 13 }; t.commit()
  ws.addRow([]).commit()
  const head = ws.addRow(cols.map((c) => c.header))
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } }
  head.alignment = { vertical: 'middle', wrapText: true }
  head.height = 30
  head.eachCell((cell) => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GREEN } } })
  head.commit()

  const sums = cols.map(() => 0)
  let n = 0
  for (let off = 0; ; off += PAGE) {
    const rows = await page(off, PAGE)
    for (const r of rows) {
      const row = ws.addRow(cols.map((c) => (c.kind === 'date' ? dt(r[c.key]) : r[c.key] ?? null)))
      cols.forEach((c, i) => {
        const f = c.kind && c.kind !== 'text' ? FMT[c.kind] : undefined
        if (f) row.getCell(i + 1).numFmt = f
        if (c.total) sums[i]! += Number(r[c.key] ?? 0)
      })
      row.commit(); n++
    }
    if (rows.length < PAGE) break
  }
  const first = 4, last = 3 + n
  if (n && cols.some((c) => c.total)) {
    const tr = ws.addRow(cols.map(() => null))
    tr.getCell(1).value = 'TOTAL'
    cols.forEach((c, i) => {
      if (!c.total) return
      const L = ws.getColumn(i + 1).letter
      tr.getCell(i + 1).value = { formula: `SUBTOTAL(9,${L}${first}:${L}${last})`, result: sums[i]! }
      tr.getCell(i + 1).numFmt = FMT[c.kind === 'qty' ? 'qty' : 'money']
    })
    tr.font = { bold: true }; tr.eachCell((cell) => { cell.border = { top: { style: 'thin' }, bottom: { style: 'double' } } })
    tr.commit()
  }
  if (n) ws.autoFilter = { from: { row: 3, column: 1 }, to: { row: last, column: cols.length } }
  else ws.addRow(['No records in this period.']).commit()
  await ws.commit()
}

/** a small register that is read in one go */
const once = (rows: () => Promise<Row[]>): Page => { let done: Row[] | null = null; return async (off) => (off > 0 ? [] : (done ??= await rows())) }

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
  const paged = (sql: string, ...params: unknown[]): Page => (off, lim) => q<any>(ctx, `${sql} LIMIT ${lim} OFFSET ${off}`, ...params)

  // ── headline numbers, straight from SQL (the Summary sheet is the first sheet, so these come first) ────────────────
  const sa = (await q1<any>(ctx, `
    SELECT COUNT(*) FILTER (WHERE ${gstOnly})::int AS gst_n, COUNT(*) FILTER (WHERE NOT (${gstOnly}))::int AS memo_n,
           COALESCE(SUM(i."taxableAmt") FILTER (WHERE ${gstOnly}), 0)::float AS taxable, COALESCE(SUM(i."cgstTotal") FILTER (WHERE ${gstOnly}), 0)::float AS cgst,
           COALESCE(SUM(i."sgstTotal") FILTER (WHERE ${gstOnly}), 0)::float AS sgst, COALESCE(SUM(i."igstTotal") FILTER (WHERE ${gstOnly}), 0)::float AS igst,
           COALESCE(SUM(i."grandTotal"), 0)::float AS total
      FROM ${I} i WHERE ${live} AND i."txnType" = 'sale_invoice'`, ctx.branchId, from, to)) ?? {}
  const na = (await q1<any>(ctx, `
    SELECT COALESCE(-SUM(i."cgstTotal" + i."sgstTotal" + i."igstTotal"), 0)::float AS tax
      FROM ${I} i WHERE ${live} AND i."txnType" IN ('credit_note', 'sale_return')`, ctx.branchId, from, to)) ?? {}
  const pa = (await q1<any>(ctx, `
    SELECT COUNT(*)::int AS n, COALESCE(SUM(i."taxableAmt"), 0)::float AS taxable, COALESCE(SUM(i."cgstTotal" + i."sgstTotal" + i."igstTotal"), 0)::float AS tax
      FROM ${I} i WHERE ${live} AND i."txnType" = 'purchase_invoice'`, ctx.branchId, from, to)) ?? {}
  const rcv = (await q1<any>(ctx, `
    SELECT COALESCE(SUM(amount), 0)::float AS s FROM ${tbl(S, 'payments')} WHERE "branchId" = $1::uuid AND status = 'active' AND "paymentDate" BETWEEN $2::date AND $3::date`, ctx.branchId, from, to))?.s ?? 0
  const exp = (await q1<any>(ctx, `
    SELECT COALESCE(SUM(amount), 0)::float AS s FROM ${tbl(S, 'expenses')} WHERE "branchId" = $1::uuid AND date BETWEEN $2::date AND $3::date`, ctx.branchId, from, to))?.s ?? 0

  const file = join(tmpdir(), `capack-${randomUUID()}.xlsx`)
  try {
    const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: file, useStyles: true, useSharedStrings: false })
    wb.creator = 'Twisha POS'; wb.created = new Date()

    const summary = wb.addWorksheet('Summary', { properties: { tabColor: { argb: GREEN } } })
    const outTax = sa.cgst + sa.sgst + sa.igst + na.tax
    const rowsOut: Array<[string, string | number | null, string?]> = [
      ['Business', header.name], ['GSTIN', header.gstin ?? ''], ['Address', header.address ?? ''], ['Period', period], ['Prepared on', todayStr()], ['', null],
      ['SALES', null], ['Tax invoices (count)', sa.gst_n], ['Cash memos without GST (count)', sa.memo_n],
      ['Taxable value of tax invoices', sa.taxable, 'money'], ['CGST collected', sa.cgst, 'money'], ['SGST collected', sa.sgst, 'money'], ['IGST collected', sa.igst, 'money'],
      ['Total billed (all sale bills)', sa.total, 'money'], ['Credit notes / returns (tax)', na.tax, 'money'], ['', null],
      ['PURCHASES', null], ['Purchase bills (count)', pa.n], ['Taxable value of purchases', pa.taxable, 'money'], ['Input tax (CGST + SGST + IGST)', pa.tax, 'money'], ['', null],
      ['GST POSITION', null], ['Output tax (after credit notes)', outTax, 'money'], ['Input tax credit', pa.tax, 'money'], ['Net GST payable / (credit)', outTax - pa.tax, 'money'], ['', null],
      ['MONEY', null], ['Received in the period', rcv, 'money'], ['Expenses in the period', exp, 'money'],
      ['', null], ['Sheets in this file', 'Sales Register · Sales Items (HSN) · GSTR-1 B2B / B2C · HSN Summary · Credit Notes · Cancelled Bills · Purchase Register · Expenses · Payments · Receivables · Stock Valuation'],
      ['Note', 'Prepared from the shop’s billing data for the accountant to check; filing is done on the GST portal. Cancelled and draft bills are never counted.'],
    ]
    summary.getColumn(1).width = 36; summary.getColumn(2).width = 70
    const t = summary.addRow([`${header.name} — accountant pack`]); t.getCell(1).font = { bold: true, size: 15, color: { argb: GREEN } }; t.commit()
    summary.addRow([]).commit()
    for (const [k, v, f] of rowsOut) {
      const row = summary.addRow([k, v])
      if (v === null && k) { for (const c of [1, 2]) { row.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GREEN } } }; row.getCell(1).font = { bold: true, color: { argb: 'FFFFFFFF' } } }
      else { row.getCell(1).font = { bold: /Net GST/.test(k) }; if (f === 'money') { row.getCell(2).numFmt = FMT.money; row.getCell(2).alignment = { horizontal: 'left' } } }
      if (/Note|Sheets|Address/.test(k)) row.getCell(2).alignment = { wrapText: true, vertical: 'top' }
      row.commit()
    }
    await summary.commit()

    // ── sales register: one row per sale bill ──────────────────────────────────────────────────────────────────────
    const salesSql = (extra = '') => `
      SELECT to_char(i.date, 'YYYY-MM-DD') AS date, i.number, COALESCE(i."domainData"->>'bill_series', '') AS series,
             CASE WHEN ${gstOnly} THEN 'Tax Invoice' ELSE 'Cash Memo (no GST)' END AS kind,
             COALESCE(p.name, i."domainData"->>'customer_name', 'Walk-in') AS customer, COALESCE(p.gstin, '') AS gstin, COALESCE(p.phone, '') AS phone,
             ${pos} AS pos, i."taxableAmt"::float AS taxable, i."cgstTotal"::float AS cgst, i."sgstTotal"::float AS sgst,
             i."igstTotal"::float AS igst, i."roundOff"::float AS round_off, i."grandTotal"::float AS total, i."paidAmt"::float AS paid,
             (i."grandTotal" - i."paidAmt")::float AS balance, i.status
        FROM ${I} i LEFT JOIN ${P} p ON p.id = i."partyId"
       WHERE ${live} AND i."txnType" = 'sale_invoice' ${extra}
       ORDER BY i.date, NULLIF(substring(i.number from '[0-9]+$'), '')::bigint NULLS LAST, i.number, i.id`
    if (want('sales')) await streamSheet(wb, 'Sales Register', `Sales register — ${header.name} — ${period}`, [
      { header: 'Date', key: 'date', width: 12, kind: 'date' }, { header: 'Bill No.', key: 'number', width: 16 }, { header: 'Series', key: 'series', width: 9 },
      { header: 'Type', key: 'kind', width: 18 }, { header: 'Customer', key: 'customer', width: 26 }, { header: 'Customer GSTIN', key: 'gstin', width: 18 },
      { header: 'Mobile', key: 'phone', width: 13 }, { header: 'Place of supply (state code)', key: 'pos', width: 12 },
      { header: 'Taxable value', key: 'taxable', width: 14, kind: 'money', total: true }, { header: 'CGST', key: 'cgst', width: 12, kind: 'money', total: true },
      { header: 'SGST', key: 'sgst', width: 12, kind: 'money', total: true }, { header: 'IGST', key: 'igst', width: 12, kind: 'money', total: true },
      { header: 'Round off', key: 'round_off', width: 10, kind: 'money', total: true }, { header: 'Invoice total', key: 'total', width: 14, kind: 'money', total: true },
      { header: 'Received', key: 'paid', width: 13, kind: 'money', total: true }, { header: 'Balance', key: 'balance', width: 13, kind: 'money', total: true },
      { header: 'Status', key: 'status', width: 10 },
    ], paged(salesSql(), ctx.branchId, from, to))

    // ── item lines with HSN ────────────────────────────────────────────────────────────────────────────────────────
    if (want('items')) await streamSheet(wb, 'Sales Items (HSN)', `Sales — item lines — ${header.name} — ${period}`, [
      { header: 'Date', key: 'date', width: 12, kind: 'date' }, { header: 'Bill No.', key: 'number', width: 16 }, { header: 'Customer', key: 'customer', width: 24 },
      { header: 'Item', key: 'description', width: 34 }, { header: 'HSN / SAC', key: 'hsn', width: 11 }, { header: 'Qty', key: 'qty', width: 8, kind: 'qty', total: true },
      { header: 'Unit', key: 'unit', width: 7 }, { header: 'Rate', key: 'rate', width: 12, kind: 'money' }, { header: 'Taxable value', key: 'taxable', width: 14, kind: 'money', total: true },
      { header: 'GST %', key: 'gst_rate', width: 8, kind: 'rate' }, { header: 'CGST', key: 'cgst', width: 12, kind: 'money', total: true }, { header: 'SGST', key: 'sgst', width: 12, kind: 'money', total: true },
      { header: 'IGST', key: 'igst', width: 12, kind: 'money', total: true }, { header: 'Line total', key: 'total', width: 14, kind: 'money', total: true },
    ], paged(`
      SELECT to_char(i.date, 'YYYY-MM-DD') AS date, i.number, COALESCE(p.name, i."domainData"->>'customer_name', 'Walk-in') AS customer,
             ii.description, COALESCE(ii."hsnSacCode", '') AS hsn, ii.qty::float AS qty, COALESCE(ii.unit, 'pcs') AS unit, ii.rate::float AS rate,
             ii."taxableAmt"::float AS taxable, ii."gstRate"::float AS gst_rate, ii."cgstAmt"::float AS cgst, ii."sgstAmt"::float AS sgst,
             ii."igstAmt"::float AS igst, ii.total::float AS total
        FROM ${II} ii JOIN ${I} i ON i.id = ii."invoiceId" LEFT JOIN ${P} p ON p.id = i."partyId"
       WHERE ${live} AND i."txnType" IN ('sale_invoice') ORDER BY i.date, i.number, ii."sortOrder", ii.id`, ctx.branchId, from, to))

    // ── GSTR-1 working: B2B (registered buyers) and B2C (everyone else, by rate and state) ─────────────────────────
    if (want('gstr1')) {
      await streamSheet(wb, 'GSTR-1 B2B', `GSTR-1 — B2B (buyers with a GSTIN) — ${header.name} (${header.gstin ?? ''}) — ${period}`, [
        { header: 'GSTIN of buyer', key: 'gstin', width: 18 }, { header: 'Buyer name', key: 'customer', width: 28 }, { header: 'Invoice no.', key: 'number', width: 16 },
        { header: 'Invoice date', key: 'date', width: 12, kind: 'date' }, { header: 'Invoice value', key: 'total', width: 14, kind: 'money', total: true },
        { header: 'Place of supply', key: 'pos', width: 10 }, { header: 'Taxable value', key: 'taxable', width: 14, kind: 'money', total: true },
        { header: 'IGST', key: 'igst', width: 12, kind: 'money', total: true }, { header: 'CGST', key: 'cgst', width: 12, kind: 'money', total: true }, { header: 'SGST', key: 'sgst', width: 12, kind: 'money', total: true },
      ], paged(salesSql(`AND ${gstOnly} AND COALESCE(p.gstin, '') <> ''`), ctx.branchId, from, to))
      await streamSheet(wb, 'GSTR-1 B2C', `GSTR-1 — B2C (no GSTIN), by place of supply and rate — ${header.name} — ${period}`, [
        { header: 'Place of supply', key: 'pos', width: 12 }, { header: 'GST %', key: 'gst_rate', width: 8, kind: 'rate' }, { header: 'Bills', key: 'bills', width: 8, kind: 'int' },
        { header: 'Taxable value', key: 'taxable', width: 15, kind: 'money', total: true }, { header: 'IGST', key: 'igst', width: 12, kind: 'money', total: true },
        { header: 'CGST', key: 'cgst', width: 12, kind: 'money', total: true }, { header: 'SGST', key: 'sgst', width: 12, kind: 'money', total: true },
      ], once(() => q<any>(ctx, `
        SELECT ${pos} AS pos, ii."gstRate"::float AS gst_rate, COALESCE(SUM(ii."taxableAmt"), 0)::float AS taxable, COALESCE(SUM(ii."cgstAmt"), 0)::float AS cgst,
               COALESCE(SUM(ii."sgstAmt"), 0)::float AS sgst, COALESCE(SUM(ii."igstAmt"), 0)::float AS igst, COUNT(DISTINCT i.id)::int AS bills
          FROM ${II} ii JOIN ${I} i ON i.id = ii."invoiceId" LEFT JOIN ${P} p ON p.id = i."partyId"
         WHERE ${live} AND i."txnType" = 'sale_invoice' AND ${gstOnly} AND COALESCE(p.gstin, '') = ''
         GROUP BY 1, 2 ORDER BY 1, 2`, ctx.branchId, from, to)))
    }

    // ── HSN summary (grouped in SQL) ───────────────────────────────────────────────────────────────────────────────
    if (want('hsn')) await streamSheet(wb, 'HSN Summary', `HSN-wise summary of outward supplies — ${header.name} — ${period}`, [
      { header: 'HSN / SAC', key: 'hsn', width: 12 }, { header: 'Description (first item)', key: 'description', width: 34 }, { header: 'UQC', key: 'uqc', width: 7 },
      { header: 'Total quantity', key: 'qty', width: 12, kind: 'qty', total: true }, { header: 'Total value', key: 'total', width: 15, kind: 'money', total: true },
      { header: 'Taxable value', key: 'taxable', width: 15, kind: 'money', total: true }, { header: 'GST %', key: 'gst_rate', width: 8, kind: 'rate' },
      { header: 'IGST', key: 'igst', width: 12, kind: 'money', total: true }, { header: 'CGST', key: 'cgst', width: 12, kind: 'money', total: true }, { header: 'SGST', key: 'sgst', width: 12, kind: 'money', total: true },
    ], once(() => q<any>(ctx, `
      SELECT COALESCE(NULLIF(ii."hsnSacCode", ''), '(no HSN)') AS hsn, MIN(ii.description) AS description, 'NOS' AS uqc,
             COALESCE(SUM(ii.qty), 0)::float AS qty, COALESCE(SUM(ii.total), 0)::float AS total, COALESCE(SUM(ii."taxableAmt"), 0)::float AS taxable, ii."gstRate"::float AS gst_rate,
             COALESCE(SUM(ii."igstAmt"), 0)::float AS igst, COALESCE(SUM(ii."cgstAmt"), 0)::float AS cgst, COALESCE(SUM(ii."sgstAmt"), 0)::float AS sgst
        FROM ${II} ii JOIN ${I} i ON i.id = ii."invoiceId"
       WHERE ${live} AND i."txnType" = 'sale_invoice' GROUP BY 1, ii."gstRate" ORDER BY 1, 7`, ctx.branchId, from, to)))

    // ── credit notes / sale returns (shown as negatives) ───────────────────────────────────────────────────────────
    if (want('notes')) await streamSheet(wb, 'Credit Notes & Returns', `Credit notes and sale returns (amounts reduce sales) — ${header.name} — ${period}`, [
      { header: 'Date', key: 'date', width: 12, kind: 'date' }, { header: 'Note no.', key: 'number', width: 16 }, { header: 'Type', key: 'kind', width: 12 },
      { header: 'Customer', key: 'customer', width: 26 }, { header: 'GSTIN', key: 'gstin', width: 18 }, { header: 'Against bill', key: 'against', width: 16 },
      { header: 'Taxable value', key: 'taxable', width: 14, kind: 'money', total: true }, { header: 'CGST', key: 'cgst', width: 12, kind: 'money', total: true },
      { header: 'SGST', key: 'sgst', width: 12, kind: 'money', total: true }, { header: 'IGST', key: 'igst', width: 12, kind: 'money', total: true }, { header: 'Total', key: 'total', width: 14, kind: 'money', total: true },
    ], paged(`
      SELECT to_char(i.date, 'YYYY-MM-DD') AS date, i.number, CASE i."txnType" WHEN 'credit_note' THEN 'Credit note' ELSE 'Sale return' END AS kind,
             COALESCE(p.name, 'Walk-in') AS customer, COALESCE(p.gstin, '') AS gstin, COALESCE(l.number, '') AS against,
             -i."taxableAmt"::float AS taxable, -i."cgstTotal"::float AS cgst, -i."sgstTotal"::float AS sgst, -i."igstTotal"::float AS igst, -i."grandTotal"::float AS total
        FROM ${I} i LEFT JOIN ${P} p ON p.id = i."partyId" LEFT JOIN ${I} l ON l.id = i."linkedInvoiceId"
       WHERE ${live} AND i."txnType" IN ('credit_note', 'sale_return') ORDER BY i.date, i.number, i.id`, ctx.branchId, from, to))

    // ── cancelled bills (so a gap in the numbering is explained) ───────────────────────────────────────────────────
    if (want('cancelled')) await streamSheet(wb, 'Cancelled Bills', `Cancelled bills (not counted anywhere else) — ${header.name} — ${period}`, [
      { header: 'Bill date', key: 'date', width: 12, kind: 'date' }, { header: 'Bill no.', key: 'number', width: 16 }, { header: 'Customer', key: 'customer', width: 26 },
      { header: 'Bill value', key: 'total', width: 14, kind: 'money', total: true }, { header: 'Cancelled on', key: 'cancelled_on', width: 13, kind: 'date' },
    ], paged(`
      SELECT to_char(i.date, 'YYYY-MM-DD') AS date, i.number, COALESCE(p.name, 'Walk-in') AS customer, i."grandTotal"::float AS total,
             COALESCE(to_char(i."cancelledAt" AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD'), '') AS cancelled_on
        FROM ${I} i LEFT JOIN ${P} p ON p.id = i."partyId"
       WHERE i."branchId" = $1::uuid AND i.status = 'cancelled' AND i."txnType" = 'sale_invoice' AND i.date BETWEEN $2::date AND $3::date ORDER BY i.date, i.number, i.id`, ctx.branchId, from, to))

    // ── purchases (input tax credit) ────────────────────────────────────────────────────────────────────────────────
    if (want('purchases')) await streamSheet(wb, 'Purchase Register', `Purchase register (input tax credit) — ${header.name} — ${period}`, [
      { header: 'Date', key: 'date', width: 12, kind: 'date' }, { header: 'Supplier bill no.', key: 'number', width: 18 }, { header: 'Supplier', key: 'supplier', width: 28 },
      { header: 'Supplier GSTIN', key: 'gstin', width: 18 }, { header: 'Taxable value', key: 'taxable', width: 14, kind: 'money', total: true },
      { header: 'CGST', key: 'cgst', width: 12, kind: 'money', total: true }, { header: 'SGST', key: 'sgst', width: 12, kind: 'money', total: true }, { header: 'IGST', key: 'igst', width: 12, kind: 'money', total: true },
      { header: 'Bill total', key: 'total', width: 14, kind: 'money', total: true }, { header: 'Paid', key: 'paid', width: 13, kind: 'money', total: true }, { header: 'Balance', key: 'balance', width: 13, kind: 'money', total: true },
    ], paged(`
      SELECT to_char(i.date, 'YYYY-MM-DD') AS date, i.number, COALESCE(p.name, '') AS supplier, COALESCE(p.gstin, '') AS gstin,
             i."taxableAmt"::float AS taxable, i."cgstTotal"::float AS cgst, i."sgstTotal"::float AS sgst, i."igstTotal"::float AS igst,
             i."grandTotal"::float AS total, i."paidAmt"::float AS paid, (i."grandTotal" - i."paidAmt")::float AS balance
        FROM ${I} i LEFT JOIN ${P} p ON p.id = i."partyId"
       WHERE ${live} AND i."txnType" = 'purchase_invoice' ORDER BY i.date, i.number, i.id`, ctx.branchId, from, to))

    // ── expenses ────────────────────────────────────────────────────────────────────────────────────────────────────
    if (want('expenses')) await streamSheet(wb, 'Expenses', `Expenses — ${header.name} — ${period}`, [
      { header: 'Date', key: 'date', width: 12, kind: 'date' }, { header: 'Category', key: 'category', width: 22 }, { header: 'Description', key: 'description', width: 36 },
      { header: 'Amount', key: 'amount', width: 14, kind: 'money', total: true }, { header: 'GST included', key: 'gst', width: 13, kind: 'money', total: true },
      { header: 'Paid by', key: 'mode', width: 12 }, { header: 'Reference', key: 'ref', width: 16 },
    ], paged(`
      SELECT to_char(e.date, 'YYYY-MM-DD') AS date, e.category, COALESCE(e.description, '') AS description, e.amount::float AS amount,
             COALESCE(e."gstAmount", 0)::float AS gst, e."paymentMode" AS mode, COALESCE(e."referenceNo", '') AS ref
        FROM ${tbl(S, 'expenses')} e WHERE e."branchId" = $1::uuid AND e.date BETWEEN $2::date AND $3::date ORDER BY e.date, e."createdAt", e.id`, ctx.branchId, from, to))

    // ── money received ──────────────────────────────────────────────────────────────────────────────────────────────
    if (want('payments')) await streamSheet(wb, 'Payments Received', `Payments received / paid — ${header.name} — ${period}`, [
      { header: 'Date', key: 'date', width: 12, kind: 'date' }, { header: 'Party', key: 'customer', width: 28 }, { header: 'Mode', key: 'method', width: 14 },
      { header: 'Amount', key: 'amount', width: 14, kind: 'money', total: true }, { header: 'Reference', key: 'ref', width: 18 },
    ], paged(`
      SELECT to_char(pm."paymentDate", 'YYYY-MM-DD') AS date, COALESCE(p.name, 'Walk-in') AS customer, pm.method, pm.amount::float AS amount, COALESCE(pm."refNo", '') AS ref
        FROM ${tbl(S, 'payments')} pm LEFT JOIN ${P} p ON p.id = pm."partyId"
       WHERE pm."branchId" = $1::uuid AND pm.status = 'active' AND pm."paymentDate" BETWEEN $2::date AND $3::date ORDER BY pm."paymentDate", pm."createdAt", pm.id`, ctx.branchId, from, to))

    // ── customers who still owe money (as of today) ────────────────────────────────────────────────────────────────
    if (want('receivables')) await streamSheet(wb, 'Receivables', `Customers who owe money — as on ${todayStr()} — ${header.name}`, [
      { header: 'Customer', key: 'name', width: 30 }, { header: 'Mobile', key: 'phone', width: 13 }, { header: 'GSTIN', key: 'gstin', width: 18 },
      { header: 'Amount due', key: 'balance', width: 15, kind: 'money', total: true }, { header: 'Oldest unpaid bill', key: 'oldest_unpaid', width: 16, kind: 'date' },
    ], paged(`
      SELECT p.name, COALESCE(p.phone, '') AS phone, COALESCE(p.gstin, '') AS gstin, p.balance::float AS balance,
             (SELECT to_char(MIN(i.date), 'YYYY-MM-DD') FROM ${I} i WHERE i."partyId" = p.id AND i."txnType" = 'sale_invoice' AND i.status IN ('confirmed', 'partial')) AS oldest_unpaid
        FROM ${P} p WHERE p."isActive" = true AND p.type IN ('customer', 'both') AND p.balance > 0.5 ORDER BY p.balance DESC, p.name, p.id`))

    // ── stock valuation (as of today) ───────────────────────────────────────────────────────────────────────────────
    if (want('stock')) await streamSheet(wb, 'Stock Valuation', `Closing stock at purchase cost — as on ${todayStr()} — ${header.name}`, [
      { header: 'Item', key: 'name', width: 36 }, { header: 'Brand', key: 'brand', width: 14 }, { header: 'Size', key: 'size', width: 14 }, { header: 'SKU', key: 'sku', width: 14 },
      { header: 'Quantity', key: 'qty', width: 10, kind: 'qty', total: true }, { header: 'Cost / unit', key: 'cost', width: 13, kind: 'money' }, { header: 'Stock value', key: 'value', width: 15, kind: 'money', total: true },
    ], paged(`
      SELECT p.name, COALESCE(p."domainAttrs"->>'brand', '') AS brand, COALESCE(p."domainAttrs"->>'size', '') AS size, COALESCE(p.sku, '') AS sku,
             COALESCE(l.qty, 0)::float AS qty, COALESCE(p."purchasePrice", 0)::float AS cost, (COALESCE(l.qty, 0) * COALESCE(p."purchasePrice", 0))::float AS value
        FROM ${tbl(S, 'products')} p
        LEFT JOIN (SELECT "productId", SUM(qty) AS qty FROM ${tbl(S, 'stock_ledger')} WHERE "branchId" = $1::uuid GROUP BY "productId") l ON l."productId" = p.id
       WHERE p."branchId" = $1::uuid AND p."isActive" = true AND p."trackStock" = true AND p."itemType" <> 'service' AND COALESCE(l.qty, 0) <> 0
       ORDER BY value DESC, p.name, p.id`, ctx.branchId))

    await wb.commit()
    const safe = header.name.replace(/[^A-Za-z0-9 _-]/g, '').trim().replace(/\s+/g, ' ') || 'Shop'
    return { buffer: await readFile(file), filename: `${safe} - ${only?.length === 1 ? only[0] : 'CA pack'} ${from} to ${to}.xlsx` }
  } finally {
    await unlink(file).catch(() => {})
  }
}
