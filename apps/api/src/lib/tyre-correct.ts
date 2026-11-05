// apps/api/src/lib/tyre-correct.ts
// "Correct this bill": undo a sale bill completely and let the caller write the corrected one with the same
// number and date — all inside ONE database transaction, so a failure anywhere leaves the original untouched.
//
// What is undone: stock (every ledger row written against the bill, including old-tyre scrap taken in), the
// customer's balance, the payments received on the bill, the warranty rows. The old bill stays on record as a
// cancelled bill under a new number (<no>-OLD, -OLDB …) because (branch, type, number) must be unique.

import type { Ctx } from './tyre-helpers.js'
import { tbl, q, q1, run, httpError, ymd } from './tyre-helpers.js'

/** A client for use inside an open transaction: nested `$transaction(fn)` calls simply join it. */
export function nestTx(tx: any): any {
  const p: any = new Proxy(tx, {
    get(t, prop) {
      if (prop === '$transaction') return (fn: unknown) => (typeof fn === 'function' ? (fn as (c: unknown) => unknown)(p) : Promise.reject(new Error('Batch transactions are not supported here')))
      const v = Reflect.get(t, prop, t)
      return typeof v === 'function' ? v.bind(t) : v
    },
  })
  return p
}

export interface Reversed {
  oldId: string
  number: string            // the bill number the corrected bill takes over
  renamedTo: string         // what the cancelled copy is called now
  date: string              // YYYY-MM-DD
  billSeries?: string
  partyId?: string
  paid: number
}

/** `req.db` must already be the transaction client (see nestTx). */
export async function reverseBill(req: Ctx, invoiceId: string, why: string): Promise<Reversed> {
  const inv = await q1<any>(req,
    `SELECT id, number, status, "txnType", "partyId", date, "grandTotal"::float AS total, "paidAmt"::float AS paid,
            "irnNo", "domainData", notes
     FROM ${tbl(req.schemaName, 'invoices')} WHERE id = $1::uuid AND "branchId" = $2::uuid FOR UPDATE`,
    invoiceId, req.branchId)
  if (!inv) throw httpError(404, 'Bill not found')
  if (inv.txnType !== 'sale_invoice') throw httpError(422, 'Only a sale bill can be corrected')
  if (inv.status === 'cancelled') throw httpError(409, 'This bill is already cancelled')
  if (inv.irnNo) throw httpError(422, 'This bill has an e-invoice number and cannot be corrected here')

  const linked = await q1<any>(req,
    `SELECT number FROM ${tbl(req.schemaName, 'invoices')}
     WHERE "linkedInvoiceId" = $1::uuid AND "branchId" = $2::uuid AND status <> 'cancelled' LIMIT 1`, invoiceId, req.branchId)
  if (linked) throw httpError(409, `Bill ${linked.number} (a return or credit note) is linked to this bill — cancel that first`)

  // payments received on this bill
  const pays = await q<any>(req,
    `SELECT pa."paymentId" AS id, p.type, p.status, p.amount::float AS amount,
            (SELECT COUNT(*) FROM ${tbl(req.schemaName, 'payment_allocations')} x
              WHERE x."paymentId" = pa."paymentId" AND x."invoiceId" <> pa."invoiceId")::int AS others
     FROM ${tbl(req.schemaName, 'payment_allocations')} pa
     JOIN ${tbl(req.schemaName, 'payments')} p ON p.id = pa."paymentId"
     WHERE pa."invoiceId" = $1::uuid AND p.status <> 'voided' FOR UPDATE OF p`, invoiceId)
  for (const p of pays) {
    if (p.others > 0 || p.type !== 'receipt') {
      throw httpError(409, 'A payment on this bill is shared with other bills (an advance was used). Undo that allocation first, then correct the bill')
    }
  }
  for (const p of pays) {
    await run(req, `DELETE FROM ${tbl(req.schemaName, 'payment_allocations')} WHERE "paymentId" = $1::uuid`, p.id)
    await run(req,
      `UPDATE ${tbl(req.schemaName, 'payments')} SET status = 'voided', "voidedAt" = NOW(), "voidReason" = $2 WHERE id = $1::uuid`,
      p.id, `Bill ${inv.number} corrected`)
  }
  const paid = pays.reduce((s: number, p: any) => s + p.amount, 0)

  // stock: undo every movement written against the bill (the sale, and old-tyre scrap taken in)
  await run(req,
    `INSERT INTO ${tbl(req.schemaName, 'stock_ledger')}
       (id, "branchId", "productId", "variantId", "batchId", "txnType", qty, rate, "refType", "refId", notes, "createdBy", "createdAt")
     SELECT gen_random_uuid(), "branchId", "productId", "variantId", "batchId", 'adjustment', -qty, rate,
            'invoice_correct', "refId", $3, $4::uuid, NOW()
     FROM ${tbl(req.schemaName, 'stock_ledger')}
     WHERE "refId" = $1::uuid AND "branchId" = $2::uuid AND COALESCE("refType", '') NOT IN ('invoice_correct', 'invoice_cancel')`,
    invoiceId, req.branchId, `Bill ${inv.number} corrected`, req.userId)

  // customer balance: the bill added its total, the payments took their part off; both are now undone
  if (inv.partyId) {
    await run(req,
      `UPDATE ${tbl(req.schemaName, 'parties')} SET balance = balance + $2::numeric - $3::numeric WHERE id = $1::uuid`,
      inv.partyId, paid, inv.total)
  }

  await run(req,
    `UPDATE ${tbl(req.schemaName, 'tyre_warranty')} SET status = 'void', "updatedAt" = NOW()
     WHERE "invoiceId" = $1::uuid AND "branchId" = $2::uuid AND status <> 'void'`, invoiceId, req.branchId)

  // the cancelled copy gets a free number so the corrected bill can take the original one
  let renamedTo = `${inv.number}-OLD`
  for (let n = 0; ; n++) {
    const suffix = n === 0 ? 'OLD' : `OLD${String.fromCharCode(65 + n)}`
    renamedTo = `${inv.number}-${suffix}`
    const taken = await q1(req,
      `SELECT 1 AS x FROM ${tbl(req.schemaName, 'invoices')} WHERE "branchId" = $1::uuid AND "txnType" = 'sale_invoice' AND number = $2`,
      req.branchId, renamedTo)
    if (!taken) break
    if (n > 24) throw httpError(409, 'This bill has been corrected too many times')
  }
  const note = `Corrected on ${new Date().toISOString().slice(0, 10)} — ${why}`
  await run(req,
    `UPDATE ${tbl(req.schemaName, 'invoices')}
     SET number = $2, status = 'cancelled', "paidAmt" = 0, "cancelledBy" = $3::uuid, "cancelledAt" = NOW(),
         notes = CASE WHEN COALESCE(notes, '') = '' THEN $4 ELSE notes || E'\\n' || $4 END,
         "domainData" = COALESCE("domainData", '{}'::jsonb) || $5::jsonb, "updatedAt" = NOW()
     WHERE id = $1::uuid`,
    invoiceId, renamedTo, req.userId, note,
    JSON.stringify({ corrected_from: inv.number, paid_before_correction: paid }))

  const dd = (inv.domainData ?? {}) as Record<string, any>
  return {
    oldId: invoiceId, number: inv.number, renamedTo, date: ymd(inv.date),
    billSeries: dd['bill_series'] || undefined, partyId: inv.partyId ?? undefined, paid,
  }
}
