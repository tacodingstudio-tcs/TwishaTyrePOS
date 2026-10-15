// packages/domain-registry/src/index.ts
// =============================================================================
// DOMAIN REGISTRY — single source of truth for domain types.
//
// This repo (tyrePlatform) is the tyre-retail / wholesale / fitting-centre vertical of
// HisabKitab. It ships exactly one domain, `tyre`, but keeps the same registry shape as
// billingPlatform so the shared core (invoice service, product service, tenants/branches
// routes) works unchanged and patches can be ported between the repos.
//
// Adding a sub-domain later (e.g. `battery`, `retreading`):
//   1. Define productAttrs / invoiceData / itemMeta Zod schemas below
//   2. Add an entry to DOMAIN_REGISTRY
//   3. Zero changes to core tables, routes, or the GST engine
// =============================================================================

import { z } from 'zod'

// ── Shared enums ──────────────────────────────────────────────────────────────

/** What kind of thing a catalogue item is. Drives GST defaults, warranty and stock behaviour. */
export const ITEM_KINDS = [
  'tyre',          // pneumatic tyre — serial / DOT / warranty tracked per unit
  'tube',          // inner tube
  'flap',          // tyre flap (trucks)
  'alloy_wheel',   // alloy / steel wheel
  'valve',         // valves, nitrogen caps, weights and similar small stock
  'battery',
  'accessory',
  'service',       // fitting, balancing, alignment … (no stock)
  'scrap',         // old-tyre stock taken in on exchange
  'charge',        // free-amount bill line: alignment, balancing, weights, labour (no stock)
] as const

/** Which kinds are individually identified (serial / DOT) and can carry a warranty. */
export const SERIALISED_KINDS: readonly string[] = ['tyre', 'tube', 'alloy_wheel', 'battery']

export const TYRE_VEHICLE_TYPES = [
  'two_wheeler', 'three_wheeler', 'car', 'suv', 'lcv', 'truck_bus', 'tractor', 'otr', 'other',
] as const

export const SERVICE_TYPES = [
  'fitting', 'balancing', 'alignment', 'puncture', 'rotation', 'nitrogen', 'valve_change', 'other',
] as const

/** Where a tyre is fitted on the vehicle (FL = front left …, SP = spare). */
export const TYRE_POSITIONS = ['FL', 'FR', 'RL', 'RR', 'SP', 'OTHER'] as const

export const SALE_KINDS = ['retail', 'wholesale', 'service_only'] as const

export const PAYMENT_TERMS = ['immediate', '7_days', '15_days', '30_days', '45_days', '60_days'] as const

export const WARRANTY_STATUSES = ['active', 'claimed', 'void'] as const
export const CLAIM_OUTCOMES = ['replaced', 'prorata', 'repaired', 'rejected'] as const

// ── Tyre shop ─────────────────────────────────────────────────────────────────
// Product = a stocked item (tyre, tube, wheel …) or a billable service (fitting, alignment …).
const TyreProductAttrs = z.object({
  item_kind:        z.enum(ITEM_KINDS).default('tyre'),
  brand:            z.string().max(100).optional(),            // MRF, Apollo, CEAT, JK, Michelin …
  pattern:          z.string().max(100).optional(),            // ZVTV, Amazer 4G, Milaze …
  size:             z.string().max(30).optional(),             // 205/55 R16 · 10.00 R20 · 90/90-17
  vehicle_type:     z.enum(TYRE_VEHICLE_TYPES).optional(),
  tube_type:        z.enum(['tubeless', 'tube']).optional(),
  construction:     z.enum(['radial', 'bias']).optional(),
  load_index:       z.number().int().min(0).max(300).optional(),
  speed_rating:     z.string().max(3).optional(),
  ply_rating:       z.string().max(10).optional(),
  warranty_months:  z.number().int().min(0).max(120).default(0),
  origin:           z.enum(['india', 'imported']).optional(),
  // services
  service_type:     z.enum(SERVICE_TYPES).optional(),
  // free text
  compatible_vehicles: z.array(z.string()).default([]),
}).strict()

// A tyre sale / fitting bill.
const TyreInvoiceData = z.object({
  sale_kind:           z.enum(SALE_KINDS).default('retail'),
  vehicle_no:          z.string().max(20).optional(),
  vehicle_type:        z.enum(TYRE_VEHICLE_TYPES).optional(),
  customer_vehicle_id: z.string().uuid().optional(),
  odometer:            z.number().int().nonnegative().optional(),
  fitted_by:           z.string().max(80).optional(),
  // old-tyre exchange: allowance is settled through a payment of method "exchange"
  exchange_qty:        z.number().int().nonnegative().default(0),
  exchange_value:      z.number().nonnegative().default(0),
  next_service_km:     z.number().int().positive().optional(),
  next_service_date:   z.string().max(10).optional(),
  payment_terms:       z.enum(PAYMENT_TERMS).optional(),
  credit_days:         z.number().int().min(0).max(180).optional(),
  // register series the bill number belongs to (car / two_wheel …) and the customer's PO
  gst_bill:            z.boolean().optional(),   // false = cash memo, outside the GST returns
  bill_series:         z.string().max(20).optional(),
  po_no:               z.string().max(40).optional(),
  po_date:             z.string().max(10).optional(),
  vehicle_make:        z.string().max(60).optional(),
  prices_include_gst:  z.boolean().optional(),
}).strict()

// Per-line meta: what was physically fitted / handed over.
const TyreItemMeta = z.object({
  item_kind:     z.enum(ITEM_KINDS).optional(),
  serial_nos:    z.array(z.string().max(40)).max(50).default([]),
  dot_codes:     z.array(z.string().max(10)).max(50).default([]),     // "2325" = week 23 of 2025
  positions:     z.array(z.enum(TYRE_POSITIONS)).max(50).default([]),
  brand:         z.string().max(100).optional(),
  size:          z.string().max(30).optional(),
  warranty_months: z.number().int().min(0).max(120).optional(),
  warranty_until:  z.string().max(10).optional(),
  service_type:  z.enum(SERVICE_TYPES).optional(),
  // service jobs: how many wheels were done, and alignment / balancing readings (free keys, short values)
  wheels:        z.number().int().min(1).max(30).optional(),
  readings:      z.object({
    before: z.record(z.string().max(30), z.string().max(20)).optional(),
    after:  z.record(z.string().max(30), z.string().max(20)).optional(),
  }).strict().optional(),
}).strict()

/** Reading names offered on the alignment form (the keys are what get stored / printed). */
export const ALIGNMENT_READING_KEYS = [
  'Front toe', 'Rear toe', 'Camber L', 'Camber R', 'Caster L', 'Caster R',
] as const

// =============================================================================
// DOMAIN REGISTRY — the single config object all layers read from
// =============================================================================
export const DOMAIN_REGISTRY = {
  tyre: {
    label:              'Tyre shop / dealer (retail, wholesale, fitting centre)',
    productAttrsSchema: TyreProductAttrs,
    invoiceDataSchema:  TyreInvoiceData,
    itemMetaSchema:     TyreItemMeta,
    defaultDomainConfig: {
      // GST — rates and HSN/SAC are configuration, not law: confirm with your CA.
      default_tyre_gst:       18,         // pneumatic tyres, tubes, flaps (GST 2.0, from 22 Sep 2025)
      default_service_gst:    18,
      default_service_sac:    '998714',   // maintenance & repair of motor vehicles
      // Selling
      serial_required:        false,      // true = refuse a tyre sale that has no serial / DOT per unit
      prices_include_gst:     false,      // true = prices typed on a bill already contain GST (Data Entry style)
      bill_series:            {},         // {car:{prefix:'',start:93}, two_wheel:{prefix:'2W-',start:1}} plain numbered registers
      allow_below_cost:       false,      // false = warn when a line is sold under purchase price
      // After-sales
      default_warranty_months: 0,         // used when the product itself has none
      service_reminder_days:  180,        // remind this long after a fitting / rotation / puncture
      service_reminder_km:    10000,
      alignment_reminder_days: 180,       // wheel alignment: typically every 6 months / 10,000 km
      alignment_reminder_km:  10000,
      balancing_reminder_days: 90,        // wheel balancing: typically every 3 months / 5,000 km
      balancing_reminder_km:  5000,
      warranty_alert_days:    30,
      // Stock
      dead_stock_days:        90,         // no sale for this long = "dead stock"
      low_stock_default:      4,
      weight_unit:            'pcs',
    },
    extensionTables: [
      'tyre_vehicles',
      'tyre_warranty',
      'tyre_notifications',
      'tyre_staff',
      'tyre_staff_days',
      'tyre_staff_ledger',
    ] as string[],
    features: {
      hasBatches:        false,
      hasAppointments:   false,
      hasKOT:            false,
      hasWeightBilling:  false,
      hasUdhaar:         true,       // dealers and fleets buy on credit
      hasEwayBill:       true,       // wholesale dispatch above ₹50,000
      hasCommission:     false,
      hasShiftReport:    false,
      hasJobCard:        false,
      hasSubscription:   false,
      hasNozzleReading:  false,
      hasBrands:         true,
      hasLoyalty:        false,
      hasHomeDelivery:   false,
      // tyre-specific
      hasWarranty:       true,
      hasVehicles:       true,
      hasSerialTracking: true,
      hasOldTyreExchange: true,
      hasServiceReminders: true,
    },
  },
} as const

// =============================================================================
// DEFAULT GST / HSN
// =============================================================================

/** HSN (6-digit) for pneumatic tyres by vehicle class — 8-digit codes are needed above ₹5 cr turnover. */
export const TYRE_HSN_BY_VEHICLE: Record<string, string> = {
  car:           '401110',   // new pneumatic tyres, of a kind used on motor cars
  suv:           '401110',
  lcv:           '401120',   // … on buses or lorries
  truck_bus:     '401120',
  two_wheeler:   '401140',   // … on motorcycles
  three_wheeler: '401199',
  tractor:       '401170',   // … on agricultural / forestry vehicles
  otr:           '401199',
  other:         '401199',
}

/** HSN by item kind for everything that is not a tyre. */
export const HSN_BY_KIND: Record<string, string> = {
  tube:        '401310',
  flap:        '401299',
  alloy_wheel: '870870',
  valve:       '848180',
  battery:     '850710',
  accessory:   '870899',
  scrap:       '400400',
}

export function defaultHsn(kind: string, vehicleType?: string, serviceSac = '998714'): string {
  if (kind === 'service') return serviceSac
  if (kind === 'tyre') return TYRE_HSN_BY_VEHICLE[vehicleType ?? 'other'] ?? '401199'
  return HSN_BY_KIND[kind] ?? '401199'
}

// =============================================================================
// EXPENSE CATEGORIES
// =============================================================================
export interface ExpenseCategory {
  code:         string
  label:        string
  icon:         string
  affectsStock: boolean   // true = buying inventory (purchases), affects COGS
}

const UNIVERSAL: ExpenseCategory[] = [
  { code: 'rent',         label: 'Shop Rent',          icon: '🏢', affectsStock: false },
  { code: 'electricity',  label: 'Electricity',        icon: '⚡', affectsStock: false },
  { code: 'internet',     label: 'Internet / Phone',   icon: '📶', affectsStock: false },
  { code: 'staff',        label: 'Staff Salary',       icon: '👤', affectsStock: false },
  { code: 'maintenance',  label: 'Maintenance',        icon: '🔧', affectsStock: false },
  { code: 'misc',         label: 'Miscellaneous',      icon: '📎', affectsStock: false },
]

const DOMAIN_EXPENSE_CATEGORIES: Record<string, ExpenseCategory[]> = {
  tyre: [
    { code: 'tyre_purchase',     label: 'Tyre / Tube Purchases',        icon: '🛞', affectsStock: true  },
    { code: 'freight_inward',    label: 'Freight Inward / Cartage',     icon: '🚚', affectsStock: false },
    { code: 'hamali',            label: 'Loading / Unloading (Hamali)', icon: '🏋️', affectsStock: false },
    { code: 'technician_salary', label: 'Technician / Fitter Salary',   icon: '🧑‍🔧', affectsStock: false },
    { code: 'machine_maintenance', label: 'Machine Maintenance (balancer, changer)', icon: '⚙️', affectsStock: false },
    { code: 'consumables',       label: 'Wheel Weights / Valves / Consumables', icon: '🔩', affectsStock: true },
    { code: 'compressor_power',  label: 'Compressor / Nitrogen Gas',    icon: '💨', affectsStock: false },
    { code: 'scrap_disposal',    label: 'Scrap Tyre Disposal',          icon: '♻️', affectsStock: false },
    { code: 'advertising',       label: 'Advertising / Hoardings',      icon: '📣', affectsStock: false },
    { code: 'warranty_claim_loss', label: 'Warranty Claim Loss',        icon: '🛡️', affectsStock: false },
  ],
}

export function getExpenseCategories(domainType: DomainType): ExpenseCategory[] {
  const domain = DOMAIN_EXPENSE_CATEGORIES[domainType] ?? []
  // Merge domain-specific first (shown at top), then universals not already covered
  const domainCodes = new Set(domain.map((c) => c.code))
  const extras = UNIVERSAL.filter((c) => !domainCodes.has(c.code))
  return [...domain, ...extras]
}

// =============================================================================
// TYPES + HELPERS
// =============================================================================
export type DomainType = keyof typeof DOMAIN_REGISTRY

export type DomainProductAttrs<T extends DomainType> = z.infer<typeof DOMAIN_REGISTRY[T]['productAttrsSchema']>
export type DomainInvoiceData<T extends DomainType>  = z.infer<typeof DOMAIN_REGISTRY[T]['invoiceDataSchema']>
export type DomainItemMeta<T extends DomainType>     = z.infer<typeof DOMAIN_REGISTRY[T]['itemMetaSchema']>

export type ItemKind        = typeof ITEM_KINDS[number]
export type TyreVehicleType = typeof TYRE_VEHICLE_TYPES[number]
export type ServiceType     = typeof SERVICE_TYPES[number]
export type TyrePosition    = typeof TYRE_POSITIONS[number]

// Helper: get features for a domain type
export function getDomainFeatures(domainType: string) {
  const domain = DOMAIN_REGISTRY[domainType as DomainType]
  if (!domain) throw new Error(`Unknown domain type: ${domainType}`)
  return domain.features
}

// Helper: validate domain_attrs for a product
export function validateProductAttrs(domainType: string, attrs: unknown) {
  const domain = DOMAIN_REGISTRY[domainType as DomainType]
  if (!domain) throw new Error(`Unknown domain type: ${domainType}`)
  // Use passthrough so legacy/extra keys already stored in the JSON field don't break validation
  return (domain.productAttrsSchema as z.ZodObject<z.ZodRawShape>).passthrough().parse(attrs ?? {})
}

// Helper: validate invoice domain_data
export function validateInvoiceData(domainType: string, data: unknown) {
  const domain = DOMAIN_REGISTRY[domainType as DomainType]
  if (!domain) throw new Error(`Unknown domain type: ${domainType}`)
  return domain.invoiceDataSchema.parse(data)
}

// =============================================================================
// SIZE NORMALISATION — one canonical spelling so "205 55 16", "205/55-R16" and "205/55ZR16" all match
// =============================================================================

/**
 * Canonical search key for a tyre size.
 *   "205/55 R16" | "205 55 16" | "2055516" | "205/55ZR16"  → "205/55R16"
 *   "10.00 R20"  | "10.00-20"                              → "10.00R20"
 *   "90/90-17"                                             → "90/90R17"
 * Anything it cannot parse is returned upper-cased with separators removed.
 */
export function normalizeTyreSize(raw: string | null | undefined): string {
  let s = String(raw ?? '').toUpperCase().replace(/[ZVHST]R/g, 'R').trim()
  if (!s) return ''
  // "2055516" — seven digits with no separators: WWW AA RR
  const compact = s.replace(/\s+/g, '')
  const m7 = compact.match(/^(\d{3})(\d{2})(\d{2})$/)
  if (m7) return `${m7[1]}/${m7[2]}R${m7[3]}`
  s = s.replace(/[\s-]+/g, ' ').replace(/\s*\/\s*/g, '/').trim()
  // "205 55 16" → "205/55R16"
  const m3 = s.match(/^(\d{2,3}) (\d{2}) R?(\d{2})$/)
  if (m3) return `${m3[1]}/${m3[2]}R${m3[3]}`
  // "205/55 16" / "205/55 R16" / "205/55R16" / "90/90 17"
  const mw = s.match(/^(\d{2,3})\/(\d{2}) ?R?(\d{2})$/)
  if (mw) return `${mw[1]}/${mw[2]}R${mw[3]}`
  // truck: "295/80 R22.5"
  const mt2 = s.match(/^(\d{3})\/(\d{2}) ?R?(\d{2}\.\d)$/)
  if (mt2) return `${mt2[1]}/${mt2[2]}R${mt2[3]}`
  // truck bias / radial: "10.00 R20" / "10.00 20" / "7.50-16"
  const mt = s.match(/^(\d{1,2}\.\d{2}) ?R?(\d{2})$/)
  if (mt) return `${mt[1]}R${mt[2]}`
  return s.replace(/[^A-Z0-9./]/g, '')
}
