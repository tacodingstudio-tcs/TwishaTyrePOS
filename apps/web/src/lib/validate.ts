// Field checks used by every form. One place, so "a mobile number" means the same thing on every screen.
// Each check returns an error message, or '' when the value is fine. An empty value is fine unless the field is required.
import { isValidGstin } from './gstin'

export type FieldKind = 'mobile' | 'gstin' | 'pan' | 'pincode' | 'ifsc' | 'hsn' | 'email' | 'pin' | 'vehicle'

/** "+91 98765-43210", "098765 43210" → "9876543210" (digits only, country/trunk prefix removed). */
export function normalizeMobile(raw: string): string {
  const d = String(raw ?? '').replace(/\D/g, '')
  if (d.length === 12 && d.startsWith('91')) return d.slice(2)
  if (d.length === 11 && d.startsWith('0')) return d.slice(1)
  return d
}

const RULES: Record<FieldKind, { label: string; test: (v: string) => boolean; hint: string }> = {
  mobile:  { label: 'Mobile number', hint: 'must be 10 digits, starting with 6, 7, 8 or 9', test: (v) => /^[6-9]\d{9}$/.test(normalizeMobile(v)) },
  gstin:   { label: 'GSTIN', hint: 'must be 15 characters like 24AABCR1234A1Z5 — check each one', test: (v) => isValidGstin(v) },
  pan:     { label: 'PAN', hint: 'must look like AAAAA9999A', test: (v) => /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(v.toUpperCase()) },
  pincode: { label: 'Pincode', hint: 'must be 6 digits', test: (v) => /^[1-9]\d{5}$/.test(v) },
  ifsc:    { label: 'IFSC', hint: 'must look like SBIN0001234', test: (v) => /^[A-Z]{4}0[A-Z0-9]{6}$/.test(v.toUpperCase()) },
  hsn:     { label: 'HSN / SAC', hint: 'must be 4 to 8 digits', test: (v) => /^\d{4,8}$/.test(v) },
  email:   { label: 'Email', hint: 'must look like name@example.com', test: (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) },
  pin:     { label: 'PIN', hint: 'must be exactly 4 digits', test: (v) => /^\d{4}$/.test(v) },
  vehicle: { label: 'Vehicle number', hint: 'looks wrong — use letters and digits only, like GJ05AB1234', test: (v) => /^[A-Z0-9]{4,12}$/.test(v.toUpperCase().replace(/[\s-]/g, '')) },
}

/** '' when fine; otherwise a short sentence for the user. */
export function check(kind: FieldKind, value: string | null | undefined, required = false): string {
  const v = String(value ?? '').trim()
  const r = RULES[kind]
  if (!v) return required ? `${r.label} is required` : ''
  return r.test(v) ? '' : `${r.label} ${r.hint}`
}

/** The first error among several `[kind, value, required?]` checks — handy for gating a Save button. */
export function firstError(...checks: Array<[FieldKind, string | null | undefined, boolean?]>): string {
  for (const [k, v, req] of checks) { const e = check(k, v, req ?? false); if (e) return e }
  return ''
}

/** What to keep while the person types: digits only for numbers, capitals for codes, a sensible length. */
export function sanitize(kind: FieldKind, raw: string): string {
  switch (kind) {
    case 'mobile':  return raw.replace(/[^\d+\s-]/g, '').slice(0, 14)
    case 'pincode': return raw.replace(/\D/g, '').slice(0, 6)
    case 'pin':     return raw.replace(/\D/g, '').slice(0, 4)
    case 'hsn':     return raw.replace(/\D/g, '').slice(0, 8)
    case 'gstin':   return raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 15)
    case 'pan':     return raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10)
    case 'ifsc':    return raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 11)
    case 'vehicle': return raw.toUpperCase().replace(/[^A-Z0-9 -]/g, '').slice(0, 14)
    case 'email':   return raw.trim().toLowerCase().slice(0, 150)
  }
}

const MODE: Partial<Record<FieldKind, 'numeric' | 'tel' | 'email' | 'text'>> = { mobile: 'tel', pincode: 'numeric', pin: 'numeric', hsn: 'numeric', email: 'email' }
export const inputModeFor = (k: FieldKind) => MODE[k] ?? 'text'
