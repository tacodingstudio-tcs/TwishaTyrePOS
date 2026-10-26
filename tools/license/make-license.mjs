// Makes a license file for ONE shop on ONE PC.
//   node tools/license/make-license.mjs --key E:\softwares\_license-keys\private.pem --shop "Shakti Enterprise" --machine XXXXX-XXXXX-XXXXX-XXXXX --days 365 [--product tyre] [--out shakti.lic]
// The customer's Machine ID is shown on the app's first screen; they send it to you; you send back the .lic file.
import { createPrivateKey, sign } from 'node:crypto'
import fs from 'node:fs'

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d }
const key = arg('key'), shop = arg('shop'), machine = (arg('machine') ?? '').toUpperCase().trim(), days = Number(arg('days', '365'))
const product = arg('product', 'tyre')
if (!key || !shop || !machine) { console.error('Needs --key <private.pem> --shop "<shop name>" --machine <Machine ID> [--days 365 | --expires YYYY-MM-DD] [--product tyre|buildmaterials] [--out file.lic]'); process.exit(2) }
if (!/^[0-9A-F]{5}(-[0-9A-F]{5}){3}$/.test(machine)) { console.error('That does not look like a Machine ID (expected XXXXX-XXXXX-XXXXX-XXXXX).'); process.exit(2) }
if (!(days > 0 && days <= 3660)) { console.error('--days must be between 1 and 3660'); process.exit(2) }

const today = new Date()
const until = arg('expires')                                  // a fixed last day, e.g. --expires 2027-11-01 (valid through that day)
if (until && !/^\d{4}-\d{2}-\d{2}$/.test(until)) { console.error('--expires must look like 2027-11-01'); process.exit(2) }
const expires = until ? new Date(`${until}T00:00:00Z`) : new Date(today.getTime() + days * 86_400_000)
const iso = (d) => d.toISOString().slice(0, 10)
const payload = { v: 1, product, shop, machine, issued: iso(today), expires: iso(expires) }
const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
const sig = sign(null, Buffer.from(body), createPrivateKey(fs.readFileSync(key))).toString('base64url')
const license = `TWL1.${body}.${sig}`
const out = arg('out', `${shop.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()}.lic`)
fs.writeFileSync(out, license + '\n')
console.log(`License for "${shop}" on ${machine}, valid until ${payload.expires} → ${out}`)
