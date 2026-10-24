// apps/api/scripts/load-bulk.ts
// =============================================================================
// Fills ONE shop with a large amount of synthetic data (to show the client how the app copes with volume):
//   60,000 customers · 60,000 tyres · 60,000 vehicles · 60,000 bills (2 lines each) · 60,000 payments ·
//   ~120,000 stock-ledger rows · 60,000 warranties        (about 265 MB in Postgres)
//
//   DATABASE_URL=<direct string> npx tsx scripts/load-bulk.ts [ownerPhone]            load
//   DATABASE_URL=<direct string> npx tsx scripts/load-bulk.ts [ownerPhone] --remove   delete exactly those rows again
//
// Everything it adds is recognisable (sku "LT-n", bill "LT-nnnnnn", customer "Customer n"), so --remove never
// touches real data. The shop must already have at least one service product (any registered tyre shop does).
// =============================================================================
import { PrismaClient } from '@prisma/client'

const OWNER = process.argv.slice(2).find((a) => /^\d{10}$/.test(a)) ?? '9200000001'
const REMOVE = process.argv.includes('--remove')
const N = 60000

const LOAD = [
  `CREATE TEMP TABLE cfg AS SELECT '__BRANCH__'::uuid b, '__USER__'::uuid u`,
  `INSERT INTO parties ("branchId", type, name, phone, balance)
   SELECT (SELECT b FROM cfg), 'customer', 'Customer '||n, '9'||lpad(n::text,9,'0'), 0 FROM generate_series(1,${N}) n`,
  `INSERT INTO products ("branchId","itemType",name,sku,unit,"gstRate","salePrice",mrp,"purchasePrice","lowStockQty","trackStock","domainAttrs")
   SELECT (SELECT b FROM cfg),'product','LoadTyre '||n,'LT-'||n,'pcs',18,
     3000+(n%200)*40, 3600+(n%200)*40, 2400+(n%200)*35, 3, true,
     jsonb_build_object('item_kind','tyre','brand',(ARRAY['MRF','CEAT','Apollo','JK','Bridgestone','Michelin'])[1+n%6],
       'pattern','P'||(n%40),'size',(ARRAY['185/65 R15','205/55 R16','165/80 R14','195/65 R15','215/60 R16','245/45 R18'])[1+n%6],
       'vehicle_type',(ARRAY['car','suv','two_wheeler'])[1+n%3],'tube_type','tubeless','warranty_months',24)
   FROM generate_series(1,${N}) n`,
  `CREATE TEMP TABLE tp AS SELECT id, row_number() OVER (ORDER BY sku) rn FROM products WHERE sku LIKE 'LT-%'`,
  `CREATE TEMP TABLE svc AS SELECT id, row_number() OVER (ORDER BY name) rn FROM products WHERE sku IS NULL OR sku NOT LIKE 'LT-%'`,
  `CREATE TEMP TABLE cp AS SELECT id, row_number() OVER (ORDER BY name) rn FROM parties WHERE name LIKE 'Customer %'`,
  `CREATE UNIQUE INDEX ON tp(rn)`,
  `CREATE UNIQUE INDEX ON cp(rn)`,
  `CREATE UNIQUE INDEX ON svc(rn)`,
  `INSERT INTO stock_ledger ("branchId","productId","txnType",qty,rate,"refType","createdAt")
   SELECT (SELECT b FROM cfg), id, 'opening', 60, 2500, 'opening', now()-interval '3 years' FROM tp`,
  `INSERT INTO tyre_vehicles ("branchId","regNo","partyId","vehicleType","makeModel","tyreSize","ownerName","ownerPhone","lastServiceDate","nextServiceDate")
   SELECT (SELECT b FROM cfg),'GJ'||lpad((n%40)::text,2,'0')||chr(65+n%26)||chr(65+(n/26)%26)||lpad(n::text,5,'0'),
     (SELECT id FROM cp WHERE rn=n),'car','Swift','185/65 R15','Customer '||n,'9'||lpad(n::text,9,'0'),
     current_date-(n%900), current_date+((n%120)-30)
   FROM generate_series(1,${N}) n`,
  `CREATE TEMP TABLE inv AS SELECT n, gen_random_uuid() id FROM generate_series(1,${N}) n`,
  `INSERT INTO invoices (id,"branchId","partyId","createdBy","txnType",number,date,status,subtotal,"taxableAmt","cgstTotal","sgstTotal","grandTotal","paidAmt","domainData","createdAt")
   SELECT i.id,(SELECT b FROM cfg),(SELECT id FROM cp WHERE rn=1+(i.n*7)%${N}),(SELECT u FROM cfg),'sale_invoice',
     'LT-'||lpad(i.n::text,6,'0'), current_date-(i.n%1000), 'paid',
     ROUND(((3000+(i.n%200)*40)+200)::numeric,2), ROUND(((3000+(i.n%200)*40)+200)::numeric,2),
     ROUND((((3000+(i.n%200)*40)+200)*0.09)::numeric,2), ROUND((((3000+(i.n%200)*40)+200)*0.09)::numeric,2),
     ROUND((((3000+(i.n%200)*40)+200)*1.18)::numeric,2), ROUND((((3000+(i.n%200)*40)+200)*1.18)::numeric,2),'{}'::jsonb,
     (current_date-(i.n%1000))::timestamptz + interval '11 hours'
   FROM inv i`,
  `INSERT INTO invoice_items ("invoiceId","productId",description,qty,unit,rate,"taxableAmt","gstRate","cgstAmt","sgstAmt",total,"sortOrder","itemMeta")
   SELECT i.id,(SELECT id FROM tp WHERE rn=1+(i.n*13)%${N}),'LoadTyre',1,'pcs',3000+(i.n%200)*40,3000+(i.n%200)*40,18,
     ROUND(((3000+(i.n%200)*40)*0.09)::numeric,2),ROUND(((3000+(i.n%200)*40)*0.09)::numeric,2),ROUND(((3000+(i.n%200)*40)*1.18)::numeric,2),0,
     jsonb_build_object('serialNos',jsonb_build_array('SN'||i.n))
   FROM inv i`,
  `INSERT INTO invoice_items ("invoiceId","productId",description,qty,unit,rate,"taxableAmt","gstRate","cgstAmt","sgstAmt",total,"sortOrder","itemMeta")
   SELECT i.id,(SELECT id FROM svc WHERE rn=1+i.n%(SELECT max(rn) FROM svc)),'Fitting',1,'pcs',200,200,18,18,18,236,1,'{}'::jsonb FROM inv i`,
  `INSERT INTO payments ("branchId","partyId",amount,method,"paymentDate","createdBy")
   SELECT (SELECT b FROM cfg),(SELECT id FROM cp WHERE rn=1+(i.n*7)%${N}),ROUND((((3000+(i.n%200)*40)+200)*1.18)::numeric,2),(ARRAY['cash','upi','card'])[1+i.n%3],current_date-(i.n%1000),(SELECT u FROM cfg) FROM inv i`,
  `INSERT INTO stock_ledger ("branchId","productId","txnType",qty,rate,"refType","refId","createdAt")
   SELECT (SELECT b FROM cfg),(SELECT id FROM tp WHERE rn=1+(i.n*13)%${N}),'sale',-1,3000,'invoice',i.id,(current_date-(i.n%1000))::timestamptz FROM inv i`,
  `INSERT INTO tyre_warranty ("branchId","invoiceId","invoiceNo","productId","itemName","brand","size","serialNo","partyId","customerName","soldOn","warrantyMonths","warrantyUntil","status")
   SELECT (SELECT b FROM cfg),i.id,'LT-'||lpad(i.n::text,6,'0'),(SELECT id FROM tp WHERE rn=1+(i.n*13)%${N}),'LoadTyre','MRF','185/65 R15','LTSN'||i.n,
     (SELECT id FROM cp WHERE rn=1+(i.n*7)%${N}),'Customer','2026-01-01'::date-(i.n%1000),24,'2028-01-01'::date-(i.n%1000),'active' FROM inv i`,
]

const UNLOAD = [
  `DELETE FROM tyre_warranty WHERE "invoiceNo" LIKE 'LT-%'`,
  `DELETE FROM payments WHERE "partyId" IN (SELECT id FROM parties WHERE name LIKE 'Customer %')`,
  `DELETE FROM stock_ledger WHERE "productId" IN (SELECT id FROM products WHERE sku LIKE 'LT-%')`,
  `DELETE FROM invoices WHERE number LIKE 'LT-%'`,
  `DELETE FROM tyre_vehicles WHERE "ownerName" LIKE 'Customer %'`,
  `DELETE FROM products WHERE sku LIKE 'LT-%'`,
  `DELETE FROM parties WHERE name LIKE 'Customer %'`,
]

async function main() {
  const prisma = new PrismaClient()
  const [t] = await prisma.$queryRawUnsafe<Array<{ schemaName: string }>>(`SELECT "schemaName" FROM public.tenants WHERE "ownerPhone" = $1`, OWNER)
  if (!t) throw new Error(`No shop registered with owner phone ${OWNER}`)
  if (!/^[a-z0-9_]+$/.test(t.schemaName)) throw new Error('unexpected schema name')
  const S = t.schemaName
  console.log(`${REMOVE ? 'Removing bulk data from' : 'Loading bulk data into'} ${S} ...`)
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${S}", public`)
    if (!REMOVE) {
      const [have] = await tx.$queryRawUnsafe<Array<{ n: number }>>(`SELECT COUNT(*)::int AS n FROM products WHERE sku LIKE 'LT-%'`)
      if (have!.n > 0) throw new Error('Bulk data is already there — run with --remove first.')
    }
    const [ids] = await tx.$queryRawUnsafe<Array<{ b: string; u: string }>>(
      `SELECT (SELECT id FROM branches ORDER BY "createdAt" LIMIT 1)::text AS b, (SELECT id FROM users WHERE role = 'owner' ORDER BY "createdAt" LIMIT 1)::text AS u`)
    for (const sql of REMOVE ? UNLOAD : LOAD) {
      const t0 = Date.now()
      const out = sql.replace('__BRANCH__', ids!.b).replace('__USER__', ids!.u)
      const n = await tx.$executeRawUnsafe(out)
      console.log(`  ${String(n).padStart(7)} rows  ${((Date.now() - t0) / 1000).toFixed(1)}s  ${out.trim().split('\n')[0]!.slice(0, 70)}`)
    }
  }, { timeout: 30 * 60_000, maxWait: 60_000 })
  const rows = await prisma.$queryRawUnsafe<Array<{ t: string; n: number }>>(
    `SELECT 'products' t, COUNT(*)::int n FROM "${S}".products UNION ALL SELECT 'invoices', COUNT(*)::int FROM "${S}".invoices UNION ALL SELECT 'parties', COUNT(*)::int FROM "${S}".parties`)
  console.log('Now in the shop:', rows.map((r) => `${r.t} ${r.n}`).join(' · '))
  await prisma.$disconnect()
}
main().catch((e) => { console.error('FAILED:', e.message ?? e); process.exit(1) })
