// apps/api/src/workers/tyre-alerts.worker.ts
//
// Daily at 09:30 IST: for every active tenant/branch, send the opt-in tyre-shop alerts —
// overdue-bill reminders, service-due reminders to vehicle owners, and the owner's digest
// (low stock, overdue money, warranties about to lapse).
// What is sent is controlled per business by the notify_* settings (all default off), and
// dedupe keys make a re-run on the same day harmless.

import cron from 'node-cron'
import { db } from '@billing/db'
import { getTenantDb } from '../lib/tenant-db.js'
import { runDailyAlerts } from '../lib/tyre-notify.js'

export async function runTyreAlerts(): Promise<void> {
  const tenants = await db.tenant.findMany({ where: { isActive: true }, select: { id: true, schemaName: true } })
  let reminders = 0, serviceDue = 0, ownerAlerts = 0
  for (const t of tenants) {
    try {
      const tdb = getTenantDb(t.schemaName)
      const branches = await tdb.branch.findMany({ where: { isActive: true }, select: { id: true } })
      for (const b of branches) {
        const r = await runDailyAlerts({ db: tdb, schemaName: t.schemaName, branchId: b.id })
        reminders += r.reminders
        serviceDue += r.serviceDue
        ownerAlerts += r.ownerAlerts
      }
    } catch (err) {
      // One tenant failing (e.g. a schema that predates the tyre tables) must not stop the rest.
      console.error(`[Tyre Alerts] tenant ${t.id} failed:`, (err as Error).message)
    }
  }
  console.log(`[Tyre Alerts] done — ${reminders} payment reminders, ${serviceDue} service reminders, ${ownerAlerts} owner alert lines queued`)
}

// 04:00 UTC = 09:30 IST
cron.schedule('0 4 * * *', () => {
  runTyreAlerts().catch((err) => console.error('[Tyre Alerts] fatal:', err))
})
console.log('[Tyre Alerts] Scheduled — runs daily at 09:30 IST')

if (process.argv.includes('--now')) {
  runTyreAlerts().then(() => process.exit(0))
}
