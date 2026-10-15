// Default catalogue items for a new tyre business: the standard fitting services and the
// "old tyre" scrap item. Tyres themselves are the shop's own stock, so none are pre-created.

import { DOMAIN_REGISTRY } from '@billing/domain-registry'

interface SeedService {
  name: string
  serviceType: string
  price: number
  unit: string
  sku: string
}

// Typical counter prices — owners edit these once; they are only a starting point.
const SERVICES: SeedService[] = [
  { name: 'Tyre Fitting (per tyre)',        serviceType: 'fitting',      price: 100, unit: 'tyre',  sku: 'SVC-FIT' },
  { name: 'Wheel Balancing (per wheel)',    serviceType: 'balancing',    price: 100, unit: 'wheel', sku: 'SVC-BAL' },
  { name: 'Wheel Alignment (4 wheels)',     serviceType: 'alignment',    price: 600, unit: 'job',   sku: 'SVC-ALN' },
  { name: 'Puncture Repair (tubeless)',     serviceType: 'puncture',     price: 150, unit: 'tyre',  sku: 'SVC-PNC' },
  { name: 'Tyre Rotation',                  serviceType: 'rotation',     price: 200, unit: 'job',   sku: 'SVC-ROT' },
  { name: 'Nitrogen Inflation (per tyre)',  serviceType: 'nitrogen',     price: 50,  unit: 'tyre',  sku: 'SVC-N2' },
  { name: 'Valve Replacement',              serviceType: 'valve_change', price: 40,  unit: 'pcs',   sku: 'SVC-VLV' },
  { name: 'Wheel Weights',                  serviceType: 'balancing',    price: 120, unit: 'job',   sku: 'SVC-WGT' },
  { name: 'Labour Charge',                  serviceType: 'other',        price: 100, unit: 'job',   sku: 'SVC-LAB' },
]

export async function seedTyreCatalogue(db: any, branchId: string, cfg?: Record<string, any>): Promise<void> {
  const defaults = (DOMAIN_REGISTRY.tyre.defaultDomainConfig as Record<string, any>)
  const sac  = String((cfg ?? defaults)['default_service_sac'] ?? defaults['default_service_sac'])
  const gst  = Number((cfg ?? defaults)['default_service_gst'] ?? defaults['default_service_gst'])

  const cats = await db.category.findMany({
    where: { branchId, slug: { in: ['services', 'scrap'] } },
    select: { id: true, slug: true },
  })
  const catId = (slug: string): string | undefined => cats.find((c: any) => c.slug === slug)?.id

  for (const s of SERVICES) {
    const exists = await db.product.findFirst({ where: { branchId, sku: s.sku }, select: { id: true } })
    if (exists) continue
    await db.product.create({
      data: {
        branchId, categoryId: catId('services') ?? null,
        itemType: 'service', name: s.name, sku: s.sku,
        hsnSacCode: sac, gstRate: gst, unit: s.unit, salePrice: s.price,
        trackStock: false,
        domainAttrs: { item_kind: 'service', service_type: s.serviceType, warranty_months: 0, compatible_vehicles: [] },
      },
    })
  }

  // Old tyres taken in on exchange are stocked here (purchase of scrap from the customer).
  const scrap = await db.product.findFirst({ where: { branchId, sku: 'SCRAP-TYRE' }, select: { id: true } })
  if (!scrap) {
    await db.product.create({
      data: {
        branchId, categoryId: catId('scrap') ?? null,
        itemType: 'product', name: 'Old Tyre (scrap)', sku: 'SCRAP-TYRE',
        hsnSacCode: '400400', gstRate: gst, unit: 'pcs', salePrice: 0, trackStock: true,
        domainAttrs: { item_kind: 'scrap', warranty_months: 0, compatible_vehicles: [] },
      },
    })
  }
}
