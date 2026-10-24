// Tyre size picker: choose Width → Profile → Rim from lists (no typing, no typos), and the size is written the
// standard way. A "type it myself" box stays for unusual sizes, and says at once whether it understood what was typed.
import { useEffect, useState } from 'react'
import { Check } from 'lucide-react'
import { SIZE_LISTS, NO_PROFILE, familyOf, formatSize, parseSize, tyreSizeError, type SizeFormat } from '@/lib/tyreSize'

interface Props {
  value: string
  onChange: (size: string) => void
  /** drives which lists are offered: car / SUV, truck / bus / tractor, two- and three-wheeler */
  vehicleType?: string
}

const FORMAT_LABEL: Record<SizeFormat, string> = { radial: 'Radial (e.g. 185/65 R15)', crossply: 'Cross-ply (e.g. 10.00-20)' }

export function SizePicker({ value, onChange, vehicleType }: Props) {
  const family = familyOf(vehicleType)
  const parsed = parseSize(value)
  // a saved size that is not in the lists (an unusual width, say) opens in type-it-yourself mode so nothing is lost
  const fits = !!parsed && (() => { const L = SIZE_LISTS[family][parsed.format]; return L.a.includes(parsed.a) && L.c.includes(parsed.c) && (parsed.format === 'crossply' || parsed.b === NO_PROFILE || !!L.b?.includes(parsed.b ?? '')) })()
  const [manual, setManual] = useState(() => !!value && !fits)
  const [format, setFormat] = useState<SizeFormat>(parsed?.format ?? (family === 'bike' && !value ? 'radial' : 'radial'))
  const [a, setA] = useState(parsed?.a ?? '')
  const [b, setB] = useState(parsed?.b ?? '')
  const [c, setC] = useState(parsed?.c ?? '')
  const [typed, setTyped] = useState(value)
  const lists = SIZE_LISTS[family][format]
  const needsB = format === 'radial'

  // another vehicle class means other lists: keep the format if it exists, clear picks that no longer apply
  useEffect(() => {
    if (manual) return
    if (a && !lists.a.includes(a)) setA('')
    if (b && b !== NO_PROFILE && lists.b && !lists.b.includes(b)) setB('')
    if (c && !lists.c.includes(c)) setC('')
  }, [family, format]) // eslint-disable-line react-hooks/exhaustive-deps

  // the saved value follows the picks; incomplete picks save nothing, so a half-chosen size can never be stored
  useEffect(() => {
    if (manual) return
    const complete = a && c && (!needsB || b)
    onChange(complete ? formatSize({ format, a, b: needsB ? b : undefined, c }, family) : '')
  }, [a, b, c, format, family, manual]) // eslint-disable-line react-hooks/exhaustive-deps

  const error = manual ? tyreSizeError(typed, true) : ''
  const sel = 'input !py-2 text-sm'
  const picked = !manual && value

  return (
    <div className="col-span-2 space-y-2">
      <div className="flex items-center gap-1 flex-wrap">
        {(['radial', 'crossply'] as SizeFormat[]).map((f) => (
          <button key={f} type="button" disabled={manual} onClick={() => { setFormat(f); setA(''); setB(''); setC('') }}
            className={`px-2.5 py-1 rounded-full text-xs border ${!manual && format === f ? 'bg-primary-600 text-white border-primary-600' : 'bg-white text-gray-600 border-gray-300 disabled:opacity-40'}`}>
            {FORMAT_LABEL[f]}
          </button>
        ))}
        <button type="button" onClick={() => { setManual(!manual); setTyped(value) }}
          className="ml-auto text-xs text-gray-500 hover:text-primary-700 underline">{manual ? 'Choose from lists' : 'Type it myself'}</button>
      </div>

      {!manual ? (
        <div className={`grid gap-2 ${needsB ? 'grid-cols-3' : 'grid-cols-2'}`}>
          <div>
            <label className="sr-only" htmlFor="size-a">{lists.labels[0]}</label>
            <select id="size-a" className={sel} value={a} onChange={(e) => setA(e.target.value)}>
              <option value="">{lists.labels[0]}</option>
              {lists.a.map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
          </div>
          {needsB && (
            <div>
              <label className="sr-only" htmlFor="size-b">{lists.labels[1]}</label>
              <select id="size-b" className={sel} value={b} onChange={(e) => setB(e.target.value)}>
                <option value="">{lists.labels[1]}</option>
                <option value={NO_PROFILE}>No profile (155 R13)</option>
                {lists.b!.map((x) => <option key={x} value={x}>{x}</option>)}
              </select>
            </div>
          )}
          <div>
            <label className="sr-only" htmlFor="size-c">{lists.labels[2]}</label>
            <select id="size-c" className={sel} value={c} onChange={(e) => setC(e.target.value)}>
              <option value="">{lists.labels[2]} (inch)</option>
              {lists.c.map((x) => <option key={x} value={x}>{format === 'radial' && family !== 'bike' ? `R${x}` : x}</option>)}
            </select>
          </div>
        </div>
      ) : (
        <input id="size-manual" className={`input font-mono ${error ? 'border-red-400' : ''}`} placeholder={lists.example} value={typed}
          onChange={(e) => {
            const t = e.target.value.toUpperCase().replace(/[^A-Z0-9./ -]/g, '').slice(0, 20)
            setTyped(t)
            const p = parseSize(t)
            onChange(p && !tyreSizeError(t) ? formatSize(p, family) : '')
          }} />
      )}

      <p className="text-xs h-4">
        {error && <span className="text-red-600">{error}</span>}
        {!error && picked && <span className="text-green-700 inline-flex items-center gap-1"><Check className="w-3 h-3" /> Size: <b className="font-mono">{value}</b></span>}
        {!error && manual && value && <span className="text-green-700 inline-flex items-center gap-1"><Check className="w-3 h-3" /> Saved as <b className="font-mono">{value}</b></span>}
        {!error && !picked && !manual && <span className="text-gray-400">Choose width{needsB ? ', profile' : ''} and rim</span>}
      </p>
    </div>
  )
}
