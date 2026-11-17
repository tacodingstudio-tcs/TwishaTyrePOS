// src/pages/InvoiceListPage.tsx
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useInvoices } from '@/hooks/useApi'
import { useAuthStore } from '@/store/auth.store'
import { PageHeader } from '@/components/layout/PageHeader'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { PartyIdSelect } from '@/components/ui/PartyCombobox'
import { Plus, Search, Printer } from 'lucide-react'
import { format } from 'date-fns'
import { ReprintMenu } from '@/components/tyre/ReprintMenu'
import { printPdf } from '@/components/tyre/openPdf'

const B2B_DOMAINS = new Set([
  'wholesale', 'enterprise', 'electronics', 'textile', 'hardware',
  'printing', 'jewellery', 'automobile', 'agri', 'catering', 'tyre',
])

function formatINR(n: number) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(n)
}

// A tyre counter shop works with these; proforma, orders, challans and debit notes stay in the system but off this screen.
const ALL_DOC_TYPE_TABS = [
  { key: '',                label: 'All',          b2bOnly: false },
  { key: 'sale_invoice',    label: 'Sales',        b2bOnly: false },
  { key: 'purchase_invoice',label: 'Purchases',    b2bOnly: false },
  { key: 'quotation',       label: 'Quotations',   b2bOnly: true  },
  { key: 'credit_note',     label: 'Credit Notes', b2bOnly: true  },
  { key: 'sale_return',     label: 'Returns',      b2bOnly: false },
]

const TXN_BADGE: Record<string, string> = {
  sale_invoice:     'bg-blue-100 text-blue-700',
  purchase_invoice: 'bg-purple-100 text-purple-700',
  quotation:        'bg-yellow-100 text-yellow-700',
  proforma:         'bg-indigo-100 text-indigo-700',
  sales_order:      'bg-cyan-100 text-cyan-700',
  delivery_challan: 'bg-orange-100 text-orange-700',
  credit_note:      'bg-green-100 text-green-700',
  debit_note:       'bg-pink-100 text-pink-700',
  sale_return:      'bg-red-100 text-red-700',
  purchase_return:  'bg-red-100 text-red-700',
}

export function InvoiceListPage() {
  const navigate = useNavigate()
  const [search, setSearch]   = useState('')
  const [status, setStatus]   = useState('')
  const [txnType, setTxnType] = useState('')
  const [payMode, setPayMode] = useState('')
  const [sort, setSort]     = useState<'number' | 'date'>('date')   // new bills on top (newest number first)
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate]     = useState('')
  const [minAmount, setMinAmount] = useState('')
  const [maxAmount, setMaxAmount] = useState('')
  const [pending, setPending]   = useState(false)
  const [vehicleNo, setVehicleNo] = useState('')
  const [series, setSeries]     = useState('')
  const [partyId, setPartyId]   = useState('')
  const [page, setPage]       = useState(1)
  const domainType = useAuthStore((s: any) => s.branch?.domainType ?? '')
  const isB2B = B2B_DOMAINS.has(domainType)

  const { data, isLoading } = useInvoices({
    search:  search  || undefined,
    status:  status  || undefined,
    txnType: txnType || undefined,
    sort,
    payMode: payMode || undefined,
    fromDate: fromDate || undefined, toDate: toDate || undefined,
    minAmount: minAmount.trim() !== '' && Number.isFinite(Number(minAmount)) ? Number(minAmount) : undefined,
    maxAmount: maxAmount.trim() !== '' && Number.isFinite(Number(maxAmount)) ? Number(maxAmount) : undefined,
    pending: pending ? 'true' : undefined,
    vehicleNo: vehicleNo.trim() || undefined,
    series: series || undefined,
    partyId: partyId || undefined,
    hideCancelled: true,        // cancelled bills (and the -OLD copies a correction leaves) show only when "Cancelled" is picked
    page,
    limit: 20,
  })

  // quick date ranges (the shop's own calendar day; the financial year runs 1 April - 31 March)
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  function quick(kind: 'today' | 'yesterday' | 'month' | 'lastMonth' | 'fy' | 'clear') {
    const n = new Date(), y = n.getFullYear(), m = n.getMonth()
    const set = (a: Date | null, b: Date | null) => { setFromDate(a ? iso(a) : ''); setToDate(b ? iso(b) : ''); setPage(1) }
    if (kind === 'today') set(n, n)
    else if (kind === 'yesterday') { const d = new Date(y, m, n.getDate() - 1); set(d, d) }
    else if (kind === 'month') set(new Date(y, m, 1), new Date(y, m + 1, 0))
    else if (kind === 'lastMonth') set(new Date(y, m - 1, 1), new Date(y, m, 0))
    else if (kind === 'fy') { const fy = m >= 3 ? y : y - 1; set(new Date(fy, 3, 1), new Date(fy + 1, 2, 31)) }
    else set(null, null)
  }
  const anyFilter = !!(fromDate || toDate || minAmount || maxAmount || pending || vehicleNo || series || partyId || payMode || status || search)
  function clearAll() { setSearch(''); setStatus(''); setPayMode(''); setFromDate(''); setToDate(''); setMinAmount(''); setMaxAmount(''); setPending(false); setVehicleNo(''); setSeries(''); setPartyId(''); setPage(1) }

  function handleTabChange(key: string) {
    setTxnType(key)
    setPage(1)
  }

  return (
    <div>
      <PageHeader
        title={isB2B ? 'Documents' : 'Bills'}
        subtitle={data?.meta ? `${data.meta.total.toLocaleString("en-IN")}${data.meta.capped ? "+" : ""} total${data.meta.capped ? " — type more to narrow it down" : ""}` : undefined}
        action={
          <div className="flex gap-2">
            {txnType === 'purchase_invoice' && (
              <button
                type="button"
                onClick={() => navigate('/invoices/new?txnType=purchase_invoice')}
                className="btn-ghost"
              >
                <Plus className="w-4 h-4" /> New Purchase Bill
              </button>
            )}
            <Link to="/invoices/new" className="btn-primary">
              <Plus className="w-4 h-4" /> {isB2B ? 'New Document' : 'New Bill'}
            </Link>
          </div>
        }
      />

      <div className="p-8 space-y-4">

        {/* Document type tabs */}
        <div className="flex flex-wrap gap-1 pb-1">
          {ALL_DOC_TYPE_TABS.filter(t => isB2B || !t.b2bOnly).map(tab => (
            <button
              key={tab.key}
              type="button"
              onClick={() => handleTabChange(tab.key)}
              className={`px-3 py-1.5 rounded text-sm font-medium whitespace-nowrap transition-colors ${
                txnType === tab.key
                  ? 'bg-primary-600 text-white'
                  : 'bg-white border border-gray-200 text-gray-600 hover:border-gray-300'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Search + status filter */}
        <div className="flex items-center gap-3">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              placeholder="Search by number, customer…"
              value={search}
              onChange={e => { setSearch(e.target.value); setPage(1) }}
              className="input pl-9"
            />
          </div>
          <select
            value={status}
            onChange={e => { setStatus(e.target.value); setPage(1) }}
            className="input w-44"
            title="Filter by status"
          >
            <option value="">All (cancelled hidden)</option>
            <option value="confirmed">Confirmed</option>
            <option value="paid">Paid</option>
            <option value="partial">Partially paid</option>
            <option value="converted">Converted</option>
            <option value="cancelled">Cancelled</option>
          </select>
          <select value={payMode} onChange={e => { setPayMode(e.target.value); setPage(1) }} className="input w-44" title="How it was paid">
            <option value="">Paid by: all</option>
            <option value="cash">Cash</option>
            <option value="upi">UPI</option>
            <option value="card">Card</option>
            <option value="bank_transfer">Bank</option>
            <option value="cheque">Cheque</option>
            <option value="credit">Credit (balance due)</option>
          </select>
          <select value={sort} onChange={e => { setSort(e.target.value as 'number' | 'date'); setPage(1) }} className="input w-52" title="Order of the list">
            <option value="date">Newest first</option>
            <option value="number">Bill number, oldest first</option>
          </select>
        </div>

        {/* more filters: dates, amount, customer, vehicle, register, pending */}
        <div className="flex flex-wrap items-end gap-3">
          <div><label className="label text-xs">From</label><input type="date" className="input w-40" value={fromDate} max={toDate || undefined} onChange={(e) => { setFromDate(e.target.value); setPage(1) }} /></div>
          <div><label className="label text-xs">To</label><input type="date" className="input w-40" value={toDate} min={fromDate || undefined} onChange={(e) => { setToDate(e.target.value); setPage(1) }} /></div>
          <div className="flex flex-wrap gap-1 pb-0.5">
            {([['today', 'Today'], ['yesterday', 'Yesterday'], ['month', 'This month'], ['lastMonth', 'Last month'], ['fy', 'This financial year']] as const).map(([k, l]) => (
              <button key={k} type="button" onClick={() => quick(k)} className="px-2.5 py-1.5 rounded text-xs bg-white border border-gray-200 text-gray-600 hover:border-gray-300">{l}</button>
            ))}
          </div>
          <div><label className="label text-xs">Amount from ₹</label><input className="input w-28" inputMode="decimal" value={minAmount} onChange={(e) => { setMinAmount(e.target.value); setPage(1) }} /></div>
          <div><label className="label text-xs">to ₹</label><input className="input w-28" inputMode="decimal" value={maxAmount} onChange={(e) => { setMaxAmount(e.target.value); setPage(1) }} /></div>
          <div><label className="label text-xs">Vehicle no.</label><input className="input w-36 uppercase" placeholder="GJ05…" maxLength={20} value={vehicleNo} onChange={(e) => { setVehicleNo(e.target.value); setPage(1) }} /></div>
          <div><label className="label text-xs">Register</label>
            <select className="input w-36" value={series} onChange={(e) => { setSeries(e.target.value); setPage(1) }}>
              <option value="">All registers</option><option value="car">Car</option><option value="two_wheel">Two wheeler</option>
            </select></div>
          <div className="w-64"><label className="label text-xs">Customer</label>
            <PartyIdSelect value={partyId} onChange={(id) => { setPartyId(id ?? ''); setPage(1) }} type="customer" placeholder="Any customer" /></div>
          <label className="flex items-center gap-2 text-sm text-gray-700 pb-2 select-none cursor-pointer">
            <input type="checkbox" checked={pending} onChange={(e) => { setPending(e.target.checked); setPage(1) }} /> Balance pending only
          </label>
          {anyFilter && <button type="button" onClick={clearAll} className="text-sm text-primary-600 hover:underline pb-2">Clear all filters</button>}
        </div>

        {/* Table */}
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="text-left px-3 lg:px-5 py-3 font-medium text-gray-500">Number</th>
                {!txnType && <th className="text-left px-3 lg:px-5 py-3 font-medium text-gray-500 hidden lg:table-cell">Type</th>}
                <th className="text-left px-3 lg:px-5 py-3 font-medium text-gray-500">Party</th>
                <th className="text-left px-3 lg:px-5 py-3 font-medium text-gray-500">Date</th>
                <th className="text-right px-3 lg:px-5 py-3 font-medium text-gray-500">Amount</th>
                <th className="text-left px-3 lg:px-5 py-3 font-medium text-gray-500">Paid by</th>
                <th className="text-left px-3 lg:px-5 py-3 font-medium text-gray-500">Status</th>
                <th className="text-right px-3 lg:px-5 py-3 font-medium text-gray-500">Print</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr><td colSpan={8} className="text-center py-12 text-gray-400">Loading…</td></tr>
              )}
              {!isLoading && data?.data?.length === 0 && (
                <tr><td colSpan={7} className="text-center py-12 text-gray-400">No documents found</td></tr>
              )}
              {data?.data?.map((inv: any) => (
                <tr key={inv.id} className="table-row">
                  <td className="px-3 lg:px-5 py-3 whitespace-nowrap">
                    <Link to={`/invoices/${inv.id}`} className="font-medium text-primary-600 hover:underline">
                      {inv.number}
                    </Link>
                  </td>
                  {!txnType && (
                    <td className="px-3 lg:px-5 py-3 hidden lg:table-cell">
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${TXN_BADGE[inv.txnType] ?? 'bg-gray-100 text-gray-600'}`}>
                        {inv.txnType?.replace(/_/g, ' ')}
                      </span>
                    </td>
                  )}
                  <td className="px-3 lg:px-5 py-3 text-gray-700">{inv.party?.name ?? inv.domainData?.customer_name ?? 'Walk-in'}</td>
                  <td className="px-3 lg:px-5 py-3 text-gray-500 whitespace-nowrap">{format(new Date(inv.date), 'd MMM yyyy')}</td>
                  <td className="px-3 lg:px-5 py-3 text-right font-semibold text-gray-900 whitespace-nowrap">
                    {formatINR(Number(inv.grandTotal))}
                  </td>
                  <td className="px-3 lg:px-5 py-3 whitespace-nowrap text-gray-700">{inv.paymentMode ?? <span className="text-gray-300">—</span>}</td>
                  <td className="px-3 lg:px-5 py-3"><StatusBadge status={inv.status} /></td>
                  <td className="px-3 lg:px-5 py-3 text-right whitespace-nowrap">
                    {inv.txnType === 'sale_invoice' && inv.status !== 'cancelled' && inv.status !== 'draft'
                      ? <ReprintMenu invoiceId={inv.id} number={String(inv.number)} compact />
                      : ['quotation', 'proforma', 'sales_order', 'delivery_challan'].includes(inv.txnType) && inv.status !== 'cancelled'
                        ? <button type="button" title={`Print ${inv.number}`} onClick={() => void printPdf(`/invoices/${inv.id}/pdf`, `${inv.number}.pdf`)}
                            className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium text-gray-600 hover:bg-gray-100 border border-gray-200"><Printer className="w-4 h-4" /> Print</button>
                        : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {data?.meta && data.meta.totalPages > 1 && (
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-500">Page {data.meta.page} of {data.meta.totalPages}{data.meta.capped ? "+" : ""}</span>
            <div className="flex gap-2">
              <button type="button" disabled={page <= 1} onClick={() => setPage(p => p - 1)} className="btn-ghost disabled:opacity-40">Previous</button>
              <button type="button" disabled={page >= data.meta.totalPages} onClick={() => setPage(p => p + 1)} className="btn-ghost disabled:opacity-40">Next</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
