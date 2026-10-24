import { PRODUCT_NAME } from '@/lib/branding'

/** Twisha mark + "Twisha" with "POS" as a solid badge, on one line. `light` is for dark backgrounds. */
export function BrandLockup({ tone = 'dark', className = '' }: { tone?: 'dark' | 'light'; className?: string }) {
  const light = tone === 'light'
  const [first, ...rest] = PRODUCT_NAME.split(' ')
  return (
    <div className={`inline-flex items-center gap-4 ${className}`}>
      <span className={`flex items-center justify-center w-16 h-16 rounded-full shrink-0 bg-white ${light ? 'shadow-xl shadow-black/40 ring-4 ring-white/15' : 'shadow-lg shadow-emerald-900/15 ring-1 ring-black/10'}`}>
        <img src="/twisha-main.png" alt="" className="h-11 w-auto" />
      </span>
      <span className="flex items-center gap-2.5 leading-none">
        <span className={`text-[2.6rem] font-extrabold tracking-tight ${light ? 'text-white' : 'text-gray-900'}`}>{first}</span>
        {rest.length > 0 && (
          <span className="px-2.5 py-1.5 rounded-lg text-xl font-black tracking-[0.12em] text-emerald-950 bg-gradient-to-br from-emerald-200 to-emerald-400 shadow-md shadow-emerald-500/30">{rest.join(' ').toUpperCase()}</span>
        )}
      </span>
    </div>
  )
}
