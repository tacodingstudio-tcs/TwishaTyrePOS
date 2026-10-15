// Sales & margin by size / brand / item, and dead stock.
import { useState } from 'react'
import { localIso, localMonth } from '@/lib/dates'
import { useQuery } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { tyreApi, apiError } from '@/lib/api'
import { PageHeader } from '@/components/layout/PageHeader'
import { inr, num, fmtDate } from '@/components/tyre/format'

type Tab = 'size' | 'brand' | 'product' | 'vehicle_type' | 'dead'
const TABS: Array<[Tab, string]> = [['size', 'By size'], ['brand', 'By brand'], ['product', 'By item'], ['vehicle_type', 'By vehicle'], ['dead', 'Dead stock']]

const monthStart = () => `${localMonth()}-01`
const today = () => localIso()

export function TyreReportsPage() {
  const [tab, setTab] = useState<Tab>('size')
  const [from, setFrom] = useState(monthStart())
  const [to, setTo] = useState(today())
  const [days, setDays] = useState(90)

  const sales = useQuery({
    queryKey: ['tyre-report', tab, from, to], enabled: tab !== 'dead',
    queryFn: () => tyreApi.salesReport({ by: tab, from, to }),
  })
  const dead = useQuery({ queryKey: ['tyre-dead', days], enabled: tab === 'dead', queryFn: () => tyreApi.deadStock(days) })

  return (
    <div>
      <PageHeader title="Reports" subtitle="What sells, what it earns, and what is sitting on the shelf"
        action={<button type="button" className="btn-ghost border border-gray-200 text-sm" onClick={async () => {
          try {
            const blob = await tyreApi.pdfBlob(`/reports/register?format=csv&from=${from}&to=${to}`)
            const url = URL.createObjectURL(blob)
            const a = document.createElement('a')
            a.href = url; a.download = `bill-register-${from}-to-${to}.csv`; a.click()
            setTimeout(() => URL.revokeObjectURL(url), 5000)
          } catch (e) { toast.error(apiError(e)) }
        }}>Download bill register (Excel)</button>} />
      <div className="p-6 space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          {TABS.map(([k, label]) => (
            <button key={k} type="button" onClick={() => setTab(k)}
              className={`px-3 py-1.5 rounded-lg text-sm ${tab === k ? 'bg-primary-600 text-white' : 'bg-white border border-gray-200 text-gray-700 hover:bg-gray-50'}`}>{label}</button>
          ))}
          <div className="ml-auto flex items-center gap-2 text-sm">
            {tab !== 'dead' ? (
              <>
                <input type="date" className="input w-auto" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From" />
                <span className="text-gray-400">to</span>
                <input type="date" className="input w-auto" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To" />
              </>
            ) : (
              <>
                <span className="text-gray-500">Not sold for</span>
                <select className="input w-auto" value={days} onChange={(e) => setDays(Number(e.target.value))}>
                  {[30, 60, 90, 180, 365].map((d) => <option key={d} value={d}>{d} days</option>)}
                </select>
              </>
            )}
          </div>
        </div>

        {tab !== 'dead' && (
          <section className="card overflow-hidden">
            {sales.isLoading ? <p className="p-8 text-center text-gray-400">Loading…</p> : (
              <>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 p-5 border-b border-gray-100">
                  <div><div className="text-xs text-gray-400">Units</div><div className="text-lg font-semibold">{num(sales.data?.totals.units)}</div></div>
                  <div><div className="text-xs text-gray-400">Sales (ex GST)</div><div className="text-lg font-semibold">{inr(sales.data?.totals.revenue)}</div></div>
                  <div><div className="text-xs text-gray-400">Margin</div><div className="text-lg font-semibold">{inr(sales.data?.totals.margin)}</div></div>
                  <div><div className="text-xs text-gray-400">Margin %</div><div className="text-lg font-semibold">{sales.data?.totals.marginPct}%</div></div>
                </div>
                {(sales.data?.data ?? []).length === 0 ? <p className="p-8 text-center text-sm text-gray-500">No sales in this period.</p> : (
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 text-xs uppercase text-gray-500">
                      <tr><th className="text-left px-4 py-3">{TABS.find((t) => t[0] === tab)?.[1].replace('By ', '')}</th><th className="text-right px-4 py-3">Units</th>
                        <th className="text-right px-4 py-3">Bills</th><th className="text-right px-4 py-3">Sales</th><th className="text-right px-4 py-3">Margin</th><th className="text-right px-4 py-3">%</th></tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {(sales.data?.data ?? []).map((r: any) => (
                        <tr key={r.label} className="hover:bg-gray-50">
                          <td className="px-4 py-3 font-medium text-gray-900">{r.label}</td>
                          <td className="px-4 py-3 text-right">{num(r.units)}</td>
                          <td className="px-4 py-3 text-right text-gray-500">{r.bills}</td>
                          <td className="px-4 py-3 text-right">{inr(r.revenue)}</td>
                          <td className="px-4 py-3 text-right">{inr(r.margin)}</td>
                          <td className={`px-4 py-3 text-right ${r.marginPct < 8 ? 'text-red-600' : r.marginPct < 15 ? 'text-amber-600' : 'text-green-700'}`}>{r.marginPct}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                <p className="px-5 py-3 text-xs text-gray-400 border-t border-gray-100">{sales.data?.note}</p>
              </>
            )}
          </section>
        )}

        {tab === 'dead' && (
          <section className="card overflow-hidden">
            {dead.isLoading ? <p className="p-8 text-center text-gray-400">Loading…</p> : (
              <>
                <div className="p-5 border-b border-gray-100 text-sm text-gray-700">
                  <strong>{dead.data?.count ?? 0}</strong> item{dead.data?.count === 1 ? '' : 's'} not sold for {days}+ days · <strong>{inr(dead.data?.stockValue)}</strong> of stock at purchase cost
                </div>
                {(dead.data?.data ?? []).length === 0 ? <p className="p-8 text-center text-sm text-gray-500">Nothing is stuck. 🎉</p> : (
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 text-xs uppercase text-gray-500">
                      <tr><th className="text-left px-4 py-3">Item</th><th className="text-left px-4 py-3">Size</th><th className="text-right px-4 py-3">Stock</th>
                        <th className="text-right px-4 py-3">Value</th><th className="text-left px-4 py-3">Last sold</th><th className="text-right px-4 py-3">Idle</th></tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {(dead.data?.data ?? []).map((r: any) => (
                        <tr key={r.id} className="hover:bg-gray-50">
                          <td className="px-4 py-3 font-medium text-gray-900">{r.name}<div className="text-xs text-gray-400 font-normal">{r.brand}</div></td>
                          <td className="px-4 py-3 text-gray-600">{r.size ?? '—'}</td>
                          <td className="px-4 py-3 text-right">{num(r.stock)}</td>
                          <td className="px-4 py-3 text-right">{inr(r.stockValue)}</td>
                          <td className="px-4 py-3 text-gray-600">{r.lastSold ? fmtDate(r.lastSold) : 'Never sold'}</td>
                          <td className="px-4 py-3 text-right text-amber-700">{r.idleDays} d</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </>
            )}
          </section>
        )}
      </div>
    </div>
  )
}
