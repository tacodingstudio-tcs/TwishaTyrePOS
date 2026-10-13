# Tyre Platform — Architecture

This repo is the tyre vertical of HisabKitab. The platform architecture (schema-per-tenant PostgreSQL,
JWT → `req.db`, domain registry, shared invoice/GST/payment core) is unchanged — see the billingPlatform
`ARCHITECTURE.md` for the long-form explanation. This document covers what is **specific to the tyre
shop** and the decisions behind it.

## 1. Shape of the system

```
React (apps/web)  ──/api──▶  Fastify (apps/api)  ──▶  PostgreSQL
                                   │                    ├─ public.tenants, refresh_tokens, idempotency_keys
                                   │                    └─ t_<slug>.*   one schema per business
                                   └─ routes/tyre*.ts  (raw SQL on tyre_* tables)
                                      routes/invoices.ts, products.ts … (shared billing core, Prisma)
```

* **One tenant = one business = one branch** (the shared core is keyed by `branchId`; `POST /api/branches` is 403).
* **One domain**, `tyre`, in `packages/domain-registry`: the Zod schemas the shared invoice/product services
  validate against (`productAttrs`, `invoiceData`, `itemMeta`), feature flags, default branch config,
  expense categories, default HSN by vehicle class and `normalizeTyreSize()`.
* Tenant tables are created by `create_tenant_schema()` (`docker/init.sql`, generic billing tables) and then
  `provisionTenantSchema()`, which also runs `lib/tyre-ddl.ts`. Both are idempotent.
* Registration seeds categories (car / two-wheeler / truck / tractor / tubes / wheels / consumables / scrap /
  services) and the default **fitting services** (fitting, balancing, alignment, puncture, rotation,
  nitrogen, valve) plus an *Old Tyre (scrap)* item (`lib/tyre-seed.ts`).

## 2. Data model

Products, stock, suppliers, purchase orders, parties, invoices and payments are the **core** tables. A tyre is
a product whose `domainAttrs` carry `item_kind`, `brand`, `pattern`, `size`, `vehicle_type`, `tube_type`,
`load_index`, `warranty_months` … A service is a product with `itemType = 'service'` (no stock).

Raw-SQL tables (not in `schema.prisma`), camelCase quoted columns, every row carrying `branchId`:

| Table | Purpose | Key facts |
|---|---|---|
| `tyre_vehicles` | Customer vehicles | unique `(branchId, regNo)`; owner/party link, tyre size, last fitted + odometer, **next service date**, `remindersOff` |
| `tyre_warranty` | One row per serial-numbered unit sold | invoice link, serial, DOT, fitted position, customer snapshot, `warrantyUntil`, `status` active/claimed/void, claim outcome; **partial unique index on live serials per product** |
| `tyre_notifications` | WhatsApp delivery log | queued/sent/failed/skipped, `dedupeKey` unique per branch |

There is no job-card or trip table: a **sale is a bill**. Everything the counter records beyond the bill
(serials, DOT, positions, vehicle, exchange) rides in the invoice's `domainData` / `itemMeta` *and* in the
tables above, so it can be queried without parsing invoices.

## 3. The counter sale — `POST /api/tyre/sales`

One request: vehicle, customer (id or name+mobile → find-or-create party), items (tyres with serials / DOT /
positions, services), optional exchange, split payments, credit days.

1. **Validate** against the catalogue: products exist and belong to the business; stock (aggregated per
   product) from the ledger; serials ≤ qty, unique within the request and among live warranty rows; serial /
   DOT only on serialised kinds; `serial_required` config; below-cost guard (counter staff blocked, manager
   warned).
2. **Price / GST:** rate defaults to the catalogue price; a catalogue GST of 0 on a non-exempt item falls back
   to the shop default (18%); HSN defaults by kind / vehicle class; CGST+SGST vs IGST decided by the core.
3. **`createInvoice`** (shared service): numbering, stock out under row locks, party balance, split payments.
4. **After-sale records**, each in its own try/catch so a failure is a `warning`, never a lost sale:
   warranty rows; vehicle upsert + next-service date (`service_reminder_days`, default 180) ; exchange.
5. **Idempotency:** the client's `Idempotency-Key`, else a derived key (content + 20-second window), so a
   double-click never sells or deducts twice.

### Old-tyre exchange
Under GST an exchange is a supply for non-monetary + monetary consideration, so **tax stays on the full
price**. The allowance is recorded as a payment of method `exchange` allocated to the bill (so status, party
balance and aging follow the normal payment path), and the old tyres are stocked into the *scrap* item with
cost = allowance. This is the accounting treatment we chose — **the shop's CA should confirm it**.

## 4. Finding tyres
`GET /api/tyre/finder` matches sizes through one canonical spelling: `205/55 R16`, `205/55R16`, `205 55 16`,
`2055516`, `205/55-16`, `205/55ZR16` → `205/55R16` (also `10.00R20`, `90/90-17`, `295/80R22.5`). The same
normalisation exists in `normalizeTyreSize()` (registry, JS) and `SIZE_KEY` (SQL); a digits-only prefix match
is the fallback. Stock is `SUM(stock_ledger.qty)`.

## 5. Warranty
Rows are created at sale for serialised kinds (`tyre`, `tube`, `alloy_wheel`, `battery`) that have a serial
or a warranty period (item → shop default). A claim is recorded once with an outcome and notes; an expired
warranty can only be recorded as *rejected*; voiding (manager) frees the serial. Cancelling a bill voids
its rows. The invoice PDF carries a warranty-card page.

## 6. API surface (`/api/tyre`)

| Group | Endpoints |
|---|---|
| Home | `GET /dashboard` |
| Finder | `GET /finder?size&brand&vehicleType&kind&q&inStock&id`, `GET /sizes`, `GET /brands`, `GET /dead-stock?days` |
| Sale | `POST /sales`, `GET /sales/:invoiceId` |
| Vehicles | `GET/POST /vehicles`, `GET /vehicles/lookup?regNo`, `GET/PATCH/DELETE /vehicles/:id`, `POST /vehicles/:id/remind`, `GET /reminders?days` |
| Warranty | `GET /warranty?serial&vehicleNo&phone&invoiceNo&search&status&expiringDays`, `POST /warranty/:id/claim`, `POST /warranty/:id/void` |
| Reports | `GET /reports/sales?by=size|brand|product|vehicle_type&from&to` |
| Documents / WhatsApp | `GET /invoices/:id/pdf`, `POST /invoices/:id/notify`, `GET /notifications`, `POST /notifications/:id/retry`, `GET/PUT /notify-settings`, `POST /notify/run-alerts` |

Roles: `viewer` read-only (403 on writes, no margin column); `cashier` can sell and record claims;
`owner`/`manager` can also void warranty, change settings and sell below cost.

## 7. WhatsApp
Same machinery as transportPlatform: every message is a `tyre_notifications` row **and** a job on the
`whatsapp-send` queue; the worker uploads the PDF as media and sends a document (or a template message when
`WHATSAPP_TEMPLATE_NAME` is set). Automatic sends are opt-in (`notify_invoice`, `notify_payment_reminders`,
`notify_service_reminders`, `notify_owner_alerts`). The daily job (09:30 IST) sends overdue-bill reminders,
service-due reminders (vehicles whose `nextServiceDate` has passed, not older than 60 days) and an owner
digest (low stock, overdue money, warranties ending). Dedupe keys make re-runs harmless.

## 8. Conventions & gotchas
* **Prisma returns `NUMERIC` as Decimal and `COUNT()` as BigInt** — `norm()` converts both. Never return raw `$queryRaw` rows.
* **`DATE` columns arrive as `Date` at UTC midnight** — use `ymd()`.
* **Business dates are IST** — `todayStr()`.
* Web: React Query + `tyreApi` in `lib/api.ts`; party / supplier fields use `PartyCombobox` (type-ahead,
  keyboard, `type=customer|supplier`; "both" parties match either).

## 9. Differences from transportPlatform
Removed: LR / trip / fleet / driver / route / e-way / freight-billing modules, `transport_*` tables, TDS card.
Added: the tyre module above, tyre registry domain, size normalisation, exchange payment method.
Kept (and shared): server-side PDFs, WhatsApp worker + delivery log, party type-ahead, idempotency fix,
single-business accounts, deployment shape.
