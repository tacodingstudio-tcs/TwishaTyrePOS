import { PRODUCT_NAME } from '@/lib/branding'

/** The Twisha POS logo (white lettering). `light` = on the dark hero as is; otherwise on its own dark plate. */
export function BrandLockup({ tone = 'dark', className = '' }: { tone?: 'dark' | 'light'; className?: string }) {
  const img = <img src="/twisha-pos-logo-full.png" alt={PRODUCT_NAME} className="h-16 w-auto drop-shadow-[0_6px_14px_rgba(0,0,0,0.55)] drop-shadow-[0_0_22px_rgba(74,222,128,0.28)]" />
  return tone === 'light'
    ? <div className={`inline-flex ${className}`}>{img}</div>
    : <div className={`inline-flex rounded-2xl bg-gradient-to-br from-emerald-900 to-emerald-950 px-5 py-3 shadow-lg ${className}`}>{img}</div>
}
