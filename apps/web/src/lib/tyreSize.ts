// Tyre sizes: the lists the picker offers, how a typed size is understood, and the spelling that gets saved.
// Mirrors normalizeTyreSize() in packages/domain-registry, which the server uses to match searches to stock.

export type SizeFamily = 'car' | 'truck' | 'bike'
export type SizeFormat = 'radial' | 'crossply'

export const familyOf = (vehicleType: string | undefined | null): SizeFamily =>
  vehicleType === 'two_wheeler' || vehicleType === 'three_wheeler' ? 'bike'
    : vehicleType === 'truck_bus' || vehicleType === 'tractor' || vehicleType === 'otr' ? 'truck' : 'car'

const range = (from: number, to: number, step = 1, dp = 0) => {
  const out: string[] = []
  for (let v = from; v <= to + 1e-9; v += step) out.push(v.toFixed(dp))
  return out
}

/** Standard sizes: width / profile R rim. Cross-ply (bias) sizes: width - rim, as printed on the tyre. */
export const SIZE_LISTS: Record<SizeFamily, Record<SizeFormat, { a: string[]; b?: string[]; c: string[]; labels: [string, string | null, string]; example: string }>> = {
  car: {
    radial:   { a: ['125', '135', '145', '155', '165', '175', '185', '195', '205', '215', '225', '235', '245', '255', '265', '275', '285', '295', '305', '315', '325', '335'],
                b: ['30', '35', '40', '45', '50', '55', '60', '65', '70', '75', '80', '85'], c: range(12, 24), labels: ['Width', 'Profile', 'Rim'], example: '185/65 R15' },
    crossply: { a: ['4.00', '4.50', '5.00', '5.20', '5.50', '5.60', '6.00', '6.40', '6.50', '7.00', '7.50'], c: range(12, 16), labels: ['Width', null, 'Rim'], example: '5.20-13' },
  },
  truck: {
    radial:   { a: ['215', '225', '235', '245', '255', '265', '275', '285', '295', '305', '315', '385', '425', '445'],
                b: ['45', '50', '55', '60', '65', '70', '75', '80', '85'], c: ['15', '16', '17', '17.5', '18', '19.5', '20', '22.5', '24.5'], labels: ['Width', 'Profile', 'Rim'], example: '295/80 R22.5' },
    crossply: { a: ['6.00', '6.50', '7.00', '7.50', '8.25', '9.00', '10.00', '11.00', '12.00', '14.9', '16.9', '18.4'],
                c: ['15', '16', '20', '22', '24', '26', '28', '30', '34', '38'], labels: ['Width', null, 'Rim'], example: '10.00-20' },
  },
  bike: {
    radial:   { a: ['60', '70', '75', '80', '90', '100', '110', '120', '130', '140', '150', '160', '180', '190'],
                b: ['60', '70', '80', '90', '100'], c: ['10', '12', '13', '14', '15', '16', '17', '18', '19', '21'], labels: ['Width', 'Profile', 'Rim'], example: '90/90-17' },
    crossply: { a: ['2.25', '2.50', '2.75', '3.00', '3.25', '3.50', '4.00', '4.10', '4.50'], c: ['10', '12', '14', '16', '17', '18', '19', '21'], labels: ['Width', null, 'Rim'], example: '2.75-18' },
  },
}

export interface ParsedSize { format: SizeFormat; a: string; b?: string; c: string }

/** Understand a size however it was typed; null when it is not a size at all. */
export function parseSize(raw: string | null | undefined): ParsedSize | null {
  const s = String(raw ?? '').toUpperCase().replace(/[ZVHST]R/g, 'R').replace(/\s+/g, ' ').trim()
  if (!s) return null
  let m = s.replace(/\s/g, '').match(/^(\d{3})(\d{2})(\d{2})$/)                                    // 1856515
  if (m) return { format: 'radial', a: m[1]!, b: m[2]!, c: m[3]! }
  m = s.match(/^(\d{2,3})[\/ -](\d{2,3})[ -]?R?[ -]?(\d{2}(?:\.\d)?)$/)                          // 185/65 R15 · 185 65 15 · 90/90-17
  if (m) return { format: 'radial', a: m[1]!, b: m[2]!, c: m[3]! }
  m = s.match(/^(\d{1,2}\.\d{1,2})[ \/-]?R?[ -]?(\d{2}(?:\.\d)?)$/)                              // 10.00-20 · 2.75-18 · 5.20/13 · 10.00 R20
  if (m) return { format: 'crossply', a: m[1]!, c: m[2]! }
  return null
}

/** The spelling that is saved: "185/65 R15", "90/90-17", "10.00-20" / "295/80 R22.5". */
export function formatSize(p: ParsedSize, family: SizeFamily): string {
  if (p.format === 'crossply') return `${p.a}-${p.c}`
  return family === 'bike' ? `${p.a}/${p.b}-${p.c}` : `${p.a}/${p.b} R${p.c}`
}

/** '' when fine or empty; otherwise a sentence. */
export function tyreSizeError(raw: string | null | undefined, required = false): string {
  const v = String(raw ?? '').trim()
  if (!v) return required ? 'Choose the tyre size' : ''
  const p = parseSize(v)
  if (!p) return 'This does not look like a tyre size — pick it from the lists, or type it like 185/65 R15'
  const rim = Number(p.c)
  if (rim < 8 || rim > 40) return 'The rim size looks wrong'
  if (p.b != null && (Number(p.a) < 50 || Number(p.a) > 700)) return 'The width looks wrong'
  return ''
}
