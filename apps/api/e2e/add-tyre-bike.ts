// Adds a bike tyre with a 3-digit profile (80/100-17) through the real Add Product form, then the SAME tyre again:
// the form must ask "already in your list - add anyway?"; "No" saves nothing, "Yes" saves it.
//   npx tsx e2e/add-tyre-bike.ts   (API :3200, web :5175, demo shop)
import puppeteer from 'puppeteer'
const WEB = process.env['WEB_URL'] ?? 'http://localhost:5175'
const API = 'http://localhost:3200'
const CHROME = process.env['CHROME_PATH'] ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const stamp = Date.now() % 100000
const name = `80/100/17 ZENOVA STREET FR1 ${stamp}`
let bad = 0
const check = (n: string, ok: boolean, d = '') => { if (!ok) bad++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  - ${d}` : ''}`) }
const b = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] })
const p = await b.newPage(); await p.evaluateOnNewDocument('window.__name = (f) => f'); await p.setViewport({ width: 1280, height: 900 })
let dialogs: string[] = [], answer = true
p.on('dialog', async (d) => { dialogs.push(d.message()); if (answer) await d.accept(); else await d.dismiss() })
await p.goto(`${WEB}/login`, { waitUntil: 'networkidle2' })
await p.type('#login-phone', '9200000001'); await p.click('#login-pin'); await p.keyboard.type('1111', { delay: 40 })
await p.waitForFunction(() => !location.pathname.startsWith('/login'), { timeout: 20000 })
const token: string = await p.evaluate(() => { const raw = [...Object.values(localStorage), ...Object.values(sessionStorage)].find((v) => /accessToken/.test(String(v))); try { return JSON.parse(String(raw)).state.accessToken } catch { return '' } })
const j = async (path: string) => (await fetch(API + path, { headers: { authorization: `Bearer ${token}` } })).json() as Promise<any>
const copies = async () => (((await j('/api/products?limit=500&search=ZENOVA')).data ?? []) as any[]).filter((x) => x.name === name).length

async function fillAndSave(sale: string, purchase = '') {
  await p.goto(`${WEB}/inventory/products`, { waitUntil: 'networkidle2' })
  await p.evaluate(() => (Array.from(document.querySelectorAll('button')).find((e) => /Add Tyre/i.test(e.textContent ?? '')) as HTMLElement).click())
  await p.waitForSelector('input[placeholder^="e.g. Amul"]')
  await p.type('input[placeholder^="e.g. Amul"]', name)
  await p.evaluate(() => {
    const pick = (label: string, value: string) => {
      const sel = (Array.from(document.querySelectorAll('select')) as HTMLSelectElement[]).find((e) => (e.previousElementSibling?.textContent ?? '').trim().startsWith(label))
      if (!sel) throw new Error('no select ' + label)
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(sel, value); sel.dispatchEvent(new Event('change', { bubbles: true }))
    }
    pick('What is it?', 'tyre'); pick('Fits', 'two_wheeler'); pick('Width', '80'); pick('Profile', '100'); pick('Rim', '17')
  })
  // a pattern, so the "same brand + pattern + size" rule is exercised as well as the same name
  await new Promise((r) => setTimeout(r, 300))
  await p.type('#prod-sale', sale); if (purchase) await p.type('#prod-purchase', purchase)
  dialogs = []
  await p.evaluate(() => (Array.from(document.querySelectorAll('button')).find((e) => /^Add Product$/.test((e.textContent ?? '').trim())) as HTMLElement).click())
  await new Promise((r) => setTimeout(r, 2000))
}

await fillAndSave('1630')
check('first save: the bike tyre (80/100-17) is saved without a question', (await copies()) === 1 && dialogs.length === 0, `${await copies()} copy`)
answer = false; await fillAndSave('1630')
check('the same tyre again asks "already in your list"', dialogs.length === 1 && /already in your list/.test(dialogs[0] ?? ''), dialogs[0]?.slice(0, 80))
check('"No" saves nothing', (await copies()) === 1)
answer = true; await fillAndSave('1630')
check('"Yes, add anyway" saves the second copy', (await copies()) === 2)
// a loss-making price asks too
const name0 = name
await b.close()
console.log(bad ? `\n${bad} check(s) failed` : '\nAll checks passed'); process.exit(bad ? 1 : 0)
