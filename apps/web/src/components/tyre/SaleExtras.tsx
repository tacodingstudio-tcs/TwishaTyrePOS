// Shown on a sale's detail page: the vehicle, and every serial-numbered tyre with its warranty.
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { ShieldCheck, Car } from 'lucide-react'
import { tyreApi } from '@/lib/api'
import { StatusPill } from './StatusPill'
import { fmtDate, POSITION_LABEL } from './format'

export function SaleExtras({ invoiceId }: { invoiceId: string }) {
  const { data } = useQuery({
    queryKey: ['tyre-sale', invoiceId],
    queryFn: () => tyreApi.getSale(invoiceId),
    retry: false,
  })
  if (!data) return null
  const warranty: any[] = data.warranty ?? []
  const vehicle = data.vehicle
  const regNo = data.summary?.vehicleNo
  if (!regNo && warranty.length === 0) return null

  return (
    <section className="card p-5 space-y-4">
      {regNo && (
        <div className="flex items-center gap-2 text-sm">
          <Car className="w-4 h-4 text-gray-400" />
          <span className="text-gray-500">Vehicle</span>
          {vehicle ? <Link to={`/tyre/vehicles/${vehicle.id}`} className="font-mono font-medium text-primary-700 hover:underline">{regNo}</Link>
            : <span className="font-mono font-medium">{regNo}</span>}
          {data.summary?.odometer ? <span className="text-gray-400">· {Number(data.summary.odometer).toLocaleString('en-IN')} km</span> : null}
          {vehicle?.nextServiceDate ? <span className="text-gray-400">· next check {fmtDate(vehicle.nextServiceDate)}</span> : null}
        </div>
      )}
      {warranty.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2 mb-2"><ShieldCheck className="w-4 h-4 text-gray-400" /> Tyres & warranty</h3>
          <ul className="divide-y divide-gray-100">
            {warranty.map((w) => (
              <li key={w.id} className="py-2 flex items-center justify-between gap-3 text-sm">
                <div className="min-w-0">
                  <div className="text-gray-900 truncate">{w.itemName}</div>
                  <div className="text-xs text-gray-500">
                    {[w.size, w.serialNo && `S/N ${w.serialNo}`, w.dotCode && `DOT ${w.dotCode}`, w.position && POSITION_LABEL[w.position]].filter(Boolean).join(' · ')}
                    {w.warrantyUntil ? ` · till ${fmtDate(w.warrantyUntil)}` : ''}
                  </div>
                </div>
                <StatusPill kind="warranty" status={w.status} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
