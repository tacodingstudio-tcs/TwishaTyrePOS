// Does every screen fit a small laptop without scroll bars? Opens each screen at small window sizes and reports page-level
// sideways scroll, inner tables / panels that scroll sideways, and (sign-in page) vertical overflow.
//   npx tsx e2e/fit-check.ts            SIZES="1024x600,1100x650" to change
import puppeteer from 'puppeteer'

const WEB = process.env['WEB_URL'] ?? 'http://localhost:5175'
const CHROME = process.env['CHROME_PATH'] ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const SIZES = (process.env['SIZES'] ?? '1024x600,1100x650,1280x680').split(',').map((s) => s.split('x').map(Number) as [number, number])
const ROUTES = ['/', '/tyre/sale', '/invoices', '/parties', '/tyre/stock', '/aging', '/tyre/reminders', '/tyre/team', '/expenses', '/advances', '/approvals',
  '/tyre/reports', '/reports', '/analytics', '/tyre/vehicles', '/tyre/warranty', '/tyre/messages', '/inventory/stock', '/inventory/products', '/inventory/suppliers',
  '/inventory/purchase-orders', '/inventory/adjustments', '/inventory/transfers', '/inventory/grn', '/pipeline', '/branches']
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] })
const problems: string[] = []

for (const [w, h] of SIZES) {
  const page = await browser.newPage(); await page.setViewport({ width: w, height: h })
  await page.evaluateOnNewDocument(() => { (window as unknown as { __name: (f: unknown) => unknown }).__name = (f) => f })
  // the sign-in page: everything visible without scrolling
  await page.goto(`${WEB}/login`, { waitUntil: 'networkidle2' }); await sleep(400)
  const lg = await page.evaluate(() => {
    const vh = innerHeight
    const bottoms = ['h1', 'h2', 'main form', 'main a[href*="twisha"]'].map((q) => document.querySelector(q)?.getBoundingClientRect().bottom ?? 0)
    const hero = document.querySelector('aside .max-w-xl')?.getBoundingClientRect().bottom ?? 0
    return { v: document.documentElement.scrollHeight - vh, hx: document.documentElement.scrollWidth - innerWidth,
      inner: [...bottoms, hero].filter((b) => b > vh + 2).map((b) => Math.round(b - vh)) }
  })
  const lgBad = lg.v > 4 || lg.hx > 4 || lg.inner.length > 0
  console.log(`${w}x${h}  /login  ${lgBad ? `SCROLLS (page ${lg.v}px tall, ${lg.hx}px wide, panels ${JSON.stringify(lg.inner)})` : 'fits'}`)
  if (lgBad) problems.push(`${w}x${h} /login`)

  await page.type('#login-phone', '9200000001'); await page.click('#login-pin'); await page.keyboard.type('1111', { delay: 30 })
  await page.waitForFunction(() => !location.pathname.startsWith('/login'), { timeout: 20000 })
  for (const route of ROUTES) {
    await page.goto(`${WEB}${route}`, { waitUntil: 'networkidle2' }); await sleep(250)
    const r = await page.evaluate(() => {
      const vw = document.documentElement.clientWidth
      const page = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - vw
      const inner: string[] = []
      for (const el of document.querySelectorAll('main *')) {
        const e = el as HTMLElement
        const cs = getComputedStyle(e)
        if ((cs.overflowX === 'auto' || cs.overflowX === 'scroll') && e.scrollWidth > e.clientWidth + 4 && e.clientWidth > 0) {
          inner.push(`${e.tagName.toLowerCase()}${e.className ? '.' + String(e.className).split(' ').slice(0, 2).join('.') : ''} wants ${e.scrollWidth}px in ${e.clientWidth}px`)
        }
      }
      return { page, inner: inner.slice(0, 3) }
    })
    if (r.page > 3 || r.inner.length) { problems.push(`${w}x${h} ${route}`); console.log(`${w}x${h}  ${route.padEnd(26)} ${r.page > 3 ? `PAGE scrolls sideways by ${r.page}px  ` : ''}${r.inner.join(' | ')}`) }
  }
  await page.close()
}
await browser.close()
console.log(problems.length ? `\n${problems.length} screen(s) need scrolling` : '\nEvery screen fits at every size')
