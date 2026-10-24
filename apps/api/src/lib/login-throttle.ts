// Sign-in throttle: five wrong PINs lock one account (tenant phone + user phone) for 15 minutes.
// Shared by the login route (counts and blocks) and the staff screen (shows who is locked, lets an owner or manager unlock).
import { redis } from './redis.js'

export const MAX_ATTEMPTS = 5
export const LOCKOUT_SECONDS = 15 * 60

const k = (key: string) => `login_attempts:${key}`
export const throttleKey = (tenantPhone: string, phone: string) => `${tenantPhone}:${phone}`

export async function checkLoginThrottle(key: string): Promise<{ allowed: boolean; retryAfterSec?: number }> {
  const attempts = await redis.get(k(key))
  const count = attempts ? parseInt(attempts, 10) : 0
  if (count >= MAX_ATTEMPTS) {
    const ttl = await redis.ttl(k(key))
    return { allowed: false, retryAfterSec: ttl > 0 ? ttl : LOCKOUT_SECONDS }
  }
  return { allowed: true }
}
export async function recordFailedAttempt(key: string): Promise<void> {
  const n = await redis.incr(k(key))
  if (n === 1) await redis.expire(k(key), LOCKOUT_SECONDS)
}
export async function clearLoginAttempts(key: string): Promise<void> {
  await redis.del(k(key))
}
/** Minutes left on a lock, or 0 when the account is not locked. */
export async function lockedMinutes(key: string): Promise<number> {
  const t = await checkLoginThrottle(key)
  return t.allowed ? 0 : Math.max(1, Math.ceil((t.retryAfterSec ?? LOCKOUT_SECONDS) / 60))
}
