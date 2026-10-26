// Wraps the whole app. In the packaged (licensed) app a PC without a valid license sees only this screen:
// its Machine ID to send to the software owner, and a box to paste the license file's text into.
// A licensed PC sees the app as usual, with a thin reminder when the license has 30 days or fewer left.
import { useEffect, useState } from 'react'
import { PRODUCT_NAME } from '@/lib/branding'

interface Status {
  required: boolean
  valid: boolean
  reason?: 'missing' | 'invalid' | 'machine' | 'expired' | 'clock' | 'product'
  machineId: string
  shop?: string
  expires?: string
  daysLeft?: number
}

const WHY: Record<string, string> = {
  missing: 'This computer is not licensed yet.',
  invalid: 'That license could not be read. Paste the whole text exactly as it was sent to you.',
  machine: 'That license was made for a different computer.',
  expired: 'The license has expired. Ask for a renewal.',
  clock: "The computer's date looks wrong (it is earlier than before). Correct the date and time, then reload.",
  product: 'That license is for a different product.',
}

async function fetchStatus(): Promise<Status | null> {
  try {
    const r = await fetch('/api/license/status', { cache: 'no-store' })
    return r.ok ? ((await r.json()) as Status) : null
  } catch { return null }
}

export function LicenseGate({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<Status | null | undefined>(undefined)   // undefined = still asking
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [copied, setCopied] = useState(false)

  useEffect(() => { void fetchStatus().then(setStatus) }, [])

  async function activate() {
    setBusy(true); setMsg('')
    try {
      const r = await fetch('/api/license/activate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ license: text.trim() }) })
      const s = (await r.json()) as Status & { error?: string }
      if (r.ok && s.valid) { window.location.reload(); return }
      setMsg(s.reason ? WHY[s.reason] ?? 'The license was refused.' : (s.error ?? 'The license was refused.'))
    } catch { setMsg('Could not reach the app. Check that Twisha POS is running, then try again.') }
    setBusy(false)
  }

  if (status === undefined) return <div className="min-h-screen bg-gray-50" />
  // the app could not be asked (not running / old server): show the app itself so its own errors are visible
  if (status === null || !status.required || status.valid) {
    return (
      <>
        {status && status.valid && status.required && typeof status.daysLeft === 'number' && status.daysLeft <= 30 && (
          <div className="bg-amber-50 border-b border-amber-200 text-amber-800 text-xs text-center py-1.5 px-3">
            Your license ends in {status.daysLeft} day{status.daysLeft === 1 ? '' : 's'} ({status.expires}). Contact Twisha Consultancy Services to renew.
          </div>
        )}
        {children}
      </>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-lg border border-gray-200 w-full max-w-lg p-6 sm:p-8">
        <h1 className="text-xl font-semibold text-gray-900">{PRODUCT_NAME} — activate</h1>
        <p className="text-sm text-gray-600 mt-1">{WHY[status.reason ?? 'missing']}{status.shop ? ` (${status.shop})` : ''}</p>

        <div className="mt-5">
          <div className="text-xs font-medium text-gray-500 uppercase tracking-wide">Step 1 — send this Machine ID</div>
          <div className="mt-1 flex items-center gap-2">
            <code className="flex-1 bg-gray-100 rounded-lg px-3 py-2 text-base font-mono tracking-wider text-gray-900 select-all">{status.machineId}</code>
            <button type="button" className="btn-secondary text-sm"
              onClick={() => { void navigator.clipboard?.writeText(status.machineId).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000) }) }}>
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <p className="text-xs text-gray-500 mt-1">Send it to Twisha Consultancy Services. You will get a license back.</p>
        </div>

        <div className="mt-5">
          <div className="text-xs font-medium text-gray-500 uppercase tracking-wide">Step 2 — paste the license</div>
          <textarea className="input mt-1 h-28 font-mono text-xs" value={text} onChange={(e) => setText(e.target.value)} placeholder="TWL1.…" spellCheck={false} />
          {msg && <p className="text-sm text-red-600 mt-1">{msg}</p>}
          <button type="button" className="btn-primary w-full justify-center mt-3" disabled={busy || text.trim().length < 20} onClick={() => void activate()}>
            {busy ? 'Checking…' : 'Activate'}
          </button>
        </div>
      </div>
    </div>
  )
}
