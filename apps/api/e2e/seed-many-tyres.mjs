// Local demo only: adds ~320 tyres of many sizes, brands and stock levels (names start "SZ-DEMO") so the size order can be seen on a big list.
//   node e2e/seed-many-tyres.mjs          add     |     node e2e/seed-many-tyres.mjs --remove    delete them again
const API = 'http://localhost:3200'
const login = await fetch(API + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone: '9200000001', pin: '1111', tenantPhone: '9200000001' }) }).then((r) => r.json())
const h = { 'content-type': 'application/json', authorization: `Bearer ${login.accessToken}` }
const call = (m, p, b) => fetch(API + p, { method: m, headers: { ...h, 'idempotency-key': crypto.randomUUID() }, body: b ? JSON.stringify(b) : undefined }).then(async (r) => ({ s: r.status, d: await r.json().catch(() => ({})) }))
if (process.argv.includes('--remove')) {
  const all = (await call('GET', '/api/products?limit=1000')).d.data ?? []
  let n = 0; for (const p of all.filter((x) => /^SZ-DEMO/.test(x.name))) { const r = await call('DELETE', `/api/products/${p.id}`); if (r.s < 300) n++ }
  console.log('removed', n); process.exit(0)
}
const brands = ['MRF', 'Apollo', 'CEAT', 'JK', 'Yokohama', 'Bridgestone', 'TVS', 'Michelin']
const car = []
for (const rim of [12, 13, 14, 15, 16, 17, 18, 19, 20]) for (const w of [135, 145, 155, 165, 175, 185, 195, 205, 215, 225, 235, 245]) for (const pr of [45, 50, 55, 60, 65, 70, 75, 80]) car.push([`${w}/${pr} R${rim}`, 'car'])
const bike = ['70/70-12', '80/100-17', '90/90-17', '100/90-17', '110/90-17', '120/80-18', '2.75-18', '3.00-17']
const truck = ['7.50 R16', '8.25 R16', '9.00 R20', '10.00 R20', '11.00 R20', '295/80 R22.5', '315/80 R22.5']
const pick = []
let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
for (const c of car) if (rnd() < 0.15) pick.push(c)
for (const b of bike) pick.push([b, 'two_wheeler']); for (const t of truck) pick.push([t, 'truck_bus'])
pick.sort(() => rnd() - 0.5)                       // shuffled, so the screen's order is the screen's own doing
let made = 0
for (const [size, vt] of pick) {
  const brand = brands[Math.floor(rnd() * brands.length)], price = 2500 + Math.floor(rnd() * 14000)
  const r = await call('POST', '/api/products', { itemType: 'product', gstRate: 18, unit: 'pcs', trackStock: true, name: `SZ-DEMO ${brand} ${size}`, sku: `SZD-${made}-${Date.now() % 100000}`,
    salePrice: price, purchasePrice: Math.round(price * 0.85), openingStock: rnd() < 0.3 ? 0 : 1 + Math.floor(rnd() * 12),
    domainAttrs: { item_kind: 'tyre', brand, pattern: 'Demo', size, vehicle_type: vt } })
  if (r.s < 300) made++
}
console.log('added', made, 'of', pick.length)
