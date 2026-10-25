// One period control for the dashboard and the analytics reports:
//   7D · 30D · 90D · Month (this month, or pick any month) · Year (this financial year, or pick any) · Custom (from – to).
// `periodParams(p)` is what to send to the analytics API; `periodRange(p)` / `periodLabel(p)` are for the screen.
import { useState } from 'react'
import { localIso } from '@/lib/dates'

export type PeriodKey = '7d' | '30d' | '90d' | 'month' | 'year' | 'custom'
/** `pick` / `label` are set when a specific month or financial year was chosen (it is sent to the server as a custom from–to) */
export interface PeriodState { period: PeriodKey; from?: string; to?: string; pick?: 'month' | 'year'; label?: string }

const BUTTONS: Array<{ key: PeriodKey; label: string; title: string }> = [
  { key: '7d', label: '7D', title: 'Last 7 days' },
  { key: '30d', label: '30D', title: 'Last 30 days' },
  { key: '90d', label: '90D', title: 'Last 90 days' },
  { key: 'month', label: 'Month', title: 'Pick a month' },
  { key: 'year', label: 'Year', title: 'Pick a financial year (April – March)' },
  { key: 'custom', label: 'Custom', title: 'Pick your own dates' },
]

/** what the analytics endpoints take */
export const periodParams = (p: PeriodState): Record<string, string> =>
  p.period === 'custom' ? { period: 'custom', from: p.from ?? '', to: p.to ?? '' } : { period: p.period }

/** a custom range is only usable once both dates are there and in order */
export const periodReady = (p: PeriodState): boolean => p.period !== 'custom' || (!!p.from && !!p.to && p.from <= p.to)

/** the dates the period covers (same rules as the server: the end is never later than today) */
export function periodRange(p: PeriodState): { from: string; to: string } {
  const now = new Date(); const today = localIso(now)
  if (p.period === 'custom') return { from: p.from ?? today, to: p.to && p.to < today ? p.to : today }
  if (p.period === 'month') return { from: localIso(new Date(now.getFullYear(), now.getMonth(), 1)), to: today }
  if (p.period === 'year') return { from: localIso(new Date(now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1, 3, 1)), to: today }
  const from = new Date(now); from.setDate(from.getDate() - (p.period === '90d' ? 90 : p.period === '30d' ? 30 : 7))
  return { from: localIso(from), to: today }
}

const dm = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })

export function periodLabel(p: PeriodState): string {
  if (p.label) return p.label
  if (p.period === 'custom') return p.from && p.to ? `${dm(p.from)} – ${dm(p.to)}` : 'Custom range'
  return { '7d': 'Last 7 days', '30d': 'Last 30 days', '90d': 'Last 90 days', month: 'This month', year: 'This financial year' }[p.period]
}

const monthState = (ym: string): PeriodState => {
  const [y, m] = ym.split('-').map(Number) as [number, number]
  return { period: 'custom', pick: 'month', from: `${ym}-01`, to: localIso(new Date(y, m, 0)),
    label: new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }) }
}
const fyState = (fy: number): PeriodState => ({ period: 'custom', pick: 'year', from: `${fy}-04-01`, to: `${fy + 1}-03-31`, label: `FY ${fy}-${String(fy + 1).slice(2)}` })

export function PeriodPicker({ value, onChange, className = '' }: { value: PeriodState; onChange: (p: PeriodState) => void; className?: string }) {
  const now = new Date(); const today = localIso(now)
  const thisFy = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1
  const [panel, setPanel] = useState<null | 'month' | 'year' | 'custom'>(value.period === 'custom' && !value.pick ? 'custom' : null)
  const [draft, setDraft] = useState({ from: value.from ?? '', to: value.to ?? '' })
  const bad = !draft.from || !draft.to || draft.from > draft.to
  const curMonth = value.pick === 'month' && value.from ? value.from.slice(0, 7) : today.slice(0, 7)
  const curFy = value.pick === 'year' && value.from ? Number(value.from.slice(0, 4)) : thisFy
  const fys = Array.from({ length: 8 }, (_, i) => thisFy - i)

  const active = (k: PeriodKey): boolean =>
    k === 'custom' ? panel === 'custom' || (value.period === 'custom' && !value.pick)
    : k === 'month' ? panel === 'month' || value.period === 'month' || value.pick === 'month'
    : k === 'year' ? panel === 'year' || value.period === 'year' || value.pick === 'year'
    : value.period === k && !panel

  const press = (k: PeriodKey) => {
    if (k === 'month') { setPanel('month'); onChange(value.pick === 'month' ? value : { period: 'month' }) }
    else if (k === 'year') { setPanel('year'); onChange(value.pick === 'year' ? value : { period: 'year' }) }
    else if (k === 'custom') setPanel('custom')
    else { setPanel(null); onChange({ period: k }) }
  }

  return (
    <div className={`flex items-center gap-2 flex-wrap justify-end ${className}`}>
      {panel === 'month' && (
        <input type="month" aria-label="Choose month" className="input py-1 text-xs w-40" max={today.slice(0, 7)} value={curMonth}
          onChange={(e) => { if (/^\d{4}-\d{2}$/.test(e.target.value)) onChange(monthState(e.target.value)) }} />
      )}
      {panel === 'year' && (
        <select aria-label="Choose financial year" className="input py-1 text-xs w-36" value={curFy} onChange={(e) => onChange(fyState(Number(e.target.value)))}>
          {fys.map((y) => <option key={y} value={y}>{`FY ${y}-${String(y + 1).slice(2)}${y === thisFy ? ' (this year)' : ''}`}</option>)}
        </select>
      )}
      {panel === 'custom' && (
        <div className="flex items-center gap-1.5 text-xs">
          <input type="date" aria-label="From date" className="input py-1 text-xs w-36" max={draft.to || today} value={draft.from}
            onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
          <span className="text-gray-400">to</span>
          <input type="date" aria-label="To date" className="input py-1 text-xs w-36" min={draft.from} max={today} value={draft.to}
            onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
          <button type="button" className="btn-primary text-xs px-2.5 py-1" disabled={bad}
            onClick={() => onChange({ period: 'custom', from: draft.from, to: draft.to })}>Apply</button>
        </div>
      )}
      <div className="flex gap-1 bg-gray-100 rounded-lg p-1" role="group" aria-label="Period">
        {BUTTONS.map((b) => (
          <button key={b.key} type="button" title={b.title} aria-pressed={active(b.key)} onClick={() => press(b.key)}
            className={`px-3 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              active(b.key) ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}>{b.label}</button>
        ))}
      </div>
    </div>
  )
}
