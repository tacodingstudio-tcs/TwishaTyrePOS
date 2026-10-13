// Stock finder — "do I have 205/55 R16, which brands, at what price?" Read-only lookup with a
// one-tap jump into a sale.
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Search } from 'lucide-react'
import { tyreApi } from '@/lib/api'
import { useAuthStore } from '@/store/auth.store'
import { PageHeader } from '@/components/layout/PageHeader'
import { inr, num, VEHICLE_TYPE_LABEL } from '@/components/tyre/format'

export function StockFinderPage() {
  const [size, setSize] = useState('')
  const [brand, setBrand] = useState('')
  const [vehicleType, setVehicleType] = useState('')
  const [inStock, setInStock] = useState(false)
  const role = useAuthStore((s) => s.user?.role)
  const canSell = role !== 'viewer'
  const showCost = role === 'owner' || role === 'manager'

  const { data: sizes } = useQuery({ queryKey: ['tyre-sizes'], queryFn: tyreApi.sizes, staleTime: 60_000 })
  const { data: brands } = useQuery({ queryKey: ['tyre-brands'], queryFn: tyreApi.brands, staleTime: 60_000 })
  const { data, isFetching } = useQuery({
    queryKey: ['tyre-finder-page', size, brand, vehicleType, inStock],
    queryFn: () => tyreApi.finder({ size: size || undefined, brand: brand || undefined, vehicleType: vehicleType || undefined, inStock: inStock ? 'true' : 'false', limit: 100 }),
    placeholderData: (prev: any) => prev,
  })
  const rows: any[] = data?.data ?? []

  return (
    <div>
      <PageHeader title="Tyre stock" subtitle="Find a size, compare brands, check price and stock" />
      <div className="p-6 space-y-6">
        <section className="card p-5">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <div className="md:col-span-1">
              <label className="label" htmlFor="f-size">Size</label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                <input id="f-size" className="input pl-9" placeholder="205/55 R16" value={size} onChange={(e) => setSize(e.target.value)} autoFocus />
              </div>
            </div>
            <div>
              <label className="label" htmlFor="f-brand">Brand</label>
              <select id="f-brand" className="input" value={brand} onChange={(e) => setBrand(e.target.value)}>
                <option value="">All brands</option>
                {(brands ?? []).map((b) => <option key={b.brand} value={b.brand}>{b.brand}</option>)}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="f-vt">Vehicle</label>
              <select id="f-vt" className="input" value={vehicleType} onChange={(e) => setVehicleType(e.target.value)}>
                <option value="">Any</option>
                {Object.entries(VEHICLE_TYPE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <label className="flex items-end gap-2 text-sm text-gray-700 pb-2">
              <input type="checkbox" checked={inStock} onChange={(e) => setInStock(e.target.checked)} /> Only in stock
            </label>
          </div>

          {(sizes ?? []).length > 0 && (
            <div className="mt-4 flex flex-wrap gap-2">
              {(sizes ?? []).slice(0, 14).map((s) => (
                <button key={s.size} type="button" onClick={() => setSize(s.size)}
                  className={`px-2.5 py-1 rounded-full text-xs border ${size === s.size ? 'border-primary-400 bg-primary-50 text-primary-700' : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50'}`}>
                  {s.size} <span className={s.stock > 0 ? 'text-gray-400' : 'text-red-400'}>({num(s.stock)})</span>
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="card overflow-hidden">
          {isFetching && rows.length === 0 ? <p className="p-8 text-center text-gray-400">Loading…</p>
            : rows.length === 0 ? <p className="p-8 text-center text-sm text-gray-500">Nothing matches. Add tyres under <Link to="/inventory/products" className="text-primary-600 hover:underline">Stock → Items</Link>.</p>
            : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-xs uppercase text-gray-500">
                    <tr>
                      <th className="text-left px-4 py-3">Tyre</th><th className="text-left px-4 py-3">Size</th><th className="text-left px-4 py-3">Brand / pattern</th>
                      <th className="text-right px-4 py-3">Price</th><th className="text-right px-4 py-3">MRP</th>
                      {showCost && <th className="text-right px-4 py-3">Margin</th>}
                      <th className="text-right px-4 py-3">Stock</th><th className="px-4 py-3" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {rows.map((r) => {
                      const a = r.domainAttrs ?? {}
                      return (
                        <tr key={r.id} className="hover:bg-gray-50">
                          <td className="px-4 py-3 font-medium text-gray-900">{r.name}<div className="text-xs text-gray-400 font-normal">{r.sku}</div></td>
                          <td className="px-4 py-3 text-gray-700">{a.size ?? '—'}<div className="text-xs text-gray-400">{[a.tube_type, a.load_index && a.speed_rating ? `${a.load_index}${a.speed_rating}` : null].filter(Boolean).join(' · ')}</div></td>
                          <td className="px-4 py-3 text-gray-700">{[a.brand, a.pattern].filter(Boolean).join(' ') || '—'}</td>
                          <td className="px-4 py-3 text-right font-medium">{inr(r.salePrice)}</td>
                          <td className="px-4 py-3 text-right text-gray-500">{r.mrp ? inr(r.mrp) : '—'}</td>
                          {showCost && <td className="px-4 py-3 text-right text-gray-500">{r.marginPct != null ? `${r.marginPct}%` : '—'}</td>}
                          <td className={`px-4 py-3 text-right font-medium ${r.stock <= 0 ? 'text-red-600' : r.stock <= r.lowStockQty ? 'text-amber-600' : 'text-gray-900'}`}>{num(r.stock)}</td>
                          <td className="px-4 py-3 text-right">
                            {canSell && <Link to={`/tyre/sale?add=${r.id}`} className="text-primary-600 hover:underline text-xs font-medium">Sell</Link>}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
        </section>
      </div>
    </div>
  )
}
