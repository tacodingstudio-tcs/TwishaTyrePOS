# HisabKitab Tyre Platform

Billing + counter software for an Indian **tyre shop / dealer** (retail, wholesale, fitting centre).
It is the tyre vertical of the HisabKitab billing platform — same stack, same architecture, same UI
shell — as its own repository.

What it covers: **find a tyre by size → bill it with fitting services → serial / DOT / warranty →
customer vehicle & service reminders → WhatsApp the invoice**, plus the usual books (invoices,
payments, aging, GST reports, purchase orders, stock, staff) inherited from the billing core.

> Scope: tyres, tubes, wheels and fitting services for a single shop. Retreading, tyre manufacturing and
> multi-branch chains are not modelled. One tenant = one business = one branch (additional branches
> are deliberately blocked).

## What's in it

| Area | Screens (sidebar) | Notes |
|---|---|---|
| **Counter** | Home · New Sale · Tyre Stock · All Bills · Customers | **New Sale** is one screen: vehicle no (known vehicles auto-fill), customer by name/mobile, size search (`205/55 R16`, `205 55 16`, `2055516` all match), fitting services as one-tap chips, serial / DOT / fitted position per tyre, old-tyre exchange, split cash/UPI/card, credit with due date. **Tyre Stock** is the size finder with brand/vehicle filters and margin (owner/manager only) |
| **Alignment & balancing** | Alignment & Balancing (sidebar) | A service-only visit with no tyre: pick the services, wheels done, optional before/after alignment readings (printed on the bill). Each service has its own reminder interval — balancing 90 days / 5,000 km, alignment 180 days / 10,000 km, tyre fitting 180 days — set under *Edit business* |
| **After-sales** | Vehicles · Warranty · Service Reminders · WhatsApp Messages | Every vehicle fitted, with tyre size and next check; warranty register searchable by serial / vehicle / mobile / bill, with claims (replaced / pro-rata / repaired / rejected); due-for-check list with one-tap WhatsApp; delivery log with retry |
| **Money** | Money to Collect · Shop Costs · Sales & Margin · GST Reports · Charts | Sales and margin by size / brand / item / vehicle type, dead stock (money sitting on the shelf) |
| **Stores (core)** | Stock levels · Items · Suppliers · Purchase orders · Goods receipts · Adjustments | Unchanged billing-platform modules; tyres are items with tyre attributes |

**GST.** A sale is a normal `sale_invoice`; CGST+SGST vs IGST is picked from the customer's state. Tyres
default to **18%** (HSN by vehicle class, `4011…`), fitting services to **18%** under SAC `998714`. These
are configuration (*My Business → Edit business*), **not tax advice — confirm with your CA**.
**Old-tyre exchange:** the bill stays at full value and the allowance is settled against it as a payment of
method *exchange* (the old tyre is the customer's consideration in kind, so GST is on the full price); the
old tyres go into a *scrap* item. Your CA should confirm this treatment for your case.

## Run it locally

Requirements: Node ≥ 20, pnpm 9, Docker.

```bash
pnpm install
docker compose -f docker/docker-compose.yml up -d postgres redis   # PG :5435, Redis :6382
cp .env.example apps/api/.env
pnpm db:migrate:prod                                               # creates the schema
pnpm --filter @billing/api dev                                     # API  → http://localhost:3200
pnpm --filter @billing/web dev                                     # Web  → http://localhost:5175
pnpm seed                                                          # optional demo shop (API must be running)
```

Log in at http://localhost:5175 — **owner `9200000001` / `1111`** (Shree Tyres & Wheels, 13 tyre models,
~25 bills over 15 days, customers with vehicles, an exchange, a credit bill, a warranty claim),
manager `9200000011` / `2222`, viewer `9200000012` / `3333`.

| | |
|---|---|
| API / Web | `localhost:3200` / `localhost:5175` (Vite proxies `/api` → 3200) |
| Postgres | `localhost:5435`, db `billing_db`, user `billing_app` / `localdev123` |
| pgAdmin / Redis UI (optional) | `docker compose … up -d` → `localhost:5052`, `localhost:8083` |

These ports are deliberately different from billingPlatform / hotelPlatform / transportPlatform so every
repo can run at once.

## Tests

```bash
pnpm test:api     # 48 integration tests against the running API (self-provisioning throwaway tenants)
(cd apps/api && npx tsc --noEmit)
(cd apps/web && npx tsc --noEmit)
```

## WhatsApp & PDFs

* **Invoice PDF** (`GET /api/tyre/invoices/:id/pdf`) is rendered server-side with pdfkit — no Chromium —
  with a warranty-card page when the bill has serial-numbered tyres.
* **WhatsApp**: manual *WhatsApp bill* button always works; automatic sends (invoice, payment reminders,
  service reminders, owner digest) are **off until switched on** under *WhatsApp Messages*. Needs
  `WHATSAPP_TOKEN` / `WHATSAPP_PHONE_NUMBER_ID`; to reach customers outside Meta's 24-hour window set
  `WHATSAPP_TEMPLATE_NAME` (an approved template with one `{{1}}` body variable).
* Daily alerts run at 09:30 IST inside the API when `RUN_WORKERS_INLINE=true`, or as
  `tsx --env-file=.env src/workers/index.ts`.

## Docs

* `docs/ARCHITECTURE.md` — how it works and the decisions behind it
* `docs/DEPLOY.md` — Neon + Render + Vercel walkthrough
* `CLAUDE.md` — conventions and gotchas for working in this repo
