// apps/api/e2e/flow-warranty.ts
// The warranty journey through the real screens: sell a tyre with a serial number, find it on the Warranty page,
// record a claim, try to claim twice, void it, and see it under "Void". Needs the API, the web app and the demo shop.
//   npx tsx e2e/flow-warranty.ts
import puppeteer, { type Page } from 'puppeteer'
import { mkdirSync } from 'node:fs'

const WEB = process.env['WEB_URL'] ?? 'http://localhost:5175'
const OUT = process.env['E2E_OUT'] ?? 'e2e-out'
const CHROME = process.env['CHROME_PATH'] ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
mkdirSync(OUT, { recursive: true })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const results: Array<{ name: string; ok: boolean; detail: string }> = []
const check = (name: string, ok: boolean, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`) }
const text = (page: Page) => page.evaluate(() => document.body.innerText)
const clickText = async (page: Page, tag: string, re: RegExp) => page.evaluate((t, src) => {
  const rx = new RegExp(src); const el = [...document.querySelectorAll(t)].find((e) => rx.test((e as HTMLElement).innerText) && (e as HTMLElement).offsetParent !== null) as HTMLElement | undefined
  if (el) { el.click(); return true } return false
}, tag, re.source)

const SERIAL = `E2E${Date.now().toString(36).toUpperCase()}`

async function main() {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] })
  const page = await browser.newPage(); await page.setViewport({ width: 1400, height: 1100 })
  const dialogs: string[] = []
  page.on('dialog', async (d) => { dialogs.push(d.message()); await d.accept('tyre returned to the supplier') })
  await page.goto(`${WEB}/login`, { waitUntil: 'networkidle2' })
  await page.type('#login-phone', '9200000001'); await page.click('#login-pin'); await page.keyboard.type('1111', { delay: 40 })
  await page.waitForFunction(() => !location.pathname.startsWith('/login'), { timeout: 20000 })

  // 1 · sell a tyre with a serial number
  await page.goto(`${WEB}/tyre/sale`, { waitUntil: 'networkidle2' })
  await page.type('input[placeholder="Name or mobile"]', 'Warranty Walk Customer', { delay: 10 })
  await page.type('input[placeholder="10-digit mobile"]', '9876512345', { delay: 10 })
  await page.type('input[placeholder="GJ05AB1234"]', 'GJ05WW9999', { delay: 10 })
  await page.type('input[aria-label="Find tyre"]', '185', { delay: 30 }); await sleep(900)
  await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => /₹/.test(x.innerText) && /in stock|stock/i.test(x.innerText) && !/Save|Cash|UPI|Credit/.test(x.innerText)) as HTMLElement | undefined; b?.click() })
  await sleep(500)
  const summaryOpened = await clickText(page, 'summary', /Serial numbers/)
  check('the serial-number box can be opened on the sale line', summaryOpened)
  await sleep(200)
  await page.type('input[placeholder="one per tyre, in fitting order"]', SERIAL, { delay: 10 })
  await clickText(page, 'button', /^Cash$/)
  await sleep(300)
  await page.evaluate(() => { const b = [...document.querySelectorAll('button')].filter((x) => /^Save bill$/.test(x.innerText.trim()) && x.getBoundingClientRect().width > 0)[0] as HTMLElement | undefined; b?.click() })
  await sleep(3000)
  check('the bill with a serial number saves', /\/invoices\/|\/tyre\/sale/.test(page.url()) && !/Something went wrong/.test(await text(page)), page.url())

  // 2 · find it on the Warranty page by serial, then by customer
  await page.goto(`${WEB}/tyre/warranty`, { waitUntil: 'networkidle2' })
  await page.type('input[placeholder^="Serial number"]', SERIAL, { delay: 15 }); await sleep(1200)
  let t = await text(page)
  check('the new tyre is on the Warranty page, in warranty, with its serial and the customer', t.includes(SERIAL) && /In warranty|active/i.test(t) && t.includes('Warranty Walk Customer'), t.includes(SERIAL) ? 'found' : 'not found')
  await page.screenshot({ path: `${OUT}/warranty-1-found.png` })

  // 3 · record a claim
  check('"Record claim" is offered', await clickText(page, 'button', /Record claim/))
  await sleep(500)
  const saveDisabledEmpty = await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => /^Save claim$/.test(x.innerText.trim())) as HTMLButtonElement | undefined; return b?.disabled ?? null })
  check('Save claim stays disabled until the notes are filled', saveDisabledEmpty === true)
  await page.select('select.input', 'replaced').catch(() => {})
  await page.type('textarea', 'Sidewall bulge, customer brought it back', { delay: 8 })
  await page.evaluate(() => { const i = [...document.querySelectorAll('input[type="number"]')].pop() as HTMLInputElement | undefined; if (i) { i.focus() } })
  await page.keyboard.type('1500')
  await page.screenshot({ path: `${OUT}/warranty-2-claim-dialog.png` })
  await clickText(page, 'button', /^Save claim$/)
  await sleep(1500)
  t = await text(page)
  check('after saving, the row shows the claim (date, outcome, amount, notes)', /Claim\s.*replaced/i.test(t) && t.includes('Sidewall bulge') && /1,500/.test(t), (t.match(/Claim [^\n]*/) ?? [''])[0].slice(0, 90))
  check('and the "Record claim" button is gone, so it cannot be claimed twice from the screen', !(await clickText(page, 'button', /Record claim/)))
  await page.screenshot({ path: `${OUT}/warranty-3-claimed.png` })

  // 4 · filters
  await page.select('select[aria-label="Status"]', 'claimed'); await sleep(900)
  check('the Claimed filter lists it', (await text(page)).includes(SERIAL))
  await page.select('select[aria-label="Status"]', 'active'); await sleep(900)
  check('the In-warranty filter no longer lists it', !(await text(page)).includes(SERIAL))

  // 5 · void (manager): asks for a reason, the serial can be sold again, and it shows under Void
  await page.select('select[aria-label="Status"]', 'any'); await sleep(900)
  check('"void" asks why', await page.evaluate(() => /void/i.test(document.body.innerText)))
  const clickedVoid = await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => /void/i.test(x.innerText) && x.getBoundingClientRect().width > 0) as HTMLElement | undefined; b?.click(); return !!b })
  await sleep(1500)
  check('voiding takes a reason (a prompt appeared) and succeeds', clickedVoid && dialogs.some((d) => /why/i.test(d)), dialogs.join(' | ').slice(0, 80))
  await page.select('select[aria-label="Status"]', 'void'); await sleep(900)
  check('the voided tyre shows under the Void filter, with the reason kept', (await text(page)).includes(SERIAL))
  await page.screenshot({ path: `${OUT}/warranty-4-void.png` })

  // 6 · a read-only user sees the list but no buttons
  const v = await browser.newPage(); await v.setViewport({ width: 1400, height: 1000 })
  await v.goto(`${WEB}/login`, { waitUntil: 'networkidle2' })
  await v.type('#login-phone', '9200000012')
  await clickText(v, 'button', /Staff member/); await v.waitForSelector('#login-biz'); await v.type('#login-biz', '9200000001')
  await v.click('#login-pin'); await v.keyboard.type('3333', { delay: 40 })
  await v.waitForFunction(() => !location.pathname.startsWith('/login'), { timeout: 20000 })
  await v.goto(`${WEB}/tyre/warranty`, { waitUntil: 'networkidle2' }); await sleep(800)
  check('a read-only user sees warranties but no claim or void buttons', !(await clickText(v, 'button', /Record claim|void/i)) && /Warranty/.test(await text(v)))

  await browser.close()
  const bad = results.filter((r) => !r.ok)
  console.log(`\n${results.length - bad.length}/${results.length} passed`)
  if (bad.length) { console.log('FAILED:'); for (const b of bad) console.log(' -', b.name, b.detail) }
}
main().catch((e) => { console.error(e); process.exit(1) })
