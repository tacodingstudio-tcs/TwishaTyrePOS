// Opens the New Sale screen at several window widths with a very large bill and reports anything that spills outside
// the window (sideways scroll, clipped buttons, text running over its card).   npx tsx e2e/layout-check.ts
import puppeteer from 'puppeteer'
import { mkdirSync } from 'node:fs'

const WEB = process.env['WEB_URL'] ?? 'http://localhost:5175'
const OUT = process.env['E2E_OUT'] ?? 'e2e-out'
const CHROME = process.env['CHROME_PATH'] ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const WIDTHS = (process.env['WIDTHS'] ?? '1000,1100,1280,1366,1440,1920').split(',').map(Number)
const PRICE = process.env['PRICE'] ?? '20000000'
mkdirSync(OUT, { recursive: true })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] })
let bad = 0
for (const w of WIDTHS) {
  const page = await browser.newPage(); await page.setViewport({ width: w, height: 800 })
  await page.evaluateOnNewDocument(() => { (window as unknown as { __name: (f: unknown) => unknown }).__name = (f) => f })
  await page.goto(`${WEB}/login`, { waitUntil: 'networkidle2' })
  await page.type('#login-phone', '9200000001'); await page.click('#login-pin'); await page.keyboard.type('1111', { delay: 30 })
  await page.waitForFunction(() => !location.pathname.startsWith('/login'), { timeout: 20000 })
  await page.goto(`${WEB}/tyre/sale`, { waitUntil: 'networkidle2' })
  await page.type('input[aria-label="Find tyre"]', '185', { delay: 20 }); await sleep(900)
  await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => /₹/.test(x.innerText) && /stock/i.test(x.innerText) && !/Save|Cash|UPI|Credit/.test(x.innerText)) as HTMLElement | undefined; b?.click() })
  await sleep(500)
  await page.evaluate(() => (document.querySelector('[aria-label^="Add Nitrogen"]') as HTMLElement | null)?.click()); await sleep(300)
  // very large figures: price and quantity on every line
  await page.evaluate((price) => {
    const set = (el: HTMLInputElement, v: string) => { const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!; d.set!.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) }
    const priceBoxes = [...document.querySelectorAll('input[type="number"]')].filter((i) => (i.previousElementSibling as HTMLElement | null)?.innerText?.match(/Price|Data Entry/)) as HTMLInputElement[]
    priceBoxes.forEach((i) => set(i, price))
  }, PRICE)
  await sleep(500)
  const r = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth
    const out: string[] = []
    for (const el of document.querySelectorAll('main *')) {
      const b = (el as HTMLElement).getBoundingClientRect()
      if (b.width > 0 && b.height > 0 && b.right > vw + 1 && !(el as HTMLElement).closest('[data-allow-scroll]')) {
        const cls = String((el as HTMLElement).className ?? '').slice(0, 60)
        out.push(`${el.tagName.toLowerCase()}.${cls} right=${Math.round(b.right)} "${((el as HTMLElement).innerText ?? '').slice(0, 24).replace(/\n/g, ' ')}"`)
      }
    }
    const scrollW = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth)
    return { vw, scrollW, sideways: scrollW > vw + 2, spill: out.slice(0, 8), total: [...document.querySelectorAll('div')].map((d) => (d as HTMLElement).innerText).find((t) => /^₹[\d,]+$/.test(t?.trim() ?? '')) ?? '' }
  })
  console.log(`${String(w).padStart(5)} px  sideways-scroll=${r.sideways ? 'YES' : 'no '}  total shown ${r.total}  ${r.spill.length ? `\n        spills: ${r.spill.join('\n                ')}` : ''}`)
  if (r.sideways || r.spill.length) bad++
  await page.screenshot({ path: `${OUT}/layout-${w}.png` })
  await page.close()
}
await browser.close()
console.log(bad ? `\n${bad} width(s) overflow` : '\nNo overflow at any width')
process.exit(bad ? 1 : 0)
