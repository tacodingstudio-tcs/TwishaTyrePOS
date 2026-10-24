// apps/api/e2e/crawl.ts
// =============================================================================
// Opens every screen of the web app the way each kind of user would, and records anything a client would
// notice: a screen that never finishes loading, a crash message, a failed request, a console error, an empty
// page. Needs the API (:3200) and the web app (:5175) running, and the demo shop (pnpm seed).
//
//   npx tsx e2e/crawl.ts            desktop, owner + manager + viewer, plus a phone-size pass
// =============================================================================
import puppeteer, { type Page } from 'puppeteer'
import { mkdirSync } from 'node:fs'

const WEB = process.env['WEB_URL'] ?? 'http://localhost:5175'
const OUT = process.env['E2E_OUT'] ?? 'e2e-out'
const CHROME = process.env['CHROME_PATH'] ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
mkdirSync(OUT, { recursive: true })

const USERS = {
  owner:   { phone: '9200000001', pin: '1111' },
  manager: { phone: '9200000011', pin: '2222', biz: '9200000001' },
  viewer:  { phone: '9200000012', pin: '3333', biz: '9200000001' },
} as const
type Role = keyof typeof USERS

const ROUTES = [
  '/', '/tyre/sale', '/tyre/sale?mode=service', '/invoices', '/parties', '/tyre/stock', '/aging', '/tyre/reminders', '/tyre/team',
  '/expenses', '/advances', '/approvals', '/tyre/reports', '/reports', '/analytics', '/tyre/vehicles', '/tyre/warranty', '/tyre/messages',
  '/inventory/stock', '/inventory/products', '/inventory/suppliers', '/inventory/purchase-orders', '/inventory/adjustments',
  '/inventory/transfers', '/inventory/grn', '/pipeline', '/staff', '/branches',
]

type Finding = { role: string; view: string; route: string; kind: string; detail: string }
const findings: Finding[] = []
const rows: string[] = []

async function newSession(role: Role, mobile: boolean) {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] })
  const page = await browser.newPage()
  await page.setViewport(mobile ? { width: 390, height: 844, isMobile: true, hasTouch: true } : { width: 1400, height: 900 })
  return { browser, page }
}

async function login(page: Page, role: Role): Promise<string | null> {
  const u = USERS[role]
  await page.goto(`${WEB}/login`, { waitUntil: 'networkidle2' })
  await page.type('#login-phone', u.phone)
  if ('biz' in u) {
    const staffBtn = await page.$$('button')
    for (const b of staffBtn) if ((await b.evaluate((e) => e.textContent ?? '')).includes('Staff member')) { await b.click(); break }
    await page.waitForSelector('#login-biz')
    await page.type('#login-biz', u.biz)
  }
  await page.click('#login-pin')
  await page.keyboard.type(u.pin, { delay: 40 })
  try { await page.waitForFunction(() => !location.pathname.startsWith('/login'), { timeout: 20000 }) } catch { return 'login did not leave /login' }
  return null
}

async function visit(page: Page, role: string, view: string, route: string) {
  const errs: string[] = []
  const onConsole = (m: any) => { if (m.type() === 'error') errs.push(`console: ${m.text().slice(0, 160)}`) }
  const onPageError = (e: Error) => errs.push(`pageerror: ${e.message.slice(0, 160)}`)
  const onResp = (r: any) => {
    const s = r.status(); const url: string = r.url()
    if (s >= 400 && url.includes('/api/')) errs.push(`HTTP ${s} ${r.request().method()} ${url.replace(/^https?:\/\/[^/]+/, '').slice(0, 90)}`)
  }
  page.on('console', onConsole); page.on('pageerror', onPageError); page.on('response', onResp)
  const t0 = Date.now()
  let note = ''
  try {
    await page.goto(`${WEB}${route}`, { waitUntil: 'networkidle2', timeout: 30000 })
  } catch { note = 'did not settle in 30 s' }
  await new Promise((r) => setTimeout(r, 400))
  const ms = Date.now() - t0
  const body: string = await page.evaluate(() => document.body.innerText)
  const stuck = /\bLoading…|\bLoading\.\.\./.test(body)
  const crashed = /Something went wrong|Unexpected Application Error|Cannot read properties|is not a function/i.test(body)
  const blank = body.trim().length < 30
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 4)
  page.off('console', onConsole); page.off('pageerror', onPageError); page.off('response', onResp)
  const expected403 = role === 'viewer' || role === 'manager'
  const real = errs.filter((e) => !(expected403 && /HTTP 403/.test(e)))
  if (note) findings.push({ role, view, route, kind: 'slow', detail: note })
  if (stuck) findings.push({ role, view, route, kind: 'stuck-loading', detail: 'still says Loading…' })
  if (crashed) findings.push({ role, view, route, kind: 'crash', detail: body.slice(0, 120).replace(/\n/g, ' ') })
  if (blank) findings.push({ role, view, route, kind: 'blank', detail: body.trim().slice(0, 60) })
  if (view === 'phone' && sideways) findings.push({ role, view, route, kind: 'sideways-scroll', detail: 'page is wider than the phone screen' })
  for (const e of [...new Set(real)]) findings.push({ role, view, route, kind: 'error', detail: e })
  rows.push(`${role.padEnd(7)} ${view.padEnd(7)} ${String(ms).padStart(5)} ms  ${route}${real.length ? `   !! ${real.length} error(s)` : ''}`)
  const file = `${OUT}/${role}-${view}-${route.replace(/[^a-z0-9]+/gi, '_') || 'home'}.png`
  if (real.length || stuck || crashed || blank || process.env['E2E_SHOTS']) await page.screenshot({ path: file, fullPage: false })
}

async function main() {
  for (const [role, mobile] of [['owner', false], ['manager', false], ['viewer', false], ['owner', true]] as Array<[Role, boolean]>) {
    const view = mobile ? 'phone' : 'desktop'
    const { browser, page } = await newSession(role, mobile)
    const err = await login(page, role)
    if (err) { findings.push({ role, view, route: '/login', kind: 'login', detail: err }); await browser.close(); continue }
    // pick one record of each detail screen from the API the page itself uses
    const token = await page.evaluate(() => {
      const raw = localStorage.getItem('auth-storage') ?? Object.entries(localStorage).map(([, v]) => v).find((v) => /accessToken/.test(String(v))) ?? ''
      try { return JSON.parse(String(raw))?.state?.accessToken ?? '' } catch { return '' }
    })
    const j = async (p: string) => { try { return await (await fetch(`http://localhost:3200${p}`, { headers: { authorization: `Bearer ${token}` } })).json() } catch { return null } }
    const dyn: string[] = []
    const inv = await j('/api/invoices?limit=1'); if (inv?.data?.[0]) dyn.push(`/invoices/${inv.data[0].id}`)
    const par = await j('/api/parties?type=customer&limit=1'); if (par?.data?.[0]) dyn.push(`/parties/${par.data[0].id}`)
    const veh = await j('/api/tyre/vehicles'); if (veh?.data?.[0]) dyn.push(`/tyre/vehicles/${veh.data[0].id}`)
    const po = await j('/api/purchase-orders?limit=1'); if (po?.data?.[0]) dyn.push(`/inventory/purchase-orders/${po.data[0].id}`)
    for (const r of [...ROUTES, ...dyn, '/register', '/no-such-page']) await visit(page, role, view, r)
    await browser.close()
  }
  console.log(rows.join('\n'))
  console.log('\n──────── FINDINGS ────────')
  if (!findings.length) console.log('none')
  for (const f of findings) console.log(`[${f.kind}] ${f.role}/${f.view} ${f.route} — ${f.detail}`)
  console.log(`\n${rows.length} page visits, ${findings.length} findings`)
}
main().catch((e) => { console.error(e); process.exit(1) })
