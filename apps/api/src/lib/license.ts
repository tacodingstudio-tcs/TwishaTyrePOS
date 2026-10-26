// License check: the installed app only works on the PC its license was made for.
//
// A license is one line:  TWL1.<payload>.<signature>
//   payload   = JSON {v, product, shop, machine, issued, expires}, base64url
//   signature = Ed25519 over the payload text, made with the PRIVATE key that only the software owner has
// The app contains only the PUBLIC key, so it can check a license but nobody can make one. The license names one
// Machine ID (see machine-id.mjs); copied to another PC it fails with reason "machine".
//
// It only applies when LICENSE_REQUIRED=true (set by the packaged app's launcher). Development and the test suite
// run without it. Licenses are made with tools/license/make-license.mjs.

import { createPublicKey, verify } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { machineId } from './machine-id.mjs'

/** Ed25519 public key (SPKI, base64) matching E:\softwares\_license-keys\private.pem */
const LICENSE_PUBLIC_KEY = 'MCowBQYDK2VwAyEAskXRuQFD7FM/S7ntBqApc3EFoV/Wn9RHjdvvK00tHOg='
/** What this product is called inside a license — a license made for another product is refused. */
export const LICENSE_PRODUCT = 'tyre'

export type LicenseReason = 'missing' | 'invalid' | 'machine' | 'expired' | 'clock' | 'product'

export interface LicenseStatus {
  required: boolean
  valid: boolean
  reason?: LicenseReason
  machineId: string
  shop?: string
  expires?: string
  daysLeft?: number
}

interface Payload { v: number; product: string; shop: string; machine: string; issued: string; expires: string }

export const licenseRequired = (): boolean => process.env['LICENSE_REQUIRED'] === 'true'
const licenseFile = (): string => process.env['LICENSE_FILE'] || path.join(process.cwd(), 'license.lic')

const IST = 5.5 * 3600_000
const today = (): string => new Date(Date.now() + IST).toISOString().slice(0, 10)
const dayNumber = (ymd: string): number => Math.floor(Date.parse(`${ymd}T00:00:00Z`) / 86_400_000)

/** Checks a license text for THIS PC. Returns the payload, or the reason it is refused. */
export function checkLicense(text: string): { ok: true; payload: Payload } | { ok: false; reason: LicenseReason; payload?: Payload } {
  const parts = text.trim().split('.')
  if (parts.length !== 3 || parts[0] !== 'TWL1') return { ok: false, reason: 'invalid' }
  let payload: Payload
  try {
    const key = createPublicKey({ key: Buffer.from(LICENSE_PUBLIC_KEY, 'base64'), format: 'der', type: 'spki' })
    if (!verify(null, Buffer.from(parts[1]!), key, Buffer.from(parts[2]!, 'base64url'))) return { ok: false, reason: 'invalid' }
    payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Payload
  } catch { return { ok: false, reason: 'invalid' } }
  if (payload.v !== 1 || !payload.machine || !payload.expires) return { ok: false, reason: 'invalid' }
  if (payload.product !== LICENSE_PRODUCT) return { ok: false, reason: 'product', payload }
  if (payload.machine.toUpperCase() !== machineId()) return { ok: false, reason: 'machine', payload }
  if (payload.expires < today()) return { ok: false, reason: 'expired', payload }
  return { ok: true, payload }
}

/** The newest date this PC has seen: setting the clock back to stretch an expiring license is caught. */
function clockWentBack(): boolean {
  const seenFile = `${licenseFile()}.seen`
  let seen = ''
  try { seen = fs.readFileSync(seenFile, 'utf8').trim() } catch { /* first run */ }
  const now = today()
  if (/^\d{4}-\d{2}-\d{2}$/.test(seen) && dayNumber(seen) - dayNumber(now) > 1) return true
  if (!seen || seen < now) { try { fs.writeFileSync(seenFile, now) } catch { /* read-only folder: skip */ } }
  return false
}

let cache: { at: number; status: LicenseStatus } | null = null

export function licenseStatus(): LicenseStatus {
  const id = machineId()
  if (!licenseRequired()) return { required: false, valid: true, machineId: id }
  if (cache && Date.now() - cache.at < 20_000) return cache.status
  let status: LicenseStatus
  let text = ''
  try { text = fs.readFileSync(licenseFile(), 'utf8') } catch { /* none yet */ }
  if (!text.trim()) status = { required: true, valid: false, reason: 'missing', machineId: id }
  else {
    const r = checkLicense(text)
    if (!r.ok) status = { required: true, valid: false, reason: r.reason, machineId: id, ...(r.payload ? { shop: r.payload.shop, expires: r.payload.expires } : {}) }
    else if (clockWentBack()) status = { required: true, valid: false, reason: 'clock', machineId: id, shop: r.payload.shop, expires: r.payload.expires }
    else status = { required: true, valid: true, machineId: id, shop: r.payload.shop, expires: r.payload.expires, daysLeft: dayNumber(r.payload.expires) - dayNumber(today()) }
  }
  cache = { at: Date.now(), status }
  return status
}

/** Saves a pasted license if it is good for this PC. */
export function activateLicense(text: string): LicenseStatus {
  const r = checkLicense(text)
  if (!r.ok) { cache = null; return { required: licenseRequired(), valid: false, reason: r.reason, machineId: machineId(), ...(r.payload ? { shop: r.payload.shop, expires: r.payload.expires } : {}) } }
  const file = licenseFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(`${file}.tmp`, text.trim() + '\n')
  fs.renameSync(`${file}.tmp`, file)
  cache = null
  return licenseStatus()
}
