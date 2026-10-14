// UI crawler (run with the API on :3200, web on :5175 and the demo shop seeded):
//   node apps/api/scripts/ui-crawl.mjs        — prints every failing API call, with the screen + action behind it.
// Never presses buttons that write or send, and skips checkboxes on screens where they are settings.
// UI crawler: visits every screen as the demo owner, flips every dropdown through all its options,
// clicks every non-destructive button / tab, types into every search box, and records each /api call
// that comes back >= 400 (or never answers), with the screen and action that caused it.
import puppeteer from 'puppeteer'

const WEB = 'http://localhost:5175'
const API = 'http://localhost:3200'

const login = await (await fetch(API + '/api/auth/login', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ tenantPhone: '9200000001', phone: process.env.CRAWL_PHONE ?? '9200000001', pin: process.env.CRAWL_PIN ?? '1111' }),
})).json()
const H = { authorization: 'Bearer ' + login.accessToken }
const first = async (p, pick) => { try { const j = await (await fetch(API + p, { headers: H })).json(); return pick(j) } catch { return null } }

const invoiceId  = await first('/api/invoices?limit=1&txnType=sale_invoice', (j) => (j.data ?? j.items ?? [])[0]?.id)
const partyId    = await first('/api/parties?limit=1&type=customer', (j) => j.data?.[0]?.id)
const vehicleId  = await first('/api/tyre/vehicles?limit=1', (j) => j.data?.[0]?.id)
const poId       = await first('/api/inventory/purchase-orders?limit=1', (j) => (j.data ?? j.items ?? j)[0]?.id)

const ROUTES = [
  '/', '/analytics', '/tyre/sale', '/tyre/sale?mode=service', '/tyre/stock', '/tyre/vehicles', '/tyre/reminders', '/tyre/warranty',
  '/tyre/reports', '/tyre/messages', '/invoices', '/invoices/new', '/invoices/new?txnType=purchase_invoice',
  '/invoices/new?txnType=quotation', '/parties', '/ai', '/expenses', '/branches', '/reports', '/staff', '/pipeline',
  '/approvals', '/contracts', '/advances', '/aging', '/broadcast', '/products',
  '/inventory/stock', '/inventory/products', '/inventory/suppliers', '/inventory/purchase-orders', '/inventory/adjustments',
  '/inventory/transfers', '/inventory/grn',
  ...(invoiceId ? [`/invoices/${invoiceId}`] : []),
  ...(partyId ? [`/parties/${partyId}`] : []),
  ...(vehicleId ? [`/tyre/vehicles/${vehicleId}`] : []),
  ...(poId ? [`/inventory/purchase-orders/${poId}`] : []),
]

// Buttons we never press: they change data or send messages.
const DANGER = /cancel|delete|remove|void|reject|approve|logout|log out|sign out|pay|record|save|create|submit|confirm|generate|gen irn|e-way|send|remind|retry|run|convert|return|claim|deactivate|reset|archive|import|upload|clear|trash|close|issue|post|allocate|resume|pause|book|add user|new user|new sale|new document|add vehicle|add supplier|new purchase|new party|add customer|new contract|new expense|adjust|transfer|share|whatsapp|pdf|print|receipt|download|export/i

const browser = await puppeteer.launch({ headless: true, executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', args: ['--no-sandbox'] })
const page = await browser.newPage()
await page.setViewport({ width: 1400, height: 1000 })
page.on('dialog', (d) => d.dismiss().catch(() => {}))

const found = new Map()
const writes = []
let where = '', action = ''
page.on('response', async (res) => {
  const url = res.url()
  if (!url.includes('/api/')) return
  const req = res.request()
  const status = res.status()
  const method = req.method()
  if (method !== 'GET') writes.push(`${method} ${new URL(url).pathname} ${status}`)
  if (status >= 400) {
    let body = ''
    try { body = (await res.text()).slice(0, 220).replace(/\s+/g, ' ') } catch { /* ignore */ }
    const u = new URL(url)
    const key = `${method} ${u.pathname}${u.search} ${status}`
    if (!found.has(key)) found.set(key, { status, method, url: u.pathname + u.search, screen: where, action, body })
  }
})
page.on('requestfailed', (req) => {
  if (req.url().includes('/api/') && !req.failure()?.errorText?.includes('ABORTED')) {
    const u = new URL(req.url())
    found.set(`FAILED ${u.pathname}${u.search}`, { status: 'net-fail', method: req.method(), url: u.pathname + u.search, screen: where, action, body: req.failure()?.errorText })
  }
})
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(`${where} :: ${e.message.slice(0, 160)}`))

const settle = () => new Promise((r) => setTimeout(r, 650))

// log in through the real form
await page.goto(WEB + '/login', { waitUntil: 'networkidle0' })
const isStaff = (process.env.CRAWL_PHONE ?? '9200000001') !== '9200000001'
if (isStaff) {
  // staff sign in with the business (owner's) phone as well
  await page.evaluate(() => Array.from(document.querySelectorAll('button')).find((b) => /staff member/i.test(b.textContent || ''))?.click())
  await new Promise((r) => setTimeout(r, 300))
}
const ins = await page.$$('input')
await ins[0].type(process.env.CRAWL_PHONE ?? '9200000001')
if (isStaff) { await ins[1].type('9200000001'); await ins[2].type(process.env.CRAWL_PIN ?? '1111') }
else await ins[1].type(process.env.CRAWL_PIN ?? '1111')
await page.click('button[type=submit]')
await new Promise((r) => setTimeout(r, 3000))

let interactions = 0
for (const route of ROUTES) {
 try {
  where = route; action = 'load'
  try { await page.goto(WEB + route, { waitUntil: 'networkidle0', timeout: 30000 }) } catch { /* keep going */ }
  await settle()

  // 1. every <select>: every option
  const nSelects = await page.$$eval('select', (s) => s.length)
  for (let i = 0; i < nSelects; i++) {
    const opts = await page.$$eval('select', (ss, idx) => Array.from(ss[idx]?.options ?? []).map((o) => o.value), i).catch(() => [])
    for (const v of opts.slice(0, 14)) {
      action = `select#${i} = "${v}"`
      try {
        await page.evaluate((idx, val) => {
          const el = document.querySelectorAll('select')[idx]
          if (!el) return
          el.value = val
          el.dispatchEvent(new Event('change', { bubbles: true }))
        }, i, v)
        interactions++
        await settle()
      } catch { /* ignore */ }
    }
  }

  // 2. every search / text filter box
  const nInputs = await page.$$eval('input[type=text], input[type=search], input:not([type])', (s) => s.length).catch(() => 0)
  for (let i = 0; i < Math.min(nInputs, 6); i++) {
    action = `type into input#${i}`
    try {
      const handles = await page.$$('input[type=text], input[type=search], input:not([type])')
      const h = handles[i]
      if (!h) continue
      const type = await h.evaluate((n) => n.getAttribute('type') || 'text')
      const disabled = await h.evaluate((n) => n.disabled)
      if (disabled) continue
      await h.click({ clickCount: 3 }).catch(() => {})
      await h.type('ab', { delay: 20 })
      interactions++
      await settle()
      await h.click({ clickCount: 3 }).catch(() => {})
      await page.keyboard.press('Backspace')
      await settle()
      void type
    } catch { /* ignore */ }
  }

  // 3. non-destructive buttons (tabs, filters, toggles)
  const texts = await page.$$eval('button', (bs) => bs.map((b) => (b.textContent || '').trim().replace(/\s+/g, ' ')))
  const todo = [...new Set(texts)].filter((t) => t && t.length <= 28 && !DANGER.test(t)).slice(0, 30)
  for (const t of todo) {
    action = `button "${t}"`
    try {
      const clicked = await page.evaluate((txt) => {
        const b = Array.from(document.querySelectorAll('button')).find((x) => (x.textContent || '').trim().replace(/\s+/g, ' ') === txt && !x.disabled)
        if (!b) return false
        b.click(); return true
      }, t)
      if (clicked) { interactions++; await settle() }
      if (!page.url().includes(route.split('?')[0])) {
        await page.goto(WEB + route, { waitUntil: 'networkidle0', timeout: 30000 }).catch(() => {})
        await settle()
      }
    } catch { /* ignore */ }
  }

  // 4. checkboxes — on settings-like screens they save immediately, so leave those alone
  const settingsLike = /messages|branches|staff|\/tyre\/vehicles\/[0-9a-f-]{36}/.test(route)
  const nChecks = settingsLike ? 0 : await page.$eval('input[type=checkbox]', (s) => s.length).catch(() => 0)
  for (let i = 0; i < Math.min(nChecks, 6); i++) {
    action = `checkbox#${i}`
    try {
      await page.evaluate((idx) => { const el = document.querySelectorAll('input[type=checkbox]')[idx]; if (el && !el.disabled) el.click() }, i)
      interactions++
      await settle()
    } catch { /* ignore */ }
  }
 } catch (e) { pageErrors.push(`${route} :: crawler step failed: ${String(e.message).slice(0, 100)}`) }
}

console.log(`screens: ${ROUTES.length}   interactions: ${interactions}   write calls made by the crawl: ${writes.length}`)
console.log(`\nfailing API calls: ${found.size}`)
for (const f of found.values()) console.log(`\n  [${f.status}] ${f.method} ${f.url}\n     screen: ${f.screen}   after: ${f.action}\n     ${f.body}`)
console.log(`\nunhandled page errors: ${pageErrors.length}`)
for (const e of [...new Set(pageErrors)].slice(0, 15)) console.log('  ' + e)
if (writes.length) console.log('\nwrites seen:', [...new Set(writes)].slice(0, 20).join(' | '))

// On Windows Chrome sometimes keeps its profile folder locked at exit; that must not hide the report above.
try { await browser.close() } catch { /* ignore */ }
process.exit(0)
