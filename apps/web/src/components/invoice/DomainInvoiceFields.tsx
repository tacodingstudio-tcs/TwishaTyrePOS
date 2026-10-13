// src/components/invoice/DomainInvoiceFields.tsx
//
// Domain-specific extra fields shown on the generic Create Invoice page.
// Data flows up as a flat patch via onChange so the parent can merge into domainData.
// Keys must match the invoiceDataSchema in packages/domain-registry.
//
// Tyre sales are normally made on the counter-sale screen (/tyre/sale), which also records serial
// numbers, warranty and the old-tyre exchange. This card covers the generic invoice screen
// (wholesale bills, quotations) so the vehicle and sale kind are still captured.
import { VEHICLE_TYPE_LABEL } from '@/components/tyre/format'

interface Props {
  domainType: string
  data: Record<string, unknown>
  onChange: (patch: Record<string, unknown>) => void
}

export function DomainInvoiceFields({ domainType, data, onChange }: Props) {
  if (domainType !== 'tyre') return null

  const str = (k: string) => (data[k] == null ? '' : String(data[k]))

  return (
    <div className="card p-4 space-y-3">
      <h3 className="text-sm font-semibold text-gray-900">Tyre sale details</h3>
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <label className="label">Sale type</label>
          <select className="input" value={str('sale_kind') || 'retail'} onChange={(e) => onChange({ sale_kind: e.target.value })}>
            <option value="retail">Retail (walk-in)</option>
            <option value="wholesale">Wholesale / dealer</option>
            <option value="service_only">Fitting / service only</option>
          </select>
        </div>
        <div>
          <label className="label">Vehicle number</label>
          <input className="input uppercase" value={str('vehicle_no')} placeholder="GJ05AB1234"
            onChange={(e) => onChange({ vehicle_no: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '') || undefined })} />
        </div>
        <div>
          <label className="label">Vehicle type</label>
          <select className="input" value={str('vehicle_type')} onChange={(e) => onChange({ vehicle_type: e.target.value || undefined })}>
            <option value="">—</option>
            {Object.entries(VEHICLE_TYPE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Odometer (km)</label>
          <input type="number" min="0" className="input" value={str('odometer')}
            onChange={(e) => onChange({ odometer: e.target.value ? Number(e.target.value) : undefined })} />
        </div>
        <div>
          <label className="label">Credit days</label>
          <input type="number" min="0" max="180" className="input" value={str('credit_days')}
            onChange={(e) => onChange({ credit_days: e.target.value ? Number(e.target.value) : undefined })} />
        </div>
      </div>
      <p className="text-xs text-gray-400">For serial numbers, warranty and old-tyre exchange use <strong>New Sale</strong> in the menu.</p>
    </div>
  )
}
