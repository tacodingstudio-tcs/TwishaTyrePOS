# Deploying: Neon (database) + Render (API) + Vercel (web)

Order matters: **Neon → Render → Vercel → back to Render** (to tell it the Vercel address).

## 1. Neon — database
1. Create a project. Pick the region nearest your users (Singapore for India) and use the same region on Render.
2. Copy the **direct** connection string (host has **no** `-pooler`). Turn "Connection pooling" OFF in the dialog.
   The app sets `search_path` per connection, which the pooled (PgBouncer) endpoint does not guarantee.
3. Neon **SQL Editor** → paste and run `deploy/neon-setup.sql` (extensions + the tenant-schema function).
4. Create the tables, from your machine (needs the connection string):
   ```
   set DATABASE_URL=postgresql://...direct string...
   pnpm --filter @billing/db exec prisma migrate deploy
   ```
   (PowerShell: `$env:DATABASE_URL="..."`.)

## 2. Render — API
1. Push this repo to GitHub/GitLab (it is not committed yet).
2. Render → **New → Blueprint** → pick the repo. It reads `render.yaml` and creates `tyre-api` + `tyre-redis`.
3. When asked, fill `DATABASE_URL` (the Neon direct string). Leave `WEB_URL` blank for now. Optional keys can stay blank.
4. After the first deploy, note the address, e.g. `https://tyre-api-xxxx.onrender.com`.
   Check `https://…/health` returns OK.

## 3. Vercel — web
1. The root `vercel.json` already points the `/api` rewrite at your Render host (edit it if the host changes). Commit + push.
2. Vercel → **Add New Project** → **Import** the repo. Leave **Root Directory** as the repo root; `vercel.json` builds only the web app (`pnpm --filter @billing/web build` → `apps/web/dist`). Deploy.
3. Note the address, e.g. `https://tyre-xxx.vercel.app`.

The web app calls relative `/api/...`; Vercel proxies that to Render via the rewrite, so there is no CORS or `VITE_API_URL` to set.

## 4. Back to Render
Set `WEB_URL` = the Vercel address (no trailing slash) and let it redeploy.

## 5. First business
Open the Vercel address → **Register** to create the client's business. **Do not run `pnpm seed`** on production — it creates demo data with known PINs.

## Things to know
- **Free Render sleeps** after ~15 min idle; the first request then takes 30–60 s. Use the Starter plan for a real client.
- Free Render Key Value (Redis) is not persistent — fine, it only holds queues/cache.
- Uploaded files use local disk, which Render wipes on each deploy (`STORAGE_TYPE=local`). Nothing in the tyre flow depends on uploads today.
- Bill / quotation PDFs are built on request with pdfkit (no Chromium, no queue). Redis only holds the WhatsApp queue and short-lived caches; if it is down or over its plan limit, sales, sign-in, PDFs and exports keep working (WhatsApp messages show "queue unreachable" with a Retry).
- `.npmrc` has `strict-ssl=false` (local proxy workaround). Remove it before building in CI if you do not need it.
- Existing tenants after a schema change: `pnpm provision:all` with `DATABASE_URL` set.
- Backups: Neon keeps point-in-time history (length depends on plan); check it covers what the client expects.
