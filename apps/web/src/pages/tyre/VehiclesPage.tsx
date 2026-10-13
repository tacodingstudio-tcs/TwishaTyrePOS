// Customer vehicles and the "due for a check" list.
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { Plus, Search, MessageCircle } from 'lucide-react'
import { tyreApi, apiError } from '@/lib/api'
import { useAuthStore } from '@/store/auth.store'
import { PageHeader } from '@/components/layout/PageHeader'
import { Modal } from '@/components/tyre/Modal'
import { fmtDate, VEHICLE_TYPE_LABEL } from '@/components/tyre/format'

export function VehiclesPage() {
  const [search, setSearch] = useState('')
  const [due, setDue] = useState(false)
  const [showNew, setShowNew] = useState(false)
  const readOnly = useAuthStore((s) => s.user?.role === 'viewer')
  const { data, isLoading } = useQuery({
    queryKey: ['tyre-vehicles', search, due],
    queryFn: () => tyreApi.listVehicles({ search: search || undefined, due: due ? 'true' : undefined, limit: 50 }),
    placeholderData: (prev: any) => prev,
  })
  const rows: any[] = data?.data ?? []

  return (
    <div>
      <PageHeader title="Customer vehicles" subtitle="Every vehicle you have fitted — with its tyre size and what is due next"
        action={!readOnly ? <button type="button" className="btn-primary" onClick={() => setShowNew(true)}><Plus className="w-4 h-4" /> Add vehicle</button> : undefined} />
      <div className="p-6 space-y-4">
        <div className="flex flex-wrap gap-3 items-center">
          <div className="relative flex-1 min-w-[240px] max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input className="input pl-9" placeholder="Vehicle number, owner or mobile" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={due} onChange={(e) => setDue(e.target.checked)} /> Due for a check
          </label>
        </div>

        <section className="card overflow-hidden">
          {isLoading ? <p className="p-8 text-center text-gray-400">Loading…</p>
            : rows.length === 0 ? <p className="p-8 text-center text-sm text-gray-500">No vehicles yet. They are added automatically when you enter a vehicle number on a sale.</p>
            : (
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-xs uppercase text-gray-500">
                  <tr><th className="text-left px-4 py-3">Vehicle</th><th className="text-left px-4 py-3">Owner</th><th className="text-left px-4 py-3">Tyre size</th>
                    <th className="text-left px-4 py-3">Last fitted</th><th className="text-left px-4 py-3">Next check</th></tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {rows.map((v) => {
                    const overdue = v.nextServiceDate && new Date(v.nextServiceDate) <= new Date()
                    return (
                      <tr key={v.id} className="hover:bg-gray-50">
                        <td className="px-4 py-3"><Link to={`/tyre/vehicles/${v.id}`} className="font-mono font-medium text-primary-700 hover:underline">{v.regNo}</Link>
                          <div className="text-xs text-gray-400">{[VEHICLE_TYPE_LABEL[v.vehicleType], v.makeModel].filter(Boolean).join(' · ')}</div></td>
                        <td className="px-4 py-3 text-gray-700">{v.partyName ?? v.ownerName ?? '—'}<div className="text-xs text-gray-400">{v.partyPhone ?? v.ownerPhone ?? ''}</div></td>
                        <td className="px-4 py-3 text-gray-700">{v.tyreSize ?? '—'}</td>
                        <td className="px-4 py-3 text-gray-600">{fmtDate(v.lastServiceDate)}</td>
                        <td className={`px-4 py-3 ${overdue ? 'text-amber-700 font-medium' : 'text-gray-600'}`}>{fmtDate(v.nextServiceDate)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
        </section>
      </div>
      {showNew && <NewVehicleModal onClose={() => setShowNew(false)} />}
    </div>
  )
}

function NewVehicleModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [f, setF] = useState({ regNo: '', vehicleType: 'car', makeModel: '', tyreSize: '', ownerName: '', ownerPhone: '' })
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF((p) => ({ ...p, [k]: e.target.value }))
  const m = useMutation({
    mutationFn: () => tyreApi.createVehicle({ ...f, makeModel: f.makeModel || null, tyreSize: f.tyreSize || null, ownerName: f.ownerName || null, ownerPhone: f.ownerPhone || null }),
    onSuccess: (v: any) => { qc.invalidateQueries({ queryKey: ['tyre-vehicles'] }); toast.success('Vehicle saved'); onClose(); navigate(`/tyre/vehicles/${v.id}`) },
    onError: (e) => toast.error(apiError(e)),
  })
  return (
    <Modal title="Add vehicle" width="md" onClose={onClose}
      footer={<>
        <button type="button" className="btn-ghost flex-1 justify-center" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary flex-1 justify-center" disabled={f.regNo.trim().length < 4 || m.isPending} onClick={() => m.mutate()}>Save</button>
      </>}>
      <div className="grid grid-cols-2 gap-3">
        <div><label className="label">Vehicle number *</label><input className="input uppercase" value={f.regNo} onChange={set('regNo')} placeholder="GJ05AB1234" /></div>
        <div><label className="label">Type</label>
          <select className="input" value={f.vehicleType} onChange={set('vehicleType')}>{Object.entries(VEHICLE_TYPE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
        <div><label className="label">Make / model</label><input className="input" value={f.makeModel} onChange={set('makeModel')} placeholder="Swift VXi" /></div>
        <div><label className="label">Tyre size</label><input className="input" value={f.tyreSize} onChange={set('tyreSize')} placeholder="185/65 R15" /></div>
        <div><label className="label">Owner</label><input className="input" value={f.ownerName} onChange={set('ownerName')} /></div>
        <div><label className="label">Mobile</label><input className="input" inputMode="numeric" value={f.ownerPhone} onChange={set('ownerPhone')} /></div>
      </div>
    </Modal>
  )
}

// ── Reminders (due list with one-tap WhatsApp) ────────────────────────────────

export function RemindersPage() {
  const qc = useQueryClient()
  const readOnly = useAuthStore((s) => s.user?.role === 'viewer')
  const [days, setDays] = useState(14)
  const { data, isLoading } = useQuery({ queryKey: ['tyre-reminders', days], queryFn: () => tyreApi.reminders(days) })
  const send = useMutation({
    mutationFn: (id: string) => tyreApi.remindVehicle(id),
    onSuccess: () => { toast.success('Queued on WhatsApp'); qc.invalidateQueries({ queryKey: ['tyre-reminders'] }) },
    onError: (e) => toast.error(apiError(e)),
  })
  const rows = data ?? []
  return (
    <div>
      <PageHeader title="Service reminders" subtitle="Vehicles due for alignment, rotation or a tyre check" />
      <div className="p-6 space-y-4">
        <div className="flex items-center gap-3 text-sm text-gray-700">
          Show vehicles due within
          <select className="input w-auto" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {[0, 7, 14, 30, 60].map((d) => <option key={d} value={d}>{d === 0 ? 'today (overdue)' : `${d} days`}</option>)}
          </select>
        </div>
        <section className="card overflow-hidden">
          {isLoading ? <p className="p-8 text-center text-gray-400">Loading…</p>
            : rows.length === 0 ? <p className="p-8 text-center text-sm text-gray-500">Nobody is due. Reminders appear about 6 months after a fitting.</p>
            : (
              <ul className="divide-y divide-gray-100">
                {rows.map((r: any) => (
                  <li key={r.id} className="p-4 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <Link to={`/tyre/vehicles/${r.id}`} className="font-mono font-medium text-primary-700 hover:underline">{r.regNo}</Link>
                      <div className="text-sm text-gray-700">{r.ownerName ?? '—'} {r.ownerPhone && <span className="text-gray-400">· {r.ownerPhone}</span>}</div>
                      <div className="text-xs text-gray-500">
                        {r.nextServiceFor ? `${r.nextServiceFor} — ` : ''}due {fmtDate(r.nextServiceDate)}{r.overdueDays > 0 ? ` (${r.overdueDays} days ago)` : ''}
                        {r.lastReminded ? ` · reminded ${fmtDate(r.lastReminded)}` : ''}
                      </div>
                    </div>
                    {!readOnly && (
                      <button type="button" className="btn-ghost border border-gray-200 shrink-0" disabled={!r.ownerPhone || send.isPending} onClick={() => send.mutate(r.id)}
                        title={r.ownerPhone ? 'Send a WhatsApp reminder' : 'No mobile number saved'}>
                        <MessageCircle className="w-4 h-4" /> Remind
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
        </section>
      </div>
    </div>
  )
}
