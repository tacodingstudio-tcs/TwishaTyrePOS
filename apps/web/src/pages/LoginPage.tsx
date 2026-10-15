// src/pages/LoginPage.tsx
// Twisha POS sign-in: a brand panel on the left (desktop) and the form on the right.
import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useMutation } from '@tanstack/react-query'
import { authApi } from '@/lib/api'
import { useAuthStore } from '@/store/auth.store'
import { CircleDot, Loader2, ReceiptText, ShieldCheck, Boxes, Users, Phone, Lock } from 'lucide-react'
import toast from 'react-hot-toast'
import { PoweredBy } from '@/components/PoweredBy'
import { PRODUCT_NAME } from '@/lib/branding'

const FEATURES: Array<[React.ElementType, string, string]> = [
  [ReceiptText, 'Bills in seconds', 'GST-ready invoices — type one price, the tax is worked out for you'],
  [ShieldCheck, 'Warranty & service reminders', 'Serial numbers on file, next alignment due, WhatsApp to the customer'],
  [Boxes, 'Stock that tells you what to order', 'Reorder alerts, dead stock and purchase orders in one place'],
  [Users, 'Your whole shop', 'Staff attendance, salary, advances, shop costs and money to collect'],
]

export function LoginPage() {
  const navigate = useNavigate()
  const setAuth  = useAuthStore((s) => s.setAuth)
  const [phone, setPhone] = useState('')
  const [pin, setPin]     = useState('')
  const [bizPhone, setBizPhone] = useState('')
  const [isStaff, setIsStaff]   = useState(false)

  const loginMutation = useMutation({
    mutationFn: () => authApi.login(phone, pin, isStaff ? bizPhone : undefined),
    onSuccess: (data) => {
      setAuth(
        data.accessToken, data.refreshToken, data.accessTokenExpiresIn,
        data.user, data.tenant, data.branch
      )
      toast.success(`Welcome back, ${data.user.name}!`)
      navigate('/')
    },
    onError: (err: any) => {
      // No response = server unreachable/asleep; the api layer already shows that message.
      if (err?.response) toast.error(err.response.status === 429 ? 'Too many tries — wait a minute' : 'Wrong phone number or PIN')
    },
  })

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (phone.length < 10 || pin.length !== 4 || (isStaff && bizPhone.length < 10)) return
    loginMutation.mutate()
  }

  return (
    <div className="min-h-screen grid lg:grid-cols-[1.05fr_1fr] bg-white">

      {/* ── Brand panel ─────────────────────────────────────────────────────────── */}
      <aside className="hidden lg:flex relative overflow-hidden flex-col justify-between p-12 text-white bg-gradient-to-br from-primary-700 via-primary-800 to-gray-900">
        {/* tyre-tread rings */}
        <svg className="absolute -right-40 -bottom-40 w-[44rem] h-[44rem] opacity-[0.10]" viewBox="0 0 200 200" fill="none" aria-hidden="true">
          {[96, 80, 64, 48, 32].map((r, i) => (
            <circle key={r} cx="100" cy="100" r={r} stroke="white" strokeWidth={i === 0 ? 10 : 3} strokeDasharray={i === 0 ? '3 5' : undefined} />
          ))}
          <circle cx="100" cy="100" r="10" fill="white" />
        </svg>
        <div className="absolute -left-24 -top-24 w-72 h-72 rounded-full bg-white/5" aria-hidden="true" />

        <div className="relative">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-xl bg-white/15 backdrop-blur flex items-center justify-center ring-1 ring-white/25">
              <CircleDot className="w-6 h-6" />
            </div>
            <div className="leading-tight">
              <div className="text-xl font-bold tracking-tight">{PRODUCT_NAME}</div>
              <div className="text-xs text-white/70">Point of sale for tyre shops</div>
            </div>
          </div>

          <h1 className="mt-16 text-4xl font-bold leading-tight max-w-md">
            Run the whole tyre shop from one screen.
          </h1>
          <p className="mt-4 text-white/75 max-w-md">
            Sell, fit, track warranty and stock, pay your people and know what is owed — built for how a tyre counter actually works.
          </p>

          <ul className="mt-10 space-y-5 max-w-md">
            {FEATURES.map(([Icon, title, text]) => (
              <li key={title} className="flex gap-4">
                <span className="mt-0.5 w-9 h-9 shrink-0 rounded-lg bg-white/10 ring-1 ring-white/15 flex items-center justify-center">
                  <Icon className="w-[18px] h-[18px]" />
                </span>
                <span>
                  <span className="block text-sm font-semibold">{title}</span>
                  <span className="block text-sm text-white/65">{text}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className="relative text-xs text-white/60">
          <span>
            Powered by{' '}
            <a href="https://www.twishaconsultancyservices.com/" target="_blank" rel="noopener noreferrer"
              className="font-semibold text-white/90 hover:text-white hover:underline">Twisha Consultancy Services</a>
          </span>
        </div>
      </aside>

      {/* ── Sign-in ─────────────────────────────────────────────────────────────── */}
      <main className="flex items-center justify-center px-5 py-10 bg-gradient-to-br from-primary-50/60 to-gray-50">
        <div className="w-full max-w-sm">

          {/* small screens: the brand sits above the form */}
          <div className="lg:hidden text-center mb-8">
            <div className="w-14 h-14 mx-auto rounded-2xl bg-primary-600 flex items-center justify-center mb-3 shadow-lg shadow-primary-600/25">
              <CircleDot className="w-7 h-7 text-white" />
            </div>
            <div className="text-xl font-bold text-gray-900">{PRODUCT_NAME}</div>
            <div className="text-xs text-gray-500">Point of sale for tyre shops</div>
          </div>

          <div className="mb-6">
            <h2 className="text-2xl font-bold text-gray-900">Sign in to {PRODUCT_NAME}</h2>
            <p className="text-sm text-gray-500 mt-1">
              {isStaff ? 'Staff sign-in — use the shop’s registered number as well.' : 'Use your registered phone number and 4-digit PIN.'}
            </p>
          </div>

          <form onSubmit={handleSubmit} className="card p-6 space-y-4 shadow-sm">
            <div>
              <label className="label" htmlFor="login-phone">Phone number</label>
              <div className="relative">
                <Phone className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  id="login-phone" type="tel" inputMode="numeric" maxLength={10} placeholder="9876543210"
                  value={phone} onChange={(e) => setPhone(e.target.value.replace(/\D/g, ''))}
                  className="input pl-9" autoFocus
                />
              </div>
            </div>

            {isStaff && (
              <div>
                <label className="label" htmlFor="login-biz">Business phone <span className="text-gray-400 font-normal">(the owner's number)</span></label>
                <input
                  id="login-biz" type="tel" inputMode="numeric" maxLength={10} placeholder="Owner's registered phone"
                  value={bizPhone} onChange={(e) => setBizPhone(e.target.value.replace(/\D/g, ''))}
                  className="input"
                />
              </div>
            )}

            <div>
              <label className="label" htmlFor="login-pin">4-digit PIN</label>
              <div className="relative">
                <Lock className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  id="login-pin" type="password" inputMode="numeric" maxLength={4} placeholder="••••"
                  value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
                  className="input pl-9 text-center text-2xl tracking-[0.5em] font-semibold"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={phone.length < 10 || pin.length !== 4 || (isStaff && bizPhone.length < 10) || loginMutation.isPending}
              className="btn-primary w-full justify-center mt-2 py-2.5"
            >
              {loginMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : `Sign in to ${PRODUCT_NAME}`}
            </button>
            <button type="button" onClick={() => setIsStaff((v) => !v)}
              className="block mx-auto text-xs text-gray-500 hover:text-primary-600">
              {isStaff ? 'I am the owner' : 'Staff member? Sign in with the business phone'}
            </button>
          </form>

          <p className="text-center text-sm text-gray-500 mt-5">
            New shop?{' '}
            <Link to="/register" className="text-primary-600 font-medium hover:underline">Create your {PRODUCT_NAME} account</Link>
          </p>

          {/* the panel above carries the credit on desktop; small screens get it here */}
          <PoweredBy className="text-center mt-8 lg:hidden" />

          {import.meta.env.DEV && (
            <details className="mt-6">
              <summary className="text-center text-xs text-gray-400 cursor-pointer select-none">Demo accounts (dev only) ▾</summary>
              <div className="mt-2 text-xs text-gray-500 bg-gray-50 rounded-lg p-3 space-y-1">
                {[
                  ['Owner — demo shop', '9200000001', '1111'],
                  ['Manager', '9200000011', '2222'],
                  ['Viewer (read-only)', '9200000012', '3333'],
                  ['Owner — Shakti Enterprise', '9300000001', '2468'],
                ].map(([who, ph, pn]) => {
                  const staff = ph === '9200000011' || ph === '9200000012'
                  return (
                    <div key={ph} className="flex justify-between gap-2 cursor-pointer hover:text-primary-600 py-0.5"
                      onClick={() => { setPhone(ph ?? ''); setPin(pn ?? ''); setIsStaff(staff); setBizPhone(staff ? '9200000001' : '') }}>
                      <span className="font-medium">{who}</span>
                      <span>{ph}</span>
                      <span className="font-mono">{pn}</span>
                    </div>
                  )
                })}
                <p className="text-gray-400 pt-1">Click a row to fill the form. Run <code>pnpm --filter @billing/api seed</code> to create the demo shop.</p>
              </div>
            </details>
          )}
        </div>
      </main>
    </div>
  )
}
