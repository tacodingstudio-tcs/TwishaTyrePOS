// Home: today at the counter, money to collect, stock position, and what needs a phone call.
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Boxes, ShieldCheck, BellRing, Wallet, TrendingUp, AlertTriangle } from 'lucide-react'
import { tyreApi } from '@/lib/api'
import { PageHeader } from '@/components/layout/PageHeader'
import { StatusPill } from '@/components/tyre/StatusPill'
import { inr, num, fmtDate } from '@/components/tyre/format'

function Stat({ label, value, sub, tone = 'default', to }: { label: string; value: string; sub?: string; tone?: 'default' | 'warn' | 'bad' | 'good'; to?: string }) {
  const color = { default: 'text-gray-900', warn: 'text-amber-600', bad: 'text-red-600', good: 'text-green-700' }[tone]
  const body = (
    <div className="card p-5 h-full hover:border-primary-200 transition-colors">
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-2xl font-semibold mt-1 ${color}`}>{value}</div>
      {sub && <div className="text-xs text-gray-400 mt-1">{sub}</div>}
    </div>
  )
  return to ? <Link to={to}>{body}</Link> : body
}

export function TyreDashboardPage() {
  const { data: d, isLoading } = useQuery({ queryKey: ['tyre-dashboard'], queryFn: tyreApi.dashboard, refetchInterval: 60_000 })

  if (isLoading || !d) return <div className="p-8 text-center text-gray-400">Loading…</div>

  return (
    <div>
      <PageHeader
        title="Today"
        subtitle={new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}
      />
      <div className="p-6 space-y-6">

        <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
          <Stat label="Sales today" value={inr(d.today.amount)} sub={`${d.today.bills} bill${d.today.bills === 1 ? '' : 's'} · ${num(d.today.tyres)} items`} />
          <Stat label="This month" value={inr(d.month.amount)} sub={`${d.month.bills} bills · ${num(d.month.tyres)} items`} />
          <Stat label="To collect" value={inr(d.receivable.outstanding)}
            sub={d.receivable.overdueBills > 0 ? `${inr(d.receivable.overdue)} overdue (${d.receivable.overdueBills})` : 'nothing overdue'}
            tone={d.receivable.overdue > 0 ? 'warn' : 'default'} to="/aging" />
          <Stat label="Stock value" value={inr(d.stock.value)} sub={`${num(d.stock.units)} units · ${d.stock.items} items`} to="/inventory/stock" />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Link to="/inventory/stock" className="card p-5 flex items-start gap-3 hover:border-primary-200">
            <Boxes className="w-5 h-5 text-gray-400 mt-0.5" />
            <div>
              <div className="text-sm font-medium text-gray-900">Stock alerts</div>
              <div className="text-sm text-gray-600 mt-1">
                <span className={d.stock.outItems > 0 ? 'text-red-600 font-medium' : ''}>{d.stock.outItems} out of stock</span>
                {' · '}
                <span className={d.stock.lowItems > 0 ? 'text-amber-600 font-medium' : ''}>{d.stock.lowItems} running low</span>
              </div>
            </div>
          </Link>
          <Link to="/tyre/warranty" className="card p-5 flex items-start gap-3 hover:border-primary-200">
            <ShieldCheck className="w-5 h-5 text-gray-400 mt-0.5" />
            <div>
              <div className="text-sm font-medium text-gray-900">Warranty</div>
              <div className="text-sm text-gray-600 mt-1">
                {d.warranty.active} in warranty · <span className={d.warranty.expiring > 0 ? 'text-amber-600 font-medium' : ''}>{d.warranty.expiring} ending in {d.warranty.alertDays} days</span>
              </div>
            </div>
          </Link>
          <Link to="/tyre/reminders" className="card p-5 flex items-start gap-3 hover:border-primary-200">
            <BellRing className="w-5 h-5 text-gray-400 mt-0.5" />
            <div>
              <div className="text-sm font-medium text-gray-900">Customers due for a check</div>
              <div className={`text-sm mt-1 ${d.remindersDue > 0 ? 'text-amber-600 font-medium' : 'text-gray-600'}`}>
                {d.remindersDue > 0 ? `${d.remindersDue} vehicle${d.remindersDue === 1 ? '' : 's'} — call or WhatsApp` : 'None right now'}
              </div>
            </div>
          </Link>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
          <section className="card xl:col-span-2">
            <div className="p-5 border-b border-gray-100 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-900">Latest bills</h2>
              <Link to="/invoices" className="text-xs text-primary-600 hover:underline">All bills</Link>
            </div>
            {d.recent.length === 0 ? (
              <p className="p-8 text-center text-sm text-gray-400">No bills yet — <Link to="/tyre/sale" className="text-primary-600 hover:underline">make the first sale</Link>.</p>
            ) : (
              <ul className="divide-y divide-gray-100">
                {d.recent.map((r: any) => (
                  <li key={r.id}>
                    <Link to={`/invoices/${r.id}`} className="flex items-center justify-between gap-3 p-4 hover:bg-gray-50">
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-gray-900">{r.number} <span className="text-gray-400 font-normal">· {fmtDate(r.date)}</span></div>
                        <div className="text-xs text-gray-500 truncate">{[r.partyName ?? 'Walk-in', r.vehicleNo].filter(Boolean).join(' · ')}</div>
                      </div>
                      <div className="flex items-center gap-3 shrink-0">
                        <StatusPill kind="sale" status={r.status} />
                        <span className="text-sm font-semibold">{inr(r.grandTotal)}</span>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card">
            <div className="p-5 border-b border-gray-100 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-900 flex items-center gap-2"><TrendingUp className="w-4 h-4 text-gray-400" /> Best sizes this month</h2>
            </div>
            {d.topSizes.length === 0 ? <p className="p-6 text-sm text-gray-400">Nothing sold yet this month.</p> : (
              <ul className="p-5 space-y-3">
                {(() => {
                  const max = Math.max(...d.topSizes.map((s: any) => s.units), 1)
                  return d.topSizes.map((s: any) => (
                    <li key={s.size}>
                      <div className="flex justify-between text-sm"><span className="text-gray-700">{s.size}</span><span className="text-gray-500">{num(s.units)}</span></div>
                      <div className="h-1.5 bg-gray-100 rounded-full mt-1"><div className="h-1.5 bg-primary-500 rounded-full" style={{ width: `${(s.units / max) * 100}%` }} /></div>
                    </li>
                  ))
                })()}
              </ul>
            )}
            {d.stock.outItems > 0 && (
              <div className="px-5 pb-5 text-xs text-amber-700 flex items-start gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {d.stock.outItems} catalogue item{d.stock.outItems === 1 ? ' is' : 's are'} out of stock — check before promising a customer.
              </div>
            )}
            <div className="px-5 pb-5"><Link to="/tyre/reports" className="text-xs text-primary-600 hover:underline flex items-center gap-1"><Wallet className="w-3.5 h-3.5" /> Sales & margin reports</Link></div>
          </section>
        </div>
      </div>
    </div>
  )
}
