// apps/api/scripts/unlock-account.ts
// =============================================================================
// Lifts a sign-in lock when nobody inside the shop can (the owner forgot the PIN and there is no manager).
//   REDIS_URL=<redis> npx tsx scripts/unlock-account.ts <ownerPhone> [userPhone]
// With one phone it unlocks the owner; with two, that staff member of the shop. Needs the same Redis the API uses
// (Render: the tyre-redis connection string). It does not change any PIN — use "reset PIN" in the app for that.
// =============================================================================
import { redis } from '../src/lib/redis.js'
import { throttleKey, clearLoginAttempts, lockedMinutes } from '../src/lib/login-throttle.js'

const [ownerPhone, userPhone] = process.argv.slice(2).filter((a) => /^\d{10}$/.test(a))
if (!ownerPhone) {
  console.error('Usage: npx tsx scripts/unlock-account.ts <ownerPhone> [userPhone]')
  process.exit(1)
}
const key = throttleKey(ownerPhone, userPhone ?? ownerPhone)
const mins = await lockedMinutes(key)
await clearLoginAttempts(key)
console.log(mins > 0 ? `Unlocked ${userPhone ?? ownerPhone} (was locked for ${mins} more minute${mins === 1 ? '' : 's'}).` : `${userPhone ?? ownerPhone} was not locked.`)
await redis.quit()
