// src/pages/LoginPage.tsx
// Twisha POS sign-in. Left: an immersive dark hero (a slowly turning tyre, a live-looking bill that shows the
// product's signature trick — type one price, tax is split out). Right: a calm sign-in card with a 4-box PIN.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation } from '@tanstack/react-query'
import { authApi } from '@/lib/api'
import { useAuthStore } from '@/store/auth.store'
import { Loader2, CircleDot, ShieldCheck, BellRing, Phone, ArrowRight, Check } from 'lucide-react'
import toast from 'react-hot-toast'
import { BrandLockup } from '@/components/BrandLockup'
import { PoweredByCard } from '@/components/PoweredBy'
import { PRODUCT_NAME } from '@/lib/branding'

const CSS = `
@keyframes tw-spin  { to { transform: rotate(360deg) } }
@keyframes tw-unspin { to { transform: rotate(-360deg) } }
@keyframes tw-float { 0%,100% { transform: translateY(0) } 50% { transform: translateY(-9px) } }
@keyframes tw-rise  { from { opacity: 0; transform: translateY(16px) } to { opacity: 1; transform: none } }
@keyframes tw-shine { 0%,55% { background-position: 160% 0 } 100% { background-position: -60% 0 } }
@keyframes tw-glow  { 0%,100% { opacity: .55 } 50% { opacity: .9 } }
@keyframes tw-sweep { from { background-position: -200% 0 } to { background-position: 200% 0 } }
.tw-spin  { animation: tw-spin 70s linear infinite }
.tw-unspin { animation: tw-unspin 70s linear infinite; transform-box: fill-box; transform-origin: center }
.tw-float { animation: tw-float 6s ease-in-out infinite }
.tw-rise  { animation: tw-rise .7s cubic-bezier(.2,.7,.2,1) both }
.tw-shine { background: linear-gradient(105deg, transparent 38%, rgba(255,255,255,.75) 50%, transparent 62%) no-repeat; background-size: 60% 100%; animation: tw-shine 5.5s ease-in-out infinite }
.tw-glow  { animation: tw-glow 5s ease-in-out infinite }
.tw-title { background: linear-gradient(100deg,#fff 20%,#86efac 45%,#fff 70%); background-size: 200% 100%; -webkit-background-clip: text; background-clip: text; color: transparent; animation: tw-sweep 7s linear infinite }
@media (prefers-reduced-motion: reduce) { .tw-spin,.tw-unspin,.tw-float,.tw-rise,.tw-glow,.tw-shine,.tw-title { animation: none } }
`

/** The tyre: tread blocks, sidewall lettering, a five-spoke rim and a hub. Pure SVG. */
function TyreArt({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 400 400" className={className} aria-hidden="true">
      <defs>
        <radialGradient id="tw-rim" cx="50%" cy="40%" r="65%">
          <stop offset="0" stopColor="#f0fdf4" /><stop offset="0.6" stopColor="#86efac" /><stop offset="1" stopColor="#15803d" />
        </radialGradient>
        <radialGradient id="tw-wall" cx="50%" cy="50%" r="50%">
          <stop offset="0.55" stopColor="#0b2417" /><stop offset="1" stopColor="#050f09" />
        </radialGradient>
        <radialGradient id="tw-hub" cx="50%" cy="38%" r="70%">
          <stop offset="0" stopColor="#f7fffa" /><stop offset="1" stopColor="#bbf7d0" />
        </radialGradient>
        <filter id="tw-hub-shadow" x="-30%" y="-30%" width="160%" height="160%">
          <feDropShadow dx="0" dy="2" stdDeviation="3" floodColor="#052e16" floodOpacity="0.45" />
        </filter>
        <path id="tw-arc" d="M200,200 m-141,0 a141,141 0 1,1 282,0 a141,141 0 1,1 -282,0" />
      </defs>
      {/* tread */}
      <circle cx="200" cy="200" r="188" fill="#040b07" stroke="#0f1f16" strokeWidth="2" />
      <circle cx="200" cy="200" r="178" fill="none" stroke="#22c55e" strokeOpacity="0.55" strokeWidth="20" strokeDasharray="9 11" />
      <circle cx="200" cy="200" r="178" fill="none" stroke="#052e16" strokeWidth="3" />
      {/* sidewall */}
      <circle cx="200" cy="200" r="158" fill="url(#tw-wall)" stroke="#14532d" strokeWidth="3" />
      <text fontSize="13" fontWeight="700" letterSpacing="7" fill="#4ade80" fillOpacity="0.85">
        <textPath href="#tw-arc" startOffset="0">TWISHA POS · RADIAL · TUBELESS · TWISHA POS · RADIAL · TUBELESS ·</textPath>
      </text>
      <circle cx="200" cy="200" r="118" fill="none" stroke="#166534" strokeWidth="2" strokeDasharray="2 6" />
      {/* rim */}
      <circle cx="200" cy="200" r="104" fill="url(#tw-rim)" stroke="#bbf7d0" strokeWidth="2" />
      {[0, 72, 144, 216, 288].map((a) => (
        <g key={a} transform={`rotate(${a} 200 200)`}>
          <rect x="188" y="104" width="24" height="74" rx="12" fill="#052e16" fillOpacity="0.92" />
          <circle cx="200" cy="120" r="5" fill="#bbf7d0" />
        </g>
      ))}
      <circle cx="200" cy="200" r="42" fill="url(#tw-hub)" stroke="#4ade80" strokeWidth="3" filter="url(#tw-hub-shadow)" />
      <circle cx="200" cy="200" r="37" fill="none" stroke="#16a34a" strokeOpacity="0.35" strokeWidth="1.5" />
      <image href="/twisha-main.png" x="178" y="172" width="44" height="58" className="tw-unspin" />
    </svg>
  )
}

/** A bill that shows what the product does: one typed price, the tax worked out underneath. */
function BillCard({ className = '', style }: { className?: string; style?: React.CSSProperties }) {
  const row = (k: string, v: string, strong = false) => (
    <div className={`flex justify-between ${strong ? 'text-white text-[15px] font-bold pt-2 mt-1 border-t border-white/15' : 'text-white/65 text-xs'}`}>
      <span>{k}</span><span className="tabular-nums">{v}</span>
    </div>
  )
  return (
    <div className={`rounded-2xl p-4 w-72 bg-black/45 backdrop-blur-lg ring-1 ring-white/20 shadow-2xl shadow-black/40 ${className}`} style={style}>
      <div className="flex items-center justify-between">
        <div className="text-[11px] uppercase tracking-wider text-white/50">Tax invoice · #94</div>
        <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-400/20 text-emerald-300 flex items-center gap-1">
          <Check className="w-3 h-3" /> Paid · UPI
        </span>
      </div>
      <div className="mt-3 text-sm font-semibold text-white">Yokohama 185/65 R15 <span className="text-white/50 font-normal">× 4</span></div>
      <div className="mt-2 rounded-lg bg-black/25 ring-1 ring-emerald-400/30 px-3 py-2 flex items-center justify-between">
        <span className="text-[11px] text-emerald-200/80">Data Entry (per tyre)</span>
        <span className="text-lg font-bold text-emerald-300 tabular-nums">₹10,400</span>
      </div>
      <div className="mt-3 space-y-1">
        {row('Taxable', '₹35,254.24')}
        {row('CGST 9%', '₹3,172.88')}
        {row('SGST 9%', '₹3,172.88')}
        {row('Total', '₹41,600', true)}
      </div>
    </div>
  )
}

/** Four boxes, one digit each: type, paste, backspace and arrows all behave. */
function PinBoxes({ value, onChange, onComplete }: { value: string; onChange: (v: string) => void; onComplete?: (pin: string) => void }) {
  const refs = useRef<Array<HTMLInputElement | null>>([])
  const digits = value.padEnd(4, ' ').split('')
  const set = (next: string) => {
    const clean = next.replace(/\D/g, '').slice(0, 4)
    onChange(clean)
    if (clean.length === 4) onComplete?.(clean)
  }
  return (
    <div className="flex gap-3 justify-between" role="group" aria-label="4-digit PIN">
      {[0, 1, 2, 3].map((i) => (
        <input
          key={i}
          ref={(el) => { refs.current[i] = el }}
          id={i === 0 ? 'login-pin' : undefined}
          type="password" inputMode="numeric" autoComplete="off" maxLength={1}
          aria-label={`PIN digit ${i + 1}`}
          value={digits[i] === ' ' ? '' : digits[i]}
          onFocus={(e) => e.target.select()}
          onChange={(e) => {
            const d = e.target.value.replace(/\D/g, '').slice(-1)
            const arr = value.padEnd(4, ' ').split('')
            arr[i] = d || ' '
            set(arr.join('').replace(/ /g, ''))
            if (d && i < 3) refs.current[i + 1]?.focus()
          }}
          onKeyDown={(e) => {
            if (e.key === 'Backspace' && !digits[i]?.trim() && i > 0) { refs.current[i - 1]?.focus() }
            if (e.key === 'ArrowLeft' && i > 0) refs.current[i - 1]?.focus()
            if (e.key === 'ArrowRight' && i < 3) refs.current[i + 1]?.focus()
          }}
          onPaste={(e) => {
            const t = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 4)
            if (t) { e.preventDefault(); set(t); refs.current[Math.min(t.length, 3)]?.focus() }
          }}
          className="w-full h-14 text-center text-2xl font-bold rounded-xl border border-gray-300 bg-white
                     focus:border-primary-500 focus:ring-4 focus:ring-primary-100 outline-none transition
                     data-[filled=true]:border-primary-400 data-[filled=true]:bg-primary-50/40"
          data-filled={!!digits[i]?.trim()}
        />
      ))}
    </div>
  )
}

export function LoginPage() {
  const navigate = useNavigate()
  const setAuth  = useAuthStore((s) => s.setAuth)
  const [phone, setPhone] = useState('')
  const [pin, setPin]     = useState('')
  const [bizPhone, setBizPhone] = useState('')
  const [isStaff, setIsStaff]   = useState(false)
  const greeting = useMemo(() => {
    const h = new Date().getHours()
    return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'
  }, [])

  // The server sleeps when nobody has used it for a while and takes up to a minute to wake. Knock on its door the
  // moment this page opens, so it is already waking while the person types their number and PIN.
  const [waking, setWaking] = useState(false)
  useEffect(() => { fetch('/api/tenants/domains', { cache: 'no-store' }).catch(() => {}) }, [])

  const loginMutation = useMutation({
    mutationFn: async (p: string) => {
      // A sleeping server answers 502 / 503 / 504 (or nothing at all) until it is up: wait and try again for about
      // a minute instead of telling the person their PIN is wrong.
      for (let attempt = 0; ; attempt++) {
        try {
          const out = await authApi.login(phone, p, isStaff ? bizPhone : undefined)
          setWaking(false)
          return out
        } catch (err: any) {
          const status = err?.response?.status as number | undefined
          const asleep = !status || status === 502 || status === 503 || status === 504
          if (!asleep || attempt >= 7) { setWaking(false); throw err }
          setWaking(true); toast.dismiss()
          await new Promise((r) => setTimeout(r, 8000))
        }
      }
    },
    onSuccess: (data) => {
      setAuth(data.accessToken, data.refreshToken, data.accessTokenExpiresIn, data.user, data.tenant, data.branch)
      toast.success(`Welcome back, ${data.user.name}!`)
      navigate('/')
    },
    onError: (err: any) => {
      // No response = server unreachable/asleep; the api layer already shows that message.
      // the api layer has already toasted the server's wording; replace it with ours so there is one clear message
      const st = err?.response?.status as number | undefined
      if (!st || st === 502 || st === 503 || st === 504) { toast.dismiss(); toast.error('The server is not answering yet — wait a minute and try again') }
      else { toast.dismiss(); toast.error(st === 429 ? 'Too many tries — wait a minute' : 'Wrong phone number or PIN') }
      // start the PIN again from the first box (a half-edited old PIN would otherwise re-submit on the 4th digit)
      setPin('')
      setTimeout(() => document.getElementById('login-pin')?.focus(), 30)
    },
  })

  const ready = phone.length >= 10 && pin.length === 4 && (!isStaff || bizPhone.length >= 10)
  function submit() {
    if (!ready || loginMutation.isPending) return
    loginMutation.mutate(pin)
  }

  return (
    <div className="min-h-screen grid lg:grid-cols-[1.15fr_1fr] bg-[#050f09]">
      <style>{CSS}</style>

      {/* ══ Hero ═══════════════════════════════════════════════════════════════════ */}
      <aside className="hidden lg:flex relative overflow-hidden flex-col justify-between p-12 text-white"
        style={{ background: 'radial-gradient(1100px 700px at 15% 0%, #14532d 0%, #052e16 38%, #050f09 75%)' }}>
        {/* dot grid + glow */}
        <div className="absolute inset-0 opacity-[0.14]" style={{ backgroundImage: 'radial-gradient(#86efac 1px, transparent 1px)', backgroundSize: '26px 26px' }} aria-hidden="true" />
        <div className="absolute -right-24 top-1/3 w-[34rem] h-[34rem] rounded-full bg-emerald-400/20 blur-3xl tw-glow" aria-hidden="true" />

        {/* the tyre, half off the canvas */}
        <div className="absolute -right-36 -bottom-40 w-[31rem] h-[31rem]" aria-hidden="true">
          <TyreArt className="w-full h-full tw-spin drop-shadow-[0_30px_60px_rgba(0,0,0,0.6)]" />
        </div>

        <header className="relative tw-rise">
          <BrandLockup tone="light" />
        </header>

        <div className="relative max-w-xl">
          <p className="tw-rise text-emerald-300/90 text-sm font-semibold tracking-[0.2em] uppercase" style={{ animationDelay: '.05s' }}>Point of sale · Tyre shops</p>
          <h1 className="tw-rise tw-title mt-4 text-5xl xl:text-6xl [@media(max-height:760px)]:text-4xl xl:[@media(max-height:760px)]:text-5xl font-extrabold leading-[1.05] tracking-tight" style={{ animationDelay: '.12s' }}>
            Every bill.<br />Every tyre.<br />Every rupee.
          </h1>
          <p className="tw-rise mt-6 [@media(max-height:760px)]:mt-4 text-lg [@media(max-height:760px)]:text-base text-white/70 max-w-sm" style={{ animationDelay: '.2s' }}>
            Type one price. {PRODUCT_NAME} splits the GST, tracks the warranty, reminds the customer and keeps your stock honest.
          </p>

          <div className="tw-rise mt-9 [@media(max-height:760px)]:mt-5 flex flex-wrap gap-2.5 max-w-sm" style={{ animationDelay: '.3s' }}>
            {[
              [ShieldCheck, 'Warranty on every serial'],
              [BellRing, 'Service due → WhatsApp'],
              [Check, 'GST-ready, always'],
            ].map(([Icon, text]) => {
              const I = Icon as React.ElementType
              return (
                <span key={text as string} className="inline-flex items-center gap-2 rounded-full bg-white/[0.07] ring-1 ring-white/15 backdrop-blur px-3.5 py-1.5 text-sm text-white/85">
                  <I className="w-4 h-4 text-emerald-300" /> {text as string}
                </span>
              )
            })}
          </div>
        </div>

        {/* floating bill, over the tyre */}
        <div className="absolute right-10 top-20 tw-rise hidden min-[1400px]:flex flex-col items-end gap-3" style={{ animationDelay: '.45s' }}>
          <BillCard className="tw-float" />
          <div className="tw-float w-72 [@media(max-height:780px)]:hidden rounded-xl bg-black/55 backdrop-blur-lg ring-1 ring-white/20 px-4 py-3 shadow-xl shadow-black/40"
            style={{ animationDelay: '-2.5s' }}>
            <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-white/55">
              <BellRing className="w-3.5 h-3.5 text-emerald-300" /> Next due
            </div>
            <div className="mt-1 font-semibold text-white text-sm">Wheel alignment · GJ 03 AB 4521</div>
            <div className="text-xs text-emerald-300 mt-0.5">in 14 days · WhatsApp ready</div>
          </div>
        </div>

        <div />
      </aside>

      {/* ══ Sign in ════════════════════════════════════════════════════════════════ */}
      <main className="relative flex items-center justify-center px-5 py-10 z-10 overflow-hidden"
        style={{ background: 'linear-gradient(135deg, #ffffff 0%, #f0fdf4 55%, #fefce8 100%)' }}>
        <svg className="absolute inset-0 w-full h-full pointer-events-none" aria-hidden="true" preserveAspectRatio="none" viewBox="0 0 400 600" fill="none">
          <path d="M-20 520 C 120 440, 220 560, 420 470" stroke="#fcd34d" strokeWidth="1.5" strokeDasharray="7 9" opacity=".7" />
          <path d="M-20 90 C 140 150, 260 40, 420 110" stroke="#86efac" strokeWidth="1.5" strokeDasharray="7 9" opacity=".7" />
        </svg>
        <div className="relative w-full max-w-md tw-rise">

          <div className="flex justify-center mb-6 lg:hidden"><BrandLockup className="scale-90" /></div>
          <div className="rounded-3xl bg-white shadow-xl shadow-emerald-900/10 ring-1 ring-black/5 overflow-hidden">
            <div className="h-1.5 bg-gradient-to-r from-amber-300 via-lime-300 to-emerald-400" />
            <div className="px-7 pt-7 pb-8 sm:px-9">

          <div className="flex items-center gap-4">
            <span className="w-14 h-14 rounded-2xl bg-gray-900 text-white flex items-center justify-center shrink-0 shadow-md">
              <CircleDot className="w-7 h-7" />
            </span>
            <div>
              <p className="text-sm font-semibold text-amber-600">{greeting} 👋</p>
              <h2 className="text-3xl font-extrabold text-gray-900 tracking-tight leading-tight">Welcome back</h2>
            </div>
          </div>
          <p className="text-sm text-gray-500 mt-4">
            {isStaff ? 'Staff sign-in — add the shop’s registered number too.' : 'Sign in to run your tyre sales, fitting and warranties.'}
          </p>

          <form onSubmit={(e) => { e.preventDefault(); submit() }} className="mt-7 space-y-5">
            <div>
              <label className="label" htmlFor="login-phone">Phone number</label>
              <div className="relative">
                <Phone className="w-4 h-4 text-gray-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                <span className="absolute left-10 top-1/2 -translate-y-1/2 text-sm text-gray-400 select-none">+91</span>
                <input
                  id="login-phone" type="tel" inputMode="numeric" maxLength={10} placeholder="98765 43210" autoFocus
                  value={phone} onChange={(e) => setPhone(e.target.value.replace(/\D/g, ''))}
                  className="w-full h-12 pl-[4.6rem] pr-3 rounded-xl border border-gray-300 bg-white text-base
                             focus:border-primary-500 focus:ring-4 focus:ring-primary-100 outline-none transition"
                />
              </div>
            </div>

            {isStaff && (
              <div className="tw-rise">
                <label className="label" htmlFor="login-biz">Shop's registered phone <span className="text-gray-400 font-normal">(the owner's number)</span></label>
                <input
                  id="login-biz" type="tel" inputMode="numeric" maxLength={10} placeholder="Owner's phone"
                  value={bizPhone} onChange={(e) => setBizPhone(e.target.value.replace(/\D/g, ''))}
                  className="w-full h-12 px-3.5 rounded-xl border border-gray-300 bg-white text-base
                             focus:border-primary-500 focus:ring-4 focus:ring-primary-100 outline-none transition"
                />
              </div>
            )}

            <div>
              <label className="label" htmlFor="login-pin">PIN</label>
              <PinBoxes value={pin} onChange={setPin} onComplete={(p) => { if (phone.length >= 10 && (!isStaff || bizPhone.length >= 10) && !loginMutation.isPending) loginMutation.mutate(p) }} />
            </div>

            <button type="submit" disabled={!ready || loginMutation.isPending}
              className="group w-full h-12 rounded-xl font-semibold text-white flex items-center justify-center gap-2
                         bg-gradient-to-r from-primary-600 to-emerald-600 shadow-lg shadow-primary-600/25
                         hover:shadow-xl hover:shadow-primary-600/35 hover:-translate-y-px active:translate-y-0
                         disabled:opacity-50 disabled:shadow-none disabled:hover:translate-y-0 transition-all">
              {loginMutation.isPending
                ? <><Loader2 className="w-4 h-4 animate-spin" /> Signing you in…</>
                : <>Sign in <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-0.5" /></>}
            </button>
            {waking && (
              <p role="status" className="text-center text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                The server was asleep and is waking up — this takes up to a minute. Please wait, you will be signed in automatically.
              </p>
            )}

            <button type="button" onClick={() => setIsStaff((v) => !v)}
              className="block mx-auto text-xs text-gray-500 hover:text-primary-600">
              {isStaff ? 'I am the owner' : 'Staff member? Sign in with the shop’s number'}
            </button>
          </form>


            </div>
          </div>

          <p className="mt-4 flex items-center justify-center gap-1.5 text-xs text-gray-500">
            <ShieldCheck className="w-3.5 h-3.5 text-emerald-500" /> Your PIN is never stored or shown
          </p>
          <div className="mt-6 flex justify-center"><PoweredByCard /></div>
        </div>
      </main>
    </div>
  )
}
