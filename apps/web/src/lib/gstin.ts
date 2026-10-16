// GSTIN format + checksum check, shared by the routes that accept a customer's GSTIN.
// 2-digit state + 10-char PAN + 1 entity digit + "Z" + 1 check character.
const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/
const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'

export function isValidGstin(raw: string): boolean {
  const g = raw.trim().toUpperCase()
  if (!GSTIN_REGEX.test(g)) return false
  let sum = 0
  for (let i = 0; i < 14; i++) {
    const m = CHARS.indexOf(g[i]!) * (i % 2 === 0 ? 1 : 2)
    sum += Math.floor(m / 36) + (m % 36)
  }
  return CHARS[(36 - (sum % 36)) % 36] === g[14]
}
