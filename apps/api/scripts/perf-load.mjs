// Fills a throw-away tenant with a LARGE dataset so endpoint timings mean something.
//
//   node scripts/perf-load.mjs [--scale 1]        (scale 1 ≈ 5 busy years: 60k bills, 8k customers, 3k tyres)
//
// Registers "Perf Test Tyres" (phone 9300000009, PIN 2468) on the local API, then bulk-inserts with plain SQL
// through docker (container tyre_postgres). Safe to re-run: it tops up nothing — drop the tenant first if you want a clean slate.
import { execSync } from 'node:child_process'
import { writeFileSync, unlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const scale = Number(args[args.indexOf('--scale') + 1] || 1)
const API = 'http://localhost:3200'
const PHONE = '9300000009', PIN = '2468'
const psql = (sql, file = false) => {
  if (!file) return execSync(`docker exec -e PGPASSWORD=localdev123 tyre_postgres psql -U billing_app -d billing_db -tA -c "${sql.replace(/"/g, '\\"').replace(/\s+/g, ' ')}"`, { encoding: 'utf8' }).trim()
  const f = path.join(os.tmpdir(), 'perf-load.sql')
  writeFileSync(f, sql)
  const out = execSync(`docker exec -i -e PGPASSWORD=localdev123 tyre_postgres psql -U billing_app -d billing_db -v ON_ERROR_STOP=1 < "${f}"`, { encoding: 'utf8', shell: 'bash', maxBuffer: 1 << 26 })
  unlinkSync(f)
  return out
}

const reg = await fetch(API + '/api/tenants/register', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ businessName: 'Perf Test Tyres', ownerName: 'Perf Owner', phone: PHONE, pin: PIN, domainType: 'tyre', stateCode: '24', city: 'Rajkot', lang: 'en' }),
})
console.log('register:', reg.status)
const login = await (await fetch(API + '/api/auth/login', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tenantPhone: PHONE, phone: PHONE, pin: PIN }),
})).json()
const branchId = login.branch.id, userId = login.user.id
const schema = psql(`select "schemaName" from public.tenants where name = 'Perf Test Tyres' order by "createdAt" desc limit 1`)
console.log({ schema, branchId, userId })

const N = { parties: 8000 * scale, tyres: 3000 * scale, bills: 60000 * scale, vehicles: 8000 * scale, expenses: 12000 * scale, warranty: 40000 * scale }
const S = `"${schema}"`
const sql = `
SET search_path TO ${S}, public;
SET synchronous_commit = off;

-- customers
INSERT INTO parties (id, "branchId", type, name, phone, balance, meta)
SELECT gen_random_uuid(), '${branchId}', 'customer', 'Customer ' || g, '9' || lpad((100000000 + g)::text, 9, '0'),
       CASE WHEN g % 9 = 0 THEN (g % 40) * 750 ELSE 0 END, '{}'
FROM generate_series(1, ${N.parties}) g;

-- tyre catalogue
INSERT INTO products (id, "branchId", "itemType", name, sku, "hsnSacCode", "gstRate", unit, "purchasePrice", "salePrice", "trackStock", "lowStockQty", "domainAttrs")
SELECT gen_random_uuid(), '${branchId}', 'product',
       (ARRAY['Yokohama','MRF','Apollo','CEAT','JK','Bridgestone','Michelin','Goodyear'])[1 + g % 8] || ' ' ||
       (135 + (g % 14) * 10) || '/' || (50 + (g % 8) * 5) || ' R' || (12 + g % 8) || ' P' || g,
       'SKU-' || g, '4011', 18, 'pcs', 2500 + (g % 90) * 80, 3000 + (g % 90) * 100, true, 2 + g % 5,
       jsonb_build_object('item_kind','tyre','brand',(ARRAY['Yokohama','MRF','Apollo','CEAT','JK','Bridgestone','Michelin','Goodyear'])[1 + g % 8],
                          'size', (135 + (g % 14) * 10) || '/' || (50 + (g % 8) * 5) || ' R' || (12 + g % 8), 'vehicle_type','car')
FROM generate_series(1, ${N.tyres}) g;

-- opening stock
INSERT INTO stock_ledger (id, "branchId", "productId", "txnType", qty, rate, "refType", "createdAt", notes)
SELECT gen_random_uuid(), '${branchId}', p.id, 'opening', 20 + (row_number() OVER ()) % 30, p."purchasePrice", 'opening', now() - interval '5 years', 'perf'
FROM products p WHERE p."branchId" = '${branchId}' AND p.sku LIKE 'SKU-%';

-- bills: one tyre line each (60% two lines), spread over 5 years
CREATE TEMP TABLE _b AS
SELECT g, gen_random_uuid() AS id,
       (SELECT id FROM parties WHERE "branchId" = '${branchId}' AND name = 'Customer ' || (1 + (g * 7919) % ${N.parties})) AS party,
       (current_date - ((g * 37) % 1825))::date AS d,
       (3000 + (g % 90) * 100) * (1 + g % 4) AS total
FROM generate_series(1, ${N.bills}) g;

INSERT INTO invoices (id, "branchId", "partyId", "createdBy", "txnType", number, date, "dueDate", status, subtotal, "discountAmt", "taxableAmt",
                      "cgstTotal", "sgstTotal", "igstTotal", "cessTotal", "roundOff", "grandTotal", "paidAmt", "domainData", "aiMeta", "createdAt", "updatedAt")
SELECT id, '${branchId}', party, '${userId}', 'sale_invoice', 'P-' || g, d, d + 15,
       CASE WHEN g % 11 = 0 THEN 'partial' WHEN g % 17 = 0 THEN 'confirmed' ELSE 'paid' END,
       round(total / 1.18, 2), 0, round(total / 1.18, 2), round(total / 1.18 * 0.09, 2), round(total / 1.18 * 0.09, 2), 0, 0, 0, total,
       CASE WHEN g % 11 = 0 THEN round(total / 2) WHEN g % 17 = 0 THEN 0 ELSE total END,
       jsonb_build_object('sale_kind','retail','bill_series','car','vehicle_no','GJ03AB' || lpad((g % 9000)::text, 4, '0'),'source','tyre_counter'), '{}',
       d::timestamptz, d::timestamptz
FROM _b;

INSERT INTO invoice_items (id, "invoiceId", "productId", description, "hsnSacCode", qty, unit, rate, "discountPct", "discountAmt", "taxableAmt",
                           "gstRate", "cgstAmt", "sgstAmt", "igstAmt", total, "sortOrder", "itemMeta")
SELECT gen_random_uuid(), b.id, p.id, p.name, '4011', 1 + b.g % 4, 'pcs', p."salePrice", 0, 0, round(b.total / 1.18, 2), 18,
       round(b.total / 1.18 * 0.09, 2), round(b.total / 1.18 * 0.09, 2), 0, b.total, 0,
       jsonb_build_object('item_kind','tyre','brand', p."domainAttrs"->>'brand', 'size', p."domainAttrs"->>'size')
FROM _b b JOIN LATERAL (SELECT * FROM products WHERE "branchId" = '${branchId}' AND sku = 'SKU-' || (1 + (b.g * 13) % ${N.tyres})) p ON true;

INSERT INTO stock_ledger (id, "branchId", "productId", "txnType", qty, rate, "refType", "refId", "createdAt", "createdBy")
SELECT gen_random_uuid(), '${branchId}', ii."productId", 'sale', -ii.qty, ii.rate, 'invoice', ii."invoiceId", i."createdAt", '${userId}'
FROM invoice_items ii JOIN invoices i ON i.id = ii."invoiceId" WHERE i."branchId" = '${branchId}' AND i.number LIKE 'P-%';

-- restock so stock doesn't go hugely negative
INSERT INTO stock_ledger (id, "branchId", "productId", "txnType", qty, rate, "refType", "createdAt")
SELECT gen_random_uuid(), '${branchId}', p.id, 'purchase', 200 * ${scale}, p."purchasePrice", 'grn', now() - interval '1 day'
FROM products p WHERE p."branchId" = '${branchId}' AND p.sku LIKE 'SKU-%';

-- payments (one per paid bill) + allocations
CREATE TEMP TABLE _p AS
SELECT gen_random_uuid() AS pid, i.id AS inv, i."partyId", i."paidAmt", i.date, i."createdAt"
FROM invoices i WHERE i."branchId" = '${branchId}' AND i.number LIKE 'P-%' AND i."paidAmt" > 0;
INSERT INTO payments (id, "branchId", "partyId", amount, method, "paymentDate", "createdBy", "createdAt", type, status)
SELECT pid, '${branchId}', "partyId", "paidAmt", (ARRAY['cash','upi','cash','card'])[1 + (extract(day from date)::int % 4)], date, '${userId}', "createdAt", 'receipt', 'active' FROM _p;
INSERT INTO payment_allocations (id, "paymentId", "invoiceId", amount) SELECT gen_random_uuid(), pid, inv, "paidAmt" FROM _p;

-- vehicles
INSERT INTO tyre_vehicles ("branchId", "regNo", "vehicleType", "makeModel", "tyreSize", "ownerName", "ownerPhone", "lastServiceDate", "lastOdometer", "nextServiceDate", "nextServiceFor")
SELECT '${branchId}', 'GJ0' || (g % 9) || 'XX' || lpad(g::text, 5, '0'), 'car', (ARRAY['Swift','Creta','i20','Nexon','Innova'])[1 + g % 5],
       (135 + (g % 14) * 10) || '/' || (50 + (g % 8) * 5) || ' R' || (12 + g % 8), 'Owner ' || g, '9' || lpad((300000000 + g)::text, 9, '0'),
       current_date - (g % 400), 20000 + g % 80000, current_date + ((g % 200) - 40), 'Wheel alignment'
FROM generate_series(1, ${N.vehicles}) g;

-- warranty register
INSERT INTO tyre_warranty ("branchId", "invoiceId", "invoiceNo", "productId", "itemName", "itemKind", brand, size, "serialNo", "dotCode", position,
                           "customerName", "customerPhone", "vehicleNo", "soldOn", "warrantyMonths", "warrantyUntil", status)
SELECT '${branchId}', b.id, 'P-' || b.g, NULL, 'Tyre ' || b.g, 'tyre', 'Yokohama', '185/65 R15', 'SN' || b.g || '-' || s, '2524', 'FL',
       'Customer ' || (1 + (b.g * 7919) % ${N.parties}), '9' || lpad((100000000 + (1 + (b.g * 7919) % ${N.parties}))::text, 9, '0'), 'GJ03AB' || lpad((b.g % 9000)::text, 4, '0'),
       b.d, 36, b.d + interval '36 months', CASE WHEN b.g % 40 = 0 THEN 'claimed' ELSE 'active' END
FROM _b b, generate_series(1, 2) s WHERE b.g <= ${Math.floor(N.warranty / 2)};

-- expenses
INSERT INTO expenses (id, "branchId", date, category, description, amount, "paymentMode", "createdBy")
SELECT gen_random_uuid(), '${branchId}', current_date - (g % 1825),
       (ARRAY['rent','electricity','hamali','freight_inward','tyre_purchase','staff','misc','machine_maintenance'])[1 + g % 8],
       'Perf expense ' || g, 200 + (g % 60) * 100, (ARRAY['cash','upi','bank'])[1 + g % 3], '${userId}'
FROM generate_series(1, ${N.expenses}) g;

ANALYZE;
SELECT 'bills' k, count(*) FROM invoices WHERE "branchId" = '${branchId}'
UNION ALL SELECT 'items', count(*) FROM invoice_items
UNION ALL SELECT 'stock rows', count(*) FROM stock_ledger
UNION ALL SELECT 'payments', count(*) FROM payments
UNION ALL SELECT 'parties', count(*) FROM parties
UNION ALL SELECT 'products', count(*) FROM products
UNION ALL SELECT 'vehicles', count(*) FROM tyre_vehicles
UNION ALL SELECT 'warranty', count(*) FROM tyre_warranty
UNION ALL SELECT 'expenses', count(*) FROM expenses;
`
console.log('loading … (this takes a minute)')
const t0 = Date.now()
console.log(psql(sql, true).split('\n').filter((l) => /\|/.test(l)).join('\n'))
console.log(`loaded in ${((Date.now() - t0) / 1000).toFixed(0)}s`)
