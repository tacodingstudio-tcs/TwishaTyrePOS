// An input that keeps typing tidy (digits only, capitals) and says what is wrong in plain words once the person has
// finished or left the field. The page decides whether Save is allowed with `check()` / `firstError()` from lib/validate.
import { useState } from 'react'
import { check, sanitize, inputModeFor, type FieldKind } from '@/lib/validate'

interface Props extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value' | 'type'> {
  kind: FieldKind
  value: string
  onChange: (v: string) => void
  required?: boolean
  /** show the message at once instead of waiting for the field to lose focus (useful after a failed Save) */
  showNow?: boolean
}

export function ValidatedInput({ kind, value, onChange, required, showNow, className = '', id, ...rest }: Props) {
  const [touched, setTouched] = useState(false)
  const msg = check(kind, value, required)
  const show = !!msg && (touched || showNow)
  const hintId = id ? `${id}-hint` : undefined
  return (
    <>
      <input
        {...rest} id={id} inputMode={inputModeFor(kind)} autoComplete="off" spellCheck={false}
        className={`input ${kind === 'gstin' || kind === 'pan' || kind === 'ifsc' || kind === 'vehicle' ? 'font-mono uppercase tracking-wide' : ''} ${show ? 'border-red-400 focus:ring-red-300' : ''} ${className}`}
        aria-invalid={show || undefined} aria-describedby={show ? hintId : undefined}
        value={value}
        onChange={(e) => onChange(sanitize(kind, e.target.value))}
        onBlur={(e) => { setTouched(true); rest.onBlur?.(e) }}
      />
      {show && <p id={hintId} role="alert" className="mt-1 text-xs text-red-600">{msg}</p>}
    </>
  )
}
