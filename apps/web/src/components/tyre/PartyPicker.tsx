// Party picker for the tyre screens. Thin wrapper; the behaviour (type-ahead on
// every keystroke, keyboard navigation, saved party or free-typed name) lives in the shared PartyCombobox.
import { PartyCombobox, type PickedParty } from '@/components/ui/PartyCombobox'

export type { PickedParty }

interface PartyPickerProps {
  label:     string
  value:     PickedParty
  onChange:  (p: PickedParty) => void
  required?: boolean
  type?:     'customer' | 'supplier'
}

export function PartyPicker({ label, value, onChange, required, type }: PartyPickerProps) {
  return <PartyCombobox label={label} value={value} onChange={(p) => onChange(p)} required={required} type={type} allowFreeText />
}
