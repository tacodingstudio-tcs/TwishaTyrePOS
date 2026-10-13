# Tyre Platform — CLAUDE.md

Tyre shop / dealer billing + counter operations (size finder → sale with fitting → serial / warranty →
vehicle reminders). Tyre vertical of HisabKitab; same architecture as billingPlatform and transportPlatform.
Read `README.md` (run it) and `docs/ARCHITECTURE.md` (how it works) first.

## Commands

```bash
pnpm install
docker compose -f docker/docker-compose.yml up -d postgres redis   # PG :5435, Redis :6382
cp .env.example apps/api/.env && pnpm db:migrate:prod
pnpm --filter @billing/api dev      # API :3200        pnpm --filter @billing/web dev   # Web :5175
pnpm seed                           # demo shop: owner 9200000001 / 1111
pnpm test:api                       # 48 integration tests — needs the API running
pnpm provision:all                  # re-apply tenant DDL to existing tenants after tyre-ddl.ts changes
(cd apps/api && npx tsc --noEmit)   # typecheck (tests are excluded from the build; ts-jest checks them)
(cd apps/web && npx tsc --noEmit)
```

`pnpm --filter @billing/api dev` runs `tsx watch`, so server edits reload. Don't start it on
:3000/:3001/:3100 — those belong to billingPlatform / transportPlatform.

## Where things live

* `apps/api/src/routes/tyre-{catalog,sales,vehicles,reports,comms}.ts` — the module; `tyre.ts` mounts them at `/api/tyre`.
* `apps/api/src/lib/tyre-ddl.ts` — tenant tables `tyre_vehicles`, `tyre_warranty`, `tyre_notifications`
  (add columns with `ALTER TABLE … ADD COLUMN IF NOT EXISTS`, then `pnpm provision:all`). Statements must
  start with `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE` / `CREATE [UNIQUE] INDEX IF NOT EXISTS` (see `runDDL`).
* `apps/api/src/lib/tyre-helpers.ts` — raw-SQL helpers, IST dates, role guards, `voidWarrantyForInvoice`.
* `apps/api/src/lib/tyre-{pdf,docs,notify,seed}.ts` — invoice PDF, document loader, WhatsApp, default services.
* `apps/api/src/workers/tyre-alerts.worker.ts` — daily reminders; `whatsapp.worker.ts` does delivery.
* `packages/domain-registry/src/index.ts` — the `tyre` domain (Zod schemas, GST/HSN defaults, `normalizeTyreSize`).
* `apps/web/src/pages/tyre/*`, `components/tyre/*`, `components/ui/PartyCombobox.tsx`, `tyreApi` in `lib/api.ts`.
* `apps/api/scripts/seed-demo.ts` — seeds through the real HTTP API (doubles as a smoke test).

## Rules that bite

1. **Never return raw `$queryRaw` rows** — NUMERIC→Decimal (JSON string) and COUNT→BigInt (JSON throws).
   Go through `q()/q1()` (they `norm()`), or `Number()` / `::float` explicitly.
2. **DATE columns are `Date` objects at UTC midnight.** Use `ymd()`; never `String(d).slice()`.
3. **Business dates are IST**, server may be UTC: `todayStr()`.
4. **Stock is `SUM(stock_ledger.qty)`** — the same figure the invoice service locks and checks. Don't read
   `stock_summary` for decisions. The sale route pre-checks stock only to give a clean 409.
5. **A sale = `createInvoice` + after-sale records** (warranty rows, vehicle, exchange payment, scrap
   stock). Follow-up failures become `warnings` in the response, never a lost sale. Keep it that way.
6. **Serial uniqueness** is a partial unique index (live rows only). Voiding a warranty row frees the serial.
7. **Old-tyre exchange** is a payment with `method: 'exchange'` (added to `payments.ts` and
   `invoice.service.ts` enums) — never a discount line; GST stays on the full price.
8. **Size matching** lives in two places that must agree: `normalizeTyreSize()` (registry) and the
   `SIZE_KEY` SQL in `tyre-catalog.ts`. Change both and add a case to the finder test.
9. Raw SQL: parameterise everything; identifiers only via `tbl()`/fixed strings; `insertRow/updateRow`
   add the `::uuid/::date/::timestamptz` casts (add new columns to `COL_CAST`).
10. Domain-data / item-meta Zod schemas in the registry are `.strict()` — a new bill field must be added there.
11. Single business: don't add branch pickers; `POST /api/branches` is intentionally 403.
12. Automatic WhatsApp sends are opt-in per business (`notify_*` in branch config). Never switch one on by default.

## Testing notes

`tyre.test.ts` registers its own tenants (phones `7xxxxxxxxx`, purged by `global-setup.ts`), so it never
depends on seed data. The jest harness adds a unique `Idempotency-Key` to POSTs; pass an explicit header
to exercise replay behaviour.

## Not done / ideas

E-way bill generation for wholesale dispatch (the transportPlatform has a GSP adapter to port); returns
that void warranty rows automatically (today: void by hand, or cancel an unpaid bill); per-DOT stock
lots and FIFO by manufacture date; supplier tyre-claim tracking; barcode/QR on tyre sidewall; GPS-free
vehicle service history import; retreading job cards. Package scope is intentionally still `@billing/*` to
keep patches portable.

## Deployment

Same shape as transportPlatform — see `docs/DEPLOY.md`. `render.yaml` and both `vercel.json` files point at
`https://tyre-api.onrender.com` as a **placeholder**: change the host to your real Render service before
deploying the web app.
