// Domain-specific product/service attribute forms.
// Keys must match the Zod productAttrsSchema for the domain in packages/domain-registry
// (the API validates product.domainAttrs with it), so select options are the exact enum values.

export type AttrFieldType = 'text' | 'number' | 'select' | 'date' | 'boolean' | 'textarea'

export interface AttrField {
  key: string
  label: string
  type: AttrFieldType
  options?: string[]
  placeholder?: string
  unit?: string
  section?: string   // new section heading above this field
  wide?: boolean     // span full width
}

const DOMAIN_ATTRS: Record<string, AttrField[]> = {
  tyre: [
    { key: 'item_kind', label: 'What is it?', type: 'select', section: 'Item',
      options: ['tyre', 'tube', 'flap', 'alloy_wheel', 'valve', 'battery', 'accessory', 'service', 'scrap'] },
    { key: 'brand', label: 'Brand', type: 'text', placeholder: 'MRF, Apollo, CEAT, JK, Michelin…' },
    { key: 'pattern', label: 'Pattern / model', type: 'text', placeholder: 'ZVTV, Amazer 4G Life…' },
    { key: 'size', label: 'Size', type: 'text', placeholder: '205/55 R16 · 10.00 R20 · 90/90-17' },
    { key: 'vehicle_type', label: 'Fits', type: 'select',
      options: ['two_wheeler', 'three_wheeler', 'car', 'suv', 'lcv', 'truck_bus', 'tractor', 'otr', 'other'] },

    { key: 'tube_type', label: 'Tubeless / tube', type: 'select', section: 'Specification', options: ['tubeless', 'tube'] },
    { key: 'construction', label: 'Construction', type: 'select', options: ['radial', 'bias'] },
    { key: 'load_index', label: 'Load index', type: 'number', placeholder: '91' },
    { key: 'speed_rating', label: 'Speed rating', type: 'text', placeholder: 'V' },
    { key: 'ply_rating', label: 'Ply rating', type: 'text', placeholder: '16PR' },
    { key: 'origin', label: 'Origin', type: 'select', options: ['india', 'imported'] },

    { key: 'warranty_months', label: 'Warranty', type: 'number', unit: 'months', section: 'After-sales', placeholder: '0 = as per maker' },
    { key: 'service_type', label: 'Service type (services only)', type: 'select',
      options: ['fitting', 'balancing', 'alignment', 'puncture', 'rotation', 'nitrogen', 'valve_change', 'other'] },
  ],
}

export function getDomainAttrs(domainType: string): AttrField[] {
  return DOMAIN_ATTRS[domainType] ?? []
}
