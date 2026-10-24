// Field validators shared by every route, so a "mobile number" or a "GSTIN" is checked the same way everywhere.
// Blank is allowed on the optional variants (the screens send '' for an empty box); anything typed must be valid.
import { z } from 'zod'
import { isValidGstin } from './gstin.js'

/** "+91 98765-43210" / "098765 43210" → "9876543210" */
export function normalizeMobile(raw: string): string {
  const d = String(raw ?? '').replace(/\D/g, '')
  if (d.length === 12 && d.startsWith('91')) return d.slice(2)
  if (d.length === 11 && d.startsWith('0')) return d.slice(1)
  return d
}

const blankToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v)

/** 10-digit Indian mobile, stored in its plain 10-digit form. */
export const mobile = z.string().trim().transform(normalizeMobile)
  .pipe(z.string().regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit mobile number (starting with 6, 7, 8 or 9)'))
export const optionalMobile = z.preprocess(blankToUndefined, mobile.optional())
export const nullableMobile = z.preprocess((v) => (v === null ? null : blankToUndefined(v)), mobile.nullable().optional())

export const gstin = z.string().trim().toUpperCase().refine((v) => isValidGstin(v), 'GSTIN is not valid — it must be 15 characters; check each one')
export const nullableGstin = z.preprocess((x) => (x === null ? null : blankToUndefined(x)), gstin.nullable().optional())
export const optionalGstin = z.preprocess(blankToUndefined, gstin.optional())

export const pan = z.string().trim().toUpperCase().regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, 'PAN must look like AAAAA9999A')
export const optionalPan = z.preprocess(blankToUndefined, pan.optional())

export const pincode = z.string().trim().regex(/^[1-9]\d{5}$/, 'Pincode must be 6 digits')
export const optionalPincode = z.preprocess(blankToUndefined, pincode.optional())

export const ifsc = z.string().trim().toUpperCase().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'IFSC must look like SBIN0001234')
export const optionalIfsc = z.preprocess(blankToUndefined, ifsc.optional())

export const hsn = z.string().trim().regex(/^\d{4,8}$/, 'HSN / SAC must be 4 to 8 digits')
export const optionalHsn = z.preprocess(blankToUndefined, hsn.optional())

export const email = z.string().trim().toLowerCase().email('Enter a valid email address')
export const optionalEmail = z.preprocess(blankToUndefined, email.optional())

/** Percentages and money that must be sane numbers. */
export const percent = z.number().min(0, 'Cannot be below 0').max(100, 'Cannot be above 100')
export const money = z.number().min(0, 'Cannot be negative').max(1e9, 'That amount is too large')

/** YYYY-MM-DD that is a real calendar day — "2026-13-45" is refused and "2026-02-30" does not quietly become 2 March. */
export const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine((v) => { const d = new Date(`${v}T00:00:00Z`); return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v }, 'That date does not exist — check the day and month')
