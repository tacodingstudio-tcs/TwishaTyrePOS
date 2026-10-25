// Add many customers / suppliers at once from an Excel or CSV sheet: choose file → "Check" (saves nothing) → "Import".
import { useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import * as XLSX from 'xlsx'
import { FileSpreadsheet, Download, X } from 'lucide-react'
import { api, apiError } from '@/lib/api'

type Row = { name: string; type: string; phone: string; email: string; gstin: string; address: string; city: string; pincode: string }
const EMPTY: Row = { name: '', type: '', phone: '', email: '', gstin: '', address: '', city: '', pincode: '' }

// Column headings people actually use → our field
const HEAD: Record<string, keyof Row> = {
  name: 'name', 'customer name': 'name', 'party name': 'name', customer: 'name', party: 'name', 'supplier name': 'name',
  type: 'type', 'party type': 'type',
  mobile: 'phone', 'mobile number': 'phone', 'mobile no': 'phone', 'mobile no.': 'phone', phone: 'phone', 'phone number': 'phone', contact: 'phone', 'contact no': 'phone',
  email: 'email', 'email id': 'email', 'e-mail': 'email',
  gstin: 'gstin', 'gst no': 'gstin', 'gst no.': 'gstin', 'gst number': 'gstin', gst: 'gstin', 'gst.no': 'gstin',
  address: 'address', 'address line': 'address',
  city: 'city', town: 'city',
  pincode: 'pincode', pin: 'pincode', 'pin code': 'pincode', zip: 'pincode',
}

function parseSheet(file: File): Promise<Row[]> {
  return file.arrayBuffer().then((buf) => {
    const wb = XLSX.read(buf, { type: 'array' })
    const ws = wb.Sheets[wb.SheetNames[0]!]!
    const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: '' })
    return raw.map((o) => {
      const r: Row = { ...EMPTY }
      for (const [k, v] of Object.entries(o)) {
        const f = HEAD[k.trim().toLowerCase()]
        if (f) r[f] = String(v ?? '').trim()
      }
      return r
    }).filter((r) => r.name)
  })
}

function downloadTemplate() {
  const rows = [
    { Name: 'Bhavinbhai Parmar', Type: 'customer', Mobile: '9876501234', 'GST No': '', Address: 'Navagam', City: 'Veraval', Pincode: '362265', Email: '' },
    { Name: 'Apollo Tyres Dealer', Type: 'supplier', Mobile: '9898012345', 'GST No': '24AAFPS4321K1ZP', Address: 'GIDC', City: 'Rajkot', Pincode: '360003', Email: 'orders@example.com' },
  ]
  const ws = XLSX.utils.json_to_sheet(rows)
  ws['!cols'] = Object.keys(rows[0]!).map((k) => ({ wch: Math.max(14, k.length + 2) }))
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Parties')
  XLSX.writeFile(wb, 'customers-template.xlsx')
}

export function PartyImportModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const [rows, setRows] = useState<Row[]>([])
  const [report, setReport] = useState<any | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const readFile = async (f?: File) => {
    if (!f) return
    try {
      const parsed = await parseSheet(f)
      if (!parsed.length) { toast.error('No rows found — the sheet needs a "Name" column (download the template)'); return }
      if (parsed.length > 2000) { toast.error('Up to 2,000 rows at a time — split the sheet'); return }
      setRows(parsed); setReport(null)
    } catch { toast.error('Could not read that file. Use .xlsx or .csv') }
  }

  const run = useMutation({
    mutationFn: (dryRun: boolean) => api.post('/parties/import', { rows, dryRun }, { timeout: 120_000 }).then((r) => r.data),
    onSuccess: (d, dryRun) => {
      setReport(d)
      if (!dryRun) { toast.success(`${d.created} added`); qc.invalidateQueries() }
    },
    onError: (e) => toast.error(apiError(e)),
  })

  const imported = !!report && !report.dryRun
  const issues: Array<{ row: number; name: string; why: string; kind: string }> = report
    ? [...report.problems.map((x: any) => ({ ...x, kind: 'Problem' })), ...report.skipped.map((x: any) => ({ ...x, kind: 'Skipped' })), ...report.warnings.map((x: any) => ({ ...x, kind: 'Note' }))]
        .sort((a, b) => a.row - b.row)
    : []

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl w-full max-w-3xl max-h-[92vh] flex flex-col">
        <div className="p-5 border-b border-gray-100 flex items-start justify-between gap-4">
          <div>
            <h3 className="text-base font-semibold text-gray-900">Import customers &amp; suppliers</h3>
            <p className="text-xs text-gray-500 mt-0.5">Only <b>Name</b> is required. A mobile already on file is skipped; a wrong mobile or GST number is left blank and listed below.</p>
          </div>
          <button type="button" onClick={onClose} className="p-1 text-gray-400 hover:text-gray-600" aria-label="Close"><X className="w-5 h-5" /></button>
        </div>

        <div className="p-5 overflow-y-auto space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <button type="button" onClick={() => fileRef.current?.click()} className="border border-gray-200 rounded-lg p-4 text-left hover:border-primary-300 hover:bg-primary-50">
              <FileSpreadsheet className="w-5 h-5 text-primary-600 mb-2" />
              <div className="text-sm font-medium text-gray-900">Choose Excel / CSV file</div>
              <div className="text-xs text-gray-500">Columns: Name, Type, Mobile, GST No, Address, City, Pincode, Email</div>
            </button>
            <button type="button" onClick={downloadTemplate} className="border border-gray-200 rounded-lg p-4 text-left hover:border-primary-300 hover:bg-primary-50">
              <Download className="w-5 h-5 text-primary-600 mb-2" />
              <div className="text-sm font-medium text-gray-900">Download the template</div>
              <div className="text-xs text-gray-500">Fill it in Excel, then choose it here</div>
            </button>
          </div>
          <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" aria-label="Choose file"
            onChange={(e) => { void readFile(e.target.files?.[0]); e.target.value = '' }} />

          {rows.length > 0 && (
            <div>
              <div className="text-sm text-gray-700 mb-1"><b>{rows.length}</b> row{rows.length === 1 ? '' : 's'} read{rows.length > 8 ? ' — first 8 shown' : ''}</div>
              <div className="overflow-x-auto border border-gray-100 rounded-lg">
                <table className="w-full text-xs">
                  <thead className="bg-gray-50 text-gray-500"><tr>{['Name', 'Type', 'Mobile', 'GST No', 'City'].map((h) => <th key={h} className="text-left px-3 py-2 font-medium">{h}</th>)}</tr></thead>
                  <tbody className="divide-y divide-gray-100">
                    {rows.slice(0, 8).map((r, i) => (
                      <tr key={i}><td className="px-3 py-1.5">{r.name}</td><td className="px-3 py-1.5">{r.type || 'customer'}</td><td className="px-3 py-1.5">{r.phone}</td><td className="px-3 py-1.5">{r.gstin}</td><td className="px-3 py-1.5">{r.city}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {report && (
            <div className={`rounded-lg border p-3 text-sm ${imported ? 'border-green-200 bg-green-50 text-green-800' : 'border-blue-200 bg-blue-50 text-blue-800'}`}>
              {imported ? 'Done: ' : 'Check result (nothing saved yet): '}<b>{report.created}</b> {imported ? 'added' : 'will be added'}, <b>{report.skipped.length}</b> skipped, <b>{report.problems.length}</b> with problems.
            </div>
          )}
          {issues.length > 0 && (
            <ul className="text-xs divide-y divide-gray-100 border border-gray-100 rounded-lg max-h-56 overflow-y-auto">
              {issues.map((x, i) => (
                <li key={i} className="px-3 py-1.5 flex gap-2">
                  <span className={`shrink-0 w-14 font-medium ${x.kind === 'Problem' ? 'text-red-600' : x.kind === 'Skipped' ? 'text-orange-600' : 'text-gray-500'}`}>{x.kind}</span>
                  <span className="text-gray-500 shrink-0">row {x.row}</span><span className="text-gray-800">{x.name}</span><span className="text-gray-500">— {x.why}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="p-4 border-t border-gray-100 flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>{imported ? 'Close' : 'Cancel'}</button>
          {!imported && <button type="button" className="btn-ghost border border-gray-200" disabled={!rows.length || run.isPending} onClick={() => run.mutate(true)}>Check</button>}
          {!imported && <button type="button" className="btn-primary" disabled={!rows.length || run.isPending} onClick={() => run.mutate(false)}>{run.isPending ? 'Working…' : `Import ${rows.length || ''}`}</button>}
        </div>
      </div>
    </div>
  )
}
