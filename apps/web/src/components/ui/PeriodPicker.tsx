// One period control for the dashboard and the analytics reports: 7D · 30D · 90D · Month · Year · Custom (from – to).
// `periodParams(p)` is what to send to the analytics API; `periodRange(p)` / `periodLabel(p)` are for the screen.
import { useState } from 'react'
import { localIso } from '@/lib/dates'

export type PeriodKey = '7d' | '30d' | '90d' | 'month' | 'year' | 'custom'
export interface PeriodState { period: PeriodKey; from?: string; to?: string }

const BUTTONS: Array<{ key: PeriodKey; label: string; title: string }> = [
  { key: '7d', label: '7D', title: 'Last 7 days' },
  { key: '30d', label: '30D', title: 'Last 30 days' },
  { key: '90d', label: '90D', title: 'Last 90 days' },
  { key: 'month', label: 'Month', title: 'This month so far' },
  { key: 'year', label: 'Year', title: 'This financial year (from 1 April)' },
  { key: 'custom', label: 'Custom', title: 'Pick your own dates' },
]

/** what the analytics endpoints take */
export const periodParams = (p: PeriodState): Record<string, string> =>
  p.period === 'custom' ? { period: 'custom', from: p.from ?? '', to: p.to ?? '' } : { period: p.period }

/** a custom range is only usable once both dates are there and in order */
export const periodReady = (p: PeriodState): boolean => p.period !== 'custom' || (!!p.from && !!p.to && p.from <= p.to)

/** the dates the period covers (same rules as the server) */
export function periodRange(p: PeriodState): { from: string; to: string } {
  const now = new Date()
  if (p.period === 'custom') return { from: p.from ?? localIso(now), to: p.to && p.to < localIso(now) ? p.to : localIso(now) }
  if (p.period === 'month') return { from: localIso(new Date(now.getFullYear(), now.getMonth(), 1)), to: localIso(now) }
  if (p.period === 'year') return { from: localIso(new Date(now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1, 3, 1)), to: localIso(now) }
  const from = new Date(now); from.setDate(from.getDate() - (p.period === '90d' ? 90 : p.period === '30d' ? 30 : 7))
  return { from: localIso(from), to: localIso(now) }
}

const dm = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })

export function periodLabel(p: PeriodState): string {
  if (p.period === 'custom') return p.from && p.to ? `${dm(p.from)} – ${dm(p.to)}` : 'Custom range'
  return { '7d': 'Last 7 days', '30d': 'Last 30 days', '90d': 'Last 90 days', month: 'This month', year: 'This financial year' }[p.period]
}

export function PeriodPicker({ value, onChange, className = '' }: { value: PeriodState; onChange: (p: PeriodState) => void; className?: string }) {
  const today = localIso()
  const [draft, setDraft] = useState({ from: value.from ?? '', to: value.to ?? '' })
  const [open, setOpen] = useState(value.period === 'custom')
  const bad = !draft.from || !draft.to || draft.from > draft.to

  return (
    <div className={`flex items-center gap-2 flex-wrap justify-end ${className}`}>
      {open && (
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
          <button key={b.key} type="button" title={b.title} aria-pressed={value.period === b.key}
            onClick={() => { if (b.key === 'custom') setOpen(true); else { setOpen(false); onChange({ period: b.key }) } }}
            className={`px-3 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              (b.key === 'custom' ? open || value.period === 'custom' : value.period === b.key) ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}>{b.label}</button>
        ))}
      </div>
    </div>
  )
}
