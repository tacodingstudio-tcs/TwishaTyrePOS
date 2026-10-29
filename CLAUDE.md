# Tyre Platform — CLAUDE.md

Tyre shop / dealer billing + counter operations (size finder → sale with fitting → serial / warranty →
vehicle reminders). Tyre vertical of HisabKitab; same architecture as billingPlatform and transportPlatform.
Read `README.md` (run it) and `docs/ARCHITECTURE.md` (how it works) first.
**Licensing** (the offline installer only runs on the PC its signed license names): everything is in `docs/LICENSING.md` — read it before touching the
installer, the `server.ts` license gate, or when asked to make / renew a license.

## Commands

```bash
pnpm install
docker compose -f docker/docker-compose.yml up -d postgres redis   # PG :5435, Redis :6382
cp .env.example apps/api/.env && pnpm db:migrate:prod
pnpm --filter @billing/api dev      # API :3200        pnpm --filter @billing/web dev   # Web :5175
pnpm seed                           # demo shop: owner 9200000001 / 1111
pnpm test:api                       # ~380 integration tests (14 suites) — needs the API running
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
15. **Redis must never block a request.** Request paths (cache, sign-in counter, ai insight flag) use `redisFast` from
    `lib/redis.ts` (fails in ~1.5 s, no offline queue); only the BullMQ workers use the patient `redis` client. Queue
    producers go through `addJob()` (time-boxed) and report "queue unreachable" instead of hanging. Every Redis use must
    fail open: `e2e/redis-down.sh` stops Redis and checks sign-in, a sale, PDF, Excel, charts still answer.
16. **Tyre-only code base.** Removed on purpose (see `docs/cleanup/REPORT.md`): Contracts, generic staff attendance/shifts,
    the Broadcast page, Razorpay payment links/webhook, the AI tools page and its endpoints, the Chromium PDF queue/worker
    (`@billing/pdf`), the daily AI reminder drafts. Bills/quotations/documents are PDFs built by pdfkit on demand
    (`/api/tyre/invoices/:id/pdf`) — do not reintroduce a queue for them. `src/__tests__/tyre-cleanup.test.ts` pins the removed routes to 404.
    The empty tables/columns of the other verticals stay in the tenant schema on purpose (zero runtime cost, no live migration).
17. **The bill is the shop's Excel sheet, redrawn** (`lib/tyre-bill-shakti.ts`): same 11 columns / row heights / borders / number
    formats, A4 fit-to-width, Calibri-twin font Carlito (`assets/fonts`, OFL). Do not restyle it. After any change run
    `npx tsx e2e/bill-preview.ts` and compare with Excel's own export using `e2e/bill-compare.py` (positions must stay within 0.4 % of
    the bill width). Tests read the PDF text through `__tests__/pdf-text.ts` (it understands embedded fonts).
    **Payment QR:** a sale bill that still has a balance, for a shop that saved its UPI ID (My Business → Edit business: `upi_id`, optional `upi_name`,
    `upi_mcc`, `upi_banner`), prints a scan-and-pay QR for the balance in the bank-details band (vector squares, `payQr` in `InvoicePdfData`, built in
    `renderInvoicePdf` via `lib/tyre-upi.ts`). The same PDF goes out on WhatsApp, so the QR travels with it. Fully paid bills, quotations and
    purchase / return documents carry none. The link builder exists twice and must stay identical: `apps/api/src/lib/tyre-upi.ts` and
    `apps/web/src/lib/upi.ts` (the "Show QR to customer" card); `tyre-bill-layout.test.ts` pins the exact string. Check a bill's QR with
    `npx tsx e2e/bill-preview.ts <dir>` then `python e2e/bill-qr-decode.py <dir> credit memo`.

18. **Licensing is on in the packaged app only** (`LICENSE_REQUIRED=true` set by `deploy/offline/runtime/cli.mjs`). Every `/api/*` call except `/api/license/*`
    answers 402 until a valid license is activated; the installer's own first-run `shop()` step passes `x-setup-key`. Never commit a private key
    or a `.lic`; the signing key lives in `E:\softwares\_license-keys\private.pem`. Details: `docs/LICENSING.md`.

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
  screen (bill, double-tap, empty bill, credit with no customer, expired session, read-only user);
  `e2e/flow-warranty.ts` walks sale-with-serial → claim sent to the company → company reply with a replacement → edit → claims report → void; `e2e/size-picker.ts` checks the size lists.
  Both need the API (:3200), the web app (:5175) and the demo shop: `npx tsx e2e/crawl.ts`.
* `src/__tests__/tyre-workbook.test.ts` replays the shop's paper book (`Shakti Bill Book.xlsx`, CAR + Two Wheel) and
  checks totals / taxable / GST against the sheet's own formulas. The data file holds real customers, so it lives in
  `apps/api/e2e/data/` (git-ignored); without it the suite is skipped. `tyre-client-edge.test.ts` covers dates,
  name-only customers, repeat returns, credit instalments, big bills, forgotten PIN.
* Rules these checks introduced: a bill date must be a real day, not in the future and not older than a year; a
  customer typed without a mobile keeps the name in `domainData.customer_name` (no party record); returns are totalled
  against the original bill; two bill books cannot share a prefix; sizes may carry load/speed/ply/LT ratings (dropped
  by `normalizeTyreSize`), single-digit rims and tractor sizes.
* Bill search (`listInvoices`) is two index-driven look-ups (bill number / customer name / mobile, "starts with") using the
  `lower(...) text_pattern_ops` indexes in `tyre-ddl.ts`; the count stops at 10,000 (`meta.capped`). After deploying, run
  `pnpm provision:all` once so existing shops get those indexes (search works without them, just slower).
* Warranty claims (`lib/tyre-warranty.ts`): outcome `pending` = sent to the tyre company (finish it with
  `PATCH /warranty/:id/claim`, owner/manager); `replaced` + `replacement{productId,serialNo}` takes one tyre out of stock and
  creates a linked warranty row (same end date) in the same transaction; claims are atomic (no double claim);
  `PATCH /warranty/:id` fixes customer/vehicle/serial/DOT; every change lands in `claimHistory`; report at
  `GET /api/tyre/reports/claims`. The claim columns are added by `provision:all` and also on first use
  (`ensureWarrantySchema`), so a deploy cannot break a shop that was not re-provisioned.
* Sign-in lock (5 wrong PINs, 15 min) lives in `lib/login-throttle.ts`. Owner or manager lifts it with
  `POST /api/users/:id/unlock` (Staff screen shows "Locked · N min" + Unlock; a manager may unlock the owner; a PIN
  reset also lifts it). Nobody left inside: `REDIS_URL=… npx tsx scripts/unlock-account.ts <ownerPhone> [userPhone]`.

## Not done / ideas

E-way bill generation for wholesale dispatch (the transportPlatform has a GSP adapter to port); credit notes
that void warranty rows (a goods return, `POST /api/invoices/:id/return`, now does; a credit note is money-only and does not); per-DOT stock
lots and FIFO by manufacture date; barcode/QR on tyre sidewall; GPS-free
vehicle service history import; retreading job cards. Package scope is intentionally still `@billing/*` to
keep patches portable.

## Deployment

Same shape as transportPlatform — see `docs/DEPLOY.md`. `render.yaml` and both `vercel.json` files point at
`https://tyre-api.onrender.com` as a **placeholder**: change the host to your real Render service before
deploying the web app.
