// Latency benchmark for every GET endpoint, against a running API.
//
//   node scripts/bench.mjs [--phone 9300000001] [--pin 2468] [--runs 12] [--api http://localhost:3200]
//
// Needs the route list first: npx tsx --env-file=.env scripts/dump-routes.ts   (writes scripts/routes.txt)
// Prints one line per endpoint (p50 / p95 / max ms, payload size) sorted slowest first, and a summary.
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const args = process.argv.slice(2)
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d }
const API = opt('api', 'http://localhost:3200')
const PHONE = opt('phone', '9300000001'), PIN = opt('pin', '2468')
const RUNS = Number(opt('runs', '12'))
const routesFile = opt('routes', path.join(path.dirname(fileURLToPath(import.meta.url)), 'routes.txt'))
if (!existsSync(routesFile)) { console.error('routes file missing:', routesFile); process.exit(1) }

// ── parse fastify's printRoutes tree into METHOD path ───────────────────────────────
const lines = readFileSync(routesFile, 'utf8').split('\n').filter((l) => /[├└]──/.test(l))
const stack = []
const routes = []
for (const l of lines) {
  const m = l.match(/^((?:│   |    )*)[├└]── (.*?)(?: \(([^)]*)\))?$/)
  if (!m) continue
  const depth = m[1].length / 4
  const seg = m[2]
  stack.length = depth
  stack[depth] = seg
  if (m[3]) {
    const full = stack.slice(0, depth + 1).map((s, i) => (i > 0 && !s.startsWith('/') && !s.startsWith('-') ? '/' + s : s)).join('')
    for (const method of m[3].split(',').map((x) => x.trim())) if (method === 'GET') routes.push(full.replace(/\/{2,}/g, '/'))
  }
}

// ── login and gather real ids so :params resolve ────────────────────────────────────
const login = await (await fetch(API + '/api/auth/login', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ tenantPhone: PHONE, phone: PHONE, pin: PIN }),
})).json()
if (!login.accessToken) { console.error('login failed'); process.exit(1) }
const H = { authorization: 'Bearer ' + login.accessToken }
const get = async (p) => { try { return await (await fetch(API + p, { headers: H })).json() } catch { return null } }
const first = (r) => (Array.isArray(r) ? r : r?.data ?? r?.rows ?? r?.items ?? [])[0]?.id
const ids = {
  invoices: first(await get('/api/invoices?limit=1')),
  parties: first(await get('/api/parties?limit=1')),
  products: first(await get('/api/products?limit=1')),
  vehicles: first(await get('/api/tyre/vehicles?limit=1')),
  warranty: first(await get('/api/tyre/warranty?limit=1')),
  expenses: first(await get('/api/expenses?limit=1')),
  branches: login.branch?.id,
  po: first(await get('/api/inventory/purchase-orders?limit=1')),
  staff: first(await get('/api/tyre/team/staff')),
}
const resolve = (route) => {
  if (!route.includes(':')) return route
  const r = route
  const pick = /\/invoices\//.test(r) ? ids.invoices : /\/sales\//.test(r) ? ids.invoices : /\/parties\//.test(r) ? ids.parties
    : /\/products\//.test(r) ? ids.products : /\/vehicles\//.test(r) ? ids.vehicles : /\/warranty\//.test(r) ? ids.warranty
    : /\/expenses\//.test(r) ? ids.expenses : /\/branches\//.test(r) ? ids.branches : /purchase-orders\//.test(r) ? ids.po
    : /credit-risk|party|statement/.test(r) ? ids.parties : /\/(ledger|stock-history)\//.test(r) ? ids.products : null
  if (!pick) return null
  return r.replace(/:[A-Za-z]+/g, pick)
}
const SKIP = /\/health|\/admin\/|\/tenants\/(check-phone|gstin)|\/pdf$|\/webhooks|\/export|\/download|\/csv|register\?format=csv|\/invoices\/[^/]+\/(pdf|print)/
const withQuery = (p) => {
  if (/\/analytics\/gst-summary$/.test(p)) return p + '?month=2026-09'
  if (/\/reports\/gstr1$/.test(p)) return p + '?month=2026-09'
  if (/\/reports\/(day-book|cash-register)$/.test(p)) return p + '?date=2026-09-15'
  if (/\/expenses\/summary$/.test(p)) return p + '?from=2026-09-01&to=2026-09-30'
  if (/\/payments\/outstanding$/.test(p)) return p + '?type=customer'
  if (/\/tyre\/team\/payroll$/.test(p)) return p + '?month=2026-10'
  if (/\/tyre\/team\/days$/.test(p)) return p + '?date=2026-10-10'
  if (/\/tyre\/finder$/.test(p)) return p + '?size=185%2065&limit=20'
  if (/\/tyre\/reports\/sales$/.test(p)) return p + '?by=size&from=2025-04-01&to=2026-10-31'
  if (/\/tyre\/reports\/register$/.test(p)) return p + '?from=2025-04-01&to=2026-10-31'
  if (/\/tyre\/reminders$/.test(p)) return p + '?days=30'
  if (/\/analytics\/(revenue-trend|margin-report|top-customers|sales-vs-purchases|payment-methods)$/.test(p)) return p + '?from=2025-04-01&to=2026-10-31'
  return p
}

const targets = [...new Set(routes.map(resolve).filter(Boolean))].filter((p) => !SKIP.test(p)).map(withQuery)
const pct = (a, p) => a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor((a.length * p) / 100))]
const results = []
for (const p of targets) {
  const times = []
  let status = 0, bytes = 0
  for (let i = 0; i < RUNS + 1; i++) {
    const t0 = performance.now()
    try {
      const r = await fetch(API + p, { headers: H })
      const b = await r.arrayBuffer()
      status = r.status; bytes = b.byteLength
    } catch { status = -1 }
    const ms = performance.now() - t0
    if (i > 0) times.push(ms)            // first call is a warm-up
  }
  results.push({ p, status, p50: pct(times, 50), p95: pct(times, 95), max: Math.max(...times), bytes })
}
results.sort((a, b) => b.p95 - a.p95)
const f = (n) => n.toFixed(0).padStart(5)
console.log('  p50   p95   max  status   size   endpoint')
for (const r of results) console.log(`${f(r.p50)} ${f(r.p95)} ${f(r.max)}  ${String(r.status).padStart(5)} ${String(Math.round(r.bytes / 1024)).padStart(5)}K  ${r.p}`)
const slow = results.filter((r) => r.p95 > 200), bad = results.filter((r) => r.status >= 400 || r.status < 0)
console.log(`\n${results.length} endpoints × ${RUNS} runs | p95 > 200ms: ${slow.length} | non-2xx: ${bad.length}`)
console.log(`overall median of p50s: ${pct(results.map((r) => r.p50), 50).toFixed(0)} ms, worst p95: ${results[0]?.p95.toFixed(0)} ms`)
