// Reads one or more copies of a shop's Excel bill book (CAR / TWO WHEEL sheets, Shakti Enterprise layout), checks them, keeps every bill once
// and writes the clean rows the installed app imports (IMPORT-BILL-BOOK.bat). Prints what it found: repeated numbers, bills that differ between
// copies, number gaps, customers whose spelling / mobile differs, unusable rows. Nothing is sent anywhere.
//
//   node scripts/prepare-bill-book.mjs --out ../../deploy/offline/import-data "F:/Shakti Tryres/GST BILL FOR CAR.xlsx" "F:/Shakti Tryres/Shakti Bill Book.xlsx"
//
// Copies are read in the order given; when two copies have the same bill number the first copy's row is kept (and a difference is reported).
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const require = createRequire(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../web/package.json'))
const XLSX = require('xlsx')

const args = process.argv.slice(2)
const files = args.filter((a) => /\.xlsx$/i.test(a))
const outDir = args.includes('--out') ? args[args.indexOf('--out') + 1] : null
if (!files.length) { console.error('usage: node prepare-bill-book.mjs [--out <folder>] <file.xlsx> [<more copies>]'); process.exit(1) }

const cell = (ws, ref) => { const c = ws[ref]; return c ? c.v : undefined }
const str = (v) => (v === undefined || v === null ? '' : String(v).trim())
const numOf = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
const isoDate = (v) => {
  if (typeof v === 'number') return new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10)
  const d = new Date(String(v)); return isNaN(d) ? null : d.toISOString().slice(0, 10)
}
const LAYOUT = {
  car:       { sheet: /^car$/i,        date: 'B', no: 'C', cust: 'D', mob: 'E', addr: 'F', make: 'G', veh: 'H', km: 'I', brand: 'J', size: 'K', qty: 'L', hsn: 'Z', price: 'Y',
               align: 'W', bal: 'X', weight: 'AA', labour: 'AB', gst: 'AC', vehicleType: 'car' },
  two_wheel: { sheet: /two\s*wheel/i, date: 'B', no: 'C', cust: 'D', mob: 'E', addr: 'F', make: 'G', veh: 'H', km: 'I', brand: 'J', size: 'K', qty: 'L', hsn: 'X', price: 'W',
               vehicleType: 'two_wheeler' },
}

function readSheet(wb, L, label, notes) {
  const name = wb.SheetNames.find((n) => L.sheet.test(n.trim()))
  if (!name) return []
  const ws = wb.Sheets[name]
  const range = XLSX.utils.decode_range(ws['!ref'])
  const rows = []
  for (let r = 5; r <= range.e.r + 1; r++) {
    const no = cell(ws, L.no + r), cust = str(cell(ws, L.cust + r)), qty = numOf(cell(ws, L.qty + r)), price = numOf(cell(ws, L.price + r))
    if (no === undefined || !cust) continue
    let date = isoDate(cell(ws, L.date + r))
    if (date && (date < '2020-01-01' || date > new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10)) && rows.length) {
      notes.push(`${label}: bill ${no} has the date ${date}; filed under ${rows[rows.length - 1].date} (the previous bill's date). CHECK`)
      date = rows[rows.length - 1].date
    }
    const chargeSum = L.align ? numOf(cell(ws, L.align + r)) + numOf(cell(ws, L.bal + r)) + numOf(cell(ws, L.weight + r)) + numOf(cell(ws, L.labour + r)) : 0
    const hasTyre = qty > 0 && price > 0
    if (!date || (!hasTyre && chargeSum <= 0)) { notes.push(`${label}: row ${r} (bill ${no}) skipped: no date, or neither a tyre price nor charges`); continue }
    const mob = str(cell(ws, L.mob + r)).replace(/\.0+$/, '')
    const veh = str(cell(ws, L.veh + r)), km = numOf(cell(ws, L.km + r)), hsn = str(cell(ws, L.hsn + r)).replace(/\.0+$/, ''), gstNo = str(cell(ws, L.gst + r))
    rows.push({
      date, billNo: String(no).replace(/\.0+$/, ''), customer: cust.replace(/\s+/g, ' '),
      mobile: mob && mob !== '0' ? mob : undefined,
      address: str(cell(ws, L.addr + r)) || undefined,
      vehicleMake: str(cell(ws, L.make + r)) || undefined,
      vehicleNo: veh && veh !== '0' ? veh : undefined,
      km: km > 0 ? Math.round(km) : undefined,
      brand: str(cell(ws, L.brand + r)) || undefined,
      size: str(cell(ws, L.size + r)) || undefined,
      hsn: hsn && hsn !== '0' ? hsn : undefined,
      qty: hasTyre ? qty : undefined, price: hasTyre ? price : undefined,
      charges: L.align ? { alignment: numOf(cell(ws, L.align + r)), balancing: numOf(cell(ws, L.bal + r)), weight: numOf(cell(ws, L.weight + r)), labour: numOf(cell(ws, L.labour + r)) } : undefined,
      gstNo: gstNo && gstNo !== '0' ? gstNo : undefined,
    })
  }
  return rows
}

const round2 = (v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v)
const same = (a, b) => ['date', 'customer', 'size', 'qty', 'price'].every((k) => String(round2(a[k])) === String(round2(b[k])))
const report = []
const result = {}
for (const [series, L] of Object.entries(LAYOUT)) {
  const kept = new Map()
  for (const f of files) {
    const wb = XLSX.readFile(f, { cellDates: false })
    const label = `${path.basename(f)} / ${series}`
    const notes = []
    const rows = readSheet(wb, L, label, notes)
    report.push(...notes.map((n) => '  ! ' + n))
    const seenHere = new Set()
    for (const r of rows) {
      if (seenHere.has(r.billNo)) { report.push(`  ! ${label}: bill ${r.billNo} appears twice in this file; the first is kept`); continue }
      seenHere.add(r.billNo)
      const have = kept.get(r.billNo)
      if (!have) kept.set(r.billNo, { ...r, _from: path.basename(f) })
      else if (!same(have, r)) report.push(`  ! ${series} bill ${r.billNo}: ${have._from} says ${have.date} ${have.customer} ${have.size} x${have.qty}; ${path.basename(f)} says ${r.date} ${r.customer} ${r.size} x${r.qty}. Kept the first.`)
    }
    report.push(`  ${label}: ${rows.length} bills read`)
  }
  const list = [...kept.values()].sort((a, b) => (Number(a.billNo) || 0) - (Number(b.billNo) || 0))
  const nums = list.map((r) => Number(r.billNo)).filter(Number.isFinite)
  const gaps = []; for (let n = nums[0]; n <= nums[nums.length - 1]; n++) if (!nums.includes(n)) gaps.push(n)
  report.push(`  [${series}] ${list.length} bills in all, numbers ${nums[0]} to ${nums[nums.length - 1]}; ${gaps.length ? `missing numbers (not in any copy): ${gaps.join(', ')}` : 'no gaps'}`)
  // customers: the importer matches by a valid 10-digit mobile, else by exact name
  const byMob = new Map(), byName = new Map()
  for (const r of list) {
    const m = (r.mobile ?? '').replace(/\D/g, '').replace(/^91(\d{10})$/, '$1'); const n = r.customer.toUpperCase()
    if (!/^[6-9]\d{9}$/.test(m)) { report.push(`  ? [${series}] bill ${r.billNo} ${r.customer}: mobile "${r.mobile ?? ''}" is not a valid 10-digit number; the customer is matched by name only`); continue }
    byMob.set(m, new Set([...(byMob.get(m) ?? []), n])); byName.set(n, new Set([...(byName.get(n) ?? []), m]))
  }
  for (const [m, s] of byMob) if (s.size > 1) report.push(`  ? [${series}] mobile ${m} is used with different names: ${[...s].join('  /  ')}  (one customer record will be made, under the first name)`)
  for (const [n, s] of byName) if (s.size > 1) report.push(`  ? [${series}] ${n} appears with different mobiles: ${[...s].join(', ')}  (two customer records will be made)`)
  result[series] = { series, vehicleType: L.vehicleType, rows: list.map(({ _from, ...r }) => r) }
}
console.log(report.join('\n'))
if (outDir) {
  fs.mkdirSync(outDir, { recursive: true })
  for (const [series, body] of Object.entries(result)) fs.writeFileSync(path.join(outDir, `${series}.json`), JSON.stringify(body))
  console.log(`\nwritten to ${path.resolve(outDir)}: ${Object.keys(result).map((s) => `${s}.json (${result[s].rows.length} bills)`).join(', ')}`)
}
