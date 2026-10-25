// Day-by-day sales for the period chosen on the dashboard, with a download to Excel.
import { useMemo } from 'react'
import * as XLSX from 'xlsx'
import { Download } from 'lucide-react'
import { format } from 'date-fns'

export interface DayRow { period: string; revenue: number; invoices: number; collected: number }

const inr = (n: number) => '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: 0 })
const dmy = (iso: string) => format(new Date(`${iso}T00:00:00`), 'dd-MM-yyyy')

export function DailyReport({ rows, label, from, to, expenses, isLoading }: {
  rows: DayRow[]; label: string; from: string; to: string; expenses?: number; isLoading: boolean
}) {
  const list = useMemo(() => rows.filter((r) => r.invoices > 0 || r.revenue !== 0)
    .map((r) => ({ day: String(r.period).slice(0, 10), bills: Number(r.invoices), sales: Number(r.revenue), collected: Number(r.collected) }))
    .sort((a, b) => (a.day < b.day ? 1 : -1)), [rows])
  const tot = list.reduce((t, r) => ({ bills: t.bills + r.bills, sales: t.sales + r.sales, collected: t.collected + r.collected }), { bills: 0, sales: 0, collected: 0 })

  function exportExcel() {
    const wb = XLSX.utils.book_new()
    const asc = [...list].reverse()
    const sheet = XLSX.utils.aoa_to_sheet([
      [`Daily sales report — ${label}`], [`${dmy(from)} to ${dmy(to)}`], [],
      ['Date', 'Day', 'Bills', 'Sales (₹)', 'Collected (₹)', 'Pending (₹)'],
      ...asc.map((r) => [dmy(r.day), format(new Date(`${r.day}T00:00:00`), 'EEEE'), r.bills, r.sales, r.collected, Math.round((r.sales - r.collected) * 100) / 100]),
      ['Total', '', tot.bills, tot.sales, tot.collected, Math.round((tot.sales - tot.collected) * 100) / 100],
    ])
    sheet['!cols'] = [{ wch: 13 }, { wch: 12 }, { wch: 8 }, { wch: 15 }, { wch: 15 }, { wch: 15 }]
    XLSX.utils.book_append_sheet(wb, sheet, 'Daily report')
    const sum = XLSX.utils.aoa_to_sheet([
      ['Summary'], ['Period', `${dmy(from)} to ${dmy(to)}`], ['Bills', tot.bills], ['Sales (₹)', tot.sales], ['Collected (₹)', tot.collected],
      ['Pending on these bills (₹)', Math.round((tot.sales - tot.collected) * 100) / 100],
      ...(expenses != null ? [['Expenses (₹)', expenses], ['Sales minus expenses (₹)', Math.round((tot.sales - expenses) * 100) / 100]] : []),
    ])
    sum['!cols'] = [{ wch: 30 }, { wch: 28 }]
    XLSX.utils.book_append_sheet(wb, sum, 'Summary')
    XLSX.writeFile(wb, `Daily-report_${from}_to_${to}.xlsx`)
  }

  return (
    <div className="card p-5">
      <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
        <h2 className="text-sm font-semibold text-gray-900">Daily report — {label.toLowerCase()}</h2>
        <button type="button" onClick={exportExcel} disabled={!list.length}
          className="flex items-center gap-1.5 text-sm px-3 py-1.5 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 disabled:opacity-50">
          <Download className="w-3.5 h-3.5" /> Export to Excel
        </button>
      </div>
      {isLoading ? <div className="py-8 text-center text-sm text-gray-400">Loading…</div>
        : !list.length ? <div className="py-8 text-center text-sm text-gray-400">No sales in this period</div>
        : (
          <div className="overflow-auto max-h-96 border border-gray-100 rounded-lg">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs text-gray-500 sticky top-0">
                <tr><th className="text-left px-3 py-2 font-medium">Date</th><th className="text-right px-3 py-2 font-medium">Bills</th>
                  <th className="text-right px-3 py-2 font-medium">Sales</th><th className="text-right px-3 py-2 font-medium">Collected</th><th className="text-right px-3 py-2 font-medium">Pending</th></tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {list.map((r) => (
                  <tr key={r.day} className="hover:bg-gray-50">
                    <td className="px-3 py-2 whitespace-nowrap">{format(new Date(`${r.day}T00:00:00`), 'EEE, d MMM yyyy')}</td>
                    <td className="px-3 py-2 text-right">{r.bills}</td>
                    <td className="px-3 py-2 text-right font-medium">{inr(r.sales)}</td>
                    <td className="px-3 py-2 text-right text-green-700">{inr(r.collected)}</td>
                    <td className={`px-3 py-2 text-right ${r.sales - r.collected > 0.5 ? 'text-orange-600' : 'text-gray-400'}`}>{r.sales - r.collected > 0.5 ? inr(r.sales - r.collected) : '—'}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-gray-50 font-semibold sticky bottom-0">
                <tr><td className="px-3 py-2">Total ({list.length} day{list.length === 1 ? '' : 's'})</td><td className="px-3 py-2 text-right">{tot.bills}</td>
                  <td className="px-3 py-2 text-right">{inr(tot.sales)}</td><td className="px-3 py-2 text-right text-green-700">{inr(tot.collected)}</td>
                  <td className="px-3 py-2 text-right text-orange-600">{inr(Math.max(0, tot.sales - tot.collected))}</td></tr>
              </tfoot>
            </table>
          </div>
        )}
    </div>
  )
}
