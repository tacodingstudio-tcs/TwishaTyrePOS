// src/components/layout/PageHeader.tsx
interface PageHeaderProps {
  title:    string
  subtitle?:string
  action?:  React.ReactNode
}

export function PageHeader({ title, subtitle, action }: PageHeaderProps) {
  return (
    <div className="flex items-center justify-between gap-3 flex-wrap px-4 sm:px-6 lg:px-8 py-3 sm:py-5 border-b border-gray-200 bg-white z-10 [@media(min-height:780px)]:sticky top-0">
      <div className="min-w-0">
        <h1 className="text-lg font-semibold text-gray-900">{title}</h1>
        {subtitle && <p className="text-sm text-gray-500 mt-0.5 [@media(max-height:700px)]:hidden">{subtitle}</p>}
      </div>
      {action}
    </div>
  )
}
