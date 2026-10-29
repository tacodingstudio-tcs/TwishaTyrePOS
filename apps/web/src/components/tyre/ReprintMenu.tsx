// Reprint a bill: Original, Duplicate or Triplicate (the copy type is printed where the bill says "Original"),
// or open it as a PDF. Used on the All Bills list and on the bill page.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Printer, ChevronDown, FileText } from 'lucide-react'
import { openPdf, printPdf } from './openPdf'

const COPIES = [
  { id: 'original', label: 'Original', hint: 'the customer’s bill' },
  { id: 'duplicate', label: 'Duplicate', hint: 'reprint / office copy' },
  { id: 'triplicate', label: 'Triplicate', hint: 'extra copy' },
] as const

export function ReprintMenu({ invoiceId, number, compact = false, label = 'Reprint' }: { invoiceId: string; number: string; compact?: boolean; label?: string }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  // The menu is drawn on the page itself (not inside the table card, which clips anything that sticks out) and placed beside the
  // button: below it when there is room, above it on a small screen.
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null)
  useLayoutEffect(() => {
    if (!open || !box.current) return
    const place = () => {
      const r = box.current!.getBoundingClientRect()
      const h = menu.current?.offsetHeight ?? 200
      const below = r.bottom + 4
      const top = below + h <= window.innerHeight - 8 ? below : Math.max(8, r.top - 4 - h)
      setPos({ top, right: Math.max(8, window.innerWidth - r.right) })
    }
    place()
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true)
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [open])
  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => { const t = e.target as Node; if (!box.current?.contains(t) && !menu.current?.contains(t)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', away); document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc) }
  }, [open])

  const path = (copy: string) => `/invoices/${invoiceId}/pdf?copy=${copy}`
  return (
    <div ref={box} className="relative inline-block">
      <button type="button" aria-haspopup="menu" aria-expanded={open} title={`${label} bill ${number}`}
        onClick={() => setOpen((v) => !v)}
        className={compact ? 'inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium text-gray-600 hover:bg-gray-100 border border-gray-200' : 'btn-ghost'}>
        <Printer className="w-4 h-4" /> {label} <ChevronDown className="w-3 h-3" />
      </button>
      {open && createPortal(
        <div ref={menu} role="menu" style={{ position: 'fixed', top: pos?.top ?? 0, right: pos?.right ?? 8, visibility: pos ? 'visible' : 'hidden' }}
          className="z-50 w-56 rounded-lg border border-gray-200 bg-white shadow-lg py-1 text-left">
          {COPIES.map((c) => (
            <button key={c.id} type="button" role="menuitem" className="w-full px-3 py-2 text-sm text-left hover:bg-gray-50 flex items-center gap-2"
              onClick={() => { setOpen(false); void printPdf(path(c.id), `${number}-${c.id}.pdf`) }}>
              <Printer className="w-4 h-4 text-gray-400" />
              <span className="flex-1">Print {c.label}<span className="block text-[11px] text-gray-400">{c.hint}</span></span>
            </button>
          ))}
          <div className="my-1 border-t border-gray-100" />
          <button type="button" role="menuitem" className="w-full px-3 py-2 text-sm text-left hover:bg-gray-50 flex items-center gap-2"
            onClick={() => { setOpen(false); void openPdf(path('original'), `${number}.pdf`) }}>
            <FileText className="w-4 h-4 text-gray-400" /> Open as PDF
          </button>
        </div>,
        document.body,
      )}
    </div>
  )
}
