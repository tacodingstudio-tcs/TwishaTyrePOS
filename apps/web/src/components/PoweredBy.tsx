// "Powered by …" credit shown on the sign-in page and the app footer.
// Name and link come from the build environment so they can be changed without touching code:
//   VITE_POWERED_BY_NAME   default "Twisha Consultancy Services"
//   VITE_POWERED_BY_URL    default https://www.twishaconsultancyservices.com/
// There is deliberately no per-business setting to hide it.
const NAME = (import.meta.env['VITE_POWERED_BY_NAME'] as string | undefined)?.trim() || 'Twisha Consultancy Services'
const URL_ = (import.meta.env['VITE_POWERED_BY_URL'] as string | undefined)?.trim() || 'https://www.twishaconsultancyservices.com/'

/** Compact badge for the app header: a small mark, then "Powered by" and the name as the link. */
export function PoweredByBadge() {
  const inner = (
    <>
      <img src="/twisha-mark.png" alt="" className="w-6 h-6 rounded-full shrink-0" />
      <span className="flex flex-col min-w-0">
        <span className="text-[10px] leading-tight text-gray-400">Powered by</span>
        <span className="text-xs font-semibold leading-tight text-gray-700 group-hover:text-primary-700 truncate">{NAME}</span>
      </span>
    </>
  )
  const cls = 'group inline-flex items-center gap-2 pl-1 pr-3 py-1 rounded-full border border-gray-200 bg-white/80 hover:border-primary-300 hover:bg-primary-50 transition-colors'
  return URL_
    ? <a href={URL_} target="_blank" rel="noopener noreferrer" className={cls} title={`Powered by ${NAME}`}>{inner}</a>
    : <span className={cls}>{inner}</span>
}

export function PoweredBy({ className = '' }: { className?: string }) {
  return (
    <p className={`text-[11px] text-gray-400 ${className}`}>
      Powered by{' '}
      {URL_
        ? <a href={URL_} target="_blank" rel="noopener noreferrer" className="font-medium text-gray-500 hover:text-primary-600 hover:underline">{NAME}</a>
        : <span className="font-medium text-gray-500">{NAME}</span>}
    </p>
  )
}

/** Sign-in page credit: one centred line, "Powered by" muted and the company name bold. */
export function PoweredByCard({ className = '' }: { className?: string }) {
  const inner = (
    <>
      <span className="text-gray-500">Powered by</span>{' '}
      <span className="font-bold text-primary-700 transition-colors duration-200 group-hover:text-primary-800
        bg-gradient-to-r from-primary-500 to-emerald-400 bg-no-repeat bg-[length:100%_2px] bg-[position:0_100%] pb-0.5">{NAME}</span>
    </>
  )
  const cls = `group inline-block text-sm text-center transition-transform duration-200 hover:-translate-y-0.5 ${className}`
  return URL_
    ? <a href={URL_} target="_blank" rel="noopener noreferrer" className={cls} title={`Powered by ${NAME}`}>{inner}</a>
    : <span className={cls}>{inner}</span>
}
