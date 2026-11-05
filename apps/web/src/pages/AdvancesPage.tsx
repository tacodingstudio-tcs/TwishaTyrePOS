import { useState } from 'react'
import { useAdvances, useRecordAdvance, useAllocateAdvance } from '@/hooks/useApi'
import { PartyIdSelect } from '@/components/ui/PartyCombobox'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { api, tyreApi, invoiceApi, apiError } from '@/lib/api'
import { useAuthStore } from '@/store/auth.store'
import { format } from 'date-fns'
import { Plus, X, CreditCard, CheckCircle } from 'lucide-react'
import toast from 'react-hot-toast'

const formatINR = (n: number) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(n)

const PAYMENT_METHODS = ['cash','upi','neft','rtgs','cheque','card','other']

function RecordAdvanceModal({ onClose }: { onClose: () => void }) {
  const recordMut = useRecordAdvance()

  const [form, setForm] = useState({
    partyId: '', amount: '', method: 'cash', refNo: '', notes: '',
    paymentDate: new Date().toISOString().split('T')[0],
  })

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    await recordMut.mutateAsync({
      partyId: form.partyId,
      amount: Number(form.amount),
      method: form.method,
      refNo: form.refNo || undefined,
      notes: form.notes || undefined,
      paymentDate: form.paymentDate,
    })
    toast.success('Advance recorded')
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg w-full max-w-md shadow-xl">
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <h2 className="font-semibold text-lg">Record Advance Payment</h2>
          <button type="button" onClick={onClose}><X className="w-5 h-5 text-gray-400" /></button>
        </div>
        <form onSubmit={submit} className="p-5 space-y-4">
          <div>
            <PartyIdSelect label="Customer" required type="customer" value={form.partyId}
              onChange={(id) => setForm(f => ({ ...f, partyId: id }))} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Amount *</label>
              <input type="number" min={1} step="0.01" required value={form.amount}
                onChange={e => setForm(f => ({ ...f, amount: e.target.value }))}
                className="w-full border rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="0.00" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Payment Date *</label>
              <input type="date" required value={form.paymentDate}
                onChange={e => setForm(f => ({ ...f, paymentDate: e.target.value }))}
                className="w-full border rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Method *</label>
              <select value={form.method} onChange={e => setForm(f => ({ ...f, method: e.target.value }))}
                className="w-full border rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                {PAYMENT_METHODS.map(m => <option key={m} value={m}>{m.toUpperCase()}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Ref / UTR No.</label>
              <input type="text" value={form.refNo}
                onChange={e => setForm(f => ({ ...f, refNo: e.target.value }))}
                className="w-full border rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="Optional" />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
            <textarea rows={2} value={form.notes}
              onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
              className="w-full border rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="Optional notes…" />
          </div>
          <div className="flex gap-2 pt-1">
            <button type="button" onClick={onClose}
              className="flex-1 border rounded py-2 text-sm hover:bg-gray-50">Cancel</button>
            <button type="submit" disabled={recordMut.isPending}
              className="flex-1 bg-blue-600 text-white rounded py-2 text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
              {recordMut.isPending ? 'Saving…' : 'Record Advance'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

/** the customer's unpaid sale bills, oldest first, each with what is still due */
async function openBillsOf(partyId: string): Promise<Array<{ id: string; number: string; date: string; due: number }>> {
  const res = await invoiceApi.list({ partyId, txnType: 'sale_invoice', limit: 100 })
  const list: any[] = Array.isArray(res) ? res : res?.data ?? res?.items ?? []
  return list
    .filter((i) => !['cancelled', 'draft'].includes(String(i.status)))
    .map((i) => ({ id: String(i.id), number: String(i.number), date: String(i.date), due: Math.round((Number(i.grandTotal) - Number(i.paidAmt)) * 100) / 100 }))
    .filter((i) => i.due > 0.004)
    .sort((a, b) => a.date.localeCompare(b.date))
}

function AllocateModal({ advance, onClose }: { advance: any; onClose: () => void }) {
  const allocateMut = useAllocateAdvance()
  const [rows, setRows] = useState([{ invoiceId: '', amount: '' }])

  const remaining = Number(advance.unallocatedAmt)
  const totalEntered = rows.reduce((s, r) => s + (Number(r.amount) || 0), 0)
  const partyId = String(advance.partyId ?? advance.party?.id ?? '')
  const { data: bills = [], isLoading: billsLoading } = useQuery({ queryKey: ['advance-open-bills', partyId], queryFn: () => openBillsOf(partyId), enabled: !!partyId })
  // the amount that goes with a chosen bill: what it still needs, but never more than the advance has left
  const suggest = (billId: string, rowIdx: number) => {
    const due = bills.find((b) => b.id === billId)?.due ?? 0
    const others = rows.reduce((sum, r, idx) => sum + (idx === rowIdx ? 0 : Number(r.amount) || 0), 0)
    return String(Math.max(0, Math.min(due, Math.round((remaining - others) * 100) / 100)))
  }

  function addRow() { setRows(r => [...r, { invoiceId: '', amount: '' }]) }
  function removeRow(i: number) { setRows(r => r.filter((_, idx) => idx !== i)) }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const allocations = rows
      .filter(r => r.invoiceId && Number(r.amount) > 0)
      .map(r => ({ invoiceId: r.invoiceId, amount: Number(r.amount) }))
    if (!allocations.length) return toast.error('Add at least one allocation')
    if (totalEntered > remaining) return toast.error('Total exceeds unallocated amount')
    await allocateMut.mutateAsync({ id: advance.id, allocations })
    toast.success('Advance allocated')
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg w-full max-w-lg shadow-xl">
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <div>
            <h2 className="font-semibold text-lg">Allocate Advance</h2>
            <p className="text-sm text-gray-500">{advance.party?.name} · Available: {formatINR(remaining)}</p>
          </div>
          <button type="button" onClick={onClose}><X className="w-5 h-5 text-gray-400" /></button>
        </div>
        <form onSubmit={submit} className="p-5 space-y-4">
          {billsLoading ? <p className="text-sm text-gray-400">Loading this customer's bills…</p>
            : bills.length === 0 ? <p className="text-sm text-amber-700">This customer has no unpaid bills to allocate against.</p>
            : <p className="text-xs text-gray-500">Pick the bill to settle with this advance. The amount fills in with what the bill still needs.</p>}
          <div className="space-y-2">
            {rows.map((row, i) => (
              <div key={i} className="flex gap-2 items-center">
                <select value={row.invoiceId}
                  onChange={e => { const id = e.target.value; setRows(r => r.map((x, idx) => idx === i ? { ...x, invoiceId: id, amount: id ? suggest(id, i) : '' } : x)) }}
                  className="flex-1 border rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                  <option value="">Choose a bill…</option>
                  {bills.map((b) => (
                    <option key={b.id} value={b.id} disabled={rows.some((x, idx) => idx !== i && x.invoiceId === b.id)}>
                      {b.number} · {format(new Date(b.date), 'dd MMM yyyy')} · due {formatINR(b.due)}
                    </option>
                  ))}
                </select>
                <input type="number" placeholder="Amount" min={0.01} step="0.01" value={row.amount}
                  onChange={e => setRows(r => r.map((x, idx) => idx === i ? { ...x, amount: e.target.value } : x))}
                  className="w-28 border rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                {rows.length > 1 && (
                  <button type="button" onClick={() => removeRow(i)} className="text-red-400 hover:text-red-600">
                    <X className="w-4 h-4" />
                  </button>
                )}
              </div>
            ))}
          </div>
          {bills.length > rows.length && (
            <button type="button" onClick={addRow} className="text-sm text-blue-600 hover:underline">+ Add another bill</button>
          )}
          <div className="flex items-center justify-between text-sm pt-1">
            <span className="text-gray-500">Total allocating:</span>
            <span className={`font-semibold ${totalEntered > remaining ? 'text-red-600' : 'text-gray-900'}`}>
              {formatINR(totalEntered)}
            </span>
          </div>
          <div className="flex gap-2 pt-1">
            <button type="button" onClick={onClose}
              className="flex-1 border rounded py-2 text-sm hover:bg-gray-50">Cancel</button>
            <button type="submit" disabled={allocateMut.isPending}
              className="flex-1 bg-green-600 text-white rounded py-2 text-sm font-medium hover:bg-green-700 disabled:opacity-50">
              {allocateMut.isPending ? 'Saving…' : 'Allocate'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

export default function AdvancesPage() {
  const [showRecord, setShowRecord]   = useState(false)
  const [allocating, setAllocating]   = useState<any>(null)
  const allocateMut = useAllocateAdvance()
  // one unpaid bill: settle it straight away (after a yes/no); several or none: open the picker
  async function startAllocate(adv: any) {
    try {
      const partyId = String(adv.partyId ?? adv.party?.id ?? '')
      const bills = partyId ? await openBillsOf(partyId) : []
      if (bills.length === 1) {
        const bill = bills[0]!
        const amount = Math.min(bill.due, Math.round(Number(adv.unallocatedAmt) * 100) / 100)
        if (amount > 0 && window.confirm(`Allocate ${formatINR(amount)} of this advance to bill ${bill.number} (due ${formatINR(bill.due)})?`)) {
          await allocateMut.mutateAsync({ id: adv.id, allocations: [{ invoiceId: bill.id, amount }] })
          toast.success(`${formatINR(amount)} allocated to bill ${bill.number}`)
          return
        }
        if (amount > 0) return
      }
    } catch { /* fall through to the picker */ }
    setAllocating(adv)
  }
  const { data, isLoading } = useAdvances()
  // salary advances given to the team live in Team & Salary; show who still owes one so they are not "missing" from here
  const canManage = useAuthStore((st) => st.canManage)
  const qc = useQueryClient()
  // An advance entered by mistake: cancelled (kept in the payment records as "voided", with the reason) and the customer's balance goes back.
  // Only while no bill has used it; one already allocated is first taken off the bill from its payments.
  async function deleteAdvance(adv: any) {
    if (!confirm(`Delete this advance of ${formatINR(Number(adv.amount))} from ${adv.party?.name ?? 'the customer'}?

Use this only for an entry made by mistake.`)) return
    try {
      await api.post(`/payments/${adv.id}/void`, { reason: 'Advance entered by mistake' })
      await qc.invalidateQueries()
      toast.success('Advance deleted')
    } catch (e) { toast.error(apiError(e)) }
  }
  const { data: staffData } = useQuery({ queryKey: ['team-staff-advances'], queryFn: () => tyreApi.teamStaff(), retry: false, enabled: canManage() })
  const staffAdv: any[] = (Array.isArray(staffData) ? staffData : staffData?.data ?? []).filter((p: any) => Number(p.advanceOutstanding) > 0)
  const advances = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : []

  const totalUnallocated = advances.reduce((s: number, a: any) => s + Number(a.unallocatedAmt), 0)

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Advance Payments</h1>
          <p className="text-sm text-gray-500 mt-1">On-account receipts from customers not yet linked to an invoice. Advances given to staff are in Team &amp; Salary.</p>
        </div>
        <button type="button" onClick={() => setShowRecord(true)}
          className="btn-primary flex items-center gap-2">
          <Plus className="w-4 h-4" /> Record Advance
        </button>
      </div>

      {staffAdv.length > 0 && (
        <div className="bg-white border rounded-lg p-4">
          <div className="flex items-center justify-between mb-2">
            <p className="text-sm font-semibold text-gray-900">Staff salary advances (still to recover)</p>
            <Link to="/tyre/team" className="text-sm text-blue-600 hover:underline">Open Team &amp; Salary</Link>
          </div>
          <ul className="divide-y divide-gray-100 text-sm">
            {staffAdv.map((p: any) => (
              <li key={p.id} className="flex justify-between py-1.5">
                <span className="text-gray-700">{p.name}</span>
                <span className="font-semibold text-orange-600">{formatINR(Number(p.advanceOutstanding))}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Summary card */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-white border rounded-lg p-4">
          <p className="text-xs text-gray-500 uppercase tracking-wide">Total Advances</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">{advances.length}</p>
        </div>
        <div className="bg-white border rounded-lg p-4">
          <p className="text-xs text-gray-500 uppercase tracking-wide">Unallocated</p>
          <p className="text-2xl font-bold text-orange-600 mt-1">{formatINR(totalUnallocated)}</p>
        </div>
        <div className="bg-white border rounded-lg p-4">
          <p className="text-xs text-gray-500 uppercase tracking-wide">Fully Allocated</p>
          <p className="text-2xl font-bold text-green-600 mt-1">
            {advances.filter((a: any) => Number(a.unallocatedAmt) <= 0).length}
          </p>
        </div>
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="text-center py-16 text-gray-400">Loading…</div>
      ) : advances.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          No advance payments recorded yet.
          <button type="button" onClick={() => setShowRecord(true)}
            className="text-blue-600 hover:underline ml-1">Record one</button>
        </div>
      ) : (
        <div className="bg-white rounded-lg border overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Customer</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Date</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Method</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600">Amount</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600">Allocated</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600">Remaining</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {advances.map((adv: any) => {
                const fullyAllocated = Number(adv.unallocatedAmt) <= 0
                return (
                  <tr key={adv.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <div className="font-medium text-gray-900">{adv.party?.name ?? '—'}</div>
                      {adv.refNo && <div className="text-xs text-gray-400">{adv.refNo}</div>}
                    </td>
                    <td className="px-4 py-3 text-gray-500">
                      {format(new Date(adv.paymentDate), 'dd MMM yyyy')}
                    </td>
                    <td className="px-4 py-3">
                      <span className="uppercase text-xs font-medium text-gray-600 bg-gray-100 px-2 py-0.5 rounded">
                        {adv.method}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right font-medium">{formatINR(Number(adv.amount))}</td>
                    <td className="px-4 py-3 text-right text-green-600">{formatINR(Number(adv.allocatedAmt))}</td>
                    <td className="px-4 py-3 text-right">
                      <span className={fullyAllocated ? 'text-gray-400' : 'font-semibold text-orange-600'}>
                        {fullyAllocated ? '—' : formatINR(Number(adv.unallocatedAmt))}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="inline-flex items-center gap-2 justify-end">
                        {fullyAllocated ? (
                          <span className="inline-flex items-center gap-1 text-xs text-green-600">
                            <CheckCircle className="w-3.5 h-3.5" /> Done
                          </span>
                        ) : (
                          <button type="button" onClick={() => void startAllocate(adv)}
                            className="inline-flex items-center gap-1 text-xs bg-blue-600 text-white px-3 py-1.5 rounded hover:bg-blue-700">
                            <CreditCard className="w-3 h-3" /> Allocate
                          </button>
                        )}
                        {canManage() && Number(adv.allocatedAmt) === 0 && (
                          <button type="button" onClick={() => void deleteAdvance(adv)} title="Delete this advance (entered by mistake)"
                            className="inline-flex items-center gap-1 text-xs text-red-600 border border-red-200 px-2.5 py-1.5 rounded hover:bg-red-50">
                            Delete
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {showRecord && <RecordAdvanceModal onClose={() => setShowRecord(false)} />}
      {allocating && <AllocateModal advance={allocating} onClose={() => setAllocating(null)} />}
    </div>
  )
}
