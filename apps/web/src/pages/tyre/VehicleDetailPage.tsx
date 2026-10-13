// One vehicle: owner, tyre size, next check, every bill and every tyre fitted.
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from 'react-router-dom'
import toast from 'react-hot-toast'
import { MessageCircle } from 'lucide-react'
import { tyreApi, apiError } from '@/lib/api'
import { useAuthStore } from '@/store/auth.store'
import { PageHeader } from '@/components/layout/PageHeader'
import { StatusPill } from '@/components/tyre/StatusPill'
import { inr, fmtDate, toInputDate, VEHICLE_TYPE_LABEL, POSITION_LABEL } from '@/components/tyre/format'

export function VehicleDetailPage() {
  const { id } = useParams<{ id: string }>()
  const qc = useQueryClient()
  const readOnly = useAuthStore((s) => s.user?.role === 'viewer')
  const { data: v, isLoading } = useQuery({ queryKey: ['tyre-vehicle', id], queryFn: () => tyreApi.getVehicle(id!) })
  const [next, setNext] = useState<string | null>(null)

  const refresh = () => { qc.invalidateQueries({ queryKey: ['tyre-vehicle', id] }); qc.invalidateQueries({ queryKey: ['tyre-vehicles'] }) }
  const save = useMutation({
    mutationFn: (patch: Record<string, unknown>) => tyreApi.updateVehicle(id!, patch),
    onSuccess: () => { refresh(); toast.success('Saved') }, onError: (e) => toast.error(apiError(e)),
  })
  const remind = useMutation({
    mutationFn: () => tyreApi.remindVehicle(id!),
    onSuccess: () => toast.success('Queued on WhatsApp'), onError: (e) => toast.error(apiError(e)),
  })

  if (isLoading || !v) return <div className="p-8 text-center text-gray-400">{isLoading ? 'Loading…' : 'Vehicle not found'}</div>
  const nextVal = next ?? toInputDate(v.nextServiceDate)

  return (
    <div>
      <PageHeader
        title={v.regNo}
        subtitle={[VEHICLE_TYPE_LABEL[v.vehicleType], v.makeModel, v.tyreSize].filter(Boolean).join(' · ')}
        action={!readOnly ? (
          <button type="button" className="btn-ghost" disabled={remind.isPending} onClick={() => remind.mutate()}>
            <MessageCircle className="w-4 h-4" /> Send reminder
          </button>
        ) : undefined}
      />
      <div className="p-6 grid grid-cols-1 xl:grid-cols-3 gap-6">
        <div className="space-y-6">
          <section className="card p-5 space-y-3 text-sm">
            <div><div className="text-xs text-gray-400">Owner</div>
              {v.partyId ? <Link to={`/parties/${v.partyId}`} className="text-primary-700 hover:underline">{v.partyName ?? v.ownerName}</Link> : (v.ownerName ?? '—')}
              <div className="text-gray-500">{v.partyPhone ?? v.ownerPhone ?? ''}</div></div>
            <div className="grid grid-cols-2 gap-3">
              <div><div className="text-xs text-gray-400">Last fitted</div>{fmtDate(v.lastServiceDate)}</div>
              <div><div className="text-xs text-gray-400">Odometer</div>{v.lastOdometer ? `${v.lastOdometer.toLocaleString('en-IN')} km` : '—'}</div>
            </div>
          </section>
          <section className="card p-5 space-y-3">
            <h2 className="text-sm font-semibold text-gray-900">Next check</h2>
            <input type="date" className="input" disabled={readOnly} value={nextVal} onChange={(e) => setNext(e.target.value)} />
            <div className="flex gap-2">
              <button type="button" className="btn-primary flex-1 justify-center" disabled={readOnly || save.isPending || next === null}
                onClick={() => save.mutate({ nextServiceDate: next || null })}>Save date</button>
            </div>
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" disabled={readOnly} checked={!!v.remindersOff} onChange={(e) => save.mutate({ remindersOff: e.target.checked })} /> Don't send automatic reminders
            </label>
          </section>
        </div>

        <div className="xl:col-span-2 space-y-6">
          <section className="card">
            <div className="p-5 border-b border-gray-100"><h2 className="text-sm font-semibold text-gray-900">Tyres fitted</h2></div>
            {v.warranty.length === 0 ? <p className="p-6 text-sm text-gray-400">No serial-numbered tyres recorded.</p> : (
              <ul className="divide-y divide-gray-100">
                {v.warranty.map((w: any) => (
                  <li key={w.id} className="p-4 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-gray-900">{w.itemName}</div>
                      <div className="text-xs text-gray-500">
                        {[w.size, w.serialNo && `S/N ${w.serialNo}`, w.dotCode && `DOT ${w.dotCode}`, w.position && POSITION_LABEL[w.position]].filter(Boolean).join(' · ')}
                      </div>
                      <div className="text-xs text-gray-400">Bill {w.invoiceNo} · {fmtDate(w.soldOn)}{w.warrantyUntil ? ` · warranty till ${fmtDate(w.warrantyUntil)}` : ''}</div>
                    </div>
                    <StatusPill kind="warranty" status={w.status} />
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card">
            <div className="p-5 border-b border-gray-100"><h2 className="text-sm font-semibold text-gray-900">Bills</h2></div>
            {v.bills.length === 0 ? <p className="p-6 text-sm text-gray-400">No bills for this vehicle.</p> : (
              <ul className="divide-y divide-gray-100">
                {v.bills.map((b: any) => (
                  <li key={b.id}>
                    <Link to={`/invoices/${b.id}`} className="flex items-center justify-between p-4 hover:bg-gray-50">
                      <div><div className="text-sm font-medium text-gray-900">{b.number}</div>
                        <div className="text-xs text-gray-500">{fmtDate(b.date)}{b.odometer ? ` · ${Number(b.odometer).toLocaleString('en-IN')} km` : ''}</div></div>
                      <div className="flex items-center gap-3"><StatusPill kind="sale" status={b.status} /><span className="text-sm font-semibold">{inr(b.grandTotal)}</span></div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
