// Shared formatting + status vocabulary for the tyre-shop screens.

export const inr = (n: number | string | null | undefined, decimals = 0): string => {
  const v = Number(n ?? 0)
  const body = Math.abs(v).toLocaleString('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
  return `${v < 0 ? '-' : ''}₹${body}`
}

export const num = (n: number | string | null | undefined, decimals = 0): string =>
  Number(n ?? 0).toLocaleString('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })

/** API date (UTC-midnight for DATE columns) → "09 Oct 2026". Formatted in UTC so the day never shifts. */
export function fmtDate(v: string | Date | null | undefined): string {
  if (!v) return '—'
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' })
}

export function fmtDateTime(v: string | Date | null | undefined): string {
  if (!v) return '—'
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
}

/** Today as YYYY-MM-DD in IST regardless of the browser's timezone. */
export function todayIst(): string {
  return new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10)
}

/** Value for <input type="date"> from an API date. */
export const toInputDate = (v: string | Date | null | undefined): string =>
  v ? new Date(v).toISOString().slice(0, 10) : ''

/** Whole days from today (IST) until an API date; negative = already past. */
export function daysUntil(v: string | Date | null | undefined): number | null {
  if (!v) return null
  const a = new Date(`${todayIst()}T00:00:00Z`).getTime()
  const b = new Date(`${new Date(v).toISOString().slice(0, 10)}T00:00:00Z`).getTime()
  return Math.round((b - a) / 86_400_000)
}

export const VEHICLE_TYPE_LABEL: Record<string, string> = {
  two_wheeler: 'Two-wheeler', three_wheeler: 'Auto / three-wheeler', car: 'Car', suv: 'SUV / MUV', lcv: 'Small commercial (LCV)',
  truck_bus: 'Truck / bus', tractor: 'Tractor / farm', otr: 'OTR / earth-mover', other: 'Other',
}

export const ITEM_KIND_LABEL: Record<string, string> = {
  tyre: 'Tyre', tube: 'Tube', flap: 'Flap', alloy_wheel: 'Wheel', valve: 'Valve / small stock', battery: 'Battery',
  accessory: 'Accessory', service: 'Service', scrap: 'Old tyre (scrap)',
}

export const SERVICE_TYPE_LABEL: Record<string, string> = {
  fitting: 'Fitting', balancing: 'Balancing', alignment: 'Alignment', puncture: 'Puncture repair', rotation: 'Rotation',
  nitrogen: 'Nitrogen', valve_change: 'Valve change', other: 'Other',
}

export const POSITION_LABEL: Record<string, string> = {
  FL: 'Front left', FR: 'Front right', RL: 'Rear left', RR: 'Rear right', SP: 'Spare', OTHER: 'Other',
}

export const PAYMENT_METHOD_LABEL: Record<string, string> = {
  cash: 'Cash', upi: 'UPI', card: 'Card', cheque: 'Cheque', bank_transfer: 'Bank transfer', exchange: 'Old tyre exchange', tds: 'TDS', credit: 'Credit',
}

type Tone = { label: string; cls: string }

export const WARRANTY_STATUS: Record<string, Tone> = {
  active:  { label: 'In warranty',  cls: 'bg-green-100 text-green-700' },
  claimed: { label: 'Claim made',   cls: 'bg-amber-100 text-amber-700' },
  void:    { label: 'Void',         cls: 'bg-gray-100 text-gray-500' },
}

export const SALE_STATUS: Record<string, Tone> = {
  paid:      { label: 'Paid',        cls: 'bg-green-100 text-green-700' },
  partial:   { label: 'Part paid',   cls: 'bg-amber-100 text-amber-700' },
  confirmed: { label: 'Unpaid',      cls: 'bg-blue-100 text-blue-700' },
  draft:     { label: 'Draft',       cls: 'bg-gray-100 text-gray-600' },
  cancelled: { label: 'Cancelled',   cls: 'bg-red-100 text-red-600' },
}

/** DOT code "2325" → "week 23 of 2025" (and its age in months, for the counter's "how old is this tyre"). */
export function dotInfo(dot: string | null | undefined): { label: string; ageMonths: number } | null {
  const m = String(dot ?? '').match(/^(\d{2})(\d{2})$/)
  if (!m) return null
  const week = Number(m[1]), yy = Number(m[2])
  if (week < 1 || week > 53) return null
  const year = 2000 + yy
  const made = new Date(Date.UTC(year, 0, 1 + (week - 1) * 7))
  const ageMonths = Math.max(0, Math.round((Date.now() - made.getTime()) / (30.44 * 86_400_000)))
  return { label: `week ${week} of ${year}`, ageMonths }
}

// ── Amount in words (Indian numbering): 104212 → "One Lakh Four Thousand Two Hundred Twelve Only" ──
const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
  'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen']
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety']

function below1000(n: number): string {
  const parts: string[] = []
  if (n >= 100) { parts.push(`${ONES[Math.floor(n / 100)]} Hundred`); n %= 100 }
  if (n >= 20) { parts.push(TENS[Math.floor(n / 10)]!); n %= 10 }
  if (n > 0) parts.push(ONES[n]!)
  return parts.join(' ')
}

export function amountInWords(amount: number): string {
  const rupees = Math.floor(Math.abs(amount))
  const paise = Math.round((Math.abs(amount) - rupees) * 100)
  if (rupees === 0 && paise === 0) return 'Zero Only'
  const units: Array<[number, string]> = [[10_000_000, 'Crore'], [100_000, 'Lakh'], [1000, 'Thousand']]
  let n = rupees
  const words: string[] = []
  for (const [size, name] of units) {
    if (n >= size) { words.push(`${below1000(Math.floor(n / size))} ${name}`); n %= size }
  }
  if (n > 0) words.push(below1000(n))
  const rupeeText = words.join(' ')
  const paiseText = paise > 0 ? `${below1000(paise)} Paise` : ''
  return [rupeeText, rupeeText && paiseText ? 'and' : '', paiseText].filter(Boolean).join(' ') + ' Only'
}
