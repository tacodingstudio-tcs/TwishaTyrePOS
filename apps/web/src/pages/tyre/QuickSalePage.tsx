// Counter sale — the screen used all day. Vehicle + customer, find tyres by size, add fitting
// services, take an old tyre in exchange, split payment, save → bill with warranty card.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useNavigate, useSearchParams } from 'react-router-dom'
import toast from 'react-hot-toast'
import { Search, Plus, Minus, Trash2, Car, Wrench, Recycle, AlertTriangle, CircleDot, Wind, Gauge, RotateCw, Droplets, Settings2, Check } from 'lucide-react'
import { tyreApi, branchApi, apiError } from '@/lib/api'
import { useAuthStore } from '@/store/auth.store'
import { PageHeader } from '@/components/layout/PageHeader'
import { PartyCombobox, type PickedParty } from '@/components/ui/PartyCombobox'
import { inr, num, VEHICLE_TYPE_LABEL, POSITION_LABEL, dotInfo } from '@/components/tyre/format'

const ALIGNMENT_KEYS = ['Front toe', 'Rear toe', 'Camber L', 'Camber R', 'Caster L', 'Caster R']

const POSITIONS = ['FL', 'FR', 'RL', 'RR', 'SP'] as const
const PAY_METHODS: Array<[string, string]> = [['cash', 'Cash'], ['upi', 'UPI'], ['card', 'Card'], ['bank_transfer', 'Bank'], ['cheque', 'Cheque']]
const DEFAULT_GST = 18
const CHARGE_LABELS = ['Alignment', 'Balancing', 'Weight', 'Labour'] as const
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

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
  price: number                // the price actually charged per unit (Data Entry) — list rate less discount
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
    qty, rate: Number(p.salePrice ?? 0), price: Number(p.salePrice ?? 0), mrp: p.mrp ?? null, discountPct: 0,
    gstRate: p.gstRate > 0 ? Number(p.gstRate) : DEFAULT_GST,
    serials: '', dots: '', positions: [], warrantyMonths: Number(a.warranty_months ?? 0) || undefined,
    serviceType: kind === 'service' ? a.service_type : undefined,
    readingsBefore: {}, readingsAfter: {},
  }
}

const SERVICE_ICON: Record<string, React.ElementType> = {
  alignment: Gauge, balancing: CircleDot, fitting: Wrench, rotation: RotateCw, nitrogen: Wind, puncture: Droplets, valve: Settings2,
}
/** A service's icon from its type, else from its name. */
function serviceIcon(s: any): React.ElementType {
  const t = String(s?.domainAttrs?.service_type ?? '')
  if (SERVICE_ICON[t]) return SERVICE_ICON[t]!
  const n = String(s?.name ?? '').toLowerCase()
  if (/align/.test(n)) return Gauge
  if (/balanc/.test(n)) return CircleDot
  if (/nitrogen|inflat|air/.test(n)) return Wind
  if (/puncture|repair/.test(n)) return Droplets
  if (/rotat/.test(n)) return RotateCw
  if (/valve/.test(n)) return Settings2
  return Wrench
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
  const [pay, setPay] = useState<Record<string, string>>({})           // split-payment amounts
  const [payMode, setPayMode] = useState<'cash' | 'upi' | 'credit' | 'split'>('cash')
  const [creditDays, setCreditDays] = useState('15')
  const [notes, setNotes] = useState('')
  // Data Entry style billing: the price typed is what the customer pays per tyre, GST inside it
  const [inclusive, setInclusive] = useState<boolean | null>(null)
  const [withGst, setWithGst] = useState(true)          // false = cash memo, no GST on this bill
  const [billSeries, setBillSeries] = useState('')
  const [makeModel, setMakeModel] = useState('')
  const [address, setAddress] = useState('')
  const [poNo, setPoNo] = useState('')
  const [charges, setCharges] = useState<Record<string, string>>({})
  const { data: branches } = useQuery({ queryKey: ['branches'], queryFn: () => branchApi.list(), staleTime: 60_000 })
  const shopCfg: Record<string, any> = (branches as any[])?.[0]?.domainConfig ?? {}
  const seriesKeys = Object.keys(shopCfg['bill_series'] ?? {})
  const isInclusive = inclusive ?? !!shopCfg['prices_include_gst']
  // a no-GST bill goes into its own register when the shop has one, so the GST register stays continuous
  const gstKeys = seriesKeys.filter((k) => k !== 'non_gst')
  useEffect(() => {
    if (!seriesKeys.length) return
    const want = !withGst && seriesKeys.includes('non_gst') ? 'non_gst' : (gstKeys.includes(billSeries) ? billSeries : (gstKeys[0] ?? seriesKeys[0]!))
    if (want !== billSeries) setBillSeries(want)
  }, [seriesKeys.join(','), withGst]) // eslint-disable-line
  // finder
  const [search, setSearch] = useState('')          // digits = size, letters = brand / pattern
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
    queryKey: ['tyre-finder', search, onlyStock],
    queryFn: () => {
      const t = search.trim()
      const isSize = /\d/.test(t)
      return tyreApi.finder({ size: isSize ? t : undefined, q: isSize ? undefined : t, inStock: onlyStock ? 'true' : 'false', limit: 12 })
    },
    enabled: search.trim().length >= 2,
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
      if (v.tyreSize && !search) setSearch(v.tyreSize)
      toast.success(`Known vehicle — ${v.ownerName ?? v.partyName ?? v.regNo}${v.tyreSize ? ` · ${v.tyreSize}` : ''}`)
    },
  })

  // totals (preview — the server is the authority)
  const totals = useMemo(() => {
    let taxable = 0, gst = 0, cgst = 0
    for (const l of lines) {
      const amt = r2(l.qty * l.price)
      const g = !withGst ? 0 : isInclusive ? r2(amt * l.gstRate / (100 + l.gstRate)) : r2(amt * l.gstRate / 100)
      taxable += isInclusive ? amt - g : amt
      gst += g; cgst += r2(g / 2)
    }
    const extra = CHARGE_LABELS.reduce((sum, k) => sum + (Number(charges[k]) || 0), 0)
    const grand = Math.round(taxable + gst + extra)
    return { taxable, gst, cgst, sgst: gst - cgst, extra, grand }
  }, [lines, isInclusive, charges, withGst])
  const exch = Number(exchValue) || 0
  const amountDue = Math.max(0, totals.grand - exch)
  const effPay: Record<string, string> = payMode === 'split' ? pay : payMode === 'credit' ? {} : { [payMode]: String(amountDue) }
  const paid = Object.values(effPay).reduce((s, v) => s + (Number(v) || 0), 0)
  const balance = Math.round((totals.grand - paid - exch) * 100) / 100
  const tyreUnits = lines.filter((l) => l.kind === 'tyre').reduce((s, l) => s + l.qty, 0)
  const hasCustomer = !!party.id || (party.name.trim().length > 0 && phone.replace(/\D/g, '').length >= 10)

  // list price, discount % and the price charged are one linked trio — change any one, the others follow
  const price2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100
  const onList = (l: Line, v: number) => setLine(l.key, { rate: v, price: price2(v * (1 - l.discountPct / 100)) })
  const onDisc = (l: Line, d: number) => setLine(l.key, { discountPct: d, price: price2(l.rate * (1 - d / 100)) })
  const onPrice = (l: Line, p: number) => setLine(l.key, {
    price: p, discountPct: l.rate > 0 && p < l.rate ? Math.round(((l.rate - p) / l.rate) * 10000) / 100 : 0,
  })
  const setLine = (key: string, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)))
  // Cash memo (no GST): the customer is not charged the tax, so the price drops by the GST that was
  // inside it. Switching back adds it again. Only applies when prices are typed GST-inclusive.
  const strip = (v: number, g: number) => price2(v / (1 + g / 100))
  const addBack = (v: number, g: number) => price2(v * (1 + g / 100))
  const memoPrice = (l: Line): Line => (!withGst && isInclusive && l.gstRate > 0)
    ? { ...l, rate: strip(l.rate, l.gstRate), price: strip(l.price, l.gstRate) } : l
  const switchGst = (on: boolean) => {
    if (on === withGst) return
    if (isInclusive) {
      setLines((ls) => ls.map((l) => l.gstRate > 0
        ? (on ? { ...l, rate: addBack(l.rate, l.gstRate), price: addBack(l.price, l.gstRate) }
              : { ...l, rate: strip(l.rate, l.gstRate), price: strip(l.price, l.gstRate) })
        : l))
    }
    setWithGst(on)
  }
  const addProduct = (p: any) => {
    setLines((ls) => {
      const existing = ls.find((l) => l.productId === p.id)
      return existing ? ls.map((l) => (l.productId === p.id ? { ...l, qty: l.qty + 1 } : l)) : [...ls, memoPrice(lineFromProduct(p, 1))]
    })
  }
  const addService = (p: any) => {
    // per-tyre services default to however many tyres are in the basket
    const perTyre = /tyre|wheel/.test(String(p.unit))
    setLines((ls) => {
      if (ls.some((l) => l.productId === p.id)) return ls
      // per-wheel services default to the tyres in the basket, or 4 wheels on a service-only visit
      const qty = perTyre ? Math.max(1, tyreUnits || (serviceMode ? 4 : 1)) : 1
      return [...ls, memoPrice(lineFromProduct(p, qty))]
    })
  }

  const save = useMutation({
    mutationFn: () => {
      const payments = PAY_METHODS.map(([m]) => ({ method: m, amount: Number(effPay[m]) || 0 })).filter((p) => p.amount > 0)
      return tyreApi.createSale({
        partyId: party.id,
        customer: !party.id && party.name.trim() ? { name: party.name.trim(), phone: phone.replace(/\D/g, '') || undefined, address: address.trim() || undefined } : undefined,
        withGst,
        pricesIncludeGst: isInclusive,
        billSeries: billSeries || undefined,
        makeModel: makeModel.trim() || undefined,
        poNo: poNo.trim() || undefined,
        charges: CHARGE_LABELS.map((label) => ({ label, amount: Number(charges[label]) || 0 })).filter((c) => c.amount > 0),
        saleKind: serviceMode && !lines.some((l) => l.kind !== 'service') ? 'service_only' : undefined,
        vehicleNo: regNo.trim() || undefined,
        vehicleType: regNo.trim() ? vehicleType : undefined,
        odometer: odometer ? Number(odometer) : undefined,
        fittedBy: fittedBy.trim() || undefined,
        creditDays: balance > 0.5 ? Number(creditDays || 0) : undefined,
        items: lines.map((l) => ({
          productId: l.productId, qty: l.qty, rate: l.rate, finalPrice: l.price,
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
    <div className="pb-4">
      <PageHeader title={serviceMode ? 'Alignment, balancing & fitting' : 'New bill'}
        subtitle={serviceMode ? 'Service visit — pick the jobs, type the charges, take payment' : 'Add tyres, type the price, save'} />
      <div className="p-4 sm:p-6 max-w-5xl mx-auto space-y-4">

        {/* 1 · register + GST */}
        <section className="card p-4 flex items-center justify-between gap-3 flex-wrap">
          <div className="flex gap-2 flex-wrap">
            {seriesKeys.filter((k) => withGst ? k !== 'non_gst' : true).map((k) => (
              <button key={k} type="button" onClick={() => setBillSeries(k)}
                className={`px-4 py-2 rounded-lg text-sm font-medium border ${billSeries === k ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-700 border-gray-200'}`}>
                {k.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-3 cursor-pointer select-none">
            <span className="text-sm font-medium text-gray-800">GST bill</span>
            <button type="button" role="switch" aria-checked={withGst} onClick={() => switchGst(!withGst)}
              className={`relative w-12 h-7 rounded-full transition ${withGst ? 'bg-green-600' : 'bg-gray-300'}`}>
              <span className={`absolute top-0.5 w-6 h-6 bg-white rounded-full shadow transition-all ${withGst ? 'left-5' : 'left-0.5'}`} />
            </button>
          </label>
          {!withGst && (
            <p className="basis-full text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
              Cash memo — no GST is charged or shown, and it stays out of the GST returns. Prices have dropped by the GST that was inside them; you can still type any price.
            </p>
          )}
        </section>

        {/* 2 · customer + vehicle */}
        <section className="card p-4">
          <div className="grid grid-cols-1 sm:grid-cols-6 gap-3">
            <div className="sm:col-span-3">
              <PartyCombobox label="Customer" type="customer" value={party}
                placeholder="Name or mobile — or type a new name"
                onChange={(p) => { setParty(p); if (p.id && p.phone) setPhone(p.phone) }} />
            </div>
            <div className="sm:col-span-3">
              <label className="label" htmlFor="ph">Mobile</label>
              <input id="ph" className="input" inputMode="numeric" maxLength={13} disabled={!!party.id} value={phone} onChange={(e) => setPhone(e.target.value)} />
            </div>
            <div className="sm:col-span-2">
              <label className="label" htmlFor="reg">Vehicle no.</label>
              <input id="reg" className="input uppercase" placeholder="GJ05AB1234" value={regNo}
                onChange={(e) => setRegNo(e.target.value)}
                onBlur={() => { if (regNo.trim().length >= 4) lookup.mutate(regNo) }} />
            </div>
            <div className="sm:col-span-2">
              <label className="label" htmlFor="mk">Vehicle make</label>
              <input id="mk" className="input" placeholder="Hyundai Creta" value={makeModel} onChange={(e) => setMakeModel(e.target.value)} />
            </div>
            <div className="sm:col-span-2">
              <label className="label" htmlFor="odo">KM reading</label>
              <input id="odo" type="number" min="0" className="input" value={odometer} onChange={(e) => setOdometer(e.target.value)} />
            </div>
          </div>
        </section>

        {/* 3 · add tyre */}
        {!serviceMode && (
          <section className="card p-4">
            <div className="flex items-center gap-3">
              <div className="relative flex-1">
                <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input className="input pl-9 text-base" autoFocus value={search} onChange={(e) => setSearch(e.target.value)}
                  placeholder="Add tyre — type size (185 65 15) or brand (Yokohama)" aria-label="Find tyre" />
              </div>
              <label className="flex items-center gap-1.5 text-xs text-gray-600 whitespace-nowrap">
                <input type="checkbox" checked={onlyStock} onChange={(e) => setOnlyStock(e.target.checked)} /> In stock
              </label>
            </div>
            {search.trim().length >= 2 && (
              <div className="mt-3 border border-gray-100 rounded-lg divide-y divide-gray-100 max-h-72 overflow-y-auto">
                {isFetching && <div className="p-3 text-sm text-gray-400">Searching…</div>}
                {!isFetching && (found?.data ?? []).length === 0 && (
                  <div className="p-3 text-sm text-gray-500">No tyres match{onlyStock ? ' in stock' : ''}.{onlyStock && ' Untick “In stock” to see out-of-stock sizes.'}</div>
                )}
                {(found?.data ?? []).map((p: any) => (
                  <button key={p.id} type="button" onClick={() => { addProduct(p); setSearch('') }}
                    className="w-full text-left p-3 hover:bg-gray-50 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-gray-900 truncate">{p.name}</div>
                      <div className={`text-xs ${p.stock <= 0 ? 'text-red-600' : p.stock <= p.lowStockQty ? 'text-amber-600' : 'text-gray-500'}`}>
                        {p.stock <= 0 ? 'Out of stock' : `${num(p.stock)} in stock`}
                      </div>
                    </div>
                    <div className="text-sm font-semibold text-gray-900 shrink-0">{inr(p.salePrice)}</div>
                    <Plus className="w-4 h-4 text-primary-600 shrink-0" />
                  </button>
                ))}
              </div>
            )}
          </section>
        )}

        {/* 3b · service cards (service visits): tap a card to add it, + / − to change how many */}
        {serviceMode && (
          <section className="card p-4">
            <div className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-3">Tap the jobs done</div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
              {(services?.data ?? []).map((sv: any) => {
                const line = lines.find((l) => l.productId === sv.id)
                const Icon = serviceIcon(sv)
                const on = !!line
                return (
                  <div key={sv.id}
                    className={`relative rounded-xl border-2 p-3 transition select-none ${on ? 'border-green-600 bg-green-50' : 'border-gray-200 bg-white hover:border-gray-300'}`}>
                    <button type="button" className="w-full text-left" onClick={() => (on ? setLine(line!.key, { qty: line!.qty + 1 }) : addService(sv))}
                      aria-label={`Add ${sv.name}`}>
                      <div className="flex items-start justify-between">
                        <Icon className={`w-6 h-6 ${on ? 'text-green-700' : 'text-gray-400'}`} />
                        {on && <span className="w-5 h-5 rounded-full bg-green-600 text-white flex items-center justify-center"><Check className="w-3.5 h-3.5" /></span>}
                      </div>
                      <div className="mt-2 text-sm font-semibold text-gray-900 leading-tight">{sv.name}</div>
                      <div className="text-xs text-gray-500 mt-0.5">{inr(sv.salePrice)}{/tyre|wheel/.test(String(sv.unit)) ? ' each' : ''}</div>
                    </button>
                    {on && (
                      <div className="mt-2 flex items-center justify-between">
                        <div className="flex items-center gap-1.5">
                          <button type="button" aria-label="Fewer"
                            className="w-7 h-7 rounded-md border border-gray-300 bg-white flex items-center justify-center"
                            onClick={() => (line!.qty <= 1 ? setLines((ls) => ls.filter((x) => x.key !== line!.key)) : setLine(line!.key, { qty: line!.qty - 1 }))}>
                            <Minus className="w-3.5 h-3.5" />
                          </button>
                          <span className="w-6 text-center text-sm font-semibold">{line!.qty}</span>
                          <button type="button" aria-label="More"
                            className="w-7 h-7 rounded-md border border-gray-300 bg-white flex items-center justify-center"
                            onClick={() => setLine(line!.key, { qty: line!.qty + 1 })}>
                            <Plus className="w-3.5 h-3.5" />
                          </button>
                        </div>
                        <span className="text-sm font-semibold text-green-800">{inr(price2(line!.qty * line!.price))}</span>
                      </div>
                    )}
                  </div>
                )
              })}
              {(services?.data ?? []).length === 0 && <p className="col-span-full text-sm text-gray-400">No services set up yet — add them under Tyres &amp; Items.</p>}
            </div>
          </section>
        )}

        {/* 4 · bill lines */}
        <section className={`card ${serviceMode && lines.length === 0 ? 'hidden' : ''}`}>
          {lines.length === 0 ? (
            <p className="p-8 text-center text-sm text-gray-400">{serviceMode ? 'Pick the jobs below.' : 'Search a tyre above to start the bill.'}</p>
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
                        <div className="text-sm font-semibold text-gray-900">{l.name}</div>
                        <div className="text-xs text-gray-500">{l.stock != null ? `${num(l.stock)} in stock` : 'Service'}</div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="text-base font-semibold text-gray-900">{inr(price2(l.qty * l.price))}</div>
                        <button type="button" title="Remove" className="text-gray-400 hover:text-red-600" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>
                          <Trash2 className="w-4 h-4 inline" />
                        </button>
                      </div>
                    </div>
                    <div className={`grid grid-cols-2 ${serviceMode ? 'sm:grid-cols-2 max-w-md' : 'sm:grid-cols-4'} gap-3 items-end`}>
                      <div><label className="label">Qty</label>
                        <input type="number" min="1" step={l.kind === 'service' ? 'any' : 1} className="input" value={l.qty}
                          onChange={(e) => setLine(l.key, { qty: Math.max(0, Number(e.target.value)) })} /></div>
                      <div className={serviceMode ? 'hidden' : ''}><label className="label">List price</label>
                        <input type="number" min="0" className="input" value={l.rate} onChange={(e) => onList(l, Number(e.target.value))} /></div>
                      <div className={serviceMode ? 'hidden' : ''}><label className="label">Discount %</label>
                        <input type="number" min="0" max="100" step="0.01" className="input" value={l.discountPct}
                          onChange={(e) => onDisc(l, Math.min(100, Math.max(0, Number(e.target.value))))} /></div>
                      <div><label className="label font-semibold text-gray-900">{isInclusive && withGst ? 'Data Entry (incl. GST)' : 'Price charged'}</label>
                        <input type="number" min="0" className="input border-gray-900 font-semibold text-base" value={l.price} onChange={(e) => onPrice(l, Number(e.target.value))} /></div>
                    </div>
                    {l.discountPct > 0 && <p className="text-xs text-green-700">Discount − {inr(price2(l.rate - l.price))} per unit ({l.discountPct}%)</p>}

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
                    {['tyre', 'tube', 'alloy_wheel', 'battery'].includes(l.kind) && (
                      <details className="rounded-lg border border-gray-100 bg-gray-50 p-3">
                        <summary className="text-xs font-medium text-gray-700 cursor-pointer">Serial numbers, DOT, GST % — optional</summary>
                        <div className="mt-3 grid grid-cols-1 md:grid-cols-4 gap-3">
                          <div className="md:col-span-2">
                            <label className="label">Serial numbers ({units}) <span className="text-gray-400 font-normal">— space or comma</span></label>
                            <input className="input font-mono text-xs" value={l.serials} onChange={(e) => setLine(l.key, { serials: e.target.value })} placeholder="one per tyre, in fitting order" />
                          </div>
                          <div>
                            <label className="label">DOT (week+year)</label>
                            <input className="input font-mono text-xs" value={l.dots} onChange={(e) => setLine(l.key, { dots: e.target.value })} placeholder="2325 2325" />
                          </div>
                          <div>
                            <label className="label">GST %</label>
                            <input type="number" min="0" max="28" className="input" value={l.gstRate} onChange={(e) => setLine(l.key, { gstRate: Number(e.target.value) })} />
                          </div>
                          {oldDot && (
                            <p className="md:col-span-4 text-xs text-amber-700 flex items-center gap-1.5"><AlertTriangle className="w-3.5 h-3.5" />
                              Manufactured {oldDot.label} — about {Math.round(oldDot.ageMonths / 12)} years old. Tell the customer.</p>
                          )}
                          {l.kind === 'tyre' && units <= 6 && (
                            <div className="md:col-span-4 flex flex-wrap items-center gap-2">
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
                      </details>
                    )}
                  </li>
                )
              })}
            </ul>
          )}

          {/* quick jobs */}
          {!serviceMode && (services?.data ?? []).length > 0 && (
            <div className="p-4 border-t border-gray-100 bg-gray-50">
              <div className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2 flex items-center gap-1.5"><Wrench className="w-3.5 h-3.5" /> Quick add</div>
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

        {/* 5 · charges */}
        <details className={`card p-4 ${serviceMode ? '' : 'open'}`} open={!serviceMode}>
          <summary className={`text-sm font-medium text-gray-800 cursor-pointer ${serviceMode ? '' : 'hidden'}`}>Add other charges (alignment, balancing, weight, labour)</summary>
          <div className="text-xs text-gray-500 mb-2">Other charges — typed amounts, no GST</div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {CHARGE_LABELS.map((k) => (
              <div key={k}><label className="label" htmlFor={`ch-${k}`}>{k}</label>
                <input id={`ch-${k}`} type="number" min="0" className="input" placeholder="0" value={charges[k] ?? ''}
                  onChange={(e) => setCharges((c) => ({ ...c, [k]: e.target.value }))} /></div>
            ))}
          </div>
        </details>

        {/* 6 · more details */}
        <details className="card p-4">
          <summary className="text-sm font-medium text-gray-800 cursor-pointer">More details — address, PO, split payment, old tyre exchange, notes</summary>
          <div className="mt-4 space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {!party.id && (
                <div className="sm:col-span-2"><label className="label" htmlFor="addr">Customer address (printed on the bill)</label>
                  <input id="addr" className="input" value={address} onChange={(e) => setAddress(e.target.value)} /></div>
              )}
              <div><label className="label" htmlFor="po">PO number</label><input id="po" className="input" value={poNo} onChange={(e) => setPoNo(e.target.value)} /></div>
              <div><label className="label" htmlFor="vt">Vehicle type</label>
                <select id="vt" className="input" value={vehicleType} onChange={(e) => setVehicleType(e.target.value)}>
                  {Object.entries(VEHICLE_TYPE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select></div>
              <div><label className="label">Fitted by</label><input className="input" value={fittedBy} onChange={(e) => setFittedBy(e.target.value)} placeholder="Technician" /></div>
              <div className="sm:col-span-3"><label className="label">Notes</label><input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
            </div>
            {!serviceMode && (
              <div>
                <h3 className="text-xs font-semibold text-gray-600 mb-2 flex items-center gap-1.5"><Recycle className="w-3.5 h-3.5" /> Old tyre in exchange</h3>
                <div className="grid grid-cols-2 gap-3 max-w-sm">
                  <div><label className="label">How many</label><input type="number" min="0" className="input" value={exchQty} onChange={(e) => setExchQty(e.target.value)} /></div>
                  <div><label className="label">Allowance (₹)</label><input type="number" min="0" className="input" value={exchValue} onChange={(e) => setExchValue(e.target.value)} /></div>
                </div>
              </div>
            )}
            <div>
              <h3 className="text-xs font-semibold text-gray-600 mb-2">Split payment</h3>
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                {PAY_METHODS.map(([m, label]) => (
                  <div key={m}><label className="label" htmlFor={`p-${m}`}>{label}</label>
                    <input id={`p-${m}`} type="number" min="0" className="input" value={pay[m] ?? ''}
                      onChange={(e) => { setPayMode('split'); setPay((p) => ({ ...p, [m]: e.target.value })) }} /></div>
                ))}
              </div>
            </div>
          </div>
        </details>

        {problems.length > 0 && lines.length > 0 && (
          <ul className="text-xs text-amber-700 space-y-1">{problems.map((p) => <li key={p} className="flex gap-1.5"><AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />{p}</li>)}</ul>
        )}
      </div>

      {/* 7 · pinned total + payment + save */}
      <div className="sticky bottom-0 z-20 bg-white border-t border-gray-200 shadow-[0_-4px_12px_rgba(0,0,0,0.06)]">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-3 flex items-center gap-4 flex-wrap">
          <div className="min-w-[10rem]">
            <div className="text-[11px] text-gray-500 leading-4">
              {withGst
                ? <>Taxable {inr(totals.taxable, 2)} · CGST {inr(totals.cgst, 2)} · SGST {inr(totals.sgst, 2)}{totals.extra > 0 ? ` · Charges ${inr(totals.extra, 2)}` : ''}</>
                : <>No GST{totals.extra > 0 ? ` · incl. charges ${inr(totals.extra, 2)}` : ''}</>}
            </div>
            <div className="text-2xl font-bold text-gray-900">{inr(totals.grand)}</div>
          </div>
          <div className="flex gap-2 flex-1 justify-center">
            {([['cash', 'Cash'], ['upi', 'UPI'], ['credit', 'Credit']] as const).map(([m, label]) => (
              <button key={m} type="button" onClick={() => setPayMode(m)}
                className={`px-4 py-2 rounded-lg text-sm font-medium border ${payMode === m ? 'bg-primary-600 text-white border-primary-600' : 'bg-white text-gray-700 border-gray-200'}`}>
                {label}
              </button>
            ))}
            {payMode === 'split' && <span className="px-3 py-2 text-xs text-gray-500">Split — see More details</span>}
          </div>
          <div className="flex items-center gap-3">
            {balance > 0.5 && <span className="text-xs text-amber-700">Balance {inr(balance, 2)}{!hasCustomer ? ' — add customer' : ''}</span>}
            <button type="button" className="btn-primary px-6 py-3 text-base" disabled={!canSave} onClick={() => save.mutate()}>
              {save.isPending ? 'Saving…' : 'Save bill'}
            </button>
          </div>
        </div>
        {readOnly && <p className="text-xs text-gray-400 text-center pb-2">Read-only access — you cannot make bills.</p>}
      </div>
    </div>
  )
}
