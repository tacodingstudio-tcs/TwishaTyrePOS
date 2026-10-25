// Erases the test data of ONE shop so it can be handed over clean. Run by the offline install's ERASE-TEST-DATA.bat (through cli.mjs,
// which stops the app and takes a safety backup first):
//
//   tsx src/lib/reset-test-data.ts [--keep-items]
//
// Always kept:  the shop itself and its settings (name, address, GSTIN, bill books and their start numbers, WhatsApp options),
//               the login, categories and brands, and the shop's service list (Tyre Fitting, Alignment, Balancing …).
// Erased:       bills, quotations and every other document, payments, customers and suppliers, vehicles, warranty cards and claims,
//               stock movements, expenses, WhatsApp message log, the team and its salary records, purchase orders, bill counters.
//               Without --keep-items the tyre/item list goes too.   With --keep-items it stays (stock goes back to 0).
// After it the next car bill is the first of the book again (93) and the next two-wheeler bill 2W-4 — the numbers in the settings.
//
// All in one transaction: either everything is erased or nothing is.

import { db } from '@billing/db'

const KEEP_ALWAYS = new Set(['branches', 'users', 'categories', 'brands'])
const ITEM_TABLES = new Set(['products', 'product_images', 'product_variants', 'product_price_history', 'product_suppliers'])

const q = (s: string) => `"${s.replace(/"/g, '""')}"`

async function main() {
  const keepItems = process.argv.includes('--keep-items')
  const tenants = await db.$queryRawUnsafe<Array<{ schemaName: string; name: string }>>(`SELECT "schemaName", name FROM public.tenants ORDER BY "createdAt" LIMIT 2`)
  if (tenants.length !== 1) throw new Error(`Expected exactly one shop in this installation, found ${tenants.length} — nothing was erased.`)
  const schema = tenants[0]!.schemaName
  const S = q(schema)

  const tables = (await db.$queryRawUnsafe<Array<{ table_name: string }>>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = '${schema}' AND table_type = 'BASE TABLE' ORDER BY table_name`)).map((r) => r.table_name)
  const count = async (t: string) => Number((await db.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*)::bigint AS n FROM ${S}.${q(t)}`))[0]!.n)
  const show = ['invoices', 'parties', 'products', 'payments', 'expenses', 'tyre_vehicles', 'tyre_warranty', 'tyre_staff', 'stock_ledger']
  const before: Record<string, number> = {}
  for (const t of show) if (tables.includes(t)) before[t] = await count(t)

  const kept = new Set([...KEEP_ALWAYS, ...(keepItems ? ITEM_TABLES : ['products'])])        // 'products' is trimmed, not emptied, without --keep-items
  const toTruncate = tables.filter((t) => !kept.has(t))

  await db.$transaction(async (tx) => {
    // A kept table that points at an erased one (a product's supplier, say) must not be wiped along with it: clear that link first.
    const fks = await tx.$queryRawUnsafe<Array<{ tbl: string; col: string; ref: string; notnull: boolean }>>(`
      SELECT cl.relname AS tbl, a.attname AS col, rf.relname AS ref, a.attnotnull AS notnull
        FROM pg_constraint c
        JOIN pg_class cl ON cl.oid = c.conrelid JOIN pg_class rf ON rf.oid = c.confrelid
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
       WHERE c.contype = 'f' AND c.connamespace = '${schema}'::regnamespace`)
    for (const f of fks) {
      if (!kept.has(f.tbl) || !toTruncate.includes(f.ref)) continue
      if (f.notnull) throw new Error(`${f.tbl}.${f.col} must keep a link to ${f.ref}, which is being erased — nothing was erased.`)
      await tx.$executeRawUnsafe(`UPDATE ${S}.${q(f.tbl)} SET ${q(f.col)} = NULL WHERE ${q(f.col)} IS NOT NULL`)
    }
    if (toTruncate.length) await tx.$executeRawUnsafe(`TRUNCATE TABLE ${toTruncate.map((t) => `${S}.${q(t)}`).join(', ')} RESTART IDENTITY CASCADE`)
    // the tyre/item list goes, the service list (fitting, alignment …) stays
    if (!keepItems) await tx.$executeRawUnsafe(`DELETE FROM ${S}.products WHERE "itemType" <> 'service'`)
  }, { timeout: 120_000 })

  const after: Record<string, number> = {}
  for (const t of show) if (tables.includes(t)) after[t] = await count(t)
  const pad = (s: string) => s.padEnd(16)
  console.log(`Shop: ${tenants[0]!.name}   (${keepItems ? 'tyre list kept, stock back to 0' : 'everything erased except the service list'})`)
  for (const t of show) if (t in before) console.log(`  ${pad(t)} ${String(before[t]).padStart(6)}  →  ${String(after[t]).padStart(6)}`)
  console.log('DONE')
}

main().catch((e) => { console.error(`FAILED: ${e instanceof Error ? e.message : e}`); process.exit(1) }).finally(() => db.$disconnect())
