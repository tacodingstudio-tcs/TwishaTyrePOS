// The UPI payment link printed as a QR on a bill that still has a balance: upi://pay?pa=<UPI ID>&pn=<name>&mc=<code>&am=<amount>&cu=INR&tn=<note>
// MUST stay the same as apps/web/src/lib/upi.ts (the "Show QR to customer" screen) — tyre-bill-layout.test.ts pins the exact string.
// Settings come from the shop's business settings (My Business → Edit business): upi_id, upi_name, upi_mcc.

export interface UpiSettings { id: string; name: string; mcc: string }

/** a UPI ID (VPA): letters, digits, dot, dash, underscore, then @ and the bank handle */
export const UPI_ID_RE = /^[A-Za-z0-9._-]{2,64}@[A-Za-z][A-Za-z0-9]{1,31}$/

export function upiSettings(config: Record<string, any> | undefined | null, shopName: string): UpiSettings | null {
  const id = String(config?.['upi_id'] ?? '').trim()
  if (!UPI_ID_RE.test(id)) return null
  const mcc = String(config?.['upi_mcc'] ?? '')
  return { id, name: String(config?.['upi_name'] ?? '').trim() || shopName, mcc: /^\d{4}$/.test(mcc) ? mcc : '5532' }   // 5532 = tyre shops
}

/** "24800.00"; null when it is not a payable amount */
export function upiAmount(n: number): string | null {
  if (!Number.isFinite(n) || n <= 0 || n > 1_000_000_00) return null
  return (Math.round(n * 100) / 100).toFixed(2)
}

/** transaction reference (`tr`): letters and digits only, at most 35. A link that carries an amount for a merchant UPI ID needs one, or some
 *  apps treat it as the shop's static QR and ask for the amount. It ties the QR to one bill and one balance. */
export function upiRef(ref: string, amount: number): string {
  return `${ref.replace(/[^A-Za-z0-9]/g, '').slice(0, 20)}${Math.round(amount * 100)}`
}

export function upiLink(s: UpiSettings, amount: number, note: string, ref: string): string | null {
  const am = upiAmount(amount)
  if (!am) return null
  const q = new URLSearchParams()
  q.set('pa', s.id); q.set('pn', s.name); q.set('mc', s.mcc); q.set('tr', upiRef(ref, amount)); q.set('am', am); q.set('cu', 'INR')
  if (note.trim()) q.set('tn', note.trim().slice(0, 50))
  return `upi://pay?${q.toString().replace(/\+/g, '%20').replace(/%40/g, '@')}`
}

/** the shop's plain QR, with no amount: the same form as the QR on the bank's own sheet, which every UPI app already scans. Printed on fully paid bills. */
export function upiPlainLink(s: UpiSettings): string {
  const q = new URLSearchParams()
  q.set('ver', '01'); q.set('mode', '01'); q.set('pa', s.id); q.set('pn', s.name); q.set('mc', s.mcc); q.set('qrMedium', '06')
  return `upi://pay?${q.toString().replace(/\+/g, '%20').replace(/%40/g, '@')}`
}

/** the QR's black squares as rows of booleans, ready to be drawn as vector squares in the PDF */
export async function qrModules(text: string): Promise<boolean[][]> {
  const { default: QRCode } = await import('qrcode')   // loaded on the first bill that needs it, not at start-up
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' })
  const n = qr.modules.size
  const rows: boolean[][] = []
  for (let r = 0; r < n; r++) { const row: boolean[] = []; for (let c = 0; c < n; c++) row.push(!!qr.modules.get(r, c)); rows.push(row) }
  return rows
}
