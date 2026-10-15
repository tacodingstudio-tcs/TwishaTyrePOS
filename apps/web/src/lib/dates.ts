// Calendar dates as the person sees them on their own clock.
// `date.toISOString().slice(0, 10)` is UTC: in India, before 5:30 am — or for a local-midnight date such as
// "1st of the month" — it gives the PREVIOUS day, which shifted month ranges and "today" by one day.
const p2 = (n: number) => String(n).padStart(2, '0')
/** YYYY-MM-DD of a Date in the local time zone. */
export const localIso = (d: Date = new Date()): string => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
/** YYYY-MM of a Date in the local time zone. */
export const localMonth = (d: Date = new Date()): string => localIso(d).slice(0, 7)
