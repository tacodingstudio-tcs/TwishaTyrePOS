// apps/api/src/routes/tyre-import.ts
// Loads a shop's old paper / Excel bill register as historic sales so the app shows their own data.
//
//   POST /api/tyre/import/register   { series, rows[], dryRun? }
//
// Each row becomes a real sale invoice with the shop's own bill number and date, paid in full, but
// WITHOUT touching stock (those tyres left the shelf long ago) and without sending any message or
// setting a service reminder. Re-running is safe: a bill number that already exists is skipped.

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { createInvoice, recordPayment } from '../services/invoice.service.js'
import { createParty } from '../services/party.service.js'
import { tbl, q1, run, httpError, requireManager, branchConfig, r2 } from '../lib/tyre-helpers.js'

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
const normReg = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '')
const tenDigits = (s: string) => {
  const d = s.replace(/\D/g, '')
  return d.length === 12 && d.startsWith('91') ? d.slice(2) : d
}

const Row = z.object({
  date:        dateStr,
  billNo:      z.union([z.string(), z.number()]).transform((v) => String(v).trim()).pipe(z.string().min(1).max(30)),
  customer:    z.string().trim().min(1).max(120),
  mobile:      z.string().trim().max(20).optional(),
  address:     z.string().trim().max(300).optional(),
  vehicleMake: z.string().trim().max(60).optional(),
  vehicleNo:   z.string().trim().max(20).optional(),
  km:          z.number().int().nonnegative().max(2_000_000).optional(),
  brand:       z.string().trim().max(80).optional(),
  size:        z.string().trim().max(40).optional(),
  hsn:         z.string().trim().max(10).optional(),
  qty:         z.number().positive().max(1000).optional(),     // absent on a service-only bill
  price:       z.number().positive().max(1e7).optional(),      // Data Entry: GST-inclusive per tyre
  gstRate:     z.number().min(0).max(28).default(18),
  charges:     z.object({
    alignment: z.number().nonnegative().max(1e6).default(0),
    balancing: z.number().nonnegative().max(1e6).default(0),
    weight:    z.number().nonnegative().max(1e6).default(0),
    labour:    z.number().nonnegative().max(1e6).default(0),
  }).default({}),
  gstNo:       z.string().trim().max(15).optional(),
})

const Body = z.object({
  series: z.string().regex(/^[a-z_]{1,20}$/).default('car'),
  vehicleType: z.enum(['car', 'two_wheeler']).default('car'),
  rows:   z.array(Row).min(1).max(1000),
  dryRun: z.boolean().default(false),
})

export const tyreImportRoutes: FastifyPluginAsync = async (app) => {
  app.post('/import/register', async (req) => {
    requireManager(req)
    const body = Body.parse(req.body)
    const cfg = await branchConfig(req)
    const series = (cfg['bill_series'] ?? {})[body.series] as { prefix?: string } | undefined
    const prefix = series?.prefix ?? ''
    const ctx = { db: req.db, branchId: req.branchId, schemaName: req.schemaName, userId: req.userId, role: req.role, branchDomainType: 'tyre' }

    const created: string[] = []
    const skipped: string[] = []
    const problems: Array<{ billNo: string; error: string }> = []
    const seen = new Set<string>()

    for (const r of body.rows) {
      const number = `${prefix}${r.billNo}`
      try {
        if (seen.has(number)) throw new Error('bill number appears twice in this file')
        seen.add(number)
        const dup = await q1<any>(req,
          `SELECT id FROM ${tbl(req.schemaName, 'invoices')} WHERE "branchId" = $1::uuid AND "txnType" = 'sale_invoice' AND number = $2`,
          req.branchId, number)
        if (dup) { skipped.push(number); continue }
        if (body.dryRun) { created.push(number); continue }

        // customer: by mobile when there is a valid one, else by exact name
        const phone = r.mobile ? tenDigits(r.mobile) : ''
        const validPhone = /^[6-9]\d{9}$/.test(phone) ? phone : null
        let partyId: string | undefined
        const found = validPhone
          ? await q1<any>(req, `SELECT id FROM ${tbl(req.schemaName, 'parties')} WHERE phone = $1 AND "isActive" = true`, validPhone)
          : await q1<any>(req, `SELECT id FROM ${tbl(req.schemaName, 'parties')} WHERE lower(name) = lower($1) AND phone IS NULL AND "isActive" = true`, r.customer)
        if (found) partyId = found.id
        else {
          const p = await createParty({
            type: 'customer', name: r.customer, creditLimit: 0, meta: {},
            ...(validPhone ? { phone: validPhone } : {}),
            ...(r.address ? { address: { line1: r.address } } : {}),
            ...(r.gstNo && r.gstNo.length === 15 ? { gstin: r.gstNo.toUpperCase() } : {}),
          }, { db: req.db, branchId: req.branchId, userId: req.userId, role: req.role } as any)
          partyId = p.id
        }

        const reg = r.vehicleNo ? normReg(r.vehicleNo) : ''
        const items: any[] = []
        if (r.qty && r.price) items.push({
          description: [r.brand, r.size].filter(Boolean).join(' ') || 'Tyre',
          qty: r.qty, unit: 'pcs', rate: r.price, discountPct: 0, gstRate: r.gstRate, gstExempt: r.gstRate === 0,
          priceIncludesGst: true, hsnSacCode: r.hsn && r.hsn !== '0' ? r.hsn : undefined,
          itemMeta: { item_kind: 'tyre', brand: r.brand, size: r.size },
        })
        for (const [label, amount] of [['Alignment', r.charges.alignment], ['Balancing', r.charges.balancing],
          ['Weight', r.charges.weight], ['Labour', r.charges.labour]] as const) {
          if (amount > 0) {
            items.push({ description: label, qty: 1, unit: 'job', rate: amount, discountPct: 0, gstRate: 0, gstExempt: true,
              priceIncludesGst: false, itemMeta: { item_kind: 'charge' } })
          }
        }

        if (items.length === 0) throw new Error('no tyre price and no charges — nothing to bill')
        const inv: any = await createInvoice({
          txnType: 'sale_invoice', partyId, date: r.date, notes: 'Imported from old bill register',
          domainData: {
            sale_kind: r.qty && r.price ? 'retail' : 'service_only', bill_series: body.series, vehicle_make: r.vehicleMake, vehicle_no: reg || undefined,
            vehicle_type: body.vehicleType, odometer: r.km || undefined, prices_include_gst: true,
            payment_splits: [], source: 'import',
          },
          aiMeta: {}, items,
        } as any, { ...ctx, fixedNumber: number } as any)

        await recordPayment({
          invoiceId: inv.id, amount: Number(inv.grandTotal), method: 'cash', paymentDate: r.date, notes: 'Imported — paid at the counter',
        } as any, ctx as any)

        if (reg) {
          await run(req,
            `INSERT INTO ${tbl(req.schemaName, 'tyre_vehicles')}
               ("branchId","regNo","partyId","vehicleType","makeModel","tyreSize","ownerName","ownerPhone","lastServiceDate","lastOdometer")
             VALUES ($1::uuid,$2,$3::uuid,$4,$5,$6,$7,$8,$9::date,$10)
             ON CONFLICT ("branchId","regNo") DO UPDATE SET
               "lastServiceDate" = GREATEST(EXCLUDED."lastServiceDate", ${tbl(req.schemaName, 'tyre_vehicles')}."lastServiceDate"),
               "lastOdometer"    = COALESCE(EXCLUDED."lastOdometer", ${tbl(req.schemaName, 'tyre_vehicles')}."lastOdometer"),
               "makeModel"       = COALESCE(EXCLUDED."makeModel", ${tbl(req.schemaName, 'tyre_vehicles')}."makeModel"),
               "tyreSize"        = COALESCE(EXCLUDED."tyreSize", ${tbl(req.schemaName, 'tyre_vehicles')}."tyreSize"),
               "isActive"        = true, "updatedAt" = NOW()`,
            req.branchId, reg, partyId ?? null, body.vehicleType, r.vehicleMake ?? null, r.size ?? null,
            r.customer, validPhone, r.date, r.km || null)
        }
        created.push(number)
      } catch (err) {
        problems.push({ billNo: number, error: (err as Error).message.slice(0, 200) })
      }
    }

    // imported numbers are unknown to the live counter — drop it so the next bill starts above them
    if (!body.dryRun && created.length) {
      await run(req, `DELETE FROM ${tbl(req.schemaName, 'invoice_sequences')} WHERE branch_id = $1::uuid AND txn_type = $2 AND fy = 'S'`,
        req.branchId, `sale_invoice:series:${body.series}`)
    }
    void httpError; void r2
    return { dryRun: body.dryRun, created: created.length, skipped: skipped.length, failed: problems.length, problems, numbers: created }
  })
}
