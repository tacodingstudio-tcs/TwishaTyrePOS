import { PRODUCT_NAME } from '@/lib/branding'

/** The Twisha POS logo. `light` is for the dark hero: the logo's dark-green lettering needs a white plate. */
export function BrandLockup({ tone = 'dark', className = '' }: { tone?: 'dark' | 'light'; className?: string }) {
  const img = <img src="/twisha-pos-logo.png" alt={PRODUCT_NAME} className="h-14 w-auto" />
  return tone === 'light'
    ? <div className={`inline-flex rounded-2xl bg-white px-5 py-3 shadow-xl shadow-black/40 ring-4 ring-white/15 ${className}`}>{img}</div>
    : <div className={`inline-flex ${className}`}>{img}</div>
}
