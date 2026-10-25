// apps/api/e2e/flow-warranty.ts
// The warranty journey through the real screens: sell a tyre with a serial number, find it on the Warranty page,
// send a claim to the tyre company, record their answer with a replacement from stock, correct the details,
// see it in the claims report, and void. Needs the API (:3200), the web app (:5175) and the demo shop.
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
const NEW_SERIAL = `NEW${Date.now().toString(36).toUpperCase()}`

async function main() {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] })
  const page = await browser.newPage(); await page.setViewport({ width: 1400, height: 1200 })
  const dialogs: string[] = []
  page.on('pageerror', (e) => console.log('PAGEERROR', String(e.message).slice(0, 200)))
  page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text().slice(0, 160)) })
  page.on('dialog', async (d) => { dialogs.push(d.message()); await d.accept('tyre returned to the supplier') })
  await page.goto(`${WEB}/login`, { waitUntil: 'networkidle2' })
  await page.type('#login-phone', '9200000001'); await page.click('#login-pin'); await page.keyboard.type('1111', { delay: 40 })
  await page.waitForFunction(() => !location.pathname.startsWith('/login'), { timeout: 20000 })

  // 1 · sell a tyre with a serial number — the serial box is open and warns until a serial is entered
  await page.goto(`${WEB}/tyre/sale`, { waitUntil: 'networkidle2' })
  await page.type('input[placeholder="Name or mobile"]', 'Warranty Walk Customer', { delay: 10 })
  await page.type('input[placeholder="10-digit mobile"]', '9876512345', { delay: 10 })
  await page.type('input[placeholder="GJ05AB1234"]', 'GJ05WW9999', { delay: 10 })
  await page.type('input[aria-label="Find tyre"]', '185', { delay: 30 }); await sleep(900)
  await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => /₹/.test(x.innerText) && /stock/i.test(x.innerText) && !/Save|Cash|UPI|Credit/.test(x.innerText)) as HTMLElement | undefined; b?.click() })
  await sleep(500)
  check('the serial-number box is already open on a tyre line (nothing to click)', !!(await page.$('input[placeholder="one per tyre, in fitting order"]')) && await page.evaluate(() => (document.querySelector('details[open]') as HTMLElement | null)?.innerText.includes('Serial numbers') ?? false))
  check('it warns that a claim cannot be matched without a serial', /No serial number yet/.test(await text(page)))
  await page.type('input[placeholder="one per tyre, in fitting order"]', SERIAL, { delay: 10 }); await sleep(200)
  check('the warning goes away once the serial is entered', !/No serial number yet|serial numbers entered/.test(await text(page)))
  await clickText(page, 'button', /^Cash$/); await sleep(300)
  await page.evaluate(() => { const b = [...document.querySelectorAll('button')].filter((x) => /^Save bill$/.test(x.innerText.trim()) && x.getBoundingClientRect().width > 0)[0] as HTMLElement | undefined; b?.click() })
  await sleep(3000)
  check('the bill with a serial number saves', /\/invoices\//.test(page.url()) && !/Something went wrong/.test(await text(page)), page.url())

  // 2 · find it, and send the claim to the tyre company ("waiting"), with their reference
  await page.goto(`${WEB}/tyre/warranty`, { waitUntil: 'networkidle2' })
  await page.type('input[placeholder^="Serial number"]', SERIAL, { delay: 15 }); await sleep(1200)
  let t = await text(page)
  check('the new tyre is on the Warranty page, in warranty, with its serial and the customer', t.includes(SERIAL) && /In warranty/i.test(t) && t.includes('Warranty Walk Customer'))
  check('"Record claim" is offered', await clickText(page, 'button', /Record claim/)); await sleep(500)
  check('Save claim stays disabled until the notes are filled', await page.evaluate(() => (([...document.querySelectorAll('button')].find((x) => /^Save claim$/.test(x.innerText.trim())) as HTMLButtonElement | undefined)?.disabled) === true))
  await page.select('.fixed select', 'pending')
  await page.type('.fixed textarea', 'Sidewall bulge — sent to the depot with the tyre', { delay: 6 })
  await page.type('.fixed input[placeholder="their reference"]', 'MRF-E2E-77', { delay: 6 })
  check('a "waiting for the company" claim needs no replacement tyre', !/Hand over a replacement/.test(await text(page)))
  await clickText(page, 'button', /^Save claim$/); await sleep(1500)
  t = await text(page)
  check('the row now says "Waiting for company", with their reference and the days so far', /Waiting for company/.test(t) && t.includes('MRF-E2E-77') && /day/.test(t))
  await page.select('select[aria-label="Status"]', 'pending'); await sleep(900)
  check('the "Waiting for company" filter lists it', (await text(page)).includes(SERIAL))
  await page.screenshot({ path: `${OUT}/warranty-1-waiting.png` })

  // 3 · the company replies: replaced, handing over a tyre from stock
  check('"Company replied" is offered to a manager', await clickText(page, 'button', /Company replied/)); await sleep(600)
  await page.select('.fixed select', 'replaced')
  await sleep(300)
  check('choosing "Replaced" offers a replacement from stock (Save waits until one is picked)', /Hand over a replacement/.test(await text(page)) && await page.evaluate(() => (([...document.querySelectorAll('button')].find((x) => /^Save changes$/.test(x.innerText.trim())) as HTMLButtonElement | undefined)?.disabled) === true))
  await page.type('.fixed input[placeholder^="Find the replacement"]', '185', { delay: 30 }); await sleep(1200)
  const picked = await page.evaluate(() => { const b = [...document.querySelectorAll('.fixed li button')].find((x) => /in stock/.test((x as HTMLElement).innerText)) as HTMLElement | undefined; if (b) { const n = b.innerText.split('\n')[0]; b.click(); return n } return '' })
  check('the replacement search lists tyres in stock', !!picked, picked)
  await sleep(300)
  await page.type('.fixed input.font-mono', NEW_SERIAL, { delay: 6 })
  await page.screenshot({ path: `${OUT}/warranty-2-replacement.png` })
  await clickText(page, 'button', /^Save changes$/); await sleep(1800)
  check('once decided, the claim leaves the "Waiting for company" list', !(await text(page)).includes(SERIAL))
  await page.select('select[aria-label="Status"]', 'any'); await sleep(1000)
  t = await text(page)
  check('the claim now shows "replaced" and which serial replaced it', /replaced by S\/N/.test(t) && t.includes(NEW_SERIAL))
  await page.evaluate(() => { (document.querySelector('input[placeholder^="Serial number"]') as HTMLInputElement).select() })
  await page.keyboard.type(NEW_SERIAL); await sleep(1200)
  t = await text(page)
  check('the replacement tyre has its own warranty record, marked as a replacement', t.includes(NEW_SERIAL) && new RegExp(`Replacement for S/N ${SERIAL}`).test(t) && /In warranty/.test(t))
  await page.screenshot({ path: `${OUT}/warranty-3-replacement-row.png` })

  // 4 · correct the details; the history keeps the change
  await page.evaluate(() => { (document.querySelector('input[placeholder^="Serial number"]') as HTMLInputElement).select() }); await page.keyboard.type(SERIAL); await sleep(1200)
  check('"Edit details" is offered to a manager', await clickText(page, 'button', /^Edit details$/)); await sleep(500)
  await page.click('.fixed input', { clickCount: 3 }); await page.keyboard.type('Corrected Customer Name')
  await clickText(page, 'button', /^Save$/); await sleep(1500)
  t = await text(page)
  check('the corrected name shows on the record, and the history lists the edit', t.includes('Corrected Customer Name') && /Show history/.test(t))
  await clickText(page, 'button', /Show history/); await sleep(300)
  check('the history lists the claim, the company reply and the edit', /Claim recorded/.test(await text(page)) && /Claim updated/.test(await text(page)) && /Details edited/.test(await text(page)))

  // 5 · the claims report
  await page.goto(`${WEB}/tyre/reports`, { waitUntil: 'networkidle2' })
  check('the "Warranty claims" report tab is there for the owner', await clickText(page, 'button', /^Warranty claims$/)); await sleep(1500)
  t = await text(page)
  check('the claims report shows totals and the outcomes', /Claims/.test(t) && /By outcome/.test(t) && /By brand/.test(t) && /Replaced/.test(t))
  await page.screenshot({ path: `${OUT}/warranty-4-report.png` })

  // 6 · void the original (manager): asks for a reason
  await page.goto(`${WEB}/tyre/warranty`, { waitUntil: 'networkidle2' })
  await page.type('input[placeholder^="Serial number"]', SERIAL, { delay: 15 }); await sleep(1200)
  const clickedVoid = await clickText(page, 'button', /^Void$/); await sleep(1500)
  check('voiding takes a reason (a prompt appeared) and succeeds', clickedVoid && dialogs.some((d) => /why/i.test(d)))
  await page.select('select[aria-label="Status"]', 'void'); await sleep(900)
  check('the voided tyre shows under the Void filter', (await text(page)).includes(SERIAL))

  // 7 · a read-only user sees the list but no buttons; counter staff can claim but not edit or void
  const v = await browser.newPage(); await v.setViewport({ width: 1400, height: 1000 })
  await v.goto(`${WEB}/login`, { waitUntil: 'networkidle2' })
  await v.type('#login-phone', '9200000012')
  await clickText(v, 'button', /Staff member/); await v.waitForSelector('#login-biz'); await v.type('#login-biz', '9200000001')
  await v.click('#login-pin'); await v.keyboard.type('3333', { delay: 40 })
  await v.waitForFunction(() => !location.pathname.startsWith('/login'), { timeout: 20000 })
  await v.goto(`${WEB}/tyre/warranty`, { waitUntil: 'networkidle2' }); await sleep(800)
  check('a read-only user sees warranties but no claim, edit or void buttons', !(await clickText(v, 'button', /Record claim|Edit details|Update claim|Company replied|Void/i)) && /Warranty/.test(await text(v)))
  await v.goto(`${WEB}/tyre/reports`, { waitUntil: 'networkidle2' }); await sleep(600)
  check('and does not see the claims-cost report tab', !(await clickText(v, 'button', /^Warranty claims$/)))

  await browser.close()
  const bad = results.filter((r) => !r.ok)
  console.log(`\n${results.length - bad.length}/${results.length} passed`)
  if (bad.length) { console.log('FAILED:'); for (const b of bad) console.log(' -', b.name, b.detail) }
}
main().catch((e) => { console.error(e); process.exit(1) })
