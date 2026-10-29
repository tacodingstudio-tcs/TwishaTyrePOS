// apps/api/e2e/small-screens.ts
// The client's laptop is small (about 1280x720 before Windows scaling, so often 1024x576 or less of page). Opens every screen as the
// owner at several small desktop sizes and reports what a person there would trip over:
//   - the page scrolls sideways
//   - a button / link / field sits (partly) outside the window, so it cannot be reached
//   - the Reprint menu on All Bills opens outside the window or is cut off
// Needs the API (:3200), the web app (:5175) and the demo shop (pnpm seed).
//
//   npx tsx e2e/small-screens.ts            screenshots go to e2e-out/small (E2E_SHOTS=0 for none)
import puppeteer, { type Page } from 'puppeteer'
import { mkdirSync } from 'node:fs'

const WEB = process.env['WEB_URL'] ?? 'http://localhost:5175'
const OUT = `${process.env['E2E_OUT'] ?? 'e2e-out'}/small`
const CHROME = process.env['CHROME_PATH'] ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const SHOTS = process.env['E2E_SHOTS'] !== '0'
mkdirSync(OUT, { recursive: true })

const ALL: Array<[number, number]> = [[1366, 768], [1280, 720], [1152, 648], [1024, 576]]
const ONLY = process.env['SIZE_ONLY']   // e.g. 1024x576
const SIZES = ONLY ? ALL.filter(([w, h]) => `${w}x${h}` === ONLY) : ALL
const ROUTES = [
  '/', '/tyre/sale', '/tyre/sale?mode=service', '/invoices', '/parties', '/tyre/stock', '/aging', '/tyre/reminders', '/tyre/team',
  '/expenses', '/advances', '/approvals', '/tyre/reports', '/reports', '/analytics', '/tyre/vehicles', '/tyre/warranty', '/tyre/messages',
  '/inventory/stock', '/inventory/products', '/inventory/suppliers', '/inventory/purchase-orders', '/inventory/adjustments',
  '/inventory/transfers', '/inventory/grn', '/pipeline', '/staff', '/branches',
]

const findings: string[] = []
const note = (size: string, route: string, what: string) => findings.push(`${size}  ${route}  —  ${what}`)

async function login(page: Page) {
  await page.goto(`${WEB}/login`, { waitUntil: 'networkidle2' })
  await page.type('#login-phone', '9200000001')
  await page.click('#login-pin')
  await page.keyboard.type('1111', { delay: 40 })
  await page.waitForFunction(() => !location.pathname.startsWith('/login'), { timeout: 20000 })
}

/** controls that are visible but lie outside the window (not merely scrolled away inside a scroll area) */
const unreachable = (page: Page) => page.evaluate(() => {
  const out: string[] = []
  const vw = window.innerWidth
  const scrollable = (el: Element | null): boolean => {
    for (let e = el; e && e !== document.body; e = e.parentElement) {
      const s = getComputedStyle(e)
      if (/(auto|scroll)/.test(s.overflowX) && e.scrollWidth > e.clientWidth + 2) return true
    }
    return false
  }
  for (const el of Array.from(document.querySelectorAll('button, a[href], input, select, textarea'))) {
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) continue
    const st = getComputedStyle(el)
    if (st.visibility === 'hidden' || st.display === 'none') continue
    if ((r.right > vw + 2 || r.left < -2) && !scrollable(el)) {
      out.push(`${el.tagName.toLowerCase()} "${(el.textContent ?? (el as HTMLInputElement).placeholder ?? '').trim().slice(0, 30)}" at x=${Math.round(r.left)}..${Math.round(r.right)} (window ${vw})`)
    }
  }
  return out.slice(0, 5)
})

async function reprintMenu(page: Page, size: string) {
  await page.goto(`${WEB}/invoices`, { waitUntil: 'networkidle2' })
  const btn = await page.$('button[aria-haspopup="menu"]')
  if (!btn) { note(size, '/invoices', 'no Reprint button found (no bills in the demo shop?)'); return }
  await btn.click()
  await new Promise((r) => setTimeout(r, 300))
  const m = await page.evaluate(() => {
    const el = document.querySelector('[role="menu"]'); if (!el) return null
    const r = el.getBoundingClientRect()
    const items = Array.from(el.querySelectorAll('[role="menuitem"]')).map((b) => { const q = b.getBoundingClientRect(); return { top: q.top, bottom: q.bottom, left: q.left, right: q.right } })
    // is each item really what the user would hit at its centre (not covered or clipped by another element)?
    const hit = items.map((q) => { const e = document.elementFromPoint((q.left + q.right) / 2, (q.top + q.bottom) / 2); return !!e && !!e.closest('[role="menu"]') })
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, vh: window.innerHeight, vw: window.innerWidth, items: items.length, hit }
  })
  if (!m) { note(size, '/invoices', 'Reprint menu did not open'); return }
  if (m.top < 0 || m.bottom > m.vh || m.left < 0 || m.right > m.vw) note(size, '/invoices', `Reprint menu is outside the window (${Math.round(m.top)}..${Math.round(m.bottom)} of ${m.vh})`)
  if (m.items < 4) note(size, '/invoices', `Reprint menu shows ${m.items} of 4 options`)
  if (m.hit.some((h) => !h)) note(size, '/invoices', 'some Reprint options are covered by something else')
  if (SHOTS) await page.screenshot({ path: `${OUT}/reprint-${size}.png` })
  await page.keyboard.press('Escape')
}

/** a popup that is drawn inside a parent which clips it (overflow hidden / auto) loses the part that sticks out */
const clipped = (page: Page, selector: string) => page.evaluate((sel) => {
  const el = document.querySelector(sel); if (!el) return 'not found'
  const r = el.getBoundingClientRect()
  const vh = window.innerHeight
  for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
    const o = getComputedStyle(p)
    if (o.position === 'fixed') break
    if (o.overflowX === 'visible' && o.overflowY === 'visible') continue
    const q = p.getBoundingClientRect()
    if (r.bottom > q.bottom + 2 || r.right > q.right + 2) return `cut off by a ${p.tagName.toLowerCase()} (popup ends at ${Math.round(r.bottom)}, its box ends at ${Math.round(q.bottom)}; window ${vh})`
  }
  return r.bottom > vh + 2 && !document.scrollingElement ? 'below the window' : ''
}, selector)

async function otherPopups(page: Page, size: string) {
  // customer picker on New Sale
  await page.goto(`${WEB}/tyre/sale`, { waitUntil: 'networkidle2' })
  const input = await page.$('input[role="combobox"]')
  if (input) {
    await input.click(); await input.type('a'); await new Promise((r) => setTimeout(r, 700))
    const why = await clipped(page, '[role="listbox"]')
    if (why && why !== 'not found') note(size, '/tyre/sale', `customer list: ${why}`)
    if (SHOTS) await page.screenshot({ path: `${OUT}/customer-list-${size}.png` })
    await page.keyboard.press('Escape')
  } else note(size, '/tyre/sale', 'customer picker not found')
  // birthdays & anniversaries in the top bar
  await page.goto(`${WEB}/`, { waitUntil: 'networkidle2' })
  const gift = await page.$('button[title="Birthdays & Anniversaries"]')
  if (gift) {
    await gift.click(); await new Promise((r) => setTimeout(r, 400))
    const why = await clipped(page, 'button[title="Birthdays & Anniversaries"] + div')
    if (why && why !== 'not found') note(size, '/', `birthdays panel: ${why}`)
    const box = await page.evaluate(() => { const d = document.querySelector('button[title="Birthdays & Anniversaries"] + div'); if (!d) return null; const r = d.getBoundingClientRect(); return { l: r.left, r: r.right, b: r.bottom, vw: window.innerWidth, vh: window.innerHeight } })
    if (box && (box.l < 0 || box.r > box.vw + 2 || box.b > box.vh + 2)) note(size, '/', `birthdays panel is outside the window (${Math.round(box.l)}..${Math.round(box.r)} x ..${Math.round(box.b)} of ${box.vw}x${box.vh})`)
    if (SHOTS) await page.screenshot({ path: `${OUT}/birthdays-${size}.png` })
    await page.keyboard.press('Escape')
  }
}

async function main() {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] })
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 120)))
  await page.evaluateOnNewDocument('window.__name = (f) => f')       // tsx adds __name() to the functions run inside the page
  await page.setViewport({ width: 1400, height: 900 })
  await login(page)
  let visits = 0
  for (const [w, h] of SIZES) {
    const size = `${w}x${h}`
    await page.setViewport({ width: w, height: h })
    for (const route of ROUTES) {
      try { await page.goto(`${WEB}${route}`, { waitUntil: 'networkidle2', timeout: 30000 }) } catch { note(size, route, 'did not settle in 30 s') }
      await new Promise((r) => setTimeout(r, 250))
      visits++
      if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 4)) note(size, route, 'page scrolls sideways')
      for (const u of await unreachable(page)) note(size, route, `outside the window: ${u}`)
      if (SHOTS && w === 1024) await page.screenshot({ path: `${OUT}/${route.replace(/[^a-z0-9]+/gi, '_') || 'home'}-${size}.png` })
    }
    await reprintMenu(page, size)
    await otherPopups(page, size)
  }
  await browser.close()
  console.log(`${visits} page visits at ${SIZES.map(([w, h]) => `${w}x${h}`).join(', ')}`)
  if (errors.length) console.log(`page errors: ${[...new Set(errors)].join(' | ')}`)
  console.log(findings.length ? `\n${findings.length} findings:\n${findings.join('\n')}` : '\nno findings')
}
main().catch((e) => { console.error(e); process.exit(1) })
