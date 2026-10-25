import { useState } from 'react'
import { FileSpreadsheet, X } from 'lucide-react'
import toast from 'react-hot-toast'
import { tyreApi, apiError } from '@/lib/api'

const SHEETS: Array<{ key: string; label: string; hint: string }> = [
  { key: 'sales', label: 'Sales register', hint: 'every bill with customer, GSTIN, taxable, GST, total' },
  { key: 'items', label: 'Sales items (HSN)', hint: 'each tyre / service line' },
  { key: 'gstr1', label: 'GSTR-1 (B2B + B2C)', hint: 'ready for return filing' },
  { key: 'hsn', label: 'HSN summary', hint: 'HSN-wise totals' },
  { key: 'notes', label: 'Credit notes & returns', hint: '' },
  { key: 'cancelled', label: 'Cancelled bills', hint: '' },
  { key: 'purchases', label: 'Purchase register', hint: 'input tax credit' },
  { key: 'expenses', label: 'Expenses', hint: '' },
  { key: 'payments', label: 'Payments', hint: 'received / paid' },
  { key: 'receivables', label: 'Customers who owe', hint: 'as on today' },
  { key: 'stock', label: 'Stock valuation', hint: 'at purchase cost, as on today' },
]

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

function presets() {
  const now = new Date(); const y = now.getFullYear(); const m = now.getMonth()
  const fy = m >= 3 ? y : y - 1
  return [
    { id: 'month', label: 'This month', from: iso(new Date(y, m, 1)), to: iso(now) },
    { id: 'last', label: 'Last month', from: iso(new Date(y, m - 1, 1)), to: iso(new Date(y, m, 0)) },
    { id: 'q', label: 'This quarter', from: iso(new Date(y, Math.floor(m / 3) * 3, 1)), to: iso(now) },
    { id: 'fy', label: `FY ${fy}-${String(fy + 1).slice(2)}`, from: `${fy}-04-01`, to: iso(now) },
    { id: 'lfy', label: `FY ${fy - 1}-${String(fy).slice(2)}`, from: `${fy - 1}-04-01`, to: `${fy}-03-31` },
  ]
}

/** "Export for CA": one Excel workbook (a sheet per register) for a chosen period. Owner / manager only. */
export function CaExportButton() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="btn-primary flex items-center gap-2">
        <FileSpreadsheet className="w-4 h-4" /> Export for CA (Excel)
      </button>
      {open && <CaExportModal onClose={() => setOpen(false)} />}
    </>
  )
}

function CaExportModal({ onClose }: { onClose: () => void }) {
  const P = presets()
  const [range, setRange] = useState({ from: P[3]!.from, to: P[3]!.to })
  const [picked, setPicked] = useState<Set<string>>(new Set(SHEETS.map((s) => s.key)))
  const [busy, setBusy] = useState(false)
  const toggle = (k: string) => setPicked((p) => { const n = new Set(p); if (n.has(k)) n.delete(k); else n.add(k); return n })
  const bad = !range.from || !range.to || range.from > range.to || picked.size === 0

  async function download() {
    setBusy(true)
    try {
      const params: Record<string, string> = { from: range.from, to: range.to }
      if (picked.size < SHEETS.length) params['only'] = [...picked].join(',')
      const blob = await tyreApi.caPack(params)
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob)
      a.download = `CA-pack_${range.from}_to_${range.to}.xlsx`; a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
      toast.success('Excel downloaded'); onClose()
    } catch (e) { toast.error(await blobError(e)) } finally { setBusy(false) }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl w-full max-w-lg p-6 space-y-4 max-h-[95vh] overflow-y-auto">
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-base font-semibold text-gray-900">Export for your CA</h3>
            <p className="text-xs text-gray-500">One Excel file, a sheet for each register. Share it by email or WhatsApp.</p>
          </div>
          <button type="button" aria-label="Close" onClick={onClose} className="text-gray-400 hover:text-gray-600"><X className="w-4 h-4" /></button>
        </div>
        <div>
          <div className="label">Period</div>
          <div className="flex flex-wrap gap-2 mb-2">
            {P.map((p) => (
              <button key={p.id} type="button" onClick={() => setRange({ from: p.from, to: p.to })}
                className={`text-xs px-2.5 py-1 rounded-full border ${range.from === p.from && range.to === p.to ? 'bg-primary-50 border-primary-600 text-primary-700' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}>{p.label}</button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <input type="date" aria-label="From" className="input" value={range.from} max={range.to} onChange={(e) => setRange({ ...range, from: e.target.value })} />
            <input type="date" aria-label="To" className="input" value={range.to} min={range.from} onChange={(e) => setRange({ ...range, to: e.target.value })} />
          </div>
        </div>
        <div>
          <div className="flex items-center justify-between">
            <div className="label">Sheets to include</div>
            <button type="button" className="text-xs text-blue-600 hover:underline"
              onClick={() => setPicked(picked.size === SHEETS.length ? new Set() : new Set(SHEETS.map((s) => s.key)))}>{picked.size === SHEETS.length ? 'Clear all' : 'Select all'}</button>
          </div>
          <ul className="grid sm:grid-cols-2 gap-x-4 gap-y-1">
            {SHEETS.map((s) => (
              <li key={s.key}>
                <label className="flex items-start gap-2 text-sm text-gray-700 cursor-pointer">
                  <input type="checkbox" className="mt-1" checked={picked.has(s.key)} onChange={() => toggle(s.key)} />
                  <span>{s.label}{s.hint && <span className="block text-xs text-gray-400">{s.hint}</span>}</span>
                </label>
              </li>
            ))}
          </ul>
        </div>
        <button type="button" className="btn-primary w-full justify-center" disabled={bad || busy} onClick={download}>
          {busy ? 'Preparing…' : 'Download Excel'}
        </button>
      </div>
    </div>
  )
}

/** an error response to a blob request arrives as a Blob of JSON — read the message out of it */
async function blobError(e: any): Promise<string> {
  const d = e?.response?.data
  if (d instanceof Blob) { try { return JSON.parse(await d.text()).error ?? 'Could not prepare the Excel' } catch { /* fall through */ } }
  return apiError(e)
}
