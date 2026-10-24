import { PRODUCT_NAME } from '@/lib/branding'

/** Twisha mark + "Twisha POS" on one baseline. `light` is for dark backgrounds (mark sits on a white tile). */
export function BrandLockup({ tone = 'dark', className = '' }: { tone?: 'dark' | 'light'; className?: string }) {
  const light = tone === 'light'
  const [first, ...rest] = PRODUCT_NAME.split(' ')
  return (
    <div className={`inline-flex items-center gap-3.5 ${className}`}>
      <span className={`flex items-center justify-center w-14 h-14 rounded-2xl shrink-0 ${light ? 'bg-white shadow-lg shadow-black/30' : 'bg-white ring-1 ring-black/5 shadow-md'}`}>
        <img src="/twisha-main.png" alt="" className="h-10 w-auto" />
      </span>
      <span className="flex items-baseline gap-2 leading-none">
        <span className={`text-4xl font-extrabold tracking-tight ${light ? 'text-white' : 'text-gray-900'}`}>{first}</span>
        {rest.length > 0 && (
          <span className={`text-4xl font-extrabold italic tracking-tight bg-clip-text text-transparent bg-gradient-to-r ${light ? 'from-emerald-300 to-sky-300' : 'from-emerald-600 to-sky-500'}`}>{rest.join(' ')}</span>
        )}
      </span>
    </div>
  )
}
