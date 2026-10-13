import { WARRANTY_STATUS, SALE_STATUS } from './format'

const MAPS = { warranty: WARRANTY_STATUS, sale: SALE_STATUS } as const

export function StatusPill({ kind, status }: { kind: keyof typeof MAPS; status: string }) {
  const tone = MAPS[kind][status]
  return (
    <span className={`badge ${tone?.cls ?? 'bg-gray-100 text-gray-600'}`}>
      {tone?.label ?? status.replace(/_/g, ' ')}
    </span>
  )
}
