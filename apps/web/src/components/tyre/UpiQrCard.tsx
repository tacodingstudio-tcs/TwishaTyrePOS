// "Scan & pay" card for one bill: the shop's own QR sheet (bank banner, shop name, SCAN & PAY, QR, UPI ID bar, UPI apps), but the QR carries the
// bill amount, so the customer's phone opens with the amount already filled in. Shown full-screen over the bill; Esc or a click outside closes it.
import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { QRCodeSVG } from 'qrcode.react'
import { X } from 'lucide-react'
import { upiLink, type UpiSettings } from '@/lib/upi'

const inr = (n: number) => `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export function UpiQrCard({ settings, amount, note, onClose }: { settings: UpiSettings; amount: number; note: string; onClose: () => void }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', esc)
    return () => document.removeEventListener('keydown', esc)
  }, [onClose])

  const link = upiLink(settings, amount, note)
  const base = import.meta.env.BASE_URL ?? '/'
  return createPortal(
    <div className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-3" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <button type="button" onClick={onClose} aria-label="Close" className="fixed right-3 top-3 z-[61] p-2 rounded-full bg-white shadow text-gray-700 hover:bg-gray-100"><X className="w-5 h-5" /></button>
      <div role="dialog" aria-label="Scan and pay" className="w-full max-w-[26rem] max-h-[96vh] overflow-y-auto rounded-2xl shadow-2xl text-center"
        style={{ background: 'linear-gradient(180deg,#f3f9fd 0%,#d7ebf6 100%)' }}>
        {settings.banner
          ? <img src={settings.banner} alt="" className="w-full block rounded-t-2xl" />
          : <div className="h-3" />}
        <div className="px-5 pt-3 pb-2">
          <div className="text-lg sm:text-xl font-bold tracking-wide uppercase" style={{ color: '#0b4d8f', fontFamily: 'Consolas, "Courier New", monospace' }}>{settings.name}</div>
          <div className="text-2xl sm:text-3xl font-extrabold mt-1" style={{ color: '#0b4d8f' }}>SCAN &amp; PAY</div>
          {link ? (
            <>
              <div className="mt-2 inline-block rounded-full bg-white px-5 py-1 shadow-sm">
                <span className="text-2xl sm:text-3xl font-bold text-gray-900">{inr(amount)}</span>
              </div>
              {note && <div className="text-xs text-gray-600 mt-1">{note}</div>}
              <div className="mt-3 mx-auto rounded-lg border bg-white p-3 inline-block" style={{ borderColor: '#2b62a8' }}>
                <QRCodeSVG value={link} level="M" marginSize={0} data-upi={link} className="block"
                  style={{ width: 'min(15rem, 42vh)', height: 'min(15rem, 42vh)' }} />
              </div>
            </>
          ) : <p className="mt-6 text-sm text-red-600">This amount cannot be paid by UPI.</p>}
        </div>
        <div className="mx-5 rounded-b-3xl px-3 py-2.5 text-white text-sm sm:text-base break-all" style={{ background: '#144a96', fontFamily: 'Consolas, "Courier New", monospace' }}>
          UPI ID: {settings.id}
        </div>
        <img src={`${base}upi/pay-apps.png`} alt="BHIM UPI, Google Pay, PhonePe, Paytm" className="mx-auto mt-3 mb-4 w-[78%] block" />
      </div>
    </div>,
    document.body,
  )
}
