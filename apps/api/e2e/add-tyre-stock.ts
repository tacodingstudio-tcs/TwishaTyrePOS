// Adds a tyre through the real Add Product form with "Stock to add now" filled in, then checks the stock level the API reports.
import puppeteer from 'puppeteer'
const WEB = process.env['WEB_URL'] ?? 'http://localhost:5175'
const API = 'http://localhost:3200'
const CHROME = process.env['CHROME_PATH'] ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const name = `E2E Stock Tyre ${Date.now() % 100000}`
const b = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] })
const p = await b.newPage(); await p.evaluateOnNewDocument('window.__name = (f) => f'); await p.setViewport({ width: 1280, height: 720 })
await p.goto(`${WEB}/login`, { waitUntil: 'networkidle2' })
await p.type('#login-phone', '9200000001'); await p.click('#login-pin'); await p.keyboard.type('1111', { delay: 40 })
await p.waitForFunction(() => !location.pathname.startsWith('/login'), { timeout: 20000 })
const token: string = await p.evaluate(() => { const raw = [...Object.values(localStorage), ...Object.values(sessionStorage)].find((v) => /accessToken/.test(String(v))); try { return JSON.parse(String(raw)).state.accessToken } catch { return '' } })
await p.goto(`${WEB}/inventory/products`, { waitUntil: 'networkidle2' })
await p.evaluate(() => (Array.from(document.querySelectorAll('button')).find((e) => /Add Tyre/i.test(e.textContent ?? '')) as HTMLElement).click())
await p.waitForSelector('input[placeholder^="e.g. Amul"]')
await p.type('input[placeholder^="e.g. Amul"]', name)
// the fields the form needs for a tyre: kind, vehicle fit, width / profile / rim
await p.evaluate(() => {
  const pick = (label: string, value: string) => {
    const sel = (Array.from(document.querySelectorAll('select')) as HTMLSelectElement[]).find((e) => (e.previousElementSibling?.textContent ?? '').trim().startsWith(label))
    if (!sel) throw new Error('no select ' + label)
    const proto = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!
    proto.set!.call(sel, value); sel.dispatchEvent(new Event('change', { bubbles: true }))
  }
  pick('What is it?', 'tyre'); pick('Fits', 'car'); pick('Width', '185'); pick('Profile', '65'); pick('Rim', '15')
})
await new Promise((r) => setTimeout(r, 400))
await p.type('#prod-sale', '5200'); await p.type('#prod-purchase', '4100')
await p.select('#prod-gst', '18')
await p.type('#prod-stock', '8')
console.log('save button:', await p.evaluate(() => { const x = Array.from(document.querySelectorAll('button')).find((e) => /^Add Product$/.test((e.textContent ?? '').trim())) as HTMLButtonElement; return { disabled: x.disabled, title: x.title } }))
console.log('form messages:', await p.evaluate(() => Array.from(document.querySelectorAll('.text-red-600, .text-red-500, .text-amber-700')).map((e) => (e.textContent ?? '').trim().slice(0, 90))))
await p.evaluate(() => (Array.from(document.querySelectorAll('button')).find((e) => /^Add Product$/.test((e.textContent ?? '').trim())) as HTMLElement).click())
await new Promise((r) => setTimeout(r, 1800))
const j = async (path: string) => (await fetch(API + path, { headers: { authorization: `Bearer ${token}` } })).json() as Promise<any>
const list = await j('/api/products?limit=200')
const prod = (list.data ?? []).find((x: any) => x.name === name)
console.log('product saved:', !!prod)
const st = await j('/api/stock?limit=200')
const row = (st.data ?? []).find((x: any) => x.productId === prod?.id)
console.log('stock level shown by the API:', row?.currentQty, '(expected 8)')
const ok = !!prod && Number(row?.currentQty) === 8
console.log(ok ? 'PASS' : 'FAIL')
await p.screenshot({ path: 'e2e-out/add-tyre-after.png' })
await b.close()
process.exit(ok ? 0 : 1)
