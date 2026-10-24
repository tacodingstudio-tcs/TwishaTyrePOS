// Opens the "add tyre" form and picks a size with no profile (155 R13) through the Width / Profile / Rim lists.
import puppeteer from 'puppeteer'
const WEB = process.env['WEB_URL'] ?? 'http://localhost:5175'
const CHROME = process.env['CHROME_PATH'] ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] })
const page = await browser.newPage(); await page.setViewport({ width: 1400, height: 1000 })
await page.goto(`${WEB}/login`, { waitUntil: 'networkidle2' })
await page.type('#login-phone', '9200000001'); await page.click('#login-pin'); await page.keyboard.type('1111', { delay: 40 })
await page.waitForFunction(() => !location.pathname.startsWith('/login'), { timeout: 20000 })
await page.goto(`${WEB}/inventory/products`, { waitUntil: 'networkidle2' })
const opened = await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => /add|new/i.test(x.innerText) && !/stock/i.test(x.innerText)); if (b) { (b as HTMLElement).click(); return b.innerText.trim() } return '' })
await sleep(800)
console.log('opened with button:', opened, '| size lists present:', !!(await page.$('#size-a')))
const out: string[] = []
if (await page.$('#size-a')) {
  await page.select('#size-a', '155'); await page.select('#size-b', '-'); await page.select('#size-c', '13'); await sleep(300)
  out.push('after picking 155 / No profile / 13 → ' + (await page.evaluate(() => [...document.querySelectorAll('p')].map((p) => p.innerText).find((t) => /Size:/.test(t)) ?? '(no confirmation line)')))
  await page.select('#size-b', '65'); await sleep(200)
  out.push('after switching profile to 65 → ' + (await page.evaluate(() => [...document.querySelectorAll('p')].map((p) => p.innerText).find((t) => /Size:/.test(t)) ?? '(none)')))
  await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => /Type it myself/.test(x.innerText)); (b as HTMLElement | undefined)?.click() })
  await sleep(300)
  await page.click('#size-manual', { clickCount: 3 }); await page.keyboard.press('Backspace'); await page.type('#size-manual', '155 R13 LT'); await sleep(300)
  out.push('typed "155 R13 LT" → ' + (await page.evaluate(() => [...document.querySelectorAll('p')].map((p) => p.innerText).find((t) => /Saved as|look like/.test(t)) ?? '(none)')))
}
console.log(out.join('\n'))
await browser.close()
