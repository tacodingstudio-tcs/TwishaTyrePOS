// The UPI payment link a customer's phone opens when it scans the shop's QR: upi://pay?pa=<UPI ID>&pn=<name>&am=<amount>...
// The shop's printed QR holds the same link without the amount; here the amount (and the bill number) are added, so the customer
// only has to confirm. Settings live in the shop's business settings: upi_id, upi_name, upi_mcc, upi_banner.

export interface UpiSettings { id: string; name: string; mcc: string; banner: string }

/** a UPI ID (VPA): letters, digits, dot, dash, underscore, then @ and the bank handle */
export const UPI_ID_RE = /^[A-Za-z0-9._-]{2,64}@[A-Za-z][A-Za-z0-9]{1,31}$/
export const isUpiId = (v: string): boolean => UPI_ID_RE.test(v.trim())

export function upiSettings(cfg: Record<string, any> | undefined | null, shopName: string): UpiSettings | null {
  const id = String(cfg?.['upi_id'] ?? '').trim()
  if (!isUpiId(id)) return null
  return {
    id,
    name: String(cfg?.['upi_name'] ?? '').trim() || shopName,
    mcc: /^\d{4}$/.test(String(cfg?.['upi_mcc'] ?? '')) ? String(cfg?.['upi_mcc']) : '5532',   // 5532 = tyre shops
    banner: String(cfg?.['upi_banner'] ?? ''),
  }
}

/** amount in rupees with two decimals, as UPI wants it ("24800.00"); null when it is not a payable amount */
export function upiAmount(n: number): string | null {
  if (!Number.isFinite(n) || n <= 0 || n > 1_000_000_00) return null
  return (Math.round(n * 100) / 100).toFixed(2)
}

export function upiLink(s: UpiSettings, amount: number, note: string): string | null {
  const am = upiAmount(amount)
  if (!am) return null
  const q = new URLSearchParams()
  q.set('pa', s.id); q.set('pn', s.name); q.set('mc', s.mcc); q.set('am', am); q.set('cu', 'INR')
  if (note.trim()) q.set('tn', note.trim().slice(0, 50))
  // URLSearchParams writes spaces as "+"; UPI apps want %20
  return `upi://pay?${q.toString().replace(/\+/g, '%20')}`
}
