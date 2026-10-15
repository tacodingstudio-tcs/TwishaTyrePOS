// Sale-creation latency and behaviour under a burst of parallel counters.
//   node scripts/bench-write.mjs [--phone 9300000009] [--pin 2468] [--seq 25] [--par 10] [--rounds 4]
const args = process.argv.slice(2)
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d }
const API = opt('api', 'http://localhost:3200'), PHONE = opt('phone', '9300000009'), PIN = opt('pin', '2468')
const SEQ = Number(opt('seq', '25')), PAR = Number(opt('par', '10')), ROUNDS = Number(opt('rounds', '4'))
const login = await (await fetch(API + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tenantPhone: PHONE, phone: PHONE, pin: PIN }) })).json()
const H = { authorization: 'Bearer ' + login.accessToken, 'content-type': 'application/json' }
const tyres = (await (await fetch(API + '/api/tyre/finder?kind=tyre&limit=100&inStock=true', { headers: H })).json()).data
const pct = (a, p) => a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p / 100))]
let n = 0
const sale = async () => {
  const t = tyres[(n++ * 7) % tyres.length]
  const t0 = performance.now()
  const r = await fetch(API + '/api/tyre/sales', { method: 'POST', headers: { ...H, 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify({ customer: { name: 'Bench ' + n, phone: '98' + String(10000000 + n).slice(-8) }, vehicleNo: 'GJ09BN' + String(1000 + n),
      items: [{ productId: t.id, qty: 1, finalPrice: Number(t.salePrice) }], payments: [{ method: 'cash', amount: Math.round(Number(t.salePrice)) }] }) })
  const ms = performance.now() - t0
  const d = await r.json().catch(() => ({}))
  return { s: r.status, ms, err: r.status >= 400 ? JSON.stringify(d).slice(0, 90) : null }
}
const stats = (label, rs) => {
  const ok = rs.filter((x) => x.s === 201), t = ok.map((x) => x.ms)
  const codes = rs.reduce((m, x) => ((m[x.s] = (m[x.s] ?? 0) + 1), m), {})
  console.log(`${label.padEnd(22)} n=${rs.length} ok=${ok.length}  p50=${pct(t, 50)?.toFixed(0)}ms  p95=${pct(t, 95)?.toFixed(0)}ms  max=${Math.max(...t).toFixed(0)}ms  codes=${JSON.stringify(codes)}`)
  rs.filter((x) => x.err).slice(0, 3).forEach((x) => console.log('   !', x.s, x.err))
}
await sale() // warm-up
const seq = []; for (let i = 0; i < SEQ; i++) seq.push(await sale())
stats('sequential (1 counter)', seq)
const par = []
const t0 = performance.now()
for (let r = 0; r < ROUNDS; r++) par.push(...(await Promise.all(Array.from({ length: PAR }, sale))))
const wall = (performance.now() - t0) / 1000
stats(`${PAR} counters at once`, par)
console.log(`throughput under burst: ${(par.length / wall).toFixed(1)} bills/s`)
