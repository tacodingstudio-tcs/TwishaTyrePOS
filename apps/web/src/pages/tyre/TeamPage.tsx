// Team & salary — the shop's own people (with or without a login): daily attendance,
// advances / bonus / deductions, monthly payroll and salary payments.
import { ValidatedInput } from '@/components/ui/ValidatedInput'
import { check, firstError } from '@/lib/validate'
import { useMemo, useState } from 'react'
import { localIso, localMonth } from '@/lib/dates'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { UserPlus, Wallet, CalendarCheck, Users } from 'lucide-react'
import { tyreApi, apiError } from '@/lib/api'
import { useAuthStore } from '@/store/auth.store'
import { PageHeader } from '@/components/layout/PageHeader'
import { inr, fmtDate } from '@/components/tyre/format'

type Tab = 'today' | 'payroll' | 'people'
const STATUS: Array<[string, string, string]> = [
  ['present', 'Present', 'bg-green-600 text-white border-green-600'],
  ['half',    'Half',    'bg-amber-500 text-white border-amber-500'],
  ['absent',  'Absent',  'bg-red-600 text-white border-red-600'],
  ['leave',   'Leave',   'bg-blue-600 text-white border-blue-600'],
]
const thisMonth = () => localMonth()
const todayIso = () => localIso()

export function TeamPage() {
  const role = useAuthStore((s) => s.user?.role)
  const [tab, setTab] = useState<Tab>('today')
  if (role !== 'owner' && role !== 'manager') {
    return (<div><PageHeader title="Team & salary" /><p className="p-8 text-sm text-gray-500">Only the owner or a manager can see salary details.</p></div>)
  }
  return (
    <div>
      <PageHeader title="Team & salary" subtitle="Attendance, advances, monthly salary and payments" />
      <div className="px-6 pt-4 flex gap-2">
        {([['today', 'Attendance', CalendarCheck], ['payroll', 'Salary', Wallet], ['people', 'People', Users]] as const).map(([k, label, Icon]) => (
          <button key={k} type="button" onClick={() => setTab(k)}
            className={`px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2 border ${tab === k ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-700 border-gray-200'}`}>
            <Icon className="w-4 h-4" /> {label}
          </button>
        ))}
      </div>
      <div className="p-6">
        {tab === 'today' && <Attendance />}
        {tab === 'payroll' && <Payroll />}
        {tab === 'people' && <People />}
      </div>
    </div>
  )
}

// ── Attendance ────────────────────────────────────────────────────────────────
function Attendance() {
  const qc = useQueryClient()
  const [date, setDate] = useState(todayIso())
  const { data: staff } = useQuery({ queryKey: ['team-staff'], queryFn: () => tyreApi.teamStaff() })
  const { data: days } = useQuery({ queryKey: ['team-days', date], queryFn: () => tyreApi.teamDays({ date }) })
  const marks = useMemo(() => {
    const m: Record<string, { status: string; overtimeHours: number }> = {}
    for (const d of days?.data ?? []) m[d.staffId] = { status: d.status, overtimeHours: d.overtimeHours }
    return m
  }, [days])
  const ot = useMutation({
    mutationFn: (v: { staffId: string; hours: number }) => tyreApi.teamOvertime({ ...v, date }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['team-days'] }),
    onError: (e) => toast.error(apiError(e)),
  })
  const save = useMutation({
    mutationFn: (v: { staffId: string; status: string | null; overtimeHours?: number }) => tyreApi.teamMark({ ...v, date }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['team-days'] }),
    onError: (e) => toast.error(apiError(e)),
  })
  const people: any[] = staff?.data ?? []
  return (
    <section className="card">
      <div className="p-5 border-b border-gray-100 flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-sm font-semibold text-gray-900">Who came today?</h2>
          <p className="text-xs text-gray-500">Monthly staff with no mark are paid as present — mark only absences, half days and leave.</p>
        </div>
        <input type="date" className="input w-auto" value={date} max={todayIso()} onChange={(e) => setDate(e.target.value)} aria-label="Date" />
      </div>
      {people.length === 0 ? <p className="p-8 text-center text-sm text-gray-400">Add your people under “People” first.</p> : (
        <ul className="divide-y divide-gray-100">
          {people.map((p) => {
            const m = marks[p.id]
            return (
              <li key={p.id} className="p-4 flex items-center gap-3 flex-wrap">
                <div className="min-w-[10rem] flex-1">
                  <div className="text-sm font-medium text-gray-900">{p.name}</div>
                  <div className="text-xs text-gray-500">{p.designation ?? '—'} · {p.salaryType === 'daily' ? `${inr(p.baseSalary)}/day` : `${inr(p.baseSalary)}/month`}</div>
                </div>
                <div className="flex gap-1.5">
                  {STATUS.map(([k, label, on]) => (
                    <button key={k} type="button" disabled={save.isPending}
                      onClick={() => save.mutate({ staffId: p.id, status: m?.status === k ? null : k, overtimeHours: m?.overtimeHours ?? 0 })}
                      className={`px-3 py-1.5 rounded-md text-xs font-medium border ${m?.status === k ? on : 'bg-white text-gray-600 border-gray-200'}`}>
                      {label}
                    </button>
                  ))}
                </div>
                <label className="text-xs text-gray-500 flex items-center gap-1">OT h
                  <input type="number" min="0" max="16" step="0.5" className="input w-16 py-1 text-xs"
                    defaultValue={m?.overtimeHours ?? 0} key={`${p.id}-${date}-${m?.overtimeHours ?? 0}`}
                    onBlur={(e) => { const h = Math.min(16, Math.max(0, Number(e.target.value) || 0)); if (h !== (m?.overtimeHours ?? 0)) ot.mutate({ staffId: p.id, hours: h }) }} />
                </label>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

// ── Payroll ───────────────────────────────────────────────────────────────────
function Payroll() {
  const qc = useQueryClient()
  const [month, setMonth] = useState(thisMonth())
  const [dlg, setDlg] = useState<{ row: any; kind: 'pay' | 'advance' | 'bonus' | 'deduction' | 'recovery' } | null>(null)
  const [ot, setOt] = useState<any | null>(null)
  const { data, isLoading } = useQuery({ queryKey: ['team-payroll', month], queryFn: () => tyreApi.teamPayroll(month) })
  const rows: any[] = data?.data ?? []
  const refresh = () => { qc.invalidateQueries({ queryKey: ['team-payroll'] }); qc.invalidateQueries({ queryKey: ['team-staff'] }) }
  return (
    <>
      <section className="card">
        <div className="p-5 border-b border-gray-100 flex items-center justify-between gap-3 flex-wrap">
          <h2 className="text-sm font-semibold text-gray-900">Salary for the month</h2>
          <input type="month" className="input w-auto" value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Month" />
        </div>
        {isLoading ? <p className="p-8 text-center text-sm text-gray-400">Loading…</p> : rows.length === 0 ? (
          <p className="p-8 text-center text-sm text-gray-400">No team members yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-xs text-gray-500 border-b border-gray-100">
                <th className="p-3">Name</th><th className="p-3 text-right">Days</th><th className="p-3 text-right">Earned</th>
                <th className="p-3 text-right">OT</th><th className="p-3 text-right">Bonus</th><th className="p-3 text-right">Deduct</th>
                <th className="p-3 text-right">Advance back</th><th className="p-3 text-right">Net</th><th className="p-3 text-right">Paid</th>
                <th className="p-3 text-right">Due</th><th className="p-3" />
              </tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.staffId} className="border-b border-gray-50 align-top">
                    <td className="p-3"><div className="font-medium text-gray-900">{r.name}</div>
                      <div className="text-xs text-gray-500">{r.designation ?? '—'}{r.advanceOutstanding > 0 ? ` · advance owed ${inr(r.advanceOutstanding)}` : ''}</div></td>
                    <td className="p-3 text-right text-xs text-gray-600">{r.payableDays}/{r.salaryType === 'daily' ? '—' : r.workingDays}
                      <div className="text-gray-400">{r.absent ? `${r.absent} abs ` : ''}{r.half ? `${r.half} half` : ''}</div></td>
                    <td className="p-3 text-right">{inr(r.earned)}</td>
                    <td className="p-3 text-right">{r.overtimeHours ? <>{inr(r.overtimePay)}<div className="text-xs text-gray-400">{r.overtimeHours} h</div></> : '—'}</td>
                    <td className="p-3 text-right">{r.bonus ? inr(r.bonus) : '—'}</td>
                    <td className="p-3 text-right">{r.deductions ? inr(r.deductions) : '—'}</td>
                    <td className="p-3 text-right">{r.recovery ? inr(r.recovery) : '—'}</td>
                    <td className="p-3 text-right font-semibold">{inr(r.net)}</td>
                    <td className="p-3 text-right text-green-700">{r.paid ? inr(r.paid) : '—'}</td>
                    <td className={`p-3 text-right font-semibold ${r.due > 0 ? 'text-red-600' : 'text-gray-400'}`}>{inr(r.due)}</td>
                    <td className="p-3">
                      <div className="flex gap-1 justify-end flex-wrap">
                        <button type="button" className="btn-primary text-xs px-2 py-1" disabled={r.due <= 0} onClick={() => setDlg({ row: r, kind: 'pay' })}>Pay</button>
                        <button type="button" className="btn-ghost border border-gray-200 text-xs px-2 py-1" onClick={() => setDlg({ row: r, kind: 'advance' })}>Advance</button>
                        <button type="button" className="btn-ghost border border-gray-200 text-xs px-2 py-1" onClick={() => setOt(r)}>Overtime</button>
                        <button type="button" className="btn-ghost border border-gray-200 text-xs px-2 py-1" onClick={() => setDlg({ row: r, kind: 'bonus' })}>Bonus</button>
                        <button type="button" className="btn-ghost border border-gray-200 text-xs px-2 py-1" onClick={() => setDlg({ row: r, kind: 'deduction' })}>Deduct</button>
                        {r.advanceOutstanding > 0 && (
                          <button type="button" className="btn-ghost border border-gray-200 text-xs px-2 py-1" onClick={() => setDlg({ row: r, kind: 'recovery' })}>Recover advance</button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot><tr className="text-sm font-semibold">
                <td className="p-3" colSpan={7}>Total</td>
                <td className="p-3 text-right">{inr(data?.totals?.net ?? 0)}</td>
                <td className="p-3 text-right">{inr(data?.totals?.paid ?? 0)}</td>
                <td className="p-3 text-right">{inr(data?.totals?.due ?? 0)}</td><td />
              </tr></tfoot>
            </table>
          </div>
        )}
      </section>
      {dlg && <EntryDialog month={month} row={dlg.row} kind={dlg.kind} onClose={() => setDlg(null)} onDone={() => { setDlg(null); refresh() }} />}
      {ot && <OvertimeDialog month={month} row={ot} onClose={() => setOt(null)} onChanged={refresh} />}
    </>
  )
}

const KIND_LABEL = { pay: 'Pay salary', advance: 'Give advance', bonus: 'Add bonus', deduction: 'Add deduction', recovery: 'Recover advance from salary' } as const

function EntryDialog({ month, row, kind, onClose, onDone }: { month: string; row: any; kind: keyof typeof KIND_LABEL; onClose: () => void; onDone: () => void }) {
  const max = kind === 'pay' ? row.due : kind === 'recovery' ? row.advanceOutstanding : undefined
  const [amount, setAmount] = useState(max ? String(max) : '')
  const [method, setMethod] = useState('cash')
  const [note, setNote] = useState('')
  const go = useMutation({
    mutationFn: () => {
      const amt = Number(amount)
      return kind === 'pay'
        ? tyreApi.teamPay({ staffId: row.staffId, month, amount: amt, method, note: note || undefined })
        : tyreApi.teamLedger({ staffId: row.staffId, kind, amount: amt, month, method, note: note || undefined })
    },
    onSuccess: () => { toast.success('Saved'); onDone() },
    onError: (e) => toast.error(apiError(e)),
  })
  const bad = !(Number(amount) > 0) || (max !== undefined && Number(amount) > max + 0.005)
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl w-full max-w-sm p-6 space-y-4">
        <div>
          <h3 className="text-base font-semibold text-gray-900">{KIND_LABEL[kind]}</h3>
          <p className="text-xs text-gray-500">{row.name} · {month}{max !== undefined ? ` · up to ${inr(max)}` : ''}</p>
        </div>
        <div><label className="label" htmlFor="amt">Amount (₹)</label>
          <input id="amt" type="number" min="1" className="input" autoFocus value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
        {(kind === 'pay' || kind === 'advance') && (
          <div><label className="label" htmlFor="meth">Paid by</label>
            <select id="meth" className="input" value={method} onChange={(e) => setMethod(e.target.value)}>
              <option value="cash">Cash</option><option value="upi">UPI</option><option value="bank_transfer">Bank</option><option value="cheque">Cheque</option>
            </select></div>
        )}
        <div><label className="label" htmlFor="nt">Note (optional)</label>
          <input id="nt" className="input" value={note} onChange={(e) => setNote(e.target.value)} /></div>
        {kind === 'recovery' && <p className="text-xs text-gray-500">This reduces this month's salary and clears that much of the advance. No money moves.</p>}
        <div className="flex gap-2 justify-end">
          <button type="button" className="btn-ghost border border-gray-200" onClick={onClose}>Cancel</button>
          <button type="button" className="btn-primary" disabled={bad || go.isPending} onClick={() => go.mutate()}>{go.isPending ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
  )
}

// ── People ────────────────────────────────────────────────────────────────────
function People() {
  const qc = useQueryClient()
  const { data } = useQuery({ queryKey: ['team-staff', 'all'], queryFn: () => tyreApi.teamStaff({ all: 'true' }) })
  const [form, setForm] = useState({ name: '', phone: '', designation: '', salaryType: 'monthly', baseSalary: '', joinDate: '', weeklyOff: '0' })
  const add = useMutation({
    mutationFn: () => tyreApi.teamAddStaff({
      name: form.name.trim(), phone: form.phone.trim() || null, designation: form.designation.trim() || null,
      salaryType: form.salaryType, baseSalary: Number(form.baseSalary), joinDate: form.joinDate || null, weeklyOff: Number(form.weeklyOff),
    }),
    onSuccess: () => {
      toast.success('Added')
      setForm({ name: '', phone: '', designation: '', salaryType: 'monthly', baseSalary: '', joinDate: '', weeklyOff: '0' })
      qc.invalidateQueries({ queryKey: ['team-staff'] })
    },
    onError: (e) => toast.error(apiError(e)),
  })
  const toggle = useMutation({
    mutationFn: (p: any) => tyreApi.teamUpdateStaff(p.id, { isActive: !p.isActive }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['team-staff'] }),
    onError: (e) => toast.error(apiError(e)),
  })
  const f = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm({ ...form, [k]: e.target.value })
  const people: any[] = data?.data ?? []
  return (
    <div className="grid grid-cols-1 xl:grid-cols-3 gap-6 items-start">
      <section className="card xl:col-span-2">
        <div className="p-5 border-b border-gray-100"><h2 className="text-sm font-semibold text-gray-900">Your people</h2></div>
        {people.length === 0 ? <p className="p-8 text-center text-sm text-gray-400">Nobody added yet.</p> : (
          <ul className="divide-y divide-gray-100">
            {people.map((p) => (
              <li key={p.id} className={`p-4 flex items-center justify-between gap-3 ${p.isActive ? '' : 'opacity-60'}`}>
                <div>
                  <div className="text-sm font-medium text-gray-900">{p.name}{p.isActive ? '' : ' (left)'}</div>
                  <div className="text-xs text-gray-500">
                    {[p.designation, p.phone, p.salaryType === 'daily' ? `${inr(p.baseSalary)} / day` : `${inr(p.baseSalary)} / month`].filter(Boolean).join(' · ')}
                    {p.advanceOutstanding > 0 ? ` · advance owed ${inr(p.advanceOutstanding)}` : ''}
                  </div>
                </div>
                <button type="button" className="btn-ghost border border-gray-200 text-xs" onClick={() => toggle.mutate(p)}>
                  {p.isActive ? 'Mark as left' : 'Re-join'}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="card p-5">
        <h2 className="text-sm font-semibold text-gray-900 mb-4 flex items-center gap-2"><UserPlus className="w-4 h-4 text-gray-400" /> Add a person</h2>
        <div className="space-y-3">
          <div><label className="label" htmlFor="pn">Name</label><input id="pn" className="input" value={form.name} onChange={f('name')} /></div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="label" htmlFor="pp">Mobile</label><ValidatedInput id="pp" kind="mobile" value={form.phone} onChange={(v) => setForm({ ...form, phone: v })} placeholder="10-digit mobile" /></div>
            <div><label className="label" htmlFor="pd">Role</label><input id="pd" className="input" placeholder="Fitter" value={form.designation} onChange={f('designation')} /></div>
            <div><label className="label" htmlFor="pt">Paid</label>
              <select id="pt" className="input" value={form.salaryType} onChange={f('salaryType')}><option value="monthly">Monthly</option><option value="daily">Daily wage</option></select></div>
            <div><label className="label" htmlFor="ps">{form.salaryType === 'daily' ? 'Per day (₹)' : 'Per month (₹)'}</label>
              <input id="ps" type="number" min="0" className="input" value={form.baseSalary} onChange={f('baseSalary')} /></div>
            <div><label className="label" htmlFor="pj">Joined on</label><input id="pj" type="date" className="input" value={form.joinDate} onChange={f('joinDate')} /></div>
            <div><label className="label" htmlFor="pw">Weekly off</label>
              <select id="pw" className="input" value={form.weeklyOff} onChange={f('weeklyOff')}>
                {['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((d, i) => <option key={d} value={i}>{d}</option>)}
                <option value="-1">None</option>
              </select></div>
          </div>
          <button type="button" className="btn-primary w-full justify-center" disabled={!form.name.trim() || form.baseSalary === '' || Number(form.baseSalary) < 0 || !!check('mobile', form.phone) || add.isPending} onClick={() => add.mutate()}>
            {add.isPending ? 'Adding…' : 'Add'}
          </button>
        </div>
      </section>
    </div>
  )
}


/** Overtime for one person in a month: add hours on a date, see and remove what is already there. Pay = hours × the hourly rate. */
function OvertimeDialog({ month, row, onClose, onChanged }: { month: string; row: any; onClose: () => void; onChanged: () => void }) {
  const qc = useQueryClient()
  const today = todayIso()
  const lastOfMonth = (() => { const [y, m] = month.split('-').map(Number) as [number, number]; return `${month}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}` })()
  const maxDate = lastOfMonth < today ? lastOfMonth : today
  const [date, setDate] = useState(today.startsWith(month) ? today : lastOfMonth)
  const [hours, setHours] = useState('')
  const { data } = useQuery({ queryKey: ['team-days-month', month], queryFn: () => tyreApi.teamDays({ month }) })
  const mine: Array<{ date: string; overtimeHours: number }> = (data?.data ?? []).filter((d: any) => d.staffId === row.staffId && d.overtimeHours > 0)
  const rate = Number(row.hourlyRate ?? 0)
  const go = useMutation({
    mutationFn: (v: { date: string; hours: number }) => tyreApi.teamOvertime({ staffId: row.staffId, ...v }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['team-days-month'] }); qc.invalidateQueries({ queryKey: ['team-days'] }); setHours(''); onChanged() },
    onError: (e) => toast.error(apiError(e)),
  })
  const h = Number(hours)
  const bad = !(h > 0) || h > 16 || date > today || !date.startsWith(month)
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl w-full max-w-md p-6 space-y-4 max-h-[95vh] overflow-y-auto">
        <div>
          <h3 className="text-base font-semibold text-gray-900">Overtime</h3>
          <p className="text-xs text-gray-500">{row.name} · {month} · {inr(rate)} per hour ({row.salaryType === 'daily' ? 'day rate ÷ 8' : 'salary ÷ working days ÷ 8'})</p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className="label" htmlFor="ot-date">Date</label>
            <input id="ot-date" type="date" className="input" min={`${month}-01`} max={maxDate} value={date} onChange={(e) => setDate(e.target.value)} /></div>
          <div><label className="label" htmlFor="ot-h">Hours</label>
            <input id="ot-h" type="number" min="0.5" max="16" step="0.5" className="input" autoFocus placeholder="e.g. 2.5" value={hours} onChange={(e) => setHours(e.target.value)} /></div>
        </div>
        {h > 0 && !bad && <p className="text-sm text-gray-700">{h} h × {inr(rate)} = <strong>{inr(h * rate)}</strong> added to this month’s salary.</p>}
        <button type="button" className="btn-primary w-full justify-center" disabled={bad || go.isPending} onClick={() => go.mutate({ date, hours: h })}>{go.isPending ? 'Saving…' : 'Add overtime'}</button>
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-1">Overtime this month — {row.overtimeHours || 0} h · {inr(row.overtimePay || 0)}</div>
          {mine.length === 0 ? <p className="text-sm text-gray-500">None yet.</p> : (
            <ul className="divide-y divide-gray-100 border border-gray-100 rounded-lg">
              {mine.map((d) => (
                <li key={d.date} className="flex items-center justify-between px-3 py-2 text-sm">
                  <span>{fmtDate(d.date)} · {d.overtimeHours} h <span className="text-gray-400">({inr(d.overtimeHours * rate)})</span></span>
                  <button type="button" className="text-xs text-red-500 hover:text-red-700" disabled={go.isPending} onClick={() => go.mutate({ date: d.date, hours: 0 })}>Remove</button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex justify-end"><button type="button" className="btn-ghost" onClick={onClose}>Done</button></div>
      </div>
    </div>
  )
}
