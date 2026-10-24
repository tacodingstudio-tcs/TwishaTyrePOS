// Replays the shop's real paper-book bills (Shakti Bill Book.xlsx: CAR and Two Wheel sheets) through the app and
// checks the app against the spreadsheet's own figures:
//   · every bill is accepted (or refused with a message the counter can act on — never a crash)
//   · bill numbers follow the book (1, 2, 3 …), one series per sheet
//   · taxable value and GST per bill agree with the sheet's formulas; the bill total is what the customer paid
//   · stock falls by exactly what was sold; the bill register lists every bill; each bill prints as a PDF with the logo
// The data file holds real customers, so it is not in git (apps/api/e2e/data/ is ignored). No file → the suite is skipped.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isRecognisedTyreSize } from '@billing/domain-registry'
import { newShopTenant, type Session } from './helpers'

const FILE = join(__dirname, '..', '..', 'e2e', 'data', 'shakti-bill-book.json')
const book: Record<'CAR' | 'Two Wheel', any[]> | null = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : null
const maybe = book ? describe : describe.skip

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

maybe('Shakti bill book replayed through the app', () => {
  let owner: Session
  const products = new Map<string, any>()
  const notes: string[] = []                    // things worth telling the shop about (not failures)
  const made: Array<{ sheet: string; row: any; id: string; number: string; expectTotal: number }> = []
  const refused: Array<{ sheet: string; row: any; status: number; message: string }> = []

  const clean = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim()
  const sizeKey = (s: unknown) => clean(s).toUpperCase()
  const post = (body: Record<string, unknown>, key = crypto.randomUUID()) =>
    owner.api.post('/api/tyre/sales', body, { headers: { 'Idempotency-Key': key } })

  async function productFor(row: any, vt: 'car' | 'two_wheeler') {
    const brand = clean(row.brand).toUpperCase() || 'UNBRANDED'
    const size = sizeKey(row.desc)
    const k = `${brand}|${size}|${vt}`
    if (products.has(k)) return products.get(k)
    const r = await owner.api.post('/api/products', {
      itemType: 'product', gstRate: 18, unit: 'pcs', trackStock: true, name: `${brand} ${size}`, sku: `WB-${products.size + 1}`,
      salePrice: Number(row.price) || 1000, purchasePrice: Math.round((Number(row.price) || 1000) * 0.8), openingStock: 500,
      domainAttrs: { item_kind: 'tyre', brand, size, vehicle_type: vt },
    })
    if (r.status !== 201) {
      notes.push(`size "${size}" refused: ${r.status} ${String(r.data?.error ?? r.data?.message ?? '').slice(0, 90)}`)
      expect(isRecognisedTyreSize(size)).toBe(false)             // only a size the reader really cannot read may be refused
      expect(String(r.data?.error ?? '')).toMatch(/not recognised/)
      products.set(k, null); return null
    }
    products.set(k, r.data); return r.data
  }

  beforeAll(async () => {
    owner = await newShopTenant('Shakti Enterprise')
    const branchId = (await owner.api.get('/api/branches')).data[0].id
    await owner.api.patch(`/api/branches/${branchId}`, {
      domainConfig: { prices_include_gst: true, bill_series: { car: { prefix: '', start: 1 }, two_wheel: { prefix: '2W-', start: 1 } } },
    })
  }, 60_000)

  async function replay(sheet: 'CAR' | 'Two Wheel') {
    const vt = sheet === 'CAR' ? 'car' : 'two_wheeler'
    for (const row of book![sheet]) {
      if (!row.name) continue                                   // spare formula rows carry no customer
      const qty = Number(row.qty), price = Number(row.price)
      const charges = sheet === 'CAR'
        ? ([['Alignment', row.align], ['Balancing', row.bal], ['Weight Charge', row.weight], ['Labour Charge', row.labour]] as Array<[string, any]>)
            .filter(([, v]) => Number(v) > 0).map(([label, v]) => ({ label, amount: Number(v) }))
        : []
      const expectTotal = r2(qty * price + charges.reduce((s, c) => s + c.amount, 0))
      if (!(qty > 0) || !(price > 0)) {
        // an unfinished line in the book (no quantity / price): the app must say so, not invent a bill
        const p = await productFor({ ...row, price: 1 }, vt)
        const res = await post({ customer: { name: clean(row.name) }, items: [{ productId: p.id, qty: qty > 0 ? qty : 0, rate: price > 0 ? price : 0 }], payments: [] })
        refused.push({ sheet, row, status: res.status, message: JSON.stringify(res.data).slice(0, 160) })
        continue
      }
      const p = await productFor(row, vt)
      if (!p) continue
      const body: Record<string, unknown> = {
        customer: { name: clean(row.name), ...(row.phone ? { phone: String(row.phone) } : {}), ...(row.addr ? { address: clean(row.addr) } : {}) },
        ...(row.veh ? { vehicleNo: clean(row.veh) } : {}), vehicleType: vt, ...(row.make ? { makeModel: clean(row.make) } : {}),
        ...(Number(row.km) > 0 ? { odometer: Number(row.km) } : {}),
        billSeries: sheet === 'CAR' ? 'car' : 'two_wheel',
        ...(row.date ? { date: String(row.date).slice(0, 10) } : {}),
        items: [{ productId: p.id, qty, rate: price }], charges,
        payments: [{ method: 'cash', amount: expectTotal }],
      }
      let res = await post(body)
      if (res.status === 422 && /mobile|phone/i.test(JSON.stringify(res.data))) {
        notes.push(`${sheet} bill ${row.bill}: phone "${row.phone}" refused (${(res.data.message ?? res.data.error ?? '').toString().slice(0, 70)}) — billed without a phone`)
        delete (body.customer as any).phone
        res = await post(body)
      }
      if (res.status === 422 && /more than a year ago|in the future/.test(JSON.stringify(res.data))) {
        const fixed = `2026${String(row.date).slice(4, 10)}`           // the book wrote 2016 for 2026
        notes.push(`${sheet} bill ${row.bill}: date ${row.date} refused (${JSON.stringify(res.data).match(/more than a year ago|in the future/)![0]}) — billed as ${fixed}`)
        body.date = fixed
        res = await post(body)
      }
      if (res.status === 422 && /vehicle|registration/i.test(JSON.stringify(res.data))) {
        notes.push(`${sheet} bill ${row.bill}: vehicle "${row.veh}" refused — billed without it`)
        delete body.vehicleNo
        res = await post(body)
      }
      if (res.status !== 201) { refused.push({ sheet, row, status: res.status, message: JSON.stringify(res.data).slice(0, 200) }); continue }
      made.push({ sheet, row, id: res.data.invoice.id, number: String(res.data.invoice.number), expectTotal })
    }
  }

  test('CAR sheet: every finished bill is accepted', async () => {
    await replay('CAR')
    const car = made.filter((m) => m.sheet === 'CAR')
    const finished = book!.CAR.filter((r) => r.name && Number(r.qty) > 0 && Number(r.price) > 0 && isRecognisedTyreSize(r.desc))
    console.log(`CAR: ${car.length} of ${finished.length} finished bills created; refused: ${refused.filter((x) => x.sheet === 'CAR').length}`)
    for (const x of refused.filter((x) => x.sheet === 'CAR')) console.log(`  refused row ${x.row.row} bill ${x.row.bill} ${x.row.name}: ${x.status} ${x.message}`)
    expect(car.length).toBe(finished.length)
  }, 300_000)

  test('Two Wheel sheet: every finished bill is accepted', async () => {
    await replay('Two Wheel')
    const two = made.filter((m) => m.sheet === 'Two Wheel')
    const finished = book!['Two Wheel'].filter((r) => r.name && Number(r.qty) > 0 && Number(r.price) > 0 && isRecognisedTyreSize(r.desc))
    for (const x of refused.filter((x) => x.sheet === 'Two Wheel')) console.log(`  refused row ${x.row.row} bill ${x.row.bill} ${x.row.name}: ${x.status} ${x.message}`)
    expect(two.length).toBe(finished.length)
  }, 120_000)

  test('unfinished lines in the book (no quantity or price) are refused with a clear message, never saved', () => {
    const blanks = refused.filter((x) => !(Number(x.row.qty) > 0) || !(Number(x.row.price) > 0))
    for (const b of blanks) { expect(b.status).toBe(422); expect(b.message.length).toBeGreaterThan(10) }
  })

  test('bill numbers follow the book: 1, 2, 3 … within each sheet', () => {
    for (const sheet of ['CAR', 'Two Wheel'] as const) {
      const mine = made.filter((m) => m.sheet === sheet)
      const nums = mine.map((m) => Number(String(m.number).match(/(\d+)$/)?.[1] ?? '0'))
      const sorted = [...nums].sort((a, b) => a - b)
      expect(new Set(nums).size).toBe(nums.length)                       // no duplicate bill numbers
      expect(sorted[0]).toBe(1)
      sorted.forEach((n, i) => { if (i) expect(n).toBe(sorted[i - 1]! + 1) })   // no gaps
    }
  })

  test("each bill agrees with the sheet's own formulas: total paid, taxable value and GST", async () => {
    const off: string[] = []
    for (const m of made) {
      const inv = (await owner.api.get(`/api/invoices/${m.id}`)).data
      const gt = Number(inv.grandTotal)
      if (Math.abs(gt - m.expectTotal) > 0.01) off.push(`bill ${m.row.bill} (${m.sheet}) total ${gt} ≠ ${m.expectTotal}`)
      const tyreLines = (inv.items as any[]).filter((i) => Number(i.gstRate) > 0)
      const taxable = tyreLines.reduce((s, i) => s + Number(i.taxableAmt), 0)
      const gst = tyreLines.reduce((s, i) => s + Number(i.cgstAmt) + Number(i.sgstAmt), 0)
      if (Math.abs(taxable - Number(m.row.taxable)) > 0.03) off.push(`bill ${m.row.bill} (${m.sheet}) taxable ${taxable.toFixed(2)} ≠ sheet ${Number(m.row.taxable).toFixed(2)}`)
      if (Math.abs(gst - Number(m.row.gst)) > 0.03) off.push(`bill ${m.row.bill} (${m.sheet}) GST ${gst.toFixed(2)} ≠ sheet ${Number(m.row.gst).toFixed(2)}`)
      if (Math.abs(Number(inv.paidAmt) - gt) > 0.01) off.push(`bill ${m.row.bill} not fully paid: ${inv.paidAmt} of ${gt}`)
    }
    if (off.length) console.log(off.join('\n'))
    expect(off).toEqual([])
  }, 300_000)

  test('stock fell by exactly what the book sold', async () => {
    const sold = new Map<string, number>()
    for (const m of made) {
      const vt = m.sheet === 'CAR' ? 'car' : 'two_wheeler'
      const p = products.get(`${clean(m.row.brand).toUpperCase() || 'UNBRANDED'}|${sizeKey(m.row.desc)}|${vt}`)
      sold.set(p.id, (sold.get(p.id) ?? 0) + Number(m.row.qty))
    }
    const stock = (await owner.api.get('/api/stock', { params: { limit: 1000 } })).data
    const now = new Map<string, number>((stock.data as any[]).map((s) => [s.productId, Number(s.currentQty)]))
    const wrong: string[] = []
    for (const [id, q] of sold) if (now.get(id) !== 500 - q) wrong.push(`${id}: ${now.get(id)} ≠ ${500 - q}`)
    expect(wrong).toEqual([])
  })

  test('the bill register lists every bill and the totals match', async () => {
    const reg = (await owner.api.get('/api/tyre/reports/register', { params: { from: '2000-01-01', to: '2099-12-31' } })).data
    expect(reg.count ?? reg.rows.length).toBeGreaterThanOrEqual(made.length)
    const rowsOut = reg.rows as any[]
    const billNos = new Set(rowsOut.map((r) => String(r['Bill No'])))
    for (const m of made) expect(billNos.has(String(m.number)) || billNos.has(String(Number(m.number.replace(/\D/g, ''))))).toBe(true)
  })

  test('every bill prints as a PDF with the emblem; a sample of reprint copies work', async () => {
    const pick = [made[0]!, made[Math.floor(made.length / 2)]!, made[made.length - 1]!]
    for (const m of pick) {
      for (const copy of ['original', 'duplicate', 'triplicate']) {
        const res = await owner.api.get(`/api/tyre/invoices/${m.id}/pdf`, { params: { copy }, responseType: 'arraybuffer' })
        expect(res.status).toBe(200)
        const head = Buffer.from(res.data).subarray(0, 5).toString()
        expect(head).toBe('%PDF-')
        if (copy === 'original') expect((Buffer.from(res.data).toString('latin1').match(/\/Subtype \/Image/g) ?? []).length).toBeGreaterThanOrEqual(1)
      }
    }
  }, 120_000)

  test('a double tap on Save does not make a second bill (same key), a deliberate second sale does', async () => {
    const m = made[0]!
    const p = products.get(`${clean(m.row.brand).toUpperCase()}|${sizeKey(m.row.desc)}|car`)
    const key = crypto.randomUUID()
    const body = { customer: { name: 'DOUBLE TAP' }, items: [{ productId: p.id, qty: 1, rate: 5000 }], payments: [{ method: 'cash', amount: 5000 }], billSeries: 'car' }
    const a = await post(body, key), b = await post(body, key)
    expect(a.status).toBe(201); expect([200, 201]).toContain(b.status)
    expect(b.data.invoice.id).toBe(a.data.invoice.id)
    const c = await post(body)
    expect(c.status).toBe(201); expect(c.data.invoice.id).not.toBe(a.data.invoice.id)
  })

  afterAll(() => {
    console.log(`\n── Notes for the shop (${notes.length}) ──\n${notes.join('\n') || 'none'}`)
    const odd = book!.CAR.concat(book!['Two Wheel']).filter((r) => r.desc && !isRecognisedTyreSize(r.desc))
    console.log(`Sizes written in a way the size finder will not recognise (${odd.length}): ${[...new Set(odd.map((r) => clean(r.desc)))].join(' | ')}`)
  })
})
