// Reads a printed tyre line ("YOKOHAMA 185/65R15 BluEarth") into brand, size, kind and vehicle type.
// Best effort only — the import screen shows the result for staff to correct before anything is saved.

const BRANDS = ['Yokohama', 'MRF', 'Apollo', 'CEAT', 'JK Tyre', 'Bridgestone', 'Michelin', 'Goodyear', 'TVS', 'Dunlop', 'Continental',
  'Falken', 'Maxxis', 'Hankook', 'Pirelli', 'Kumho', 'Toyo', 'Metzeler', 'Birla', 'Good Year', 'Eurogrip', 'Michelin']

/** "YOKOHAMA 185/65R15 BluEarth" → brand, size, kind, vehicle type … best effort; the screen lets staff correct it. */
export function parseTyreLine(rawName: string) {
  const name = rawName.replace(/\s+/g, ' ').trim()
  const lower = name.toLowerCase()
  const brand = BRANDS.find((b) => lower.includes(b.toLowerCase().replace('good year', 'goodyear')) || lower.includes(b.toLowerCase()))
  const kind = /\btube\b/.test(lower) ? 'tube' : /\bflap\b/.test(lower) ? 'flap' : /\b(alloy|wheel rim|rim)\b/.test(lower) ? 'alloy_wheel' : 'tyre'
  // 185/65R15 · 185 65 15 · 185/65/15 · 2055516
  const radial = name.match(/\b(\d{3})\s*[\/\- ]?\s*(\d{2})\s*[\/\- ]?\s*(?:[ZVHST]?R)?\s*[\/\- ]?\s*(\d{2})\b/i)
  // 2.75-18 · 3.00-17 · 90/90-17 · 10.00 R20
  const bias = name.match(/\b(\d{1,2}\.\d{2}|\d{2,3}\/\d{2,3})\s*[-xR ]\s*(\d{2})\b/i)
  let size = '', vehicleType = 'car'
  if (radial) {
    size = `${radial[1]}/${radial[2]} R${radial[3]}`
    const width = Number(radial[1]), rim = Number(radial[3])
    if (width < 130) vehicleType = 'two_wheeler'
    else if (rim >= 17 && width >= 225) vehicleType = 'suv'
  } else if (bias) {
    size = `${bias[1]}-${bias[2]}`
    const rim = Number(bias[2])
    vehicleType = /^\d{1,2}\.\d{2}$/.test(bias[1]!) ? (Number(bias[1]) >= 7 || rim >= 20 ? 'truck_bus' : 'two_wheeler') : 'two_wheeler'
  }
  const pattern = brand && size ? name.replace(new RegExp(brand, 'i'), '').replace(/\d[\d\s\/.\-R]*\d/g, '').replace(/\b(tyre|tube|tubeless|tl|tt)\b/gi, '').replace(/[^\w ]/g, ' ').replace(/\s+/g, ' ').trim() : ''
  return { brand: brand?.replace('Good Year', 'Goodyear'), size, kind, vehicleType, pattern: pattern || undefined }
}

