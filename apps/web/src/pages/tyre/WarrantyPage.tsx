// Warranty register: look a tyre up by serial / vehicle / mobile / bill, record a claim, follow it up with the tyre
// company, hand over a replacement from stock, correct a claim or the details on a record.
import { useState } from 'react'
import { localIso } from '@/lib/dates'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import toast from 'react-hot-toast'
import { Search, ShieldCheck, Pencil, History, Check } from 'lucide-react'
import { tyreApi, apiError } from '@/lib/api'
import { useAuthStore } from '@/store/auth.store'
import { PageHeader } from '@/components/layout/PageHeader'
import { Modal } from '@/components/tyre/Modal'
import { StatusPill } from '@/components/tyre/StatusPill'
import { fmtDate, POSITION_LABEL, dotInfo, inr } from '@/components/tyre/format'

const OUTCOMES: Array<[string, string]> = [
  ['pending', 'Sent to the tyre company — waiting'], ['replaced', 'Replaced'], ['prorata', 'Pro-rata adjustment'], ['repaired', 'Repaired'], ['rejected', 'Rejected'],
]
const OUTCOME_LABEL: Record<string, string> = { pending: 'waiting for the company', replaced: 'replaced', prorata: 'pro-rata adjustment', repaired: 'repaired', rejected: 'rejected' }
const daysSince = (iso: string) => Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 86_400_000))

export function WarrantyPage() {
  const qc = useQueryClient()
  const role = useAuthStore((s) => s.user?.role)
  const readOnly = role === 'viewer'
  const canManage = role === 'owner' || role === 'manager'
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('any')
  const [expiring, setExpiring] = useState(false)
  const [claim, setClaim] = useState<{ w: any; mode: 'new' | 'edit' } | null>(null)
  const [editing, setEditing] = useState<any | null>(null)
  const [openHistory, setOpenHistory] = useState<string | null>(null)

  const { data, isLoading } = useQuery({
    queryKey: ['tyre-warranty', search, status, expiring],
    queryFn: () => tyreApi.listWarranty({ search: search || undefined, status, expiringDays: expiring ? 30 : undefined, limit: 50 }),
    placeholderData: (prev: any) => prev,
  })
  const rows: any[] = data?.data ?? []
  const today = localIso()
  const refresh = () => qc.invalidateQueries({ queryKey: ['tyre-warranty'] })

  const voidIt = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => tyreApi.voidWarranty(id, reason),
    onSuccess: () => { toast.success('Voided — the serial number can be sold again'); refresh() },
    onError: (e) => toast.error(apiError(e)),
  })

  return (
    <div>
      <PageHeader title="Warranty" subtitle="Every serial-numbered tyre you have sold, with claims" />
      <div className="p-4 sm:p-6 space-y-4">
        <div className="flex flex-wrap gap-3 items-center">
          <div className="relative flex-1 min-w-[260px] max-w-lg">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input className="input pl-9" placeholder="Serial number, vehicle number, mobile, customer or bill no" value={search} onChange={(e) => setSearch(e.target.value)} autoFocus />
          </div>
          <select className="input w-auto" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
            <option value="any">All</option><option value="active">In warranty</option><option value="pending">Waiting for company</option>
            <option value="claimed">Claimed</option><option value="void">Void</option>
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
                  const pending = w.status === 'claimed' && w.claimOutcome === 'pending'
                  const history: any[] = Array.isArray(w.claimHistory) ? w.claimHistory : []
                  return (
                    <li key={w.id} className="p-4 flex items-start justify-between gap-4">
                      <div className="min-w-0 space-y-0.5">
                        <div className="text-sm font-medium text-gray-900 flex items-center gap-2 flex-wrap">
                          {w.itemName}
                          <StatusPill kind="warranty" status={pending ? 'pending' : w.status} />
                          {expired && w.status === 'active' && <span className="badge bg-red-50 text-red-600">Warranty ended</span>}
                          {w.replacesSerial && <span className="badge bg-green-50 text-green-700">Replacement for S/N {w.replacesSerial}</span>}
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
                          <div className={`text-xs mt-1 ${pending ? 'text-blue-700' : 'text-amber-700'}`}>
                            Claim {fmtDate(w.claimedAt)}: {OUTCOME_LABEL[w.claimOutcome] ?? w.claimOutcome}
                            {pending && ` · ${daysSince(w.claimedAt)} day${daysSince(w.claimedAt) === 1 ? '' : 's'} so far`}
                            {w.claimRef ? ` · ref ${w.claimRef}` : ''}{w.claimAmount ? ` · ${inr(w.claimAmount)}` : ''} — {w.claimNotes}
                            {w.replacementSerial && <span className="text-green-700"> · replaced by S/N {w.replacementSerial}</span>}
                          </div>
                        )}
                        {history.length > 1 && (
                          <button type="button" onClick={() => setOpenHistory(openHistory === w.id ? null : w.id)} className="text-xs text-gray-400 hover:text-gray-600 inline-flex items-center gap-1 mt-0.5">
                            <History className="w-3 h-3" /> {openHistory === w.id ? 'Hide' : 'Show'} history ({history.length})
                          </button>
                        )}
                        {openHistory === w.id && (
                          <ul className="text-xs text-gray-500 mt-1 space-y-0.5 border-l-2 border-gray-100 pl-3">
                            {history.map((h, i) => (
                              <li key={i}>{new Date(h.at).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })} — {historyText(h)}</li>
                            ))}
                          </ul>
                        )}
                      </div>
                      <div className="flex flex-col items-end gap-2 shrink-0">
                        {!readOnly && w.status === 'active' && (
                          <button type="button" className="btn-ghost border border-gray-200 text-xs" onClick={() => setClaim({ w, mode: 'new' })}><ShieldCheck className="w-3.5 h-3.5" /> Record claim</button>
                        )}
                        {canManage && w.status === 'claimed' && (
                          <button type="button" className="btn-ghost border border-gray-200 text-xs" onClick={() => setClaim({ w, mode: 'edit' })}>
                            <Pencil className="w-3.5 h-3.5" /> {pending ? 'Company replied' : 'Update claim'}
                          </button>
                        )}
                        {canManage && w.status !== 'void' && (
                          <button type="button" className="text-xs text-gray-500 hover:text-primary-700" onClick={() => setEditing(w)}>Edit details</button>
                        )}
                        {canManage && w.status !== 'void' && (
                          <button type="button" className="text-xs text-gray-400 hover:text-red-600"
                            onClick={() => { const r = window.prompt('Why is this being voided? (e.g. tyre returned)'); if (r && r.trim().length >= 3) voidIt.mutate({ id: w.id, reason: r.trim() }) }}>
                            Void
                          </button>
                        )}
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
        </section>
      </div>
      {claim && <ClaimDialog w={claim.w} mode={claim.mode} onClose={() => setClaim(null)}
        onDone={(res: any) => {
          setClaim(null); refresh(); qc.invalidateQueries({ queryKey: ['tyre-finder'] })
          toast.success(claim.mode === 'new' ? 'Claim recorded' : 'Claim updated')
          for (const m of res?.warnings ?? []) toast(m, { icon: '⚠️', duration: 7000 })
        }} />}
      {editing && <DetailsDialog w={editing} onClose={() => setEditing(null)} onDone={() => { setEditing(null); refresh(); toast.success('Details updated') }} />}
    </div>
  )
}

function historyText(h: any): string {
  if (h.kind === 'claim') return `Claim recorded: ${OUTCOME_LABEL[h.outcome] ?? h.outcome}${h.claimRef ? ` (ref ${h.claimRef})` : ''}`
  if (h.kind === 'update') {
    const parts: string[] = []
    if (h.before?.outcome !== h.after?.outcome) parts.push(`${OUTCOME_LABEL[h.before?.outcome] ?? h.before?.outcome} → ${OUTCOME_LABEL[h.after?.outcome] ?? h.after?.outcome}`)
    if (h.before?.claimAmount !== h.after?.claimAmount) parts.push(`amount ${h.before?.claimAmount ?? '—'} → ${h.after?.claimAmount ?? '—'}`)
    if (h.before?.claimRef !== h.after?.claimRef) parts.push('reference changed')
    if (h.before?.notes !== h.after?.notes) parts.push('notes changed')
    return `Claim updated${parts.length ? `: ${parts.join(', ')}` : ''}`
  }
  if (h.kind === 'edit') return `Details edited: ${Object.keys(h.after ?? {}).join(', ')}`
  return h.kind
}

function ClaimDialog({ w, mode, onClose, onDone }: { w: any; mode: 'new' | 'edit'; onClose: () => void; onDone: (res: any) => void }) {
  const editing = mode === 'edit'
  const [outcome, setOutcome] = useState<string>(editing ? w.claimOutcome : 'replaced')
  const [notes, setNotes] = useState<string>(editing ? (w.claimNotes ?? '') : '')
  const [amount, setAmount] = useState<string>(editing && w.claimAmount != null ? String(w.claimAmount) : '')
  const [ref, setRef] = useState<string>(editing ? (w.claimRef ?? '') : '')
  const canReplace = outcome === 'replaced' && !w.replacementId
  const [giveTyre, setGiveTyre] = useState(true)
  const [q, setQ] = useState('')
  const [picked, setPicked] = useState<any | null>(null)
  const [serial, setSerial] = useState('')
  const [dot, setDot] = useState('')

  const { data: found } = useQuery({
    queryKey: ['tyre-finder', 'replacement', q],
    enabled: canReplace && giveTyre && !picked && q.trim().length >= 2,
    queryFn: () => tyreApi.finder({ q: q.trim(), kind: 'tyre', inStock: true, limit: 6 }),
  })

  const m = useMutation({
    mutationFn: () => {
      const replacement = canReplace && giveTyre && picked
        ? { productId: picked.id, serialNo: serial.trim() || null, dotCode: dot.trim() || null } : undefined
      const body: Record<string, unknown> = { outcome, notes: notes.trim(), claimRef: ref.trim() || null, claimAmount: amount === '' ? null : Number(amount), ...(replacement ? { replacement } : {}) }
      return editing ? tyreApi.updateClaim(w.id, body) : tyreApi.claimWarranty(w.id, body)
    },
    onSuccess: onDone, onError: (e) => toast.error(apiError(e)),
  })
  const needsTyre = canReplace && giveTyre && !picked
  return (
    <Modal title={editing ? (w.claimOutcome === 'pending' ? 'Company replied — finish the claim' : 'Update claim') : 'Record warranty claim'} width="md" onClose={onClose}
      footer={<>
        <button type="button" className="btn-ghost flex-1 justify-center" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary flex-1 justify-center" disabled={notes.trim().length < 3 || needsTyre || m.isPending} onClick={() => m.mutate()}>
          {m.isPending ? 'Saving…' : editing ? 'Save changes' : 'Save claim'}
        </button>
      </>}>
      <div className="space-y-3">
        <p className="text-sm text-gray-600">{w.itemName}{w.serialNo ? ` · S/N ${w.serialNo}` : ''}</p>
        <div><label className="label">Outcome</label>
          <select className="input" value={outcome} disabled={!!w.replacementId} onChange={(e) => setOutcome(e.target.value)}>{OUTCOMES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          {w.replacementId && <p className="text-xs text-gray-500 mt-1">A replacement tyre was already handed over, so the outcome stays “Replaced”.</p>}
        </div>
        <div><label className="label">What happened? *</label><textarea className="input h-20 resize-none" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. sidewall bulge, customer brought it back" /></div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className="label">Company claim no. <span className="text-gray-400 font-normal">(optional)</span></label><input className="input" value={ref} onChange={(e) => setRef(e.target.value)} placeholder="their reference" maxLength={60} /></div>
          <div><label className="label">Amount / customer credit (₹)</label><input type="number" min="0" className="input" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
        </div>

        {canReplace && (
          <div className="rounded-lg border border-gray-200 p-3 space-y-2">
            <label className="flex items-center gap-2 text-sm font-medium text-gray-800">
              <input type="checkbox" checked={giveTyre} onChange={(e) => { setGiveTyre(e.target.checked); setPicked(null) }} /> Hand over a replacement tyre from stock now
            </label>
            {!giveTyre && <p className="text-xs text-amber-700">Stock will not change. You can add the replacement later with “Update claim”.</p>}
            {giveTyre && (picked ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between rounded-lg bg-green-50 border border-green-200 px-3 py-2 text-sm">
                  <span className="flex items-center gap-1.5 text-green-800"><Check className="w-4 h-4" /> {picked.name}</span>
                  <button type="button" className="text-xs text-gray-500 hover:underline" onClick={() => setPicked(null)}>Change</button>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div><label className="label">New tyre serial no.</label><input className="input font-mono text-sm" value={serial} onChange={(e) => setSerial(e.target.value)} maxLength={40} /></div>
                  <div><label className="label">DOT (week+year)</label><input className="input font-mono text-sm" value={dot} onChange={(e) => setDot(e.target.value.replace(/\D/g, '').slice(0, 4))} placeholder="2325" /></div>
                </div>
                <p className="text-xs text-gray-500">One tyre leaves stock and gets its own warranty, ending when this one would have.</p>
              </div>
            ) : (
              <div>
                <input className="input" placeholder="Find the replacement — size or brand (185 65 15, Yokohama)" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
                {q.trim().length >= 2 && (
                  <ul className="mt-2 divide-y divide-gray-100 border border-gray-100 rounded-lg max-h-48 overflow-y-auto">
                    {(found?.data ?? []).length === 0 && <li className="p-3 text-sm text-gray-500">No tyre in stock matches.</li>}
                    {(found?.data ?? []).map((p: any) => (
                      <li key={p.id}>
                        <button type="button" className="w-full text-left p-2.5 hover:bg-gray-50 flex items-center justify-between gap-2" onClick={() => setPicked(p)}>
                          <span className="text-sm text-gray-900 truncate">{p.name}</span>
                          <span className="text-xs text-gray-500 shrink-0">{p.stock} in stock</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  )
}

function DetailsDialog({ w, onClose, onDone }: { w: any; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ customerName: w.customerName ?? '', customerPhone: w.customerPhone ?? '', vehicleNo: w.vehicleNo ?? '', serialNo: w.serialNo ?? '', dotCode: w.dotCode ?? '' })
  const m = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {}
      for (const k of Object.keys(f) as Array<keyof typeof f>) if ((f[k] ?? '') !== (w[k] ?? '')) body[k] = f[k].trim() === '' ? null : f[k].trim()
      return tyreApi.editWarranty(w.id, body)
    },
    onSuccess: onDone, onError: (e) => toast.error(apiError(e)),
  })
  const changed = (Object.keys(f) as Array<keyof typeof f>).some((k) => (f[k] ?? '') !== (w[k] ?? ''))
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF((p) => ({ ...p, [k]: e.target.value }))
  return (
    <Modal title="Edit details" width="md" onClose={onClose}
      footer={<>
        <button type="button" className="btn-ghost flex-1 justify-center" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary flex-1 justify-center" disabled={!changed || m.isPending} onClick={() => m.mutate()}>{m.isPending ? 'Saving…' : 'Save'}</button>
      </>}>
      <div className="space-y-3">
        <p className="text-sm text-gray-600">{w.itemName}{w.invoiceNo ? ` · bill ${w.invoiceNo}` : ''}. Every change is kept in the history.</p>
        <div className="grid grid-cols-2 gap-3">
          <div><label className="label">Customer</label><input className="input" value={f.customerName} onChange={set('customerName')} /></div>
          <div><label className="label">Mobile</label><input className="input" inputMode="numeric" value={f.customerPhone} onChange={set('customerPhone')} placeholder="10 digits" /></div>
          <div><label className="label">Vehicle no.</label><input className="input font-mono" value={f.vehicleNo} onChange={set('vehicleNo')} /></div>
          <div><label className="label">Serial no.</label><input className="input font-mono" value={f.serialNo} onChange={set('serialNo')} /></div>
          <div><label className="label">DOT (week+year)</label><input className="input font-mono" value={f.dotCode} onChange={set('dotCode')} maxLength={4} placeholder="2325" /></div>
        </div>
      </div>
    </Modal>
  )
}
