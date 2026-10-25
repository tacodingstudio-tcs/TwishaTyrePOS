// Warranty register and claims, end to end as the shop uses them: a sale with serial numbers creates the warranty,
// the counter looks it up, a customer comes back with a defective tyre, the claim is recorded once, and what
// follows (voiding, resale of the serial, vehicle history) stays consistent.

import { newShopTenant, testPhone, addStaff, type Session } from './helpers'

const ymd = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10)
let n = 0
const serial = (p: string) => `${p}${Date.now().toString(36).toUpperCase()}${++n}`

describe('Warranty and claims', () => {
  let owner: Session, cashier: Session, viewer: Session, tyre: any, other: any
  const sale = (b: Record<string, unknown>) => owner.api.post('/api/tyre/sales', b, { headers: { 'Idempotency-Key': crypto.randomUUID() } })
  const list = async (params: Record<string, unknown>) => (await owner.api.get('/api/tyre/warranty', { params })).data
  const mkSale = async (serials: string[], opts: Record<string, unknown> = {}, months = 24) => {
    const r = await sale({
      customer: { name: 'Warranty Customer', phone: testPhone() }, vehicleNo: 'GJ05WA1234', vehicleType: 'car',
      items: [{ productId: tyre.id, qty: serials.length, serialNos: serials, warrantyMonths: months }],
      payments: [{ method: 'cash', amount: 5900 * serials.length }], ...opts,
    })
    expect(r.status).toBe(201)
    return r.data as { invoice: any; warranty: any[] }
  }

  beforeAll(async () => {
    owner = await newShopTenant('Warranty Flow Tyres')
    cashier = await addStaff(owner, 'cashier')
    viewer = await addStaff(owner, 'viewer')
    tyre = (await owner.api.post('/api/products', {
      itemType: 'product', gstRate: 18, unit: 'pcs', trackStock: true, name: 'MRF 185/65 R15', sku: 'W1', salePrice: 5000, purchasePrice: 3500, openingStock: 200,
      domainAttrs: { item_kind: 'tyre', brand: 'MRF', size: '185/65 R15', vehicle_type: 'car', warranty_months: 24 },
    })).data
    other = await newShopTenant('Other Warranty Tyres')
  }, 60_000)

  describe('created at the sale', () => {
    test('one row per tyre, with the serial, the end date and the customer / vehicle', async () => {
      const [a, b] = [serial('WA'), serial('WB')]
      const r = await mkSale([a, b])
      expect(r.warranty).toHaveLength(2)
      expect(r.warranty.map((w) => w.serialNo).sort()).toEqual([a, b].sort())
      for (const w of r.warranty) {
        expect(w.status).toBe('active'); expect(w.warrantyMonths).toBe(24)
        expect(String(w.warrantyUntil).slice(0, 10)).toBe(String(new Date(new Date().setFullYear(new Date().getFullYear() + 2)).toISOString().slice(0, 10)).replace(/^(\d{4})-02-29$/, '$1-02-28'))
        expect(w.customerName).toBe('Warranty Customer'); expect(w.vehicleNo).toBe('GJ05WA1234'); expect(w.invoiceNo).toBe(r.invoice.number)
      }
    })
    test('a warranty never runs longer than it says: 31 Aug + 6 months ends 28 Feb, not 3 March', async () => {
      // pick a recent 31st (within the one-year back-date window)
      const d = new Date(); let found = ''
      for (let i = 0; i < 12 && !found; i++) { const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 31)); if (t.getUTCDate() === 31 && t.getTime() < Date.now()) found = t.toISOString().slice(0, 10) }
      expect(found).not.toBe('')
      const r = await mkSale([serial('WM')], { date: found }, 1)
      const until = String(r.warranty[0].warrantyUntil).slice(0, 10)
      const [y, m] = found.split('-').map(Number) as [number, number]
      const lastOfNext = new Date(Date.UTC(y, m + 1, 0)).toISOString().slice(0, 10)       // last day of the month after the sale
      expect(until).toBe(lastOfNext)
    })
    test('no warranty months and no serial: nothing is registered; serial with 0 months is registered "as per maker" (no end date)', async () => {
      const none = await sale({ customer: { name: 'No Reg' }, items: [{ productId: tyre.id, qty: 1, warrantyMonths: 0 }], payments: [{ method: 'cash', amount: 5900 }] })
      expect(none.data.warranty).toHaveLength(0)
      const s = serial('WZ')
      const maker = await mkSale([s], {}, 0)
      expect(maker.warranty[0].warrantyUntil).toBeNull()
      expect((await list({ serial: s })).data[0].expired).toBe(false)
    })
    test('warranty months without serial numbers still registers one row per tyre', async () => {
      const r = await sale({ customer: { name: 'No Serial' }, items: [{ productId: tyre.id, qty: 3, warrantyMonths: 12 }], payments: [{ method: 'cash', amount: 5900 * 3 }] })
      expect(r.data.warranty).toHaveLength(3)
      expect(r.data.warranty.every((w: any) => w.serialNo === null)).toBe(true)
    })
  })

  describe('look-ups at the counter', () => {
    let s1: string, phone: string, billNo: string
    beforeAll(async () => {
      s1 = serial('LK'); phone = testPhone()
      const r = await mkSale([s1], { customer: { name: 'Look Up Lal', phone }, vehicleNo: 'GJ 01-LK 7777' })
      billNo = r.invoice.number
    })
    test('by serial (part of it, any case), vehicle number (any spelling), mobile, bill number and customer name', async () => {
      expect((await list({ serial: s1.toLowerCase() })).total).toBe(1)
      expect((await list({ serial: s1.slice(0, 5) })).total).toBeGreaterThanOrEqual(1)
      expect((await list({ vehicleNo: 'gj01lk7777' })).total).toBeGreaterThanOrEqual(1)
      expect((await list({ vehicleNo: 'GJ 01-LK 7777' })).total).toBeGreaterThanOrEqual(1)
      expect((await list({ phone })).total).toBe(1)
      expect((await list({ invoiceNo: billNo })).total).toBeGreaterThanOrEqual(1)
      expect((await list({ search: 'look up' })).total).toBe(1)
      expect((await list({ search: 'no-such-thing-xyz' })).total).toBe(0)
    })
    test('status filters and "ending soon": a warranty that ends in 10 days shows for 30 days but not for 5', async () => {
      const soon = serial('SN')
      await mkSale([soon], { date: ymd(-172) }, 6)                                          // sold 172 days ago, 6 months → ends in ~10 days
      const w = (await list({ serial: soon })).data[0]
      const days = Math.round((new Date(String(w.warrantyUntil).slice(0, 10)).getTime() - Date.now()) / 86_400_000)
      expect(days).toBeGreaterThan(0); expect(days).toBeLessThan(15)
      expect((await list({ expiringDays: 30, serial: soon })).total).toBe(1)
      expect((await list({ expiringDays: 1, serial: soon })).total).toBe(0)
      expect((await list({ status: 'active', serial: soon })).total).toBe(1)
      expect((await list({ status: 'claimed', serial: soon })).total).toBe(0)
    })
    test('a running-out warranty is flagged "expired" once its end date has passed', async () => {
      const old = serial('OL')
      await mkSale([old], { date: ymd(-300) }, 6)                                           // 6 months from 300 days ago: ended ~120 days ago
      expect((await list({ serial: old })).data[0].expired).toBe(true)
    })
    test('every list answers a hostile or empty search without error', async () => {
      for (const q of ['%', "'; DROP TABLE tyre_warranty; --", '😀', '   ', 'a'.repeat(60)]) {
        const r = await owner.api.get('/api/tyre/warranty', { params: { search: q } })
        expect([q, r.status]).toEqual([q, 200])
      }
      expect((await owner.api.get('/api/tyre/warranty', { params: { search: 'x'.repeat(61) } })).status).toBe(422)
    })
    test('another business sees none of it', async () => {
      expect((await other.api.get('/api/tyre/warranty', { params: { serial: s1 } })).data.total).toBe(0)
    })
  })

  describe('a claim', () => {
    const rowOf = async (s: string) => (await list({ serial: s, status: 'any' })).data[0]
    test('each outcome is recorded with notes, amount and time; the row becomes "claimed" and leaves the in-warranty list', async () => {
      for (const outcome of ['replaced', 'prorata', 'repaired', 'rejected']) {
        const s = serial('CL'); await mkSale([s])
        const w = await rowOf(s)
        const r = await owner.api.post(`/api/tyre/warranty/${w.id}/claim`, { outcome, notes: `Customer says ${outcome}`, claimAmount: 1250.5 })
        expect([outcome, r.status]).toEqual([outcome, 200])
        const after = await rowOf(s)
        expect(after.status).toBe('claimed'); expect(after.claimOutcome).toBe(outcome)
        expect(Number(after.claimAmount)).toBe(1250.5); expect(after.claimedAt).toBeTruthy()
        expect((await list({ serial: s, status: 'active' })).total).toBe(0)
      }
    })
    test('bad input is refused with a plain message: unknown outcome, notes too short, negative or absurd amount, no body', async () => {
      const s = serial('BD'); await mkSale([s]); const w = await rowOf(s)
      const post = (b: unknown) => owner.api.post(`/api/tyre/warranty/${w.id}/claim`, b as any)
      expect((await post({ outcome: 'refund', notes: 'valid notes' })).status).toBe(422)
      expect((await post({ outcome: 'repaired', notes: 'ab' })).status).toBe(422)
      expect((await post({ outcome: 'repaired', notes: 'valid notes', claimAmount: -5 })).status).toBe(422)
      expect((await post({ outcome: 'repaired', notes: 'valid notes', claimAmount: 1e9 })).status).toBe(422)
      expect((await post({})).status).toBe(422)
      expect((await rowOf(s)).status).toBe('active')                                         // none of those changed anything
      expect((await owner.api.post('/api/tyre/warranty/not-a-uuid/claim', { outcome: 'repaired', notes: 'valid notes' })).status).toBe(422)
      expect((await owner.api.post('/api/tyre/warranty/00000000-0000-4000-8000-000000000000/claim', { outcome: 'repaired', notes: 'valid notes' })).status).toBe(404)
    })
    test('a second claim on the same tyre is refused; two taps at the same moment record exactly one', async () => {
      const s = serial('RC'); await mkSale([s]); const w = await rowOf(s)
      const body = { outcome: 'replaced', notes: 'double tap on the claim button' }
      const [a, b] = await Promise.all([owner.api.post(`/api/tyre/warranty/${w.id}/claim`, body), owner.api.post(`/api/tyre/warranty/${w.id}/claim`, body)])
      expect([a.status, b.status].sort()).toEqual([200, 409])
      expect((await owner.api.post(`/api/tyre/warranty/${w.id}/claim`, body)).status).toBe(409)
    })
    test('counter staff can record a claim; a viewer cannot; another business cannot', async () => {
      const s = serial('RL'); await mkSale([s]); const w = await rowOf(s)
      expect((await viewer.api.post(`/api/tyre/warranty/${w.id}/claim`, { outcome: 'repaired', notes: 'viewer try' })).status).toBe(403)
      expect((await other.api.post(`/api/tyre/warranty/${w.id}/claim`, { outcome: 'repaired', notes: 'other shop try' })).status).toBe(404)
      expect((await cashier.api.post(`/api/tyre/warranty/${w.id}/claim`, { outcome: 'repaired', notes: 'cashier records it' })).status).toBe(200)
    })
    test('after the warranty ended only a rejection can be recorded', async () => {
      const s = serial('XP'); await mkSale([s], { date: ymd(-300) }, 6); const w = await rowOf(s)
      expect(w.expired).toBe(true)
      expect((await owner.api.post(`/api/tyre/warranty/${w.id}/claim`, { outcome: 'replaced', notes: 'too late to replace' })).status).toBe(422)
      expect((await owner.api.post(`/api/tyre/warranty/${w.id}/claim`, { outcome: 'rejected', notes: 'out of warranty by months' })).status).toBe(200)
    })
    test('on the last day of the warranty a claim is still honoured', async () => {
      const s = serial('LD')
      // a 1-month warranty sold exactly one month ago today ends today
      const d = new Date(); d.setUTCMonth(d.getUTCMonth() - 1)
      if (d.getUTCDate() !== new Date().getUTCDate()) return                                 // month lengths differ today: skip rather than guess
      await mkSale([s], { date: d.toISOString().slice(0, 10) }, 1)
      const w = await rowOf(s)
      expect(String(w.warrantyUntil).slice(0, 10)).toBe(ymd(0))
      expect((await owner.api.post(`/api/tyre/warranty/${w.id}/claim`, { outcome: 'replaced', notes: 'claim on the last day' })).status).toBe(200)
    })
  })

  describe('after a claim or a void', () => {
    test('a claim does not free the serial (the tyre is still the customer\'s on record); a void does', async () => {
      const s = serial('FR'); await mkSale([s]); const w = (await list({ serial: s })).data[0]
      await owner.api.post(`/api/tyre/warranty/${w.id}/claim`, { outcome: 'repaired', notes: 'patched and balanced' })
      const again = await sale({ customer: { name: 'Same Serial' }, items: [{ productId: tyre.id, qty: 1, serialNos: [s] }], payments: [{ method: 'cash', amount: 5900 }] })
      expect(again.status).toBe(409)
      expect((await owner.api.post(`/api/tyre/warranty/${w.id}/void`, { reason: 'record was wrong' })).status).toBe(200)
      const resold = await sale({ customer: { name: 'Same Serial' }, items: [{ productId: tyre.id, qty: 1, serialNos: [s] }], payments: [{ method: 'cash', amount: 5900 }] })
      expect(resold.status).toBe(201)
    })
    test('voiding needs a reason and a manager; a void shows only under the Void filter and keeps the history note', async () => {
      const s = serial('VD'); await mkSale([s]); const w = (await list({ serial: s })).data[0]
      expect((await cashier.api.post(`/api/tyre/warranty/${w.id}/void`, { reason: 'cashier try' })).status).toBe(403)
      expect((await owner.api.post(`/api/tyre/warranty/${w.id}/void`, { reason: '' })).status).toBe(422)
      expect((await owner.api.post(`/api/tyre/warranty/${w.id}/void`, { reason: 'tyre returned to supplier' })).status).toBe(200)
      expect((await list({ serial: s })).total).toBe(0)
      const v = (await list({ serial: s, status: 'void' })).data[0]
      expect(v.claimNotes).toMatch(/Voided: tyre returned to supplier/)
      expect((await owner.api.post(`/api/tyre/warranty/${w.id}/void`, { reason: 'again' })).status).toBe(422)
    })
    test('the vehicle page lists the warranty on its tyres', async () => {
      const s = serial('VH'); const reg = 'GJ05VH4321'
      await mkSale([s], { vehicleNo: reg })
      const id = (await owner.api.get('/api/tyre/vehicles/lookup', { params: { regNo: reg } })).data.vehicle.id
      const detail = (await owner.api.get(`/api/tyre/vehicles/${id}`)).data
      expect((detail.warranty as any[]).some((w) => w.serialNo === s)).toBe(true)
    })
    test('the bill PDF carries a warranty card page for the tyres sold', async () => {
      const r = await mkSale([serial('PD')])
      const pdf = await owner.api.get(`/api/tyre/invoices/${r.invoice.id}/pdf`, { responseType: 'arraybuffer' })
      expect(pdf.status).toBe(200)
      expect((Buffer.from(pdf.data).toString('latin1').match(/\/Type \/Page\b/g) ?? []).length).toBeGreaterThanOrEqual(2)
    })
  })

  // ── claim follow-up, replacements, corrections, edits, report ──────────────────────────────────────────────────
  describe('follow-up with the tyre company', () => {
    const rowOf = async (s: string) => (await list({ serial: s, status: 'any' })).data[0]
    test('a claim can be sent to the company as "waiting", with their reference, and decided later', async () => {
      const s = serial('PN'); await mkSale([s]); const w = await rowOf(s)
      const c = await owner.api.post(`/api/tyre/warranty/${w.id}/claim`, { outcome: 'pending', notes: 'Sent to the MRF depot with the tyre', claimRef: 'MRF-CL-2231' })
      expect(c.status).toBe(200); expect(c.data.claimOutcome).toBe('pending'); expect(c.data.claimRef).toBe('MRF-CL-2231'); expect(c.data.claimSettledAt).toBeNull()
      expect((await list({ serial: s, status: 'pending' })).total).toBe(1)
      expect((await list({ serial: s, status: 'claimed' })).total).toBe(1)
      expect((await owner.api.post(`/api/tyre/warranty/${w.id}/claim`, { outcome: 'repaired', notes: 'second try' })).status).toBe(409)   // still one claim per tyre
      const done = await owner.api.patch(`/api/tyre/warranty/${w.id}/claim`, { outcome: 'prorata', claimAmount: 2100, notes: 'MRF approved 60% credit' })
      expect(done.status).toBe(200); expect(done.data.claimOutcome).toBe('prorata'); expect(Number(done.data.claimAmount)).toBe(2100); expect(done.data.claimSettledAt).toBeTruthy()
      expect(done.data.claimRef).toBe('MRF-CL-2231')                                         // untouched fields stay
      expect((await list({ serial: s, status: 'pending' })).total).toBe(0)
      const h = (await rowOf(s)).claimHistory as any[]
      expect(h.map((x) => x.kind)).toEqual(['claim', 'update'])
      expect(h[1].before.outcome).toBe('pending'); expect(h[1].after.outcome).toBe('prorata')
    })
    test('only an owner or manager can correct a claim; staff and viewers cannot; the amount can be cleared', async () => {
      const s = serial('PC'); await mkSale([s]); const w = await rowOf(s)
      await owner.api.post(`/api/tyre/warranty/${w.id}/claim`, { outcome: 'repaired', notes: 'Patched at the shop', claimAmount: 300 })
      expect((await cashier.api.patch(`/api/tyre/warranty/${w.id}/claim`, { notes: 'cashier edit' })).status).toBe(403)
      expect((await viewer.api.patch(`/api/tyre/warranty/${w.id}/claim`, { notes: 'viewer edit' })).status).toBe(403)
      expect((await other.api.patch(`/api/tyre/warranty/${w.id}/claim`, { notes: 'other shop edit' })).status).toBe(404)
      const r = await owner.api.patch(`/api/tyre/warranty/${w.id}/claim`, { claimAmount: null, notes: 'Patched, no charge' })
      expect(r.status).toBe(200); expect(r.data.claimAmount).toBeNull(); expect(r.data.claimNotes).toBe('Patched, no charge')
      expect((await owner.api.patch(`/api/tyre/warranty/${w.id}/claim`, {})).status).toBe(422)
      expect((await owner.api.patch(`/api/tyre/warranty/${w.id}/claim`, { outcome: 'refund' })).status).toBe(422)
    })
    test('a claim cannot be corrected before it exists, or after the record was voided', async () => {
      const s = serial('PE'); await mkSale([s]); const w = await rowOf(s)
      expect((await owner.api.patch(`/api/tyre/warranty/${w.id}/claim`, { notes: 'no claim yet' })).status).toBe(409)
      await owner.api.post(`/api/tyre/warranty/${w.id}/void`, { reason: 'entered by mistake' })
      expect((await owner.api.patch(`/api/tyre/warranty/${w.id}/claim`, { notes: 'void record' })).status).toBe(409)
    })
  })

  describe('a replacement tyre from stock', () => {
    let rep: any
    const stockOf = async (id: string) => Number(((await owner.api.get('/api/stock', { params: { limit: 500 } })).data.data as any[]).find((x) => x.productId === id)?.currentQty)
    const rowOf = async (s: string) => (await list({ serial: s, status: 'any' })).data[0]
    beforeAll(async () => {
      rep = (await owner.api.post('/api/products', {
        itemType: 'product', gstRate: 18, unit: 'pcs', trackStock: true, name: 'MRF 195/65 R15 (replacement stock)', sku: 'W2', salePrice: 5200, purchasePrice: 3600, openingStock: 5,
        domainAttrs: { item_kind: 'tyre', brand: 'MRF', size: '195/65 R15', vehicle_type: 'car', warranty_months: 24 },
      })).data
    })
    test('"replaced" with a tyre from stock: stock drops by one, the new tyre gets its own warranty (same end date), both rows point at each other', async () => {
      const s = serial('RP'); await mkSale([s]); const w = await rowOf(s)
      const before = await stockOf(rep.id)
      const ns = serial('NEW')
      const c = await owner.api.post(`/api/tyre/warranty/${w.id}/claim`, { outcome: 'replaced', notes: 'Bulge — replaced from stock', replacement: { productId: rep.id, serialNo: ns, dotCode: '1225' } })
      expect(c.status).toBe(200); expect(c.data.warnings).toEqual([])
      expect(await stockOf(rep.id)).toBe(before - 1)
      const repl = c.data.replacement
      expect(repl.serialNo).toBe(ns); expect(repl.status).toBe('active'); expect(repl.dotCode).toBe('1225')
      expect(String(repl.warrantyUntil).slice(0, 10)).toBe(String(w.warrantyUntil).slice(0, 10))   // the new tyre keeps what was left
      expect(repl.customerName).toBe(w.customerName); expect(repl.vehicleNo).toBe(w.vehicleNo)
      const after = await rowOf(s)
      expect(after.replacementSerial).toBe(ns)
      expect((await rowOf(ns)).replacesSerial).toBe(s)
      expect((await list({ serial: ns, status: 'active' })).total).toBe(1)                              // the replacement can be claimed in turn
    })
    test('nothing in stock → the claim is refused and NOTHING changes (the warranty stays active, stock untouched)', async () => {
      const empty = (await owner.api.post('/api/products', {
        itemType: 'product', gstRate: 18, unit: 'pcs', trackStock: true, name: 'Out of stock tyre', sku: 'W3', salePrice: 5000, purchasePrice: 3500, openingStock: 0,
        domainAttrs: { item_kind: 'tyre', brand: 'MRF', size: '205/55 R16', vehicle_type: 'car' },
      })).data
      const s = serial('RN'); await mkSale([s]); const w = await rowOf(s)
      const r = await owner.api.post(`/api/tyre/warranty/${w.id}/claim`, { outcome: 'replaced', notes: 'No tyre to give', replacement: { productId: empty.id } })
      expect(r.status).toBe(409); expect(JSON.stringify(r.data)).toMatch(/none in stock/)
      expect((await rowOf(s)).status).toBe('active')
      expect(await stockOf(empty.id)).toBe(0)
    })
    test('a serial that is already registered, a service, an unknown product, or a non-"replaced" outcome is refused with nothing changed', async () => {
      const s = serial('RS'); await mkSale([s]); const w = await rowOf(s)
      const stock0 = await stockOf(rep.id)
      const dup = serial('DUP'); await mkSale([dup])
      const clash = await owner.api.post(`/api/tyre/warranty/${w.id}/claim`, { outcome: 'replaced', notes: 'serial clash', replacement: { productId: tyre.id, serialNo: dup } })
      expect(clash.status).toBe(409); expect(JSON.stringify(clash.data)).toMatch(/already registered/)
      const svc = (await owner.api.get('/api/tyre/finder', { params: { kind: 'service', limit: 1 } })).data.data[0]
      expect((await owner.api.post(`/api/tyre/warranty/${w.id}/claim`, { outcome: 'replaced', notes: 'a service?', replacement: { productId: svc.id } })).status).toBe(422)
      expect((await owner.api.post(`/api/tyre/warranty/${w.id}/claim`, { outcome: 'replaced', notes: 'unknown item', replacement: { productId: '00000000-0000-4000-8000-000000000000' } })).status).toBe(404)
      expect((await owner.api.post(`/api/tyre/warranty/${w.id}/claim`, { outcome: 'repaired', notes: 'repair with replacement?', replacement: { productId: rep.id } })).status).toBe(422)
      expect((await owner.api.post(`/api/tyre/warranty/${w.id}/claim`, { outcome: 'replaced', notes: 'bad dot', replacement: { productId: rep.id, dotCode: '99' } })).status).toBe(422)
      expect((await rowOf(s)).status).toBe('active'); expect(await stockOf(rep.id)).toBe(stock0)
    })
    test('"replaced" without a replacement works but warns that stock was not changed; the tyre can be handed over later, once', async () => {
      const s = serial('RW'); await mkSale([s]); const w = await rowOf(s)
      const stock0 = await stockOf(rep.id)
      const c = await owner.api.post(`/api/tyre/warranty/${w.id}/claim`, { outcome: 'replaced', notes: 'company will send one' })
      expect(c.status).toBe(200); expect(c.data.warnings.join(' ')).toMatch(/stock was not changed/); expect(await stockOf(rep.id)).toBe(stock0)
      const later = await owner.api.patch(`/api/tyre/warranty/${w.id}/claim`, { replacement: { productId: rep.id, serialNo: serial('LATE') } })
      expect(later.status).toBe(200); expect(later.data.replacement.status).toBe('active'); expect(await stockOf(rep.id)).toBe(stock0 - 1)
      const twice = await owner.api.patch(`/api/tyre/warranty/${w.id}/claim`, { replacement: { productId: rep.id, serialNo: serial('TWICE') } })
      expect(twice.status).toBe(409); expect(await stockOf(rep.id)).toBe(stock0 - 1)
    })
    test('once a replacement was handed over the claim cannot be turned into something else (stock would be wrong)', async () => {
      const s = serial('RX'); await mkSale([s]); const w = await rowOf(s)
      await owner.api.post(`/api/tyre/warranty/${w.id}/claim`, { outcome: 'replaced', notes: 'replaced in store', replacement: { productId: rep.id, serialNo: serial('RXN') } })
      const r = await owner.api.patch(`/api/tyre/warranty/${w.id}/claim`, { outcome: 'repaired' })
      expect(r.status).toBe(422); expect(JSON.stringify(r.data)).toMatch(/replacement/)
      expect((await owner.api.patch(`/api/tyre/warranty/${w.id}/claim`, { notes: 'Notes can still be corrected' })).status).toBe(200)
    })
    test('two counters giving away the LAST tyre at once: exactly one wins, stock never goes below zero', async () => {
      const last = (await owner.api.post('/api/products', {
        itemType: 'product', gstRate: 18, unit: 'pcs', trackStock: true, name: 'Last one tyre', sku: 'W4', salePrice: 5000, purchasePrice: 3500, openingStock: 1,
        domainAttrs: { item_kind: 'tyre', brand: 'MRF', size: '215/60 R16', vehicle_type: 'car' },
      })).data
      const [s1, s2] = [serial('LA'), serial('LB')]
      await mkSale([s1]); await mkSale([s2])
      const [w1, w2] = [await rowOf(s1), await rowOf(s2)]
      const go = (w: any, n: string) => owner.api.post(`/api/tyre/warranty/${w.id}/claim`, { outcome: 'replaced', notes: 'last tyre race', replacement: { productId: last.id, serialNo: n } })
      const [a, b] = await Promise.all([go(w1, serial('X1')), go(w2, serial('X2'))])
      expect([a.status, b.status].sort()).toEqual([200, 409])
      expect(await stockOf(last.id)).toBe(0)
      expect([(await rowOf(s1)).status, (await rowOf(s2)).status].sort()).toEqual(['active', 'claimed'])   // the loser was rolled back whole
    })
  })

  describe('correcting the details on a record', () => {
    const rowOf = async (s: string) => (await list({ serial: s, status: 'any' })).data[0]
    test('a manager fixes the customer, mobile, vehicle, serial and DOT; each change is kept in the history', async () => {
      const s = serial('ED'); await mkSale([s]); const w = await rowOf(s)
      const ns = serial('ED2')
      const r = await owner.api.patch(`/api/tyre/warranty/${w.id}`, { customerName: 'Corrected Name', customerPhone: '98250 12345', vehicleNo: 'gj-05 xy 4321', serialNo: ns, dotCode: '3325' })
      expect(r.status).toBe(200)
      expect(r.data.customerName).toBe('Corrected Name'); expect(r.data.customerPhone).toBe('9825012345'); expect(r.data.vehicleNo).toBe('GJ05XY4321')
      expect(r.data.serialNo).toBe(ns); expect(r.data.dotCode).toBe('3325')
      expect((await list({ vehicleNo: 'gj05xy4321' })).total).toBeGreaterThanOrEqual(1)
      const h = (await rowOf(ns)).claimHistory as any[]
      expect(h[h.length - 1].kind).toBe('edit'); expect(h[h.length - 1].before.customerName).toBe('Warranty Customer')
      expect((await owner.api.patch(`/api/tyre/warranty/${w.id}`, { customerPhone: '' })).data.customerPhone).toBeNull()   // clearing a wrong number
    })
    test('staff and viewers cannot edit; a bad mobile, DOT or empty change is refused; a serial that already exists is refused; a voided record cannot be edited', async () => {
      const s = serial('EE'); await mkSale([s]); const w = await rowOf(s)
      expect((await cashier.api.patch(`/api/tyre/warranty/${w.id}`, { customerName: 'x' })).status).toBe(403)
      expect((await viewer.api.patch(`/api/tyre/warranty/${w.id}`, { customerName: 'x' })).status).toBe(403)
      expect((await other.api.patch(`/api/tyre/warranty/${w.id}`, { customerName: 'x' })).status).toBe(404)
      expect((await owner.api.patch(`/api/tyre/warranty/${w.id}`, { customerPhone: '12345' })).status).toBe(422)
      expect((await owner.api.patch(`/api/tyre/warranty/${w.id}`, { dotCode: '12' })).status).toBe(422)
      expect((await owner.api.patch(`/api/tyre/warranty/${w.id}`, {})).status).toBe(422)
      const taken = serial('TK'); await mkSale([taken])
      expect((await owner.api.patch(`/api/tyre/warranty/${w.id}`, { serialNo: taken })).status).toBe(409)
      expect((await rowOf(s)).serialNo).toBe(s)
      await owner.api.post(`/api/tyre/warranty/${w.id}/void`, { reason: 'wrong entry' })
      expect((await owner.api.patch(`/api/tyre/warranty/${w.id}`, { customerName: 'late edit' })).status).toBe(422)
    })
  })

  describe('claims report', () => {
    test('totals, outcomes, brands, months and the claims still waiting — for owner / manager only', async () => {
      const shop = await newShopTenant('Claims Report Tyres')
      const p = (await shop.api.post('/api/products', {
        itemType: 'product', gstRate: 18, unit: 'pcs', trackStock: true, name: 'Apollo 185/65 R15', sku: 'R1', salePrice: 5000, purchasePrice: 3500, openingStock: 50,
        domainAttrs: { item_kind: 'tyre', brand: 'Apollo', size: '185/65 R15', vehicle_type: 'car', warranty_months: 24 },
      })).data
      const mk = async (n: number) => {
        const sr = Array.from({ length: n }, () => serial('RPT'))
        await shop.api.post('/api/tyre/sales', { customer: { name: 'Report Customer', phone: testPhone() }, items: [{ productId: p.id, qty: n, serialNos: sr }], payments: [{ method: 'cash', amount: 5900 * n }] }, { headers: { 'Idempotency-Key': crypto.randomUUID() } })
        return (await shop.api.get('/api/tyre/warranty', { params: { limit: 100 } })).data.data.filter((w: any) => sr.includes(w.serialNo)) as any[]
      }
      const ws = await mk(4)
      const claim = (w: any, b: Record<string, unknown>) => shop.api.post(`/api/tyre/warranty/${w.id}/claim`, b)
      expect((await claim(ws[0], { outcome: 'repaired', notes: 'patched', claimAmount: 400 })).status).toBe(200)
      expect((await claim(ws[1], { outcome: 'prorata', notes: 'credit given', claimAmount: 1600 })).status).toBe(200)
      expect((await claim(ws[2], { outcome: 'rejected', notes: 'road damage' })).status).toBe(200)
      expect((await claim(ws[3], { outcome: 'pending', notes: 'sent to Apollo', claimRef: 'AP-77' })).status).toBe(200)
      const rep = (await shop.api.get('/api/tyre/reports/claims')).data
      expect(rep.totals.claims).toBe(4); expect(rep.totals.amount).toBe(2000); expect(rep.totals.pending).toBe(1)
      expect(Object.fromEntries(rep.byOutcome.map((o: any) => [o.outcome, o.claims]))).toEqual({ repaired: 1, prorata: 1, rejected: 1, pending: 1 })
      expect(rep.byBrand).toEqual([expect.objectContaining({ brand: 'Apollo', claims: 4, amount: 2000, rejected: 1 })])
      expect(rep.byMonth).toHaveLength(1)
      expect(rep.rows).toHaveLength(4)
      expect(rep.pendingNow).toEqual([expect.objectContaining({ claimRef: 'AP-77', waitingDays: 0 })])
      expect((await shop.api.get('/api/tyre/reports/claims', { params: { from: '2020-01-01', to: '2020-12-31' } })).data.totals.claims).toBe(0)
      expect((await shop.api.get('/api/tyre/reports/claims', { params: { from: '2026-13-01' } })).status).toBe(422)
      const dash = (await shop.api.get('/api/tyre/dashboard')).data
      expect(dash.warranty.pendingClaims).toBe(1)
      const staff = await addStaff(shop, 'cashier'), view = await addStaff(shop, 'viewer')
      expect((await staff.api.get('/api/tyre/reports/claims')).status).toBe(403)
      expect((await view.api.get('/api/tyre/reports/claims')).status).toBe(403)
    })
  })
})
