// "Show QR" button: opens the scan-and-pay card for an amount. Needs the shop's UPI ID (My Business → Edit business); without it the button
// says so instead of doing nothing.
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { QrCode } from 'lucide-react'
import toast from 'react-hot-toast'
import { branchApi } from '@/lib/api'
import { upiSettings, upiAmount } from '@/lib/upi'
import { UpiQrCard } from './UpiQrCard'

export function UpiQrButton({ amount, note, className = 'btn-ghost border border-gray-200', label = 'Show QR', onOpen }: { amount: number; note: string; className?: string; label?: string; onOpen?: () => void }) {
  const [open, setOpen] = useState(false)
  const { data: branches } = useQuery({ queryKey: ['branches'], queryFn: () => branchApi.list(), staleTime: 60_000 })
  const b = (branches as any[] | undefined)?.[0]
  const settings = upiSettings(b?.domainConfig, String(b?.domainConfig?.['business_name'] ?? b?.name ?? ''))
  const ok = upiAmount(amount) !== null
  return (
    <>
      <button type="button" className={`${className} whitespace-nowrap`} disabled={!ok} title={ok ? 'Show a QR the customer can scan to pay this amount' : 'Nothing to pay yet'}
        onClick={() => { if (!settings) { toast.error('Add the shop’s UPI ID first: My Business → Edit business → UPI ID'); return } setOpen(true); onOpen?.() }}>
        <QrCode className="w-4 h-4" /> {label}
      </button>
      {open && settings && <UpiQrCard settings={settings} amount={amount} note={note} onClose={() => setOpen(false)} />}
    </>
  )
}
