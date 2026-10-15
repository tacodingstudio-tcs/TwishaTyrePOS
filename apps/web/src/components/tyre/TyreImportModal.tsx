// Add many tyres at once: from an Excel / CSV sheet, or by photographing the supplier's bill (AI).
// Both end in the same editable table → "Check" (preview, saves nothing) → "Import".
import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import * as XLSX from 'xlsx'
import { FileSpreadsheet, Camera, Download, X, AlertTriangle } from 'lucide-react'
import { api, apiError } from '@/lib/api'

interface Row {
  brand: string; size: string; pattern: string; name: string; kind: string; vehicleType: string
  salePrice: string; purchasePrice: string; mrp: string; gstRate: string; hsn: string
  stock: string; reorderLevel: string; warrantyMonths: string; sku: string; billedAs?: string
}
const EMPTY: Row = {
  brand: '', size: '', pattern: '', name: '', kind: 'tyre', vehicleType: 'car', salePrice: '', purchasePrice: '', mrp: '',
  gstRate: '', hsn: '', stock: '', reorderLevel: '', warrantyMonths: '', sku: '',
}

// Column headings people actually use → our field
const HEAD: Record<string, keyof Row> = {
  brand: 'brand', company: 'brand', make: 'brand',
  size: 'size', 'tyre size': 'size', 'tire size': 'size',
  pattern: 'pattern', model: 'pattern', 'pattern/model': 'pattern',
  name: 'name', item: 'name', 'item name': 'name', description: 'name', product: 'name',
  type: 'kind', kind: 'kind', 'item type': 'kind',
  vehicle: 'vehicleType', 'vehicle type': 'vehicleType', category: 'vehicleType',
  'sale price': 'salePrice', 'selling price': 'salePrice', price: 'salePrice', 'data entry': 'salePrice', rate: 'salePrice',
  'purchase price': 'purchasePrice', 'buying price': 'purchasePrice', cost: 'purchasePrice', 'purchase rate': 'purchasePrice',
  mrp: 'mrp', gst: 'gstRate', 'gst %': 'gstRate', 'gst rate': 'gstRate', hsn: 'hsn', 'hsn code': 'hsn',
  stock: 'stock', qty: 'stock', quantity: 'stock', 'qty received': 'stock', received: 'stock', 'opening stock': 'stock',
  'reorder level': 'reorderLevel', reorder: 'reorderLevel', 'min stock': 'reorderLevel', 'low stock': 'reorderLevel',
  warranty: 'warrantyMonths', 'warranty months': 'warrantyMonths', 'warranty (months)': 'warrantyMonths',
  sku: 'sku', code: 'sku', 'item code': 'sku',
}
const KIND_ALIAS: Record<string, string> = {
  tyre: 'tyre', tire: 'tyre', tube: 'tube', flap: 'flap', wheel: 'alloy_wheel', alloy: 'alloy_wheel', 'alloy wheel': 'alloy_wheel',
  valve: 'valve', battery: 'battery', accessory: 'accessory',
}
const VEHICLE_ALIAS: Record<string, string> = {
  car: 'car', suv: 'suv', jeep: 'suv', bike: 'two_wheeler', 'two wheeler': 'two_wheeler', 'two-wheeler': 'two_wheeler', '2 wheeler': 'two_wheeler',
  '2w': 'two_wheeler', scooter: 'two_wheeler', motorcycle: 'two_wheeler', auto: 'three_wheeler', rickshaw: 'three_wheeler',
  'three wheeler': 'three_wheeler', truck: 'truck_bus', bus: 'truck_bus', 'truck/bus': 'truck_bus', 'truck & bus': 'truck_bus',
  lcv: 'lcv', tractor: 'tractor', otr: 'otr', other: 'other',
}
const VEHICLE_LABEL: Record<string, string> = {
  car: 'Car', suv: 'SUV', two_wheeler: 'Two wheeler', three_wheeler: 'Auto', truck_bus: 'Truck / Bus', lcv: 'LCV', tractor: 'Tractor', otr: 'OTR', other: 'Other',
}

const num = (v: string): number | undefined => {
  const n = Number(String(v).replace(/[₹,\s]/g, ''))
  return v.trim() !== '' && Number.isFinite(n) ? n : undefined
}

function toPayload(r: Row) {
  return {
    brand: r.brand.trim() || undefined, size: r.size.trim() || undefined, pattern: r.pattern.trim() || undefined,
    name: r.name.trim() || undefined, kind: r.kind, vehicleType: r.vehicleType,
    salePrice: num(r.salePrice), purchasePrice: num(r.purchasePrice), mrp: num(r.mrp), gstRate: num(r.gstRate),
    hsn: r.hsn.trim() || undefined, stock: num(r.stock), reorderLevel: num(r.reorderLevel),
    warrantyMonths: num(r.warrantyMonths) !== undefined ? Math.round(num(r.warrantyMonths)!) : undefined, sku: r.sku.trim() || undefined,
  }
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
        if (!f) continue
        ;(r as any)[f] = String(v ?? '').trim()
      }
      r.kind = KIND_ALIAS[r.kind.toLowerCase()] ?? 'tyre'
      r.vehicleType = VEHICLE_ALIAS[r.vehicleType.toLowerCase()] ?? 'car'
      return r
    }).filter((r) => r.brand || r.size || r.name)
  })
}

function downloadTemplate() {
  const rows = [
    { Brand: 'Yokohama', Size: '185/65 R15', Pattern: 'BluEarth', Type: 'tyre', Vehicle: 'car', 'Sale Price': 6500, 'Purchase Price': 5400, 'GST %': 18,
      HSN: '4011', Stock: 8, 'Reorder Level': 4, 'Warranty Months': 36 },
    { Brand: 'Apollo', Size: '2.75-18', Pattern: '', Type: 'tyre', Vehicle: 'bike', 'Sale Price': 2000, 'Purchase Price': 1650, 'GST %': 18,
      HSN: '4011', Stock: 10, 'Reorder Level': 3, 'Warranty Months': 0 },
    { Brand: 'MRF', Size: '4.00-8', Pattern: '', Type: 'tube', Vehicle: 'bike', 'Sale Price': 350, 'Purchase Price': 280, 'GST %': 18,
      HSN: '4013', Stock: 20, 'Reorder Level': 5, 'Warranty Months': 0 },
  ]
  const ws = XLSX.utils.json_to_sheet(rows)
  ws['!cols'] = Object.keys(rows[0]!).map((k) => ({ wch: Math.max(12, k.length + 2) }))
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Tyres')
  XLSX.writeFile(wb, 'tyre-stock-template.xlsx')
}

export function TyreImportModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const [rows, setRows] = useState<Row[]>([])
  const [source, setSource] = useState<'excel' | 'scan' | null>(null)
  const [scanInfo, setScanInfo] = useState<{ supplier?: string | null; billNo?: string | null; confidence?: number } | null>(null)
  const [report, setReport] = useState<any | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const photoRef = useRef<HTMLInputElement>(null)

  const { data: ai } = useQuery({
    queryKey: ['tyre-ai-status'], staleTime: 60_000,
    queryFn: () => api.get('/tyre/import/ai-status').then((r) => r.data as { enabled: boolean; configured: boolean; available: boolean }),
  })

  const setCell = (i: number, k: keyof Row, v: string) => { setReport(null); setRows((rs) => rs.map((r, n) => (n === i ? { ...r, [k]: v } : r))) }

  const readFile = async (f?: File) => {
    if (!f) return
    try {
      const parsed = await parseSheet(f)
      if (!parsed.length) { toast.error('No rows found — check the column headings (download the template)'); return }
      setRows(parsed); setSource('excel'); setReport(null); setScanInfo(null)
    } catch { toast.error('Could not read that file. Use .xlsx or .csv') }
  }

  const scan = useMutation({
    mutationFn: async (f: File) => {
      const b64: string = await new Promise((res, rej) => {
        const fr = new FileReader()
        fr.onload = () => res(String(fr.result))
        fr.onerror = () => rej(new Error('Could not read the photo'))
        fr.readAsDataURL(f)
      })
      const mediaType = f.type === 'image/png' ? 'image/png' : f.type === 'image/webp' ? 'image/webp' : 'image/jpeg'
      return api.post('/tyre/import/scan-bill', { imageBase64: b64, mediaType }, { timeout: 120_000 }).then((r) => r.data)
    },
    onSuccess: (d: any) => {
      setRows((d.rows as any[]).map((x) => ({
        ...EMPTY, brand: x.brand ?? '', size: x.size ?? '', pattern: x.pattern ?? '', name: x.name ?? '', kind: x.kind ?? 'tyre',
        vehicleType: x.vehicleType ?? 'car', stock: x.stock != null ? String(x.stock) : '',
        purchasePrice: x.purchasePrice != null ? String(x.purchasePrice) : '', gstRate: x.gstRate != null ? String(x.gstRate) : '',
        hsn: x.hsn ?? '', billedAs: x.billedAs,
      })))
      setScanInfo({ supplier: d.supplier, billNo: d.billNo, confidence: d.confidence })
      setSource('scan'); setReport(null)
      toast.success(`Read ${d.rows.length} line${d.rows.length === 1 ? '' : 's'} — please check them`)
    },
    onError: (e) => toast.error(apiError(e)),
  })

  const run = useMutation({
    mutationFn: (dryRun: boolean) => api.post('/tyre/import/products', { rows: rows.map(toPayload), dryRun }).then((r) => r.data),
    onSuccess: (d, dryRun) => {
      setReport(d)
      if (!dryRun) {
        toast.success(`${d.created} added, ${d.updated} updated, ${d.stockAdded} tyres received`)
        for (const k of ['products', 'tyre-finder', 'stock-levels', 'ai-reorder']) qc.invalidateQueries({ queryKey: [k] })
        qc.invalidateQueries()
      }
    },
    onError: (e) => toast.error(apiError(e)),
  })

  const byRow = new Map<number, any>((report?.rows ?? []).map((r: any) => [r.row, r]))
  const imported = !!report && !report.dryRun
  const canImport = rows.length > 0 && !run.isPending && !imported

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl w-full max-w-6xl max-h-[92vh] flex flex-col">
        <div className="p-5 border-b border-gray-100 flex items-start justify-between gap-4">
          <div>
            <h3 className="text-base font-semibold text-gray-900">Add many tyres at once</h3>
            <p className="text-xs text-gray-500 mt-0.5">
              New tyres are created. A tyre that already exists gets its prices updated and the Stock column <b>added</b> to what is on the shelf.
            </p>
          </div>
          <button type="button" onClick={onClose} className="p-1 text-gray-400 hover:text-gray-600" aria-label="Close"><X className="w-5 h-5" /></button>
        </div>

        <div className="p-5 overflow-y-auto space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <button type="button" onClick={() => fileRef.current?.click()}
              className="border border-gray-200 rounded-lg p-4 text-left hover:border-primary-300 hover:bg-primary-50">
              <FileSpreadsheet className="w-5 h-5 text-primary-600 mb-2" />
              <div className="text-sm font-medium text-gray-900">From an Excel / CSV sheet</div>
              <div className="text-xs text-gray-500">Choose your .xlsx or .csv file</div>
            </button>
            {ai?.enabled === false ? null : (
              <button type="button" disabled={!ai?.available || scan.isPending} onClick={() => photoRef.current?.click()}
                className={`border rounded-lg p-4 text-left ${ai?.available ? 'border-gray-200 hover:border-primary-300 hover:bg-primary-50' : 'border-gray-100 bg-gray-50 opacity-70 cursor-not-allowed'}`}>
                <Camera className="w-5 h-5 text-primary-600 mb-2" />
                <div className="text-sm font-medium text-gray-900">{scan.isPending ? 'Reading the bill…' : 'Scan a supplier bill (AI)'}</div>
                <div className="text-xs text-gray-500">
                  {ai?.available ? 'Photo of the purchase bill → tyres and quantities' : 'Needs internet and an AI key on the server — use Excel instead'}
                </div>
              </button>
            )}
            <button type="button" onClick={downloadTemplate}
              className="border border-gray-200 rounded-lg p-4 text-left hover:border-primary-300 hover:bg-primary-50">
              <Download className="w-5 h-5 text-primary-600 mb-2" />
              <div className="text-sm font-medium text-gray-900">Download the Excel template</div>
              <div className="text-xs text-gray-500">Fill it in, then choose it here</div>
            </button>
          </div>
          <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv,text/csv" className="hidden" onChange={(e) => { readFile(e.target.files?.[0]); e.target.value = '' }} />
          <input ref={photoRef} type="file" accept="image/*" capture="environment" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) scan.mutate(f); e.target.value = '' }} />

          {source === 'scan' && scanInfo && (
            <div className="text-xs bg-amber-50 border border-amber-200 text-amber-800 rounded-lg p-3 flex gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>
                Read from {scanInfo.supplier ? <b>{scanInfo.supplier}</b> : 'the bill'}{scanInfo.billNo ? ` · bill ${scanInfo.billNo}` : ''}
                {scanInfo.confidence != null ? ` · confidence ${(scanInfo.confidence * 100).toFixed(0)}%` : ''}.
                Scanned text can be misread — check every size and quantity. Purchase price is from the bill; enter a sale price for any tyre marked “new”.
              </span>
            </div>
          )}

          {rows.length > 0 && (
            <div className="overflow-x-auto border border-gray-100 rounded-lg">
              <table className="w-full text-xs">
                <thead className="bg-gray-50 text-gray-500">
                  <tr>
                    <th className="p-2 text-left">#</th><th className="p-2 text-left">Brand</th><th className="p-2 text-left">Size</th>
                    <th className="p-2 text-left">Pattern</th><th className="p-2 text-left">Type</th><th className="p-2 text-left">Vehicle</th>
                    <th className="p-2 text-right">Sale price</th><th className="p-2 text-right">Buy price</th><th className="p-2 text-right">Stock +</th>
                    <th className="p-2 text-right">Reorder</th><th className="p-2 text-left">Result</th><th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => {
                    const res = byRow.get(i + 1)
                    return (
                      <tr key={i} className="border-t border-gray-50 align-top">
                        <td className="p-1.5 text-gray-400">{i + 1}</td>
                        <td className="p-1"><input className="input py-1 text-xs w-28" value={r.brand} onChange={(e) => setCell(i, 'brand', e.target.value)} /></td>
                        <td className="p-1"><input className="input py-1 text-xs w-28" value={r.size} onChange={(e) => setCell(i, 'size', e.target.value)} />
                          {r.billedAs && <div className="text-[10px] text-gray-400 mt-0.5 max-w-[7rem] truncate" title={r.billedAs}>bill: {r.billedAs}</div>}</td>
                        <td className="p-1"><input className="input py-1 text-xs w-24" value={r.pattern} onChange={(e) => setCell(i, 'pattern', e.target.value)} /></td>
                        <td className="p-1">
                          <select className="input py-1 text-xs w-24" value={r.kind} onChange={(e) => setCell(i, 'kind', e.target.value)}>
                            {['tyre', 'tube', 'flap', 'alloy_wheel', 'valve', 'battery', 'accessory'].map((k) => <option key={k} value={k}>{k.replace('_', ' ')}</option>)}
                          </select></td>
                        <td className="p-1">
                          <select className="input py-1 text-xs w-28" value={r.vehicleType} onChange={(e) => setCell(i, 'vehicleType', e.target.value)}>
                            {Object.entries(VEHICLE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                          </select></td>
                        <td className="p-1"><input type="number" className="input py-1 text-xs w-24 text-right" value={r.salePrice} onChange={(e) => setCell(i, 'salePrice', e.target.value)} /></td>
                        <td className="p-1"><input type="number" className="input py-1 text-xs w-24 text-right" value={r.purchasePrice} onChange={(e) => setCell(i, 'purchasePrice', e.target.value)} /></td>
                        <td className="p-1"><input type="number" className="input py-1 text-xs w-16 text-right" value={r.stock} onChange={(e) => setCell(i, 'stock', e.target.value)} /></td>
                        <td className="p-1"><input type="number" className="input py-1 text-xs w-16 text-right" value={r.reorderLevel} onChange={(e) => setCell(i, 'reorderLevel', e.target.value)} /></td>
                        <td className="p-1.5 min-w-[9rem]">
                          {res && (res.action === 'error'
                            ? <span className="text-red-600">{res.error}</span>
                            : <span className={res.action === 'create' ? 'text-green-700' : 'text-blue-700'}>
                                {res.action === 'create' ? 'New tyre' : 'Update'}{res.stockAdded ? ` · +${res.stockAdded} stock` : ''}
                              </span>)}
                        </td>
                        <td className="p-1"><button type="button" className="text-gray-400 hover:text-red-600" title="Remove row"
                          onClick={() => { setReport(null); setRows((rs) => rs.filter((_, n) => n !== i)) }}><X className="w-3.5 h-3.5" /></button></td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}

          {report && (
            <div className={`text-sm rounded-lg p-3 border ${report.failed ? 'bg-amber-50 border-amber-200 text-amber-800' : 'bg-green-50 border-green-200 text-green-800'}`}>
              {report.dryRun ? 'Preview (nothing saved yet): ' : 'Done: '}
              <b>{report.created}</b> new, <b>{report.updated}</b> updated, <b>{report.stockAdded}</b> tyres of stock{' '}
              {report.failed ? <>· <b>{report.failed}</b> row{report.failed === 1 ? '' : 's'} need fixing (shown in red)</> : '· all rows look good'}
              {!report.dryRun && report.created + report.updated > 0 && (
                <span className="block text-xs mt-1">Stock Levels, Tyres &amp; Items and the New Sale search are already up to date.</span>
              )}
            </div>
          )}
        </div>

        <div className="p-4 border-t border-gray-100 flex items-center justify-between gap-3">
          <span className="text-xs text-gray-500">{rows.length ? `${rows.length} row${rows.length === 1 ? '' : 's'}` : 'Choose a file or scan a bill to begin'}</span>
          <div className="flex gap-2">
            <button type="button" className="btn-ghost border border-gray-200" onClick={onClose}>{imported ? 'Close' : 'Cancel'}</button>
            {!imported && (
              <>
                <button type="button" className="btn-ghost border border-gray-200" disabled={!rows.length || run.isPending} onClick={() => run.mutate(true)}>
                  Check
                </button>
                <button type="button" className="btn-primary" disabled={!canImport || (report && report.dryRun && report.failed === rows.length)} onClick={() => run.mutate(false)}>
                  {run.isPending ? 'Working…' : `Import ${rows.length || ''}`}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
