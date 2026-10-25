# Tyre-only clean-up — report

Branch `cleanup/tyre-only` (8 commits on top of `main`). **Not merged, not deployed.** Net change: 51 files, +181 / −6,454 lines.
Everything below was measured on this machine against the same demo shop and a 60,000-bill load shop.

## How it was done

1. **Safety net first** (commit `a6563d2`): route inventory (268 routes), per-route "who calls it" table, baseline test / browser / latency numbers, two flaky e2e scripts steadied.
2. **One feature per commit**, each followed by type-check (API + web) and the full test suite. Any commit can be reverted alone.
3. **Only things no screen can reach.** A feature was removed only if (a) no menu or link leads to it, (b) the web app never calls its endpoints, and (c) nothing else in the API imports it. Things that are merely *unused by the screens but part of billing core* (payments, notifications inbox, discount rules, GRN, transfers…) were **kept**.

## Removed

| What | Why it was safe | Lines |
|---|---|---|
| **Contracts** page, 10 endpoints, hooks, test | no menu entry; tyre shop does not use recurring contracts | ~480 |
| **Generic staff attendance / shifts** page + 7 endpoints | replaced by *Team & Salary*; no menu entry | ~700 |
| **Broadcast** page + `/broadcasts/contacts` (birthday/anniversary panel kept) | no menu entry | ~690 |
| **Razorpay** payment link + webhook + service + dependency | no screen; public webhook endpoint = needless attack surface | ~380 |
| **Old Chromium PDF pipeline**: queue job on every saved bill, worker, `@billing/pdf` package, generic `/invoices/:id/pdf` | all PDFs come from `/api/tyre/invoices/:id/pdf` (pdfkit). The production image has **no Chromium**, so on Render every sale queued a job that failed 3× and logged errors — wasted Redis commands (part of the Upstash quota problem) | ~1,100 |
| **AI tools page** + 15 endpoints/services only it used, daily AI reminder-draft worker | `/ai` has no menu link; its drafts could only be approved on that page. Kept: Home insight card, reorder suggestions, supplier-bill scan | ~3,000 |

Also dropped: `razorpay` dependency; `puppeteer` moved to dev-only (browser test scripts); PM2 config pointed at the removed worker (fixed); Dockerfile / DEPLOY notes updated.

## Deliberately NOT removed

* **Database tables and columns of other verticals** (e.g. `products` has 88 columns). They are empty/NULL, cost ~16 KB per table per shop and nothing at run time (NULLs sit in a bitmap). Dropping them needs an irreversible `ALTER TABLE` on live data, and Prisma uses some tables through *nested writes* that a text search cannot see (e.g. order/receipt item tables). Risk > benefit, so none were dropped. If wanted later: back up, drop only models proven dead by a failing-then-passing test, one at a time.
* Core billing APIs the screens do not currently call (payments list, notifications inbox, discount rules, GRN, transfers…).
* `POST /api/tyre/team/days/bulk` (tyre feature, UI not wired yet).

## Found and fixed during the clean-up

* **Redis outage made sign-in (and anything that touched the cache) hang forever** instead of failing fast. New fast-failing client for request paths; queue adds are time-boxed and WhatsApp reports "queue unreachable — use Retry". `e2e/redis-down.sh` proves it.
* **CA Excel export** held a whole year in memory (~1 GB at 60,000 bills → 502 on small hosts); now streamed in pages (~200 MB). Stock sheet no longer stops at 20,000 items.
* **Cancelled bills were counted** in revenue / charts. Fixed.
* Staff-advances panel called a manager-only endpoint for viewers (403 in console).

## Results

| Check | Before | After |
|---|---|---|
| Automated tests (API) | 355 passed | **380 passed** (354 + 26 new clean-up tests), also **380 on the production Docker image** |
| Screen crawl (132 visits: owner/manager/viewer/phone) | 0 findings | **0 findings** |
| New-sale flow (browser) | 17/17 | **17/17** |
| Warranty flow (browser) | 25/25 | **25/25** |
| Old bookmarks `/contracts` `/staff` `/broadcast` `/ai` | – | redirect to Home, no console errors |
| Redis fully down: sign-in, sale, PDF, Excel, charts | sign-in **hung** | all answer in < 0.4 s (WhatsApp send reports the reason in 2.7 s); recovers by itself |
| Removed endpoints | – | return 404 (never 500) – pinned by `tyre-cleanup.test.ts` |
| GET endpoints (60k-bill shop) | 111 routes, median p50 11 ms | 99 routes, median p50 **11 ms**; p95 > 200 ms: same 2 (CA export, bill register) |
| Save a bill: 1 counter / 10 at once | p50 72 ms / 344 ms, 27 bills/s | p50 61–81 ms / 326–376 ms, 25–29 bills/s (run-to-run noise ±10 %) |
| CA Excel (60k bills, full pack) | 1.3 s, **~1 GB** memory | 1.8 s, **~200 MB** (slower on purpose: streams to disk) |
| API start-up to healthy | 5.7 s | **5.0 s** |
| API idle memory | 206 MB | **187 MB** (−9 %) |
| Web JS (total / gzip) | 1,822 KB / 505 KB | **1,741 KB / 489 KB** |

Raw numbers: `bench-*.txt`, `e2e-*.txt` in this folder.

## Not measured

* Behaviour on Render itself (memory limit, cold start) and with the real Upstash — only the local equivalents above.
* Live data: nothing was run against the live database. No schema change was made, so **no `provision:all` is needed** for this branch.

## Rolling back

Whole thing: `git revert` the merge. One feature: `git revert <its commit>` (hashes in `git log main..cleanup/tyre-only`).
