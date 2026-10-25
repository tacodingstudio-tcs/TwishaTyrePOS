// apps/api/scripts/seed-demo.ts
// =============================================================================
// Seeds a realistic demo tyre shop by driving the *real HTTP API*:
//   register tenant → login → suppliers → tyre catalogue with opening stock → customers →
//   counter sales (cash / UPI / credit / exchange, serials, vehicles) → a payment → a warranty claim.
// It doubles as an end-to-end smoke test of the whole tyre flow.
//
//   pnpm --filter @billing/api seed          (API must be running on API_URL)
//
// Idempotent: if the demo tenant already has tyres, it does nothing.
// Demo logins:  owner 9200000001 / 1111  ·  manager 9200000011 / 2222  ·  viewer 9200000012 / 3333
// =============================================================================

const API = process.env['API_URL'] ?? `http://localhost:${process.env['PORT'] ?? 3200}`

// ── tiny HTTP client ─────────────────────────────────────────────────────────
let token = ''
async function call<T = any>(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...extraHeaders,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  const data = text ? JSON.parse(text) : null
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 400)}`)
  return data as T
}
const get  = <T = any>(p: string) => call<T>('GET', p)
const post = <T = any>(p: string, b?: unknown, h?: Record<string, string>) => call<T>('POST', p, b ?? {}, h)

// ── deterministic helpers ────────────────────────────────────────────────────
let seed = 20261013
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296 }
const pick = <T,>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)]!
const between = (lo: number, hi: number) => Math.round(lo + rnd() * (hi - lo))

const IST = 5.5 * 3600_000
const day = (offset: number) => new Date(Date.now() + IST + offset * 86_400_000).toISOString().slice(0, 10)

/** Valid GSTIN (state + PAN + entity + Z + mod-36 checksum) so it passes the registration validator. */
function gstin(state: string, pan: string): string {
  const base = `${state}${pan}1Z`
  const CH = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  let sum = 0
  for (let i = 0; i < 14; i++) { const m = CH.indexOf(base[i]!) * (i % 2 === 0 ? 1 : 2); sum += Math.floor(m / 36) + (m % 36) }
  return base + CH[(36 - (sum % 36)) % 36]
}

const log = (m: string) => console.log(`  ${m}`)
let serialN = 0
const serial = (brand: string) => `${brand.slice(0, 3).toUpperCase()}${String(20260000 + ++serialN)}`

// ── catalogue ────────────────────────────────────────────────────────────────
interface Tyre { name: string; sku: string; brand: string; pattern: string; size: string; vt: string; mrp: number; cost: number; price: number; stock: number; warranty: number; tubeless?: boolean }
const TYRES: Tyre[] = [
  { name: 'MRF ZVTV 185/65 R15',         sku: 'MRF-ZVTV-185-65-15', brand: 'MRF',      pattern: 'ZVTV',           size: '185/65 R15', vt: 'car', mrp: 4650, cost: 3750, price: 4300, stock: 16, warranty: 12, tubeless: true },
  { name: 'MRF ZLX 195/55 R16',          sku: 'MRF-ZLX-195-55-16',  brand: 'MRF',      pattern: 'ZLX',            size: '195/55 R16', vt: 'car', mrp: 6200, cost: 5100, price: 5750, stock: 8,  warranty: 12, tubeless: true },
  { name: 'Apollo Amazer 4G 185/65 R15', sku: 'APL-AMZ-185-65-15',  brand: 'Apollo',   pattern: 'Amazer 4G Life', size: '185/65 R15', vt: 'car', mrp: 4400, cost: 3500, price: 4000, stock: 12, warranty: 0,  tubeless: true },
  { name: 'Apollo Alnac 205/65 R16',     sku: 'APL-ALN-205-65-16',  brand: 'Apollo',   pattern: 'Alnac 4G',       size: '205/65 R16', vt: 'suv', mrp: 7400, cost: 6000, price: 6800, stock: 6,  warranty: 0,  tubeless: true },
  { name: 'CEAT Milaze 165/80 R14',      sku: 'CEAT-MIL-165-80-14', brand: 'CEAT',     pattern: 'Milaze',         size: '165/80 R14', vt: 'car', mrp: 3300, cost: 2650, price: 3050, stock: 10, warranty: 0,  tubeless: true },
  { name: 'CEAT Securadrive 205/55 R16', sku: 'CEAT-SEC-205-55-16', brand: 'CEAT',     pattern: 'SecuraDrive',    size: '205/55 R16', vt: 'car', mrp: 6900, cost: 5600, price: 6350, stock: 5,  warranty: 0,  tubeless: true },
  { name: 'JK UX Royale 205/55 R16',     sku: 'JK-UXR-205-55-16',   brand: 'JK',       pattern: 'UX Royale',      size: '205/55 R16', vt: 'car', mrp: 6700, cost: 5500, price: 6200, stock: 4,  warranty: 12, tubeless: true },
  { name: 'Michelin Energy XM2 195/65 R15', sku: 'MIC-XM2-195-65-15', brand: 'Michelin', pattern: 'Energy XM2+',   size: '195/65 R15', vt: 'car', mrp: 7800, cost: 6500, price: 7400, stock: 3,  warranty: 24, tubeless: true },
  { name: 'MRF Meteor 90/90-17',         sku: 'MRF-MET-90-90-17',   brand: 'MRF',      pattern: 'Meteor',         size: '90/90-17',   vt: 'two_wheeler', mrp: 2150, cost: 1700, price: 1950, stock: 14, warranty: 0 },
  { name: 'TVS Eurogrip 100/90-17',      sku: 'TVS-EUR-100-90-17',  brand: 'TVS',      pattern: 'Eurogrip',       size: '100/90-17',  vt: 'two_wheeler', mrp: 2500, cost: 2000, price: 2300, stock: 9,  warranty: 0, tubeless: true },
  { name: 'Apollo Amar 10.00 R20',       sku: 'APL-AMR-1000-20',    brand: 'Apollo',   pattern: 'Amar',           size: '10.00 R20',  vt: 'truck_bus', mrp: 21500, cost: 17500, price: 19900, stock: 6, warranty: 0 },
  { name: 'JK Jetway 295/80 R22.5',      sku: 'JK-JET-295-80-22',   brand: 'JK',       pattern: 'Jetway JUH5',    size: '295/80 R22.5', vt: 'truck_bus', mrp: 29800, cost: 24500, price: 27500, stock: 4, warranty: 0, tubeless: true },
  { name: 'CEAT Farmax 13.6-28',         sku: 'CEAT-FAR-136-28',    brand: 'CEAT',     pattern: 'Farmax R',       size: '13.6 R28',    vt: 'tractor', mrp: 24500, cost: 20000, price: 22800, stock: 2, warranty: 0 },
]

async function main() {
  console.log(`Seeding tyre-shop demo against ${API}`)

  // ── 1. tenant + login ──────────────────────────────────────────────────────
  const OWNER = { phone: '9200000001', pin: '1111' }
  const exists = await fetch(`${API}/api/tenants/check-phone/${OWNER.phone}`).then((r) => r.json()).catch(() => null)
  if (!exists || exists.available !== false) {
    await post('/api/tenants/register', {
      businessName: 'Shakti Enterprise', ownerName: 'Yogesh Mori',
      phone: OWNER.phone, pin: OWNER.pin, city: 'Surat', stateCode: '24', lang: 'en',
      gstin: gstin('24', 'AAFPS4321K'), domainType: 'tyre',
    })
    log('registered tenant "Shakti Enterprise"')
  }
  const login = await post('/api/auth/login', { tenantPhone: OWNER.phone, phone: OWNER.phone, pin: OWNER.pin })
  token = login.accessToken

  const present = await get<any>('/api/tyre/finder?kind=tyre&limit=1')
  const hasSales = ((await get<any>('/api/invoices?limit=1')).data ?? []).length > 0
  if (hasSales) { console.log('Demo data already present — nothing to do.'); return }   // a half-finished run (no sales yet) resumes below

  // staff
  for (const u of [
    { name: 'Suresh (manager)', phone: '9200000011', pin: '2222', role: 'manager' },
    { name: 'Viewer', phone: '9200000012', pin: '3333', role: 'viewer' },
  ]) {
    try { await post('/api/users', u) } catch { /* already there */ }
  }
  log('staff: manager 9200000011/2222, viewer 9200000012/3333')

  // ── 2. suppliers ───────────────────────────────────────────────────────────
  for (const s of [
    { name: 'MRF Ltd — Surat Depot', phone: '9825000101' },
    { name: 'Apollo Tyres Distributor', phone: '9825000102' },
    { name: 'CEAT Authorised Dealer', phone: '9825000103' },
  ]) {
    const have = ((await get<any>('/api/parties?type=supplier&limit=100')).data ?? []).some((x: any) => x.phone === s.phone)
    if (!have) await post('/api/parties', { type: 'supplier', ...s, address: { city: 'Surat', state: 'Gujarat', stateCode: '24' } })
  }
  log('3 suppliers')

  // ── 3. catalogue with opening stock ────────────────────────────────────────
  const created: Array<{ t: Tyre; id: string }> = []
  const bySku = new Map<string, string>(((await get<any>('/api/products?limit=500')).data ?? []).map((x: any) => [x.sku, x.id]))
  for (const t of TYRES) {
    if (bySku.has(t.sku)) { created.push({ t, id: bySku.get(t.sku)! }); continue }
    const p = await post('/api/products', {
      itemType: 'product', name: t.name, sku: t.sku, unit: 'pcs', gstRate: 18,
      salePrice: t.price, mrp: t.mrp, purchasePrice: t.cost, lowStockQty: 3, trackStock: true,
      openingStock: t.stock, openingRate: t.cost,
      domainAttrs: {
        item_kind: 'tyre', brand: t.brand, pattern: t.pattern, size: t.size, vehicle_type: t.vt,
        tube_type: t.tubeless ? 'tubeless' : 'tube', warranty_months: t.warranty,
      },
    })
    created.push({ t, id: p.id })
  }
  const tube = bySku.has('TUBE-400-8') ? { id: bySku.get('TUBE-400-8')! } : await post('/api/products', {
    itemType: 'product', name: 'Tube 4.00-8 (scooter)', sku: 'TUBE-400-8', unit: 'pcs', gstRate: 18,
    salePrice: 380, mrp: 420, purchasePrice: 290, lowStockQty: 5, openingStock: 25, openingRate: 290,
    domainAttrs: { item_kind: 'tube', brand: 'MRF', size: '4.00-10', vehicle_type: 'two_wheeler' },
  })
  log(`${created.length} tyres + 1 tube with opening stock`)

  const services = (await get<any>('/api/tyre/finder?kind=service&limit=30')).data as any[]
  const svc = (sku: string) => services.find((s) => s.sku === sku)!

  // ── 4. customers ───────────────────────────────────────────────────────────
  const NAMES = ['Ramesh Patel', 'Kiran Desai', 'Hardik Mehta', 'Nilesh Shah', 'Priya Joshi', 'Amit Trivedi', 'Sanjay Modi', 'Pooja Parekh']
  const customers = NAMES.map((n, i) => ({ name: n, phone: `98250${String(20000 + i * 137).slice(-5)}` }))
  const REGS = ['GJ05AB1234', 'GJ05CD4521', 'GJ05EF7788', 'GJ01HK3030', 'GJ05MN1199', 'GJ06PQ5566', 'GJ05RS9090', 'GJ05TU2468']

  // ── 5. sales over the last two weeks ───────────────────────────────────────
  const carTyres = created.filter((c) => c.t.vt === 'car' || c.t.vt === 'suv')
  let sold = 0
  for (let d = 14; d >= 0; d--) {
    const n = between(1, 3)
    for (let k = 0; k < n; k++) {
      const ci = between(0, customers.length - 1)
      const c = customers[ci]!
      const choice = rnd()
      const items: any[] = []
      let totalApprox = 0
      if (choice < 0.7) {
        const tyre = pick(carTyres)
        const qty = pick([1, 2, 4, 4])
        items.push({
          productId: tyre.id, qty,
          serialNos: Array.from({ length: qty }, () => serial(tyre.t.brand)),
          dotCodes: [pick(['2325', '3225', '1025', '4524'])],
          positions: qty === 4 ? ['FL', 'FR', 'RL', 'RR'] : [],
        })
        items.push({ productId: svc('SVC-FIT').id, qty })
        items.push({ productId: svc('SVC-BAL').id, qty })
        if (qty === 4) items.push({ productId: svc('SVC-ALN').id, qty: 1 })
        totalApprox = (tyre.t.price * qty + svc('SVC-FIT').salePrice * qty + svc('SVC-BAL').salePrice * qty + (qty === 4 ? svc('SVC-ALN').salePrice : 0)) * 1.18
      } else if (choice < 0.85) {
        items.push({ productId: svc('SVC-PNC').id, qty: 1 })
        totalApprox = svc('SVC-PNC').salePrice * 1.18
      } else {
        items.push({ productId: tube.id, qty: 1 }, { productId: svc('SVC-FIT').id, qty: 1 })
        totalApprox = (380 + svc('SVC-FIT').salePrice) * 1.18
      }
      const total = Math.round(totalApprox)
      const useCredit = rnd() < 0.18 && total > 3000
      const body: any = {
        date: day(-d), customer: c, vehicleNo: REGS[ci], vehicleType: 'car', odometer: between(15000, 90000),
        fittedBy: pick(['Raju', 'Bablu', 'Imran']), items,
        payments: useCredit ? [{ method: 'upi', amount: Math.round(total * 0.4) }] : [{ method: pick(['cash', 'upi', 'card']), amount: total }],
        creditDays: useCredit ? 15 : undefined,
      }
      try {
        const r = await post('/api/tyre/sales', body, { 'Idempotency-Key': `seed-${d}-${k}-${sold}` })
        sold++
        if (sold === 1) log(`first bill ${r.invoice.number}`)
      } catch (e) {
        // an item may run short of stock late in the loop — skip rather than fail the whole seed
        const m = String((e as Error).message)
        if (!m.includes('in stock') && !m.includes('Payments are more') && !m.includes('credit')) throw e
      }
    }
  }
  log(`${sold} counter sales over 15 days`)

  // ── 6. an exchange sale ────────────────────────────────────────────────────
  const fitTyre = created.find((c) => c.t.sku === 'MRF-ZVTV-185-65-15')!
  const ex = await post('/api/tyre/sales', {
    customer: { name: 'Rakesh Exchange', phone: '9825099001' }, vehicleNo: 'GJ05XX0001', vehicleType: 'car', odometer: 61000,
    items: [{ productId: fitTyre.id, qty: 2, serialNos: [serial('MRF'), serial('MRF')], dotCodes: ['4025'] }, { productId: svc('SVC-FIT').id, qty: 2 }],
    exchange: { qty: 2, value: 1400, note: 'Old MRF 185/65 R15, worn' },
    payments: [{ method: 'cash', amount: 8400 }],
  })
  log(`exchange bill ${ex.invoice.number} (2 old tyres taken in)`)

  // ── 7. a payment against a credit bill + a warranty claim ──────────────────
  const unpaid = await get<any>('/api/invoices?status=partial&limit=1')
  const first = (unpaid.data ?? unpaid.items ?? [])[0]
  if (first) {
    const due = Number(first.grandTotal) - Number(first.paidAmt)
    await post(`/api/invoices/${first.id}/payment`, { amount: Math.round(due / 2), method: 'upi' }, { 'Idempotency-Key': crypto.randomUUID() })
    log(`part-payment on ${first.number}`)
  }
  const w = (await get<any>('/api/tyre/warranty?status=active&limit=1')).data[0]
  if (w) {
    await post(`/api/tyre/warranty/${w.id}/claim`, { outcome: 'prorata', notes: 'Premature wear, 60% tread — pro-rata adjustment given', claimAmount: 900 })
    log(`warranty claim on ${w.serialNo}`)
  }

  console.log('\nDone. Log in:  owner 9200000001 / 1111   manager 9200000011 / 2222   viewer 9200000012 / 3333')
}

main().catch((e) => { console.error('\nSeed failed:', e.message); process.exit(1) })
