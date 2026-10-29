// apps/api/e2e/upi-qr.ts
// Saves a UPI ID (and a bank banner) in the demo shop's settings, opens a bill that still has a balance, clicks "Show QR to customer" and
// screenshots the card. The QR's own text (the upi:// link) is read back from the page, so the amount can be compared with the bill.
// Decode the picture itself with:  python e2e/upi-decode.py e2e-out/upi/<size>.png
//   npx tsx e2e/upi-qr.ts            needs the API (:3200), the web app (:5175) and the demo shop (pnpm seed)
import puppeteer from 'puppeteer'
import { mkdirSync, readFileSync } from 'node:fs'

const WEB = process.env['WEB_URL'] ?? 'http://localhost:5175'
const API = 'http://localhost:3200'
const OUT = `${process.env['E2E_OUT'] ?? 'e2e-out'}/upi`
const CHROME = process.env['CHROME_PATH'] ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const BANNER = process.env['UPI_BANNER'] ?? 'E:/softwares/tyrePOS-build-tools/_deliver/UPI-QR/bank-banner.png'
mkdirSync(OUT, { recursive: true })
let bad = 0
const check = (ok: boolean, what: string) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) bad++ }

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] })
const page = await browser.newPage()
await page.setViewport({ width: 1400, height: 900 })
await page.goto(`${WEB}/login`, { waitUntil: 'networkidle2' })
await page.type('#login-phone', '9200000001'); await page.click('#login-pin'); await page.keyboard.type('1111', { delay: 40 })
await page.waitForFunction(() => !location.pathname.startsWith('/login'), { timeout: 20000 })
const token: string = await page.evaluate(() => {
  const all = [...Object.values(localStorage), ...Object.values(sessionStorage)]
  const raw = all.find((v) => /accessToken/.test(String(v))) ?? ''
  try { return JSON.parse(String(raw))?.state?.accessToken ?? '' } catch { return '' }
})
const api = async (path: string, init: RequestInit = {}) => (await fetch(`${API}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(init.headers ?? {}) } })).json() as Promise<any>

// settings: UPI ID like the shop's own QR sheet + the bank banner
const branch = (await api('/api/branches'))[0]
const banner = `data:image/png;base64,${readFileSync(BANNER).toString('base64')}`
const upiCfg = { upi_id: 'shaktienterprise@gscb', upi_name: '', upi_banner: banner }
await api(`/api/branches/${branch.id}`, { method: 'PATCH', body: JSON.stringify({ domainConfig: { ...(branch.domainConfig ?? {}), ...upiCfg } }) })
const saved = (await api('/api/branches'))[0].domainConfig
check(saved.upi_id === 'shaktienterprise@gscb' && String(saved.upi_banner).startsWith('data:image'), 'UPI ID and banner are saved with the shop settings')

// a bill with a balance to collect
const list = await api('/api/invoices?limit=50')
const inv = (list.data ?? []).find((i: any) => i.txnType === 'sale_invoice' && Number(i.grandTotal) - Number(i.paidAmt) > 0.5 && i.status !== 'cancelled')
if (!inv) { console.log('no bill with a balance in the demo shop - make a credit sale first'); await browser.close(); process.exit(1) }
const due = Math.round((Number(inv.grandTotal) - Number(inv.paidAmt)) * 100) / 100
console.log(`bill ${inv.number}: balance ${due}`)

for (const [w, h] of [[1400, 900], [1024, 576], [390, 844]] as Array<[number, number]>) {
  const size = `${w}x${h}`
  await page.setViewport({ width: w, height: h, ...(w < 500 ? { isMobile: true, hasTouch: true } : {}) })
  await page.goto(`${WEB}/invoices/${inv.id}`, { waitUntil: 'networkidle2' })
  const btn = await page.evaluateHandle(() => Array.from(document.querySelectorAll('button')).find((b) => /Show QR to customer/.test(b.textContent ?? '')) ?? null)
  const el = btn.asElement()
  if (!el) { check(false, `${size}: Show QR button is on the bill page`); continue }
  await el.click()
  await new Promise((r) => setTimeout(r, 600))
  const link: string = await page.evaluate(() => document.querySelector('[data-upi]')?.getAttribute('data-upi') ?? '')
  const u = new URL(link.replace('upi://', 'http://x/'))
  check(u.searchParams.get('pa') === 'shaktienterprise@gscb', `${size}: pays shaktienterprise@gscb`)
  check(u.searchParams.get('am') === due.toFixed(2), `${size}: amount ${u.searchParams.get('am')} = balance ${due.toFixed(2)}`)
  check(u.searchParams.get('cu') === 'INR' && /Bill/.test(u.searchParams.get('tn') ?? ''), `${size}: INR and the bill number in the note`)
  const fits = await page.evaluate(() => { const d = document.querySelector('[role="dialog"]'); if (!d) return false; const r = d.getBoundingClientRect(); return r.top >= 0 && r.left >= 0 && r.right <= innerWidth + 1 && (r.bottom <= innerHeight + 1 || getComputedStyle(d).overflowY === 'auto') })
  check(fits, `${size}: the card is inside the window (or scrolls)`)
  await page.screenshot({ path: `${OUT}/${size}.png` })
  await page.keyboard.press('Escape')
  await new Promise((r) => setTimeout(r, 200))
  check(!(await page.$('[role="dialog"]')), `${size}: Esc closes the card`)
}
// New Sale: add a tyre, choose UPI, show the QR - the amount is the bill total
for (const [w, h] of [[1400, 900], [1024, 576]] as Array<[number, number]>) {
  const size = `${w}x${h}`
  await page.setViewport({ width: w, height: h })
  await page.goto(`${WEB}/tyre/sale`, { waitUntil: 'networkidle2' })
  await page.type('input[aria-label="Find tyre"]', '185', { delay: 30 })
  await new Promise((r) => setTimeout(r, 900))
  await page.evaluate(() => {
    const cand = Array.from(document.querySelectorAll('button')).filter((b) => /₹/.test((b as HTMLElement).innerText) && !/Save|Cash|UPI|Credit/.test((b as HTMLElement).innerText))
    ;(cand[0] as HTMLElement | undefined)?.click()
  })
  await new Promise((r) => setTimeout(r, 600))
  const clickBtn = (re: string) => page.evaluate((src) => { const r = new RegExp(src); const b = Array.from(document.querySelectorAll('button')).find((x) => r.test(x.textContent ?? '') && (x as HTMLElement).offsetParent !== null); if (b) { (b as HTMLElement).click(); return true } return false }, re)
  check(await clickBtn('^\s*UPI\s*$'), `${size}: New Sale has a UPI button`)
  await new Promise((r) => setTimeout(r, 300))
  check(await clickBtn('Show QR'), `${size}: Show QR appears once UPI is chosen`)
  await new Promise((r) => setTimeout(r, 500))
  const link: string = await page.evaluate(() => document.querySelector('[data-upi]')?.getAttribute('data-upi') ?? '')
  const shown: string = await page.evaluate(() => (document.querySelector('[role="dialog"]') as HTMLElement | null)?.innerText ?? '')
  const am = link ? new URL(link.replace('upi://', 'http://x/')).searchParams.get('am') : null
  check(!!am && Number(am) > 0 && shown.replace(/[,₹\s]/g, '').includes(String(Math.round(Number(am)))), `${size}: QR amount ${am} is the amount shown on the card`)
  await page.screenshot({ path: `${OUT}/sale-${size}.png` })
  await page.keyboard.press('Escape')
}
await browser.close()
console.log(bad ? `\n${bad} check(s) failed` : '\nall checks passed')
process.exit(bad ? 1 : 0)
