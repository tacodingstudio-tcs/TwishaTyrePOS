// Warranty register: look a tyre up by serial / vehicle / mobile / bill, record a claim.
import { useState } from 'react'
import { localIso } from '@/lib/dates'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import toast from 'react-hot-toast'
import { Search, ShieldCheck } from 'lucide-react'
import { tyreApi, apiError } from '@/lib/api'
import { useAuthStore } from '@/store/auth.store'
import { PageHeader } from '@/components/layout/PageHeader'
import { Modal } from '@/components/tyre/Modal'
import { StatusPill } from '@/components/tyre/StatusPill'
import { fmtDate, POSITION_LABEL, dotInfo, inr } from '@/components/tyre/format'

const OUTCOMES: Array<[string, string]> = [['replaced', 'Replaced'], ['prorata', 'Pro-rata adjustment'], ['repaired', 'Repaired'], ['rejected', 'Rejected']]

export function WarrantyPage() {
  const qc = useQueryClient()
  const role = useAuthStore((s) => s.user?.role)
  const readOnly = role === 'viewer'
  const canVoid = role === 'owner' || role === 'manager'
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('any')
  const [expiring, setExpiring] = useState(false)
  const [claim, setClaim] = useState<any | null>(null)

  const { data, isLoading } = useQuery({
    queryKey: ['tyre-warranty', search, status, expiring],
    queryFn: () => tyreApi.listWarranty({ search: search || undefined, status, expiringDays: expiring ? 30 : undefined, limit: 50 }),
    placeholderData: (prev: any) => prev,
  })
  const rows: any[] = data?.data ?? []
  const today = localIso()

  const voidIt = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => tyreApi.voidWarranty(id, reason),
    onSuccess: () => { toast.success('Voided — the serial number can be sold again'); qc.invalidateQueries({ queryKey: ['tyre-warranty'] }) },
    onError: (e) => toast.error(apiError(e)),
  })

  return (
    <div>
      <PageHeader title="Warranty" subtitle="Every serial-numbered tyre you have sold, with claims" />
      <div className="p-6 space-y-4">
        <div className="flex flex-wrap gap-3 items-center">
          <div className="relative flex-1 min-w-[260px] max-w-lg">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input className="input pl-9" placeholder="Serial number, vehicle number, mobile, customer or bill no" value={search} onChange={(e) => setSearch(e.target.value)} autoFocus />
          </div>
          <select className="input w-auto" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
            <option value="any">All</option><option value="active">In warranty</option><option value="claimed">Claimed</option><option value="void">Void</option>
          </select>
          <label className="flex items-center gap-2 text-sm text-gray-700"><input type="checkbox" checked={expiring} onChange={(e) => setExpiring(e.target.checked)} /> Ending in 30 days</label>
        </div>

        <section className="card overflow-hidden">
          {isLoading ? <p className="p-8 text-center text-gray-400">Loading…</p>
            : rows.length === 0 ? <p className="p-8 text-center text-sm text-gray-500">No records. Serial numbers are saved when you enter them on a sale.</p>
            : (
              <ul className="divide-y divide-gray-100">
                {rows.map((w) => {
                  const expired = w.warrantyUntil && String(w.warrantyUntil).slice(0, 10) < today
                  const dot = dotInfo(w.dotCode)
                  return (
                    <li key={w.id} className="p-4 flex items-start justify-between gap-4">
                      <div className="min-w-0 space-y-0.5">
                        <div className="text-sm font-medium text-gray-900 flex items-center gap-2 flex-wrap">
                          {w.itemName}
                          <StatusPill kind="warranty" status={w.status} />
                          {expired && w.status === 'active' && <span className="badge bg-red-50 text-red-600">Warranty ended</span>}
                        </div>
                        <div className="text-xs text-gray-600">
                          {[w.size, w.serialNo && `S/N ${w.serialNo}`, w.dotCode && `DOT ${w.dotCode}${dot ? ` (${dot.label})` : ''}`, w.position && POSITION_LABEL[w.position]].filter(Boolean).join(' · ')}
                        </div>
                        <div className="text-xs text-gray-500">
                          {w.customerName ?? 'Walk-in'}{w.customerPhone ? ` · ${w.customerPhone}` : ''}{w.vehicleNo ? ` · ${w.vehicleNo}` : ''}
                        </div>
                        <div className="text-xs text-gray-400">
                          <Link to={`/invoices/${w.invoiceId}`} className="text-primary-600 hover:underline">Bill {w.invoiceNo}</Link> · sold {fmtDate(w.soldOn)}
                          {w.warrantyUntil ? ` · till ${fmtDate(w.warrantyUntil)}` : ' · as per maker'}
                        </div>
                        {w.status === 'claimed' && (
                          <div className="text-xs text-amber-700 mt-1">
                            Claim {fmtDate(w.claimedAt)}: {w.claimOutcome}{w.claimAmount ? ` · ${inr(w.claimAmount)}` : ''} — {w.claimNotes}
                          </div>
                        )}
                      </div>
                      <div className="flex flex-col items-end gap-2 shrink-0">
                        {!readOnly && w.status === 'active' && (
                          <button type="button" className="btn-ghost border border-gray-200 text-xs" onClick={() => setClaim(w)}><ShieldCheck className="w-3.5 h-3.5" /> Record claim</button>
                        )}
                        {canVoid && w.status !== 'void' && (
                          <button type="button" className="text-xs text-gray-400 hover:text-red-600"
                            onClick={() => { const r = window.prompt('Why is this being voided? (e.g. tyre returned)'); if (r && r.trim().length >= 3) voidIt.mutate({ id: w.id, reason: r.trim() }) }}>Void</button>
                        )}
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
        </section>
      </div>
      {claim && <ClaimDialog w={claim} onClose={() => setClaim(null)} onDone={() => { setClaim(null); qc.invalidateQueries({ queryKey: ['tyre-warranty'] }); toast.success('Claim recorded') }} />}
    </div>
  )
}

function ClaimDialog({ w, onClose, onDone }: { w: any; onClose: () => void; onDone: () => void }) {
  const [outcome, setOutcome] = useState('replaced')
  const [notes, setNotes] = useState('')
  const [amount, setAmount] = useState('')
  const m = useMutation({
    mutationFn: () => tyreApi.claimWarranty(w.id, { outcome, notes, claimAmount: amount ? Number(amount) : undefined }),
    onSuccess: onDone, onError: (e) => toast.error(apiError(e)),
  })
  return (
    <Modal title="Record warranty claim" width="md" onClose={onClose}
      footer={<>
        <button type="button" className="btn-ghost flex-1 justify-center" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary flex-1 justify-center" disabled={notes.trim().length < 3 || m.isPending} onClick={() => m.mutate()}>Save claim</button>
      </>}>
      <div className="space-y-3">
        <p className="text-sm text-gray-600">{w.itemName}{w.serialNo ? ` · S/N ${w.serialNo}` : ''}</p>
        <div><label className="label">Outcome</label>
          <select className="input" value={outcome} onChange={(e) => setOutcome(e.target.value)}>{OUTCOMES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
        <div><label className="label">What happened? *</label><textarea className="input h-20 resize-none" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. sidewall bulge, assessed by the brand's representative" /></div>
        <div><label className="label">Claim amount / customer credit (₹)</label><input type="number" min="0" className="input" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
      </div>
    </Modal>
  )
}
