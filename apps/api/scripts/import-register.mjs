// Loads a shop's Excel bill register (CAR / TWO WHEEL sheets, Shakti Enterprise layout) as historic bills.
//
//   node scripts/import-register.mjs "<file.xlsx>" --phone 9200000001 --pin 1111 [--api http://localhost:3200] [--dry]
//
// Safe to re-run: bill numbers that already exist are skipped. Needs the owner or manager login.
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const require = createRequire(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../web/package.json'))
const XLSX = require('xlsx')

const args = process.argv.slice(2)
const file = args.find((a) => !a.startsWith('--') && /\.xlsx$/i.test(a))
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d }
const API = opt('api', 'http://localhost:3200')
const phone = opt('phone'), pin = opt('pin'), dry = args.includes('--dry')
if (!file || !phone || !pin) { console.error('usage: node import-register.mjs <file.xlsx> --phone <owner phone> --pin <pin> [--api url] [--dry]'); process.exit(1) }

const wb = XLSX.readFile(file, { cellDates: false })
const cell = (ws, ref) => { const c = ws[ref]; return c ? c.v : undefined }
const str = (v) => (v === undefined || v === null ? '' : String(v).trim())
const numOf = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
const isoDate = (v) => {
  if (typeof v === 'number') return new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10)
  const d = new Date(String(v)); return isNaN(d) ? null : d.toISOString().slice(0, 10)
}

// column letters per sheet (see the workbook audit)
const LAYOUT = {
  car:       { sheet: /^car$/i,        date: 'B', no: 'C', cust: 'D', mob: 'E', addr: 'F', make: 'G', veh: 'H', km: 'I', brand: 'J', size: 'K', qty: 'L', hsn: 'Z', price: 'Y',
               align: 'W', bal: 'X', weight: 'AA', labour: 'AB', gst: 'AC', vehicleType: 'car' },
  two_wheel: { sheet: /two\s*wheel/i, date: 'B', no: 'C', cust: 'D', mob: 'E', addr: 'F', make: 'G', veh: 'H', km: 'I', brand: 'J', size: 'K', qty: 'L', hsn: 'X', price: 'W',
               vehicleType: 'two_wheeler' },
}

const login = await (await fetch(API + '/api/auth/login', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ tenantPhone: phone, phone, pin }),
})).json()
if (!login.accessToken) { console.error('login failed:', JSON.stringify(login)); process.exit(1) }
const H = { authorization: 'Bearer ' + login.accessToken, 'content-type': 'application/json' }

// bill_series must exist in the shop settings or the import cannot number the bills
const branches = await (await fetch(API + '/api/branches', { headers: H })).json()
const branch = branches[0]
const cfg = branch.domainConfig ?? {}

for (const [series, L] of Object.entries(LAYOUT)) {
  const name = wb.SheetNames.find((n) => L.sheet.test(n.trim()))
  if (!name) { console.log(`[${series}] no sheet found — skipped`); continue }
  const ws = wb.Sheets[name]
  const range = XLSX.utils.decode_range(ws['!ref'])
  const rows = []
  const skippedRows = []
  for (let r = 5; r <= range.e.r + 1; r++) {
    const no = cell(ws, L.no + r), cust = str(cell(ws, L.cust + r)), qty = numOf(cell(ws, L.qty + r)), price = numOf(cell(ws, L.price + r))
    if (no === undefined || !cust) continue
    let date = isoDate(cell(ws, L.date + r))
    // a mistyped year (e.g. 2002) would file the bill in the wrong financial year — use the previous bill's date
    if (date && (date < '2020-01-01' || date > new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10)) && rows.length) {
      console.log(`   ! bill ${no}: date ${date} looks wrong, using ${rows[rows.length - 1].date} (previous bill)`)
      date = rows[rows.length - 1].date
    }
    const chargeSum = L.align ? numOf(cell(ws, L.align + r)) + numOf(cell(ws, L.bal + r)) + numOf(cell(ws, L.weight + r)) + numOf(cell(ws, L.labour + r)) : 0
    const hasTyre = qty > 0 && price > 0
    if (!date || (!hasTyre && chargeSum <= 0)) { skippedRows.push(`row ${r} (bill ${no}): no date, or neither a tyre price nor charges`); continue }
    const mob = str(cell(ws, L.mob + r)).replace(/\.0+$/, '')
    const veh = str(cell(ws, L.veh + r))
    const km = numOf(cell(ws, L.km + r))
    const hsn = str(cell(ws, L.hsn + r)).replace(/\.0+$/, '')
    const gstNo = str(cell(ws, L.gst + r))
    rows.push({
      date, billNo: String(no).replace(/\.0+$/, ''), customer: cust,
      mobile: mob && mob !== '0' ? mob : undefined,
      address: str(cell(ws, L.addr + r)) || undefined,
      vehicleMake: str(cell(ws, L.make + r)) || undefined,
      vehicleNo: veh && veh !== '0' ? veh : undefined,
      km: km > 0 ? Math.round(km) : undefined,
      brand: str(cell(ws, L.brand + r)) || undefined,
      size: str(cell(ws, L.size + r)) || undefined,
      hsn: hsn && hsn !== '0' ? hsn : undefined,
      qty: hasTyre ? qty : undefined, price: hasTyre ? price : undefined,
      charges: L.align ? {
        alignment: numOf(cell(ws, L.align + r)), balancing: numOf(cell(ws, L.bal + r)),
        weight: numOf(cell(ws, L.weight + r)), labour: numOf(cell(ws, L.labour + r)),
      } : undefined,
      gstNo: gstNo && gstNo !== '0' ? gstNo : undefined,
    })
  }
  console.log(`[${series}] sheet "${name}": ${rows.length} bills read${skippedRows.length ? `, ${skippedRows.length} unusable` : ''}`)
  skippedRows.forEach((s) => console.log('   -', s))
  if (!rows.length) continue
  if (!cfg.bill_series?.[series] && !dry) {
    console.log(`   Add the "${series}" register in My Business → Billing style first (start number), then re-run.`)
    continue
  }
  const res = await fetch(API + '/api/tyre/import/register', {
    method: 'POST', headers: H, body: JSON.stringify({ series, vehicleType: L.vehicleType, rows, dryRun: dry }),
  })
  const out = await res.json()
  if (!res.ok) { console.log('   FAILED:', JSON.stringify(out).slice(0, 400)); continue }
  console.log(`   ${dry ? 'would create' : 'created'} ${out.created}, already there ${out.skipped}, failed ${out.failed}`)
  out.problems.slice(0, 20).forEach((p) => console.log(`   - bill ${p.billNo}: ${p.error}`))
}
