// apps/api/e2e/flow-correct.ts
// "Correct bill" through the real screens: make a bill, open it, press Correct bill, swap the tyre, save.
// The corrected bill must keep the number and date, the old copy must be cancelled, stock must follow.
//   npx tsx e2e/flow-correct.ts        (needs the API :3200, the web app :5175 and the demo shop)
import puppeteer from 'puppeteer'
import { mkdirSync } from 'node:fs'

const WEB = process.env['WEB_URL'] ?? 'http://localhost:5175'
const API = process.env['API_URL'] ?? 'http://localhost:3200'
const OUT = process.env['E2E_OUT'] ?? 'e2e-out'
const CHROME = process.env['CHROME_PATH'] ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
mkdirSync(OUT, { recursive: true })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
let bad = 0
const check = (n: string, ok: boolean, d = '') => { if (!ok) bad++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  — ${d}` : ''}`) }

const lg = await (await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone: '9200000001', pin: '1111', tenantPhone: '9200000001' }) })).json() as any
const H = { authorization: `Bearer ${lg.accessToken}`, 'content-type': 'application/json' }
const call = async (m: string, p: string, b?: unknown) => { const r = await fetch(`${API}${p}`, { method: m, headers: { ...H, 'idempotency-key': crypto.randomUUID() }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, data: await r.json().catch(() => ({})) as any } }
const stock = async (id: string) => Number(((await call('GET', '/api/stock?limit=500')).data.data as any[]).find((s) => s.productId === id)?.currentQty)

const tyres = (await call('GET', '/api/tyre/finder?kind=tyre&inStock=true&limit=5')).data.data as any[]
const [a, b] = [tyres[0], tyres[1]]
const sale = await call('POST', '/api/tyre/sales', { customer: { name: 'E2E CORRECT', phone: '9811100777' }, vehicleNo: 'GJ32ZZ0777', items: [{ productId: a.id, qty: 1, finalPrice: Number(a.salePrice) }], payments: [{ method: 'cash', amount: Math.round(Number(a.salePrice) * 1.18) }] })
check('test bill made', sale.status === 201, JSON.stringify(sale.data).slice(0, 120))
const id = sale.data.invoice.id, number = sale.data.invoice.number
const sA = await stock(a.id), sB = await stock(b.id)

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] })
const page = await browser.newPage(); await page.setViewport({ width: 1400, height: 1000 })
const errs: string[] = []; page.on('pageerror', (e) => errs.push(String(e)))
await page.goto(`${WEB}/login`, { waitUntil: 'networkidle2' })
await page.type('#login-phone', '9200000001'); await page.click('#login-pin'); await page.keyboard.type('1111', { delay: 40 })
await page.waitForFunction(() => !location.pathname.startsWith('/login'), { timeout: 20000 })
await page.goto(`${WEB}/invoices/${id}`, { waitUntil: 'networkidle2' })
const clickBtn = async (re: RegExp) => { for (const h of await page.$$('button')) { if (re.test(await h.evaluate((e) => e.textContent ?? ''))) { await h.click(); return true } } return false }
check('Correct bill button is on the bill', await clickBtn(/Correct bill/))
await page.waitForFunction(() => location.pathname === '/tyre/sale', { timeout: 10000 })
await page.waitForFunction((n) => document.body.innerText.includes('Correcting bill ' + n), { timeout: 10000 }, number)
await sleep(800)
let txt = await page.evaluate(() => document.body.innerText)
check('old bill is filled in (tyre, customer, vehicle)', txt.includes(a.name) && txt.includes('E2E CORRECT') && /GJ32ZZ0777/.test(await page.evaluate(() => Array.from(document.querySelectorAll('input')).map((i) => i.value).join('|'))))
await page.screenshot({ path: `${OUT}/correct-1-filled.png` })
// swap the tyre: remove the line, add the other tyre from the finder
for (const h of await page.$$('button[aria-label*="emove"], button[title*="emove"]')) { await h.click(); break }
await sleep(400)
const searchBox = await page.$('input[placeholder*="ize"], input[placeholder*="earch"]')
if (searchBox) { await searchBox.click({ clickCount: 3 }); await searchBox.type(String(b.domainAttrs?.size ?? b.name).split(' ')[0]!) }
await sleep(1500)
await page.screenshot({ path: `${OUT}/correct-2-swapped.png` })
// the finder offers b by name; click it
let added = false
{
  const hits = await page.$$('button, [role="button"], li, div, span')
  let pick: typeof hits[number] | null = null
  for (const h of hits) { const t = await h.evaluate((e) => e.textContent ?? ''); if (t.includes(b.name) && !t.includes(a.name) && t.length < b.name.length + 40) pick = h }
  if (pick) { await pick.click(); added = true }
}
check('other tyre added from the finder', added)
await sleep(600)
const saved = await clickBtn(/Save corrected bill/)
check('Save corrected bill pressed', saved)
await page.waitForFunction(() => /^\/invoices\/[0-9a-f-]{36}$/.test(location.pathname), { timeout: 15000 }).catch(() => {})
await sleep(1000)
await page.screenshot({ path: `${OUT}/correct-3-after.png` })
const newId = page.url().split('/').pop()!
check('landed on a new bill page', newId !== id && /^[0-9a-f-]{36}$/.test(newId), page.url())
const fresh = (await call('GET', `/api/invoices/${newId}`)).data, old = (await call('GET', `/api/invoices/${id}`)).data
check('same number, same date', fresh.number === number && String(fresh.date).slice(0, 10) === String(sale.data.invoice.date).slice(0, 10), `${fresh.number} ${String(fresh.date).slice(0, 10)}`)
check('old copy cancelled and renamed', old.status === 'cancelled' && old.number === `${number}-OLD`, `${old.status} ${old.number}`)
check('stock follows (old tyre back, new tyre out)', (await stock(a.id)) === sA + 1 && (await stock(b.id)) === sB - 1)
check('no page errors', errs.length === 0, errs.join(' | ').slice(0, 200))
await browser.close()
console.log(bad ? `\n${bad} check(s) failed` : '\nAll checks passed'); process.exit(bad ? 1 : 0)
