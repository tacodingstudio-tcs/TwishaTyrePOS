// Domain-specific entity configuration for party/customer management.
// Tyre vertical: parties are retail customers, fleets and dealers (and suppliers / tyre companies).

export interface EntityMetaField {
  key:         string
  label:       string
  type:        'text' | 'number' | 'select' | 'date'
  placeholder?: string
  options?:    string[]
  optional?:   boolean
}

export interface EntityConfig {
  singular:     string
  plural:       string
  singularLower: string
  // What to call the product/service catalogue for this domain
  catalogSingular: string
  catalogPlural:   string
  // Which meta fields to capture on the add/edit entity form
  metaFields:   EntityMetaField[]
  // Which columns to show in the list beyond name/phone/balance
  listColumns:  Array<{ key: string; label: string; fromMeta?: boolean }>
}

const DOMAIN_ENTITY: Record<string, EntityConfig> = {
  tyre: {
    singular: 'Customer', plural: 'Customers', singularLower: 'customer',
    catalogSingular: 'Tyre / Item', catalogPlural: 'Tyres & Items',
    metaFields: [
      { key: 'contact_person',  label: 'Contact Person',  type: 'text',   placeholder: 'For fleets and dealers', optional: true },
      { key: 'customer_kind',   label: 'Customer Type',   type: 'select', options: ['Retail', 'Fleet / Transporter', 'Dealer / Sub-dealer', 'Garage'], optional: true },
      { key: 'preferred_brand', label: 'Preferred Brand', type: 'text',   placeholder: 'e.g. MRF', optional: true },
    ],
    listColumns: [
      { key: 'customer_kind', label: 'Type', fromMeta: true },
    ],
  },
}

const DEFAULT_CONFIG: EntityConfig = {
  singular: 'Customer', plural: 'Customers', singularLower: 'customer',
  catalogSingular: 'Service', catalogPlural: 'Services',
  metaFields: [],
  listColumns: [],
}

export function getEntityConfig(domainType: string): EntityConfig {
  return DOMAIN_ENTITY[domainType] ?? DEFAULT_CONFIG
}
