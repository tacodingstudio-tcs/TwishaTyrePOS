// Counter sale — the screen used all day. Vehicle + customer, find tyres by size, add fitting
// services, take an old tyre in exchange, split payment, save → bill with warranty card.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useNavigate, useSearchParams } from 'react-router-dom'
import toast from 'react-hot-toast'
import { Search, Plus, Trash2, Car, Wrench, Recycle, AlertTriangle } from 'lucide-react'
import { tyreApi, apiError } from '@/lib/api'
import { useAuthStore } from '@/store/auth.store'
import { PageHeader } from '@/components/layout/PageHeader'
import { PartyCombobox, type PickedParty } from '@/components/ui/PartyCombobox'
import { inr, num, VEHICLE_TYPE_LABEL, POSITION_LABEL, dotInfo } from '@/components/tyre/format'

const ALIGNMENT_KEYS = ['Front toe', 'Rear toe', 'Camber L', 'Camber R', 'Caster L', 'Caster R']

const POSITIONS = ['FL', 'FR', 'RL', 'RR', 'SP'] as const
const PAY_METHODS: Array<[string, string]> = [['cash', 'Cash'], ['upi', 'UPI'], ['card', 'Card'], ['bank_transfer', 'Bank'], ['cheque', 'Cheque']]
const DEFAULT_GST = 18

interface Line {
  key: string
  productId: string
  name: string
  kind: string                 // tyre | tube | … | service
  unit: string
  size?: string
  brand?: string
  stock: number | null
  qty: number
  rate: number
  mrp?: number | null
  discountPct: number
  gstRate: number
  serials: string
  dots: string
  positions: string[]
  warrantyMonths?: number
  serviceType?: string
  readingsBefore: Record<string, string>
  readingsAfter: Record<string, string>
}

const cleanReadings = (r: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v !== ''))
const nonEmpty = (r: Record<string, string>) => (Object.keys(r).length ? r : undefined)

const splitList = (s: string) => s.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean)
let seq = 0
const newKey = () => `l${Date.now()}${seq++}`

function lineFromProduct(p: any, qty = 1): Line {
  const a = p.domainAttrs ?? {}
  const kind = p.itemType === 'service' ? 'service' : (a.item_kind ?? 'tyre')
  return {
    key: newKey(), productId: p.id, name: p.name, kind, unit: p.unit ?? 'pcs',
    size: a.size, brand: a.brand, stock: kind === 'service' ? null : Number(p.stock ?? 0),
    qty, rate: Number(p.salePrice ?? 0), mrp: p.mrp ?? null, discountPct: 0,
    gstRate: p.gstRate > 0 ? Number(p.gstRate) : DEFAULT_GST,
    serials: '', dots: '', positions: [], warrantyMonths: Number(a.warranty_months ?? 0) || undefined,
    serviceType: kind === 'service' ? a.service_type : undefined,
    readingsBefore: {}, readingsAfter: {},
  }
}

export function QuickSalePage() {
  const navigate = useNavigate()
  const [sp] = useSearchParams()
  const role = useAuthStore((s) => s.user?.role)
  const readOnly = role === 'viewer'
  const serviceMode = sp.get('mode') === 'service'      // alignment / balancing / fitting without selling a tyre

  // customer + vehicle
  const [party, setParty] = useState<PickedParty>({ name: '' })
  const [phone, setPhone] = useState('')
  const [regNo, setRegNo] = useState('')
  const [vehicleType, setVehicleType] = useState('car')
  const [odometer, setOdometer] = useState('')
  const [fittedBy, setFittedBy] = useState('')
  // basket
  const [lines, setLines] = useState<Line[]>([])
  // exchange + payment
  const [exchQty, setExchQty] = useState('')
  const [exchValue, setExchValue] = useState('')
  const [pay, setPay] = useState<Record<string, string>>({})
  const [creditDays, setCreditDays] = useState('15')
  const [notes, setNotes] = useState('')
  // finder
  const [size, setSize] = useState('')
  const [text, setText] = useState('')
  const [onlyStock, setOnlyStock] = useState(true)
  const attemptKey = useRef(crypto.randomUUID())

  // Deep link from the stock finder: /tyre/sale?add=<productId>
  const addId = sp.get('add')
  const { data: preload } = useQuery({
    queryKey: ['tyre-preload', addId], enabled: !!addId,
    queryFn: () => tyreApi.finder({ id: addId, kind: 'any', limit: 1 }),
  })
  const preloaded = useRef(false)
  useEffect(() => {
    const p = preload?.data?.[0]
    if (p && !preloaded.current) { preloaded.current = true; setLines((ls) => [...ls, lineFromProduct(p, 1)]) }
  }, [preload])

  const { data: found, isFetching } = useQuery({
    queryKey: ['tyre-finder', size, text, onlyStock],
    queryFn: () => tyreApi.finder({ size: size || undefined, q: text || undefined, inStock: onlyStock ? 'true' : 'false', limit: 12 }),
    enabled: size.trim().length >= 2 || text.trim().length >= 2,
    placeholderData: (prev: any) => prev,
  })
  const { data: services } = useQuery({
    queryKey: ['tyre-services'], queryFn: () => tyreApi.finder({ kind: 'service', limit: 30 }), staleTime: 60_000,
  })

  // vehicle lookup on blur → fills owner + size context
  const lookup = useMutation({
    mutationFn: (r: string) => tyreApi.lookupVehicle(r),
    onSuccess: (r: any) => {
      const v = r?.vehicle
      if (!v) return
      setVehicleType(v.vehicleType ?? 'car')
      if (v.partyId && !party.id) setParty({ id: v.partyId, name: v.partyName ?? v.ownerName ?? '', phone: v.partyPhone ?? v.ownerPhone ?? null })
      else if (!party.id && v.ownerName) { setParty({ name: v.ownerName }); setPhone(v.ownerPhone ?? '') }
      if (v.tyreSize && !size) setSize(v.tyreSize)
      toast.success(`Known vehicle — ${v.ownerName ?? v.partyName ?? v.regNo}${v.tyreSize ? ` · ${v.tyreSize}` : ''}`)
    },
  })

  // totals (preview — the server is the authority)
  const totals = useMemo(() => {
    let taxable = 0, gst = 0
    for (const l of lines) {
      const t = l.qty * l.rate * (1 - l.discountPct / 100)
      taxable += t; gst += t * l.gstRate / 100
    }
    const grand = Math.round(taxable + gst)
    return { taxable, gst, grand }
  }, [lines])
  const paid = Object.values(pay).reduce((s, v) => s + (Number(v) || 0), 0)
  const exch = Number(exchValue) || 0
  const balance = Math.round((totals.grand - paid - exch) * 100) / 100
  const tyreUnits = lines.filter((l) => l.kind === 'tyre').reduce((s, l) => s + l.qty, 0)
  const hasCustomer = !!party.id || (party.name.trim().length > 0 && phone.replace(/\D/g, '').length >= 10)

  const setLine = (key: string, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)))
  const addProduct = (p: any) => {
    setLines((ls) => {
      const existing = ls.find((l) => l.productId === p.id)
      return existing ? ls.map((l) => (l.productId === p.id ? { ...l, qty: l.qty + 1 } : l)) : [...ls, lineFromProduct(p, 1)]
    })
  }
  const addService = (p: any) => {
    // per-tyre services default to however many tyres are in the basket
    const perTyre = /tyre|wheel/.test(String(p.unit))
    setLines((ls) => {
      if (ls.some((l) => l.productId === p.id)) return ls
      // per-wheel services default to the tyres in the basket, or 4 wheels on a service-only visit
      const qty = perTyre ? Math.max(1, tyreUnits || (serviceMode ? 4 : 1)) : 1
      return [...ls, lineFromProduct(p, qty)]
    })
  }

  const save = useMutation({
    mutationFn: () => {
      const payments = PAY_METHODS.map(([m]) => ({ method: m, amount: Number(pay[m]) || 0 })).filter((p) => p.amount > 0)
      return tyreApi.createSale({
        partyId: party.id,
        customer: !party.id && party.name.trim() ? { name: party.name.trim(), phone: phone.replace(/\D/g, '') || undefined } : undefined,
        saleKind: serviceMode && !lines.some((l) => l.kind !== 'service') ? 'service_only' : undefined,
        vehicleNo: regNo.trim() || undefined,
        vehicleType: regNo.trim() ? vehicleType : undefined,
        odometer: odometer ? Number(odometer) : undefined,
        fittedBy: fittedBy.trim() || undefined,
        creditDays: balance > 0.5 ? Number(creditDays || 0) : undefined,
        items: lines.map((l) => ({
          productId: l.productId, qty: l.qty, rate: l.rate, discountPct: l.discountPct,
          serialNos: splitList(l.serials), dotCodes: splitList(l.dots),
          positions: l.positions.filter(Boolean),
          warrantyMonths: l.warrantyMonths,
          wheels: l.kind === 'service' && /wheel|tyre/.test(l.unit) ? Math.max(1, Math.round(l.qty)) : undefined,
          readings: l.kind === 'service' && (Object.keys(cleanReadings(l.readingsBefore)).length > 0 || Object.keys(cleanReadings(l.readingsAfter)).length > 0)
            ? { before: nonEmpty(cleanReadings(l.readingsBefore)), after: nonEmpty(cleanReadings(l.readingsAfter)) } : undefined,
        })),
        exchange: exch > 0 && Number(exchQty) > 0 ? { qty: Number(exchQty), value: exch } : undefined,
        payments,
        notes: notes.trim() || undefined,
      }, attemptKey.current)
    },
    onSuccess: (r: any) => {
      attemptKey.current = crypto.randomUUID()
      toast.success(`Bill ${r.invoice?.number ?? ''} saved`)
      ;(r.warnings ?? []).forEach((w: string) => toast(w, { icon: '⚠️', duration: 6000 }))
      navigate(`/invoices/${r.invoice.id}`)
    },
    onError: (e) => toast.error(apiError(e)),
  })

  const problems: string[] = []
  if (lines.length === 0) problems.push('Add at least one item')
  for (const l of lines) {
    if (l.stock != null && l.qty > l.stock) problems.push(`${l.name}: only ${l.stock} in stock`)
    if (splitList(l.serials).length > l.qty) problems.push(`${l.name}: more serial numbers than quantity`)
  }
  if (balance > 0.5 && !hasCustomer) problems.push('Add the customer name and mobile to leave a balance on credit')
  if (balance < -0.5) problems.push('Payments are more than the bill')
  const canSave = !readOnly && problems.length === 0 && !save.isPending

  return (
    <div>
      <PageHeader title={serviceMode ? 'Alignment, balancing & fitting' : 'New sale'}
        subtitle={serviceMode ? 'Service visit — record the job and readings, take payment' : 'Tyres, fitting and payment — one bill with warranty card'} />
      <div className="p-6 grid grid-cols-1 xl:grid-cols-3 gap-6 items-start">

        <div className="xl:col-span-2 space-y-6">
          {/* Customer + vehicle */}
          <section className="card p-5">
            <h2 className="text-sm font-semibold text-gray-900 mb-4 flex items-center gap-2"><Car className="w-4 h-4 text-gray-400" /> Customer & vehicle</h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div>
                <label className="label" htmlFor="reg">Vehicle number</label>
                <input id="reg" className="input uppercase" placeholder="GJ05AB1234" value={regNo}
                  onChange={(e) => setRegNo(e.target.value)}
                  onBlur={() => { if (regNo.trim().length >= 4) lookup.mutate(regNo) }} />
              </div>
              <div>
                <label className="label" htmlFor="vt">Vehicle type</label>
                <select id="vt" className="input" value={vehicleType} onChange={(e) => setVehicleType(e.target.value)}>
                  {Object.entries(VEHICLE_TYPE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </div>
              <div>
                <label className="label" htmlFor="odo">Odometer (km)</label>
                <input id="odo" type="number" min="0" className="input" value={odometer} onChange={(e) => setOdometer(e.target.value)} />
              </div>
              <div className="md:col-span-2">
                <PartyCombobox label="Customer" type="customer" value={party}
                  placeholder="Search by name or mobile — or type a new name"
                  onChange={(p) => { setParty(p); if (p.id && p.phone) setPhone(p.phone) }} />
              </div>
              <div>
                <label className="label" htmlFor="ph">Mobile {party.id ? '' : '(for the bill & reminders)'}</label>
                <input id="ph" className="input" inputMode="numeric" maxLength={13} disabled={!!party.id} value={phone} onChange={(e) => setPhone(e.target.value)} />
              </div>
            </div>
          </section>

          {/* Finder */}
          {!serviceMode && <section className="card p-5">
            <h2 className="text-sm font-semibold text-gray-900 mb-4 flex items-center gap-2"><Search className="w-4 h-4 text-gray-400" /> Find tyres</h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div>
                <label className="label" htmlFor="size">Size</label>
                <input id="size" className="input" placeholder="205/55 R16 · 185 65 15 · 2055516" value={size} onChange={(e) => setSize(e.target.value)} autoFocus />
              </div>
              <div>
                <label className="label" htmlFor="q">Brand / pattern / name</label>
                <input id="q" className="input" placeholder="MRF, ZVTV, Apollo…" value={text} onChange={(e) => setText(e.target.value)} />
              </div>
              <label className="flex items-end gap-2 text-sm text-gray-700 pb-2">
                <input type="checkbox" checked={onlyStock} onChange={(e) => setOnlyStock(e.target.checked)} /> Only in stock
              </label>
            </div>

            {(size.trim().length >= 2 || text.trim().length >= 2) && (
              <div className="mt-4 border border-gray-100 rounded-lg divide-y divide-gray-100 max-h-80 overflow-y-auto">
                {isFetching && <div className="p-3 text-sm text-gray-400">Searching…</div>}
                {!isFetching && (found?.data ?? []).length === 0 && (
                  <div className="p-3 text-sm text-gray-500">No tyres match{onlyStock ? ' in stock' : ''}. {onlyStock && 'Untick “Only in stock” to see out-of-stock sizes.'}</div>
                )}
                {(found?.data ?? []).map((p: any) => {
                  const a = p.domainAttrs ?? {}
                  return (
                    <button key={p.id} type="button" onClick={() => addProduct(p)}
                      className="w-full text-left p-3 hover:bg-gray-50 flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-gray-900 truncate">{p.name}</div>
                        <div className="text-xs text-gray-500">
                          {[a.size, a.brand, a.pattern, a.tube_type].filter(Boolean).join(' · ')}
                          {a.warranty_months ? ` · ${a.warranty_months} mo warranty` : ''}
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="text-sm font-semibold text-gray-900">{inr(p.salePrice)}</div>
                        <div className={`text-xs ${p.stock <= 0 ? 'text-red-600' : p.stock <= p.lowStockQty ? 'text-amber-600' : 'text-gray-500'}`}>
                          {p.stock <= 0 ? 'Out of stock' : `${num(p.stock)} in stock`}
                        </div>
                      </div>
                      <Plus className="w-4 h-4 text-primary-600 shrink-0" />
                    </button>
                  )
                })}
              </div>
            )}
          </section>}

          {/* Basket */}
          <section className="card">
            <div className="p-5 border-b border-gray-100 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-900">Bill items</h2>
              <span className="text-xs text-gray-500">{tyreUnits > 0 ? `${tyreUnits} tyre${tyreUnits === 1 ? '' : 's'}` : ''}</span>
            </div>
            {lines.length === 0 ? (
              <p className="p-8 text-center text-sm text-gray-400">{serviceMode ? 'Pick the services done on this vehicle below.' : 'Search a size above, or add a fitting service below.'}</p>
            ) : (
              <ul className="divide-y divide-gray-100">
                {lines.map((l) => {
                  const units = Math.round(l.qty)
                  const dotAge = splitList(l.dots).map(dotInfo).filter(Boolean)
                  const oldDot = dotAge.find((d) => d && d.ageMonths > 60)
                  return (
                    <li key={l.key} className="p-4 space-y-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-gray-900">{l.name}</div>
                          <div className="text-xs text-gray-500">{[l.size, l.brand].filter(Boolean).join(' · ')}{l.stock != null ? ` · ${num(l.stock)} in stock` : ''}</div>
                        </div>
                        <button type="button" title="Remove" className="p-1 text-gray-400 hover:text-red-600" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                      <div className="grid grid-cols-4 gap-3">
                        <div><label className="label">Qty</label>
                          <input type="number" min="1" step={l.kind === 'service' ? 'any' : 1} className="input" value={l.qty}
                            onChange={(e) => setLine(l.key, { qty: Math.max(0, Number(e.target.value)) })} /></div>
                        <div><label className="label">Rate (₹)</label>
                          <input type="number" min="0" className="input" value={l.rate} onChange={(e) => setLine(l.key, { rate: Number(e.target.value) })} />
                          {l.mrp ? <span className="text-[11px] text-gray-400">MRP {inr(l.mrp)}</span> : null}</div>
                        <div><label className="label">Disc %</label>
                          <input type="number" min="0" max="100" className="input" value={l.discountPct} onChange={(e) => setLine(l.key, { discountPct: Number(e.target.value) })} /></div>
                        <div><label className="label">GST %</label>
                          <input type="number" min="0" max="28" className="input" value={l.gstRate} onChange={(e) => setLine(l.key, { gstRate: Number(e.target.value) })} /></div>
                      </div>
                      {l.kind === 'service' && l.serviceType === 'alignment' && (
                        <details className="rounded-lg border border-gray-100 bg-gray-50 p-3">
                          <summary className="text-xs font-medium text-gray-700 cursor-pointer">Alignment readings (optional) — printed on the bill</summary>
                          <div className="mt-3 grid grid-cols-[auto,1fr,1fr] gap-x-3 gap-y-2 items-center text-xs">
                            <span />
                            <span className="text-gray-500">Before</span><span className="text-gray-500">After</span>
                            {ALIGNMENT_KEYS.map((k) => (
                              <div key={k} className="contents">
                                <span className="text-gray-600">{k}</span>
                                <input className="input py-1 text-xs" value={l.readingsBefore[k] ?? ''} placeholder="reading"
                                  onChange={(e) => setLine(l.key, { readingsBefore: { ...l.readingsBefore, [k]: e.target.value } })} />
                                <input className="input py-1 text-xs" value={l.readingsAfter[k] ?? ''} placeholder="reading"
                                  onChange={(e) => setLine(l.key, { readingsAfter: { ...l.readingsAfter, [k]: e.target.value } })} />
                              </div>
                            ))}
                          </div>
                        </details>
                      )}
                      {l.kind !== 'service' && ['tyre', 'tube', 'alloy_wheel', 'battery'].includes(l.kind) && (
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                          <div className="md:col-span-2">
                            <label className="label">Serial numbers ({units}) <span className="text-gray-400 font-normal">— separate with space or comma</span></label>
                            <input className="input font-mono text-xs" value={l.serials} onChange={(e) => setLine(l.key, { serials: e.target.value })} placeholder="one per tyre, in fitting order" />
                          </div>
                          <div>
                            <label className="label">DOT (week+year)</label>
                            <input className="input font-mono text-xs" value={l.dots} onChange={(e) => setLine(l.key, { dots: e.target.value })} placeholder="2325 2325" />
                          </div>
                          {oldDot && (
                            <p className="md:col-span-3 text-xs text-amber-700 flex items-center gap-1.5"><AlertTriangle className="w-3.5 h-3.5" />
                              Manufactured {oldDot.label} — about {Math.round(oldDot.ageMonths / 12)} years old. Tell the customer.</p>
                          )}
                          {l.kind === 'tyre' && units <= 6 && (
                            <div className="md:col-span-3 flex flex-wrap items-center gap-2">
                              <span className="text-xs text-gray-500">Fitted on:</span>
                              {Array.from({ length: units }).map((_, u) => (
                                <select key={u} className="input w-auto py-1 text-xs" value={l.positions[u] ?? ''}
                                  onChange={(e) => { const next = [...l.positions]; next[u] = e.target.value; setLine(l.key, { positions: next }) }}>
                                  <option value="">Tyre {u + 1}</option>
                                  {POSITIONS.map((p) => <option key={p} value={p}>{POSITION_LABEL[p]}</option>)}
                                </select>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}

            {/* Services */}
            {(services?.data ?? []).length > 0 && (
              <div className="p-4 border-t border-gray-100 bg-gray-50 rounded-b-xl">
                <div className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2 flex items-center gap-1.5"><Wrench className="w-3.5 h-3.5" /> Fitting & services</div>
                <div className="flex flex-wrap gap-2">
                  {(services?.data ?? []).map((s: any) => (
                    <button key={s.id} type="button" onClick={() => addService(s)}
                      className="px-3 py-1.5 text-xs rounded-full border border-gray-200 bg-white hover:border-primary-300 hover:bg-primary-50">
                      {s.name} · {inr(s.salePrice)}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </section>
        </div>

        {/* Right rail */}
        <div className="space-y-6 xl:sticky xl:top-4">
          <section className="card p-5">
            <h2 className="text-sm font-semibold text-gray-900 mb-3">Bill</h2>
            <dl className="text-sm space-y-1.5">
              <div className="flex justify-between"><dt className="text-gray-500">Taxable</dt><dd>{inr(totals.taxable, 2)}</dd></div>
              <div className="flex justify-between"><dt className="text-gray-500">GST</dt><dd>{inr(totals.gst, 2)}</dd></div>
              <div className="flex justify-between text-base font-semibold border-t border-gray-100 pt-2"><dt>Total</dt><dd>{inr(totals.grand)}</dd></div>
            </dl>
          </section>

          {!serviceMode && <section className="card p-5">
            <h2 className="text-sm font-semibold text-gray-900 mb-3 flex items-center gap-2"><Recycle className="w-4 h-4 text-gray-400" /> Old tyre in exchange</h2>
            <div className="grid grid-cols-2 gap-3">
              <div><label className="label">How many</label><input type="number" min="0" className="input" value={exchQty} onChange={(e) => setExchQty(e.target.value)} /></div>
              <div><label className="label">Allowance (₹)</label><input type="number" min="0" className="input" value={exchValue} onChange={(e) => setExchValue(e.target.value)} /></div>
            </div>
            <p className="text-[11px] text-gray-400 mt-2">The bill stays at full value; the allowance is settled against it and the old tyres go into scrap stock.</p>
          </section>}

          <section className="card p-5">
            <h2 className="text-sm font-semibold text-gray-900 mb-3">Payment</h2>
            <div className="space-y-2">
              {PAY_METHODS.map(([m, label]) => (
                <div key={m} className="flex items-center gap-2">
                  <label className="w-20 text-sm text-gray-600" htmlFor={`p-${m}`}>{label}</label>
                  <input id={`p-${m}`} type="number" min="0" className="input" value={pay[m] ?? ''}
                    onChange={(e) => setPay((p) => ({ ...p, [m]: e.target.value }))} />
                </div>
              ))}
            </div>
            <div className="flex gap-2 mt-3">
              <button type="button" className="btn-ghost border border-gray-200 text-xs flex-1 justify-center" disabled={totals.grand <= 0}
                onClick={() => setPay({ cash: String(Math.max(0, totals.grand - exch)) })}>Full cash</button>
              <button type="button" className="btn-ghost border border-gray-200 text-xs flex-1 justify-center" disabled={totals.grand <= 0}
                onClick={() => setPay({ upi: String(Math.max(0, totals.grand - exch)) })}>Full UPI</button>
            </div>
            <div className={`mt-4 flex justify-between text-sm font-medium ${balance > 0.5 ? 'text-amber-700' : balance < -0.5 ? 'text-red-600' : 'text-green-700'}`}>
              <span>{balance > 0.5 ? 'Balance on credit' : balance < -0.5 ? 'Overpaid by' : 'Settled'}</span>
              <span>{inr(Math.abs(balance), 2)}</span>
            </div>
            {balance > 0.5 && (
              <div className="mt-3"><label className="label">Credit days</label>
                <input type="number" min="0" max="180" className="input" value={creditDays} onChange={(e) => setCreditDays(e.target.value)} /></div>
            )}
          </section>

          <section className="card p-5 space-y-3">
            <div><label className="label">Fitted by</label><input className="input" value={fittedBy} onChange={(e) => setFittedBy(e.target.value)} placeholder="Technician" /></div>
            <div><label className="label">Notes</label><textarea className="input h-16 resize-none" value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
            {problems.length > 0 && lines.length > 0 && (
              <ul className="text-xs text-amber-700 space-y-1">{problems.map((p) => <li key={p} className="flex gap-1.5"><AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />{p}</li>)}</ul>
            )}
            <button type="button" className="btn-primary w-full justify-center py-3 text-base" disabled={!canSave} onClick={() => save.mutate()}>
              {save.isPending ? 'Saving…' : `Save bill · ${inr(totals.grand)}`}
            </button>
            {readOnly && <p className="text-xs text-gray-400 text-center">Read-only access — you cannot make bills.</p>}
          </section>
        </div>
      </div>
    </div>
  )
}
