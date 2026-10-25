// Browser zoom = a smaller window. For each screen at zoomed-in sizes: scroll every scrollable area to its end, then check
// that nothing is stranded below the visible window (content you cannot reach), and report what takes the room.
//   npx tsx e2e/zoom-check.ts        SIZES="960x540,720x420" to change   (200% zoom on 1920x1080 = 960x540)
import puppeteer from 'puppeteer'
import { mkdirSync } from 'node:fs'

const WEB = process.env['WEB_URL'] ?? 'http://localhost:5175'
const OUT = process.env['E2E_OUT'] ?? 'e2e-out'
const CHROME = process.env['CHROME_PATH'] ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const SIZES = (process.env['SIZES'] ?? '960x540,720x420,1280x720').split(',').map((s) => s.split('x').map(Number) as [number, number])
const ROUTES = (process.env['ROUTES'] ?? '/,/tyre/sale,/invoices,/parties,/tyre/stock,/aging,/tyre/reminders,/tyre/team,/expenses,/advances,/approvals,/tyre/reports,/reports,/analytics,/tyre/vehicles,/tyre/warranty,/tyre/messages,/inventory/stock,/inventory/products,/inventory/suppliers,/inventory/purchase-orders,/inventory/adjustments,/inventory/transfers,/inventory/grn,/pipeline,/branches').split(',')
mkdirSync(OUT, { recursive: true })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] })
let bad = 0
for (const [w, h] of SIZES) {
  const page = await browser.newPage(); await page.setViewport({ width: w, height: h })
  await page.evaluateOnNewDocument(() => { (window as unknown as { __name: (f: unknown) => unknown }).__name = (f) => f })
  await page.goto(`${WEB}/login`, { waitUntil: 'networkidle2' })
  await page.type('#login-phone', '9200000001'); await page.click('#login-pin'); await page.keyboard.type('1111', { delay: 30 })
  await page.waitForFunction(() => !location.pathname.startsWith('/login'), { timeout: 20000 })
  for (const route of ROUTES) {
    await page.goto(`${WEB}${route}`, { waitUntil: 'networkidle2' }); await sleep(300)
    const r = await page.evaluate(() => {
      // scroll everything that scrolls to its very end
      const scrollers = [document.scrollingElement as HTMLElement, ...[...document.querySelectorAll('*')].filter((e) => {
        const cs = getComputedStyle(e as HTMLElement); return /(auto|scroll)/.test(cs.overflowY) && (e as HTMLElement).scrollHeight > (e as HTMLElement).clientHeight + 2
      }) as HTMLElement[]]
      for (const s of scrollers) s.scrollTop = s.scrollHeight
      const vh = innerHeight
      // anything of the page content still below the window after scrolling to the end?
      let worst = 0; let who = ''
      for (const el of document.querySelectorAll('main *')) {
        const e = el as HTMLElement; const b = e.getBoundingClientRect()
        if (b.width < 2 || b.height < 2 || getComputedStyle(e).position === 'fixed') continue
        if (b.bottom > vh + 2 && b.bottom - vh > worst) { worst = b.bottom - vh; who = `${e.tagName.toLowerCase()}.${String(e.className).split(' ').slice(0, 2).join('.')} "${(e.innerText ?? '').slice(0, 24).replace(/\n/g, ' ')}"` }
      }
      // how much of the window do the fixed/sticky bars take?
      const sticky = [...document.querySelectorAll('main *')].filter((e) => /(sticky|fixed)/.test(getComputedStyle(e as HTMLElement).position)).map((e) => Math.round((e as HTMLElement).getBoundingClientRect().height))
      const topBar = (document.querySelector('main > div:first-child') as HTMLElement | null)?.getBoundingClientRect().height ?? 0
      return { worst: Math.round(worst), who, nScroll: scrollers.length, vh, sticky, topBar: Math.round(topBar) }
    })
    const stuck = r.worst > 4
    if (stuck) bad++
    console.log(`${w}x${h}  ${route.padEnd(26)} ${stuck ? `UNREACHABLE content ${r.worst}px below the window: ${r.who}` : 'reachable'}${r.sticky.length ? `   pinned bars: ${r.sticky.join('+')}px (+ top bar ${r.topBar}px) of ${r.vh}px` : ''}`)
    if (stuck) await page.screenshot({ path: `${OUT}/zoom-${w}x${h}-${route.replace(/\W+/g, '_')}.png` })
  }
  await page.close()
}
await browser.close()
console.log(bad ? `\n${bad} screen(s) strand content` : '\nEvery screen is fully reachable at every size')
