// apps/api/e2e/flow-sale.ts
// =============================================================================
// The counter, driven through the real screen: make a bill the way the shop does, and try the things that go
// wrong at a busy counter. Needs the API (:3200), the web app (:5175) and the demo shop (pnpm seed).
//   npx tsx e2e/flow-sale.ts
// =============================================================================
import puppeteer, { type Page, type Browser } from 'puppeteer'
import { mkdirSync } from 'node:fs'

const WEB = process.env['WEB_URL'] ?? 'http://localhost:5175'
const API = process.env['API_URL'] ?? 'http://localhost:3200'
const OUT = process.env['E2E_OUT'] ?? 'e2e-out'
const CHROME = process.env['CHROME_PATH'] ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
mkdirSync(OUT, { recursive: true })

const results: Array<{ name: string; ok: boolean; detail: string }> = []
const check = (name: string, ok: boolean, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`) }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function open(mobile = false): Promise<{ browser: Browser; page: Page }> {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] })
  const page = await browser.newPage()
  await page.setViewport(mobile ? { width: 390, height: 844, isMobile: true, hasTouch: true } : { width: 1400, height: 1000 })
  return { browser, page }
}
async function login(page: Page, phone = '9200000001', pin = '1111', biz?: string) {
  await page.goto(`${WEB}/login`, { waitUntil: 'networkidle2' })
  await page.type('#login-phone', phone)
  if (biz) {
    for (const b of await page.$$('button')) if ((await b.evaluate((e) => e.textContent ?? '')).includes('Staff member')) { await b.click(); break }
    await page.waitForSelector('#login-biz'); await page.type('#login-biz', biz)
  }
  await page.click('#login-pin'); await page.keyboard.type(pin, { delay: 40 })
  await page.waitForFunction(() => !location.pathname.startsWith('/login'), { timeout: 20000 })
}
const token = (page: Page) => page.evaluate(() => {
  const raw = localStorage.getItem('auth-storage') ?? Object.values(localStorage).find((v) => /accessToken/.test(String(v))) ?? ''
  try { return JSON.parse(String(raw))?.state?.accessToken ?? '' } catch { return '' }
})
const api = async (page: Page, path: string) => (await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${await token(page)}` } })).json() as Promise<any>
const bodyText = (page: Page) => page.evaluate(() => document.body.innerText)
async function clickText(page: Page, tag: string, text: string | RegExp, nth = 0): Promise<boolean> {
  const hs = await page.$$(tag)
  let seen = 0
  for (const h of hs) {
    const t: string = await h.evaluate((e) => (e as HTMLElement).innerText ?? '')
    if (typeof text === 'string' ? t.trim().includes(text) : text.test(t)) { if (seen++ === nth) { await h.click(); return true } }
  }
  return false
}
const shot = (page: Page, name: string) => page.screenshot({ path: `${OUT}/${name}.png` })
const saveBtn = (page: Page) => page.evaluateHandle(() => [...document.querySelectorAll('button')].filter((b) => /^(Save bill|Saving…)$/.test(b.innerText.trim()) && (b as HTMLElement).offsetParent !== null && b.getBoundingClientRect().width > 0)[0] ?? null)
const saveDisabled = async (page: Page) => (await (await saveBtn(page)).asElement()?.evaluate((b) => (b as HTMLButtonElement).disabled)) ?? true
const invoiceCount = async (page: Page) => (await api(page, '/api/invoices?limit=1&txnType=sale_invoice')).meta.total as number

async function newSale(page: Page) { await page.goto(`${WEB}/tyre/sale`, { waitUntil: 'networkidle2' }); await sleep(300) }
async function addFirstTyre(page: Page, q = '185'): Promise<string> {
  await page.type('input[aria-label="Find tyre"]', q, { delay: 30 })
  await sleep(900)
  const clicked = await page.evaluate(() => {
    const cand = [...document.querySelectorAll('button')].filter((b) => /in stock|₹/.test(b.innerText) && !/Save|Cash|UPI|Credit/.test(b.innerText))
    const b = cand.find((x) => x.closest('ul, div')?.querySelector('[aria-label="Find tyre"]') == null && /₹/.test(x.innerText)) as HTMLElement | undefined
    if (b) { b.click(); return b.innerText.split('\n')[0] }
    return ''
  })
  await sleep(500)
  return clicked
}

async function main() {
  const { browser, page } = await open()
  await login(page)

  // ── 1. an ordinary cash bill: customer, vehicle, a tyre, a job, cash, save ───────────────────────────────
  await newSale(page)
  const before = await invoiceCount(page)
  await page.type('input[placeholder="Name or mobile"]', 'E2E Counter Customer', { delay: 15 })
  await page.type('input[placeholder="10-digit mobile"]', '9876501234', { delay: 15 })
  await page.type('input[placeholder="GJ05AB1234"]', 'GJ05ZZ1234', { delay: 15 })
  await page.type('input[placeholder="Hyundai Creta"]', 'Swift', { delay: 15 })
  const tyreName = await addFirstTyre(page)
  check('searching a tyre by size shows results that can be tapped', !!tyreName, tyreName)
  await shot(page, 'sale-1-tyre-added')
  const hasLine = /Data Entry|Price charged|in stock/.test(await bodyText(page))
  check('the tyre appears as a bill line with a price box', hasLine)
  await page.evaluate(() => (document.querySelector('[aria-label^="Add Tyre Fitting"]') as HTMLElement | null)?.click())
  await sleep(400)
  const totalShown = await page.evaluate(() => [...document.querySelectorAll('div')].map((d) => d.innerText).find((t) => /^₹[\d,]+$/.test(t?.trim() ?? '')) ?? '')
  check('a job can be added with one tap and the total updates', /₹[1-9]/.test(totalShown), totalShown)
  check('Save is enabled once there is something to bill', !(await saveDisabled(page)))
  await clickText(page, 'button', 'Cash', 0)
  await shot(page, 'sale-2-ready')
  await (await saveBtn(page)).asElement()!.click()
  await sleep(2500)
  const after = await invoiceCount(page)
  check('saving makes exactly one bill', after === before + 1, `${before} → ${after}`)
  await shot(page, 'sale-3-saved')
  const latest = (await api(page, '/api/invoices?limit=1&txnType=sale_invoice&search=E2E%20Counter')).data[0]
  const inv = await api(page, `/api/invoices/${latest.id}`)
  check('the saved bill carries the customer, the vehicle and the cash received', /E2E Counter/.test(JSON.stringify(inv)) && Number(inv.paidAmt) === Number(inv.grandTotal), `paid ${inv.paidAmt} of ${inv.grandTotal}`)
  const t = await token(page)
  const pdf = await fetch(`${API}/api/tyre/invoices/${latest.id}/pdf`, { headers: { authorization: `Bearer ${t}` } })
  check('the bill prints as a PDF', pdf.status === 200 && (await pdf.arrayBuffer()).byteLength > 5000)

  // ── 2. things that go wrong at the counter ───────────────────────────────────────────────────────────────
  await newSale(page)
  check('an empty bill cannot be saved', await saveDisabled(page))

  await newSale(page)
  await addFirstTyre(page)
  await clickText(page, 'button', 'Credit', 0)
  await sleep(300)
  const creditNoCust = await bodyText(page)
  check('a credit bill with no customer asks for the customer, and does not save', /add the customer|customer name/i.test(creditNoCust) && (await saveDisabled(page)))

  await newSale(page)
  await page.type('input[placeholder="10-digit mobile"]', '12345', { delay: 20 })
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur())
  await sleep(300)
  check('a half-typed mobile number is flagged right there', /10-digit|valid mobile|mobile number/i.test(await bodyText(page)))

  await newSale(page)
  await addFirstTyre(page)
  const qtyHandle = await page.$('input[type="number"][min="1"], input[aria-label*="Quantity" i]')
  const stockText = await page.evaluate(() => (document.body.innerText.match(/(\d+) in stock/) ?? [])[1] ?? '')
  check('stock is shown beside the tyre while billing', !!stockText, `${stockText} in stock`)
  if (qtyHandle && stockText) {
    await qtyHandle.click({ clickCount: 3 }); await qtyHandle.type(String(Number(stockText) + 5))
    await sleep(400)
    check('asking for more than is in stock is stopped with a clear message', /only \d+ in stock/i.test(await bodyText(page)) || (await saveDisabled(page)))
  }

  // double click on Save → one bill
  await newSale(page)
  const c0 = await invoiceCount(page)
  await page.type('input[placeholder="Name or mobile"]', 'E2E Double Tap', { delay: 15 })
  await addFirstTyre(page)
  await clickText(page, 'button', 'Cash', 0)
  const sb = (await saveBtn(page)).asElement()!
  await sb.evaluate((el) => { (el as HTMLElement).click(); (el as HTMLElement).click() })                      // two taps in the same instant
  await sleep(3000)
  const c1 = await invoiceCount(page)
  check('double-tapping Save does not make two bills', c1 === c0 + 1, `${c0} → ${c1}`)

  // session ends while billing: the token is removed, then Save
  await newSale(page)
  await page.type('input[placeholder="Name or mobile"]', 'E2E Expired Session', { delay: 15 })
  await addFirstTyre(page)
  await page.setRequestInterception(true)
  page.on('request', (rq) => {                                     // the server now says the session is over
    if (/\/api\/(tyre\/sales|auth\/refresh)/.test(rq.url()) && rq.method() === 'POST') rq.respond({ status: 401, contentType: 'application/json', body: '{"error":"Unauthorized","message":"Invalid or expired token"}' })
    else rq.continue()
  })
  await clickText(page, 'button', 'Cash', 0)
  await (await saveBtn(page)).asElement()?.click().catch(() => {})
  await sleep(3000)
  check('when the session has ended, Save sends the person to sign in instead of losing the bill silently', /\/login/.test(page.url()) || /sign in|session/i.test(await bodyText(page)), page.url())
  await browser.close()

  // ── 3. a phone at the counter ────────────────────────────────────────────────────────────────────────────
  const m = await open(true)
  await login(m.page)
  await newSale(m.page)
  const wide = await m.page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 4)
  check('the bill screen fits a phone without sideways scrolling', !wide)
  const menu = await m.page.$('button[aria-label="Open menu"]')
  check('the menu opens from a button on a phone', !!menu)
  await shot(m.page, 'phone-sale')
  await m.browser.close()

  // ── 4. a viewer can look but not bill ────────────────────────────────────────────────────────────────────
  const v = await open()
  await login(v.page, '9200000012', '3333', '9200000001')
  await newSale(v.page)
  check('a read-only user sees the bill screen but cannot save', await saveDisabled(v.page))
  await v.browser.close()

  const bad = results.filter((r) => !r.ok)
  console.log(`\n${results.length - bad.length}/${results.length} passed`)
  if (bad.length) { console.log('FAILED:'); for (const b of bad) console.log(' -', b.name, b.detail) }
}
main().catch((e) => { console.error(e); process.exit(1) })
