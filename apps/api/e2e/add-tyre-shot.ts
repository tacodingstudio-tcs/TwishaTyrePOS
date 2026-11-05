// Opens Items > Add Product on the demo shop and screenshots the form (top and bottom), listing the labels it shows.
import puppeteer from 'puppeteer'
const WEB = process.env['WEB_URL'] ?? 'http://localhost:5175'
const CHROME = process.env['CHROME_PATH'] ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const b = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] })
const p = await b.newPage(); await p.setViewport({ width: 1280, height: 720 })
await p.goto(`${WEB}/login`, { waitUntil: 'networkidle2' })
await p.type('#login-phone', '9200000001'); await p.click('#login-pin'); await p.keyboard.type('1111', { delay: 40 })
await p.waitForFunction(() => !location.pathname.startsWith('/login'), { timeout: 20000 })
await p.goto(`${WEB}/inventory/products`, { waitUntil: 'networkidle2' })
await new Promise((r) => setTimeout(r, 500))
const clicked = await p.evaluate(() => { const x = Array.from(document.querySelectorAll('button')).find((e) => /^\s*\+?\s*Add (Product|Item|Tyre)/i.test(e.textContent ?? '')); if (x) { (x as HTMLElement).click(); return x.textContent } return null })
console.log('clicked:', clicked)
await new Promise((r) => setTimeout(r, 800))
console.log('labels:', await p.evaluate(() => Array.from(document.querySelectorAll('[role="dialog"] label, .fixed label')).map((l) => (l.textContent ?? '').trim().slice(0, 40))))
await p.screenshot({ path: 'e2e-out/add-tyre-top.png' })
await p.evaluate(() => { for (const e of Array.from(document.querySelectorAll('*'))) { const s = getComputedStyle(e); if (/(auto|scroll)/.test(s.overflowY) && e.scrollHeight > e.clientHeight + 20) (e as HTMLElement).scrollTop = 99999 } })
await new Promise((r) => setTimeout(r, 300))
await p.screenshot({ path: 'e2e-out/add-tyre-bottom.png' })
await b.close()
