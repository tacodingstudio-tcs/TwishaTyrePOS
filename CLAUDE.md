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
pnpm test:api                       # 197 integration tests (3 suites) — needs the API running
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
12. **Viewers are read-only globally**: a `preHandler` in `server.ts` returns 403 for every non-GET from a
    viewer behind the login. Don't rely on (or add) per-route checks for that.
13. NUL characters in any query/body string are rejected up front (`preValidation` hook) — Postgres would
    otherwise throw a 500.
14. Automatic WhatsApp sends are opt-in per business (`notify_*` in branch config). Never switch one on by default.

## Testing notes

Three suites in `apps/api/src/__tests__`: `tyre.test.ts` (the module), `tyre-edge.test.ts` (auth/roles,
validation, hostile strings, cross-business access, races, idempotency, the daily alert job) and
`tyre-core.test.ts` (the billing-core flows a shop uses: purchasing, payments, returns, expenses, staff,
reports). To test the production image rather than dev:
`docker build -f docker/Dockerfile.api -t tyre-api:test .`, run it with `FORCE_SEARCH_PATH=true` against the
local Postgres/Redis (`host.docker.internal`), then `TEST_API_PORT=<mapped port> npx jest --runInBand`.

`tyre.test.ts` registers its own tenants (phones `7xxxxxxxxx`, purged by `global-setup.ts`), so it never
depends on seed data. The jest harness adds a unique `Idempotency-Key` to POSTs; pass an explicit header
to exercise replay behaviour.

## End-to-end checks (client view)

* `apps/api/e2e/crawl.ts` opens every screen as owner / manager / viewer and on a phone-size screen and reports
  crashes, stuck loaders, failed requests and console errors. `apps/api/e2e/flow-sale.ts` drives the real New Sale
  screen (bill, double-tap, empty bill, credit with no customer, expired session, read-only user).
  Both need the API (:3200), the web app (:5175) and the demo shop: `npx tsx e2e/crawl.ts`.
* `src/__tests__/tyre-workbook.test.ts` replays the shop's paper book (`Shakti Bill Book.xlsx`, CAR + Two Wheel) and
  checks totals / taxable / GST against the sheet's own formulas. The data file holds real customers, so it lives in
  `apps/api/e2e/data/` (git-ignored); without it the suite is skipped. `tyre-client-edge.test.ts` covers dates,
  name-only customers, repeat returns, credit instalments, big bills, forgotten PIN.
* Rules these checks introduced: a bill date must be a real day, not in the future and not older than a year; a
  customer typed without a mobile keeps the name in `domainData.customer_name` (no party record); returns are totalled
  against the original bill; two bill books cannot share a prefix; sizes may carry load/speed/ply/LT ratings (dropped
  by `normalizeTyreSize`), single-digit rims and tractor sizes.
* Sign-in lock (5 wrong PINs, 15 min) lives in `lib/login-throttle.ts`. Owner or manager lifts it with
  `POST /api/users/:id/unlock` (Staff screen shows "Locked · N min" + Unlock; a manager may unlock the owner; a PIN
  reset also lifts it). Nobody left inside: `REDIS_URL=… npx tsx scripts/unlock-account.ts <ownerPhone> [userPhone]`.

## Not done / ideas

E-way bill generation for wholesale dispatch (the transportPlatform has a GSP adapter to port); credit notes
that void warranty rows (a goods return, `POST /api/invoices/:id/return`, now does; a credit note is money-only and does not); per-DOT stock
lots and FIFO by manufacture date; supplier tyre-claim tracking; barcode/QR on tyre sidewall; GPS-free
vehicle service history import; retreading job cards. Package scope is intentionally still `@billing/*` to
keep patches portable.

## Deployment

Same shape as transportPlatform — see `docs/DEPLOY.md`. `render.yaml` and both `vercel.json` files point at
`https://tyre-api.onrender.com` as a **placeholder**: change the host to your real Render service before
deploying the web app.
