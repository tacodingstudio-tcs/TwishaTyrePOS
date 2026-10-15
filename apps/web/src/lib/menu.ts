// Menu entries the shop can hide from the sidebar (My Business → Menu). Hiding only removes the link —
// the screen still works if opened directly. Core screens (Home, New Sale, All Bills, Customers,
// My Business) are never hideable.
export const HIDEABLE_MENU: Array<{ to: string; label: string; hint?: string }> = [
  { to: '/tyre/stock',            label: 'Tyre Stock' },
  { to: '/tyre/sale?mode=service', label: 'Alignment & Balancing' },
  { to: '/tyre/vehicles',         label: 'Vehicles' },
  { to: '/tyre/warranty',         label: 'Warranty' },
  { to: '/tyre/reminders',        label: 'Service Reminders' },
  { to: '/tyre/messages',         label: 'WhatsApp Messages' },
  { to: '/aging',                 label: 'Money to Collect' },
  { to: '/expenses',              label: 'Shop Costs' },
  { to: '/tyre/reports',          label: 'Sales & Margin' },
  { to: '/reports',               label: 'GST Reports' },
  { to: '/analytics',             label: 'Charts' },
  { to: '/advances',              label: 'Advances' },
  { to: '/approvals',             label: 'Approvals' },
  { to: '/inventory',             label: 'Stores', hint: 'purchase orders, suppliers, adjustments' },
  { to: '/pipeline',              label: 'Quotations' },
  { to: '/contracts',             label: 'Contracts', hint: 'recurring billing' },
  { to: '/broadcast',             label: 'Broadcast' },
  { to: '/tyre/team',             label: 'Team & Salary' },
  { to: '/ai',                    label: 'AI Assistant' },
]

/** Hidden by default: recurring billing is not something a tyre shop starts with. */
export const DEFAULT_HIDDEN_MENU = ['/contracts']

export function hiddenMenu(domainConfig: Record<string, any> | undefined | null): Set<string> {
  const v = domainConfig?.['hidden_menu']
  return new Set(Array.isArray(v) ? (v as string[]) : DEFAULT_HIDDEN_MENU)
}
