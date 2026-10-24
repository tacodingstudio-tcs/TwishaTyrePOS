import { PRODUCT_NAME } from '@/lib/branding'

/** The Twisha POS logo (white lettering). `light` = on the dark hero as is; otherwise on its own dark plate. */
export function BrandLockup({ tone = 'dark', className = '' }: { tone?: 'dark' | 'light'; className?: string }) {
  const img = <img src="/twisha-pos-logo-full.png" alt={PRODUCT_NAME} className="h-16 w-auto drop-shadow-[0_6px_14px_rgba(0,0,0,0.55)] drop-shadow-[0_0_22px_rgba(74,222,128,0.28)]" />
  if (tone !== 'light') return <div className={`inline-flex rounded-2xl bg-gradient-to-br from-emerald-900 to-emerald-950 px-5 py-3 shadow-lg ${className}`}>{img}</div>
  // On the hero: a soft green halo behind the logo and a slow light sweep that only touches the logo's own pixels.
  const mask = { WebkitMaskImage: 'url(/twisha-pos-logo-full.png)', maskImage: 'url(/twisha-pos-logo-full.png)', WebkitMaskSize: '100% 100%', maskSize: '100% 100%' }
  return (
    <div className={`relative inline-flex ${className}`}>
      <span aria-hidden="true" className="tw-glow absolute -inset-x-8 -inset-y-6 rounded-full bg-emerald-400/25 blur-2xl" />
      <span aria-hidden="true" className="absolute -inset-x-3 -inset-y-2 rounded-3xl bg-gradient-to-r from-white/[0.07] to-transparent ring-1 ring-white/10 backdrop-blur-[2px]" />
      <span className="relative inline-flex">
        {img}
        <span aria-hidden="true" className="tw-shine absolute inset-0 pointer-events-none" style={mask} />
      </span>
    </div>
  )
}
