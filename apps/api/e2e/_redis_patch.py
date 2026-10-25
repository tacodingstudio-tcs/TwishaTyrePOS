import re
R = 'e:/HisabKitab/tyrePlatform/apps/api/src/'

# 1. the sign-in throttle must never stop a sign-in: when Redis is down or over its quota, allow the attempt (fail open)
p = R + 'lib/login-throttle.ts'
s = open(p, encoding='utf8').read()
s = s.replace("""export async function checkLoginThrottle(key: string): Promise<{ allowed: boolean; retryAfterSec?: number }> {
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
}""", """// Redis is only a counter here. If it is unreachable or over its plan limit (Upstash free: 500,000 commands a month), signing in
// must still work — the lock is skipped until Redis is back, never turned into a failed login.
export async function checkLoginThrottle(key: string): Promise<{ allowed: boolean; retryAfterSec?: number }> {
  try {
    const attempts = await redis.get(k(key))
    const count = attempts ? parseInt(attempts, 10) : 0
    if (count >= MAX_ATTEMPTS) {
      const ttl = await redis.ttl(k(key))
      return { allowed: false, retryAfterSec: ttl > 0 ? ttl : LOCKOUT_SECONDS }
    }
  } catch { /* fail open */ }
  return { allowed: true }
}
export async function recordFailedAttempt(key: string): Promise<void> {
  try {
    const n = await redis.incr(k(key))
    if (n === 1) await redis.expire(k(key), LOCKOUT_SECONDS)
  } catch { /* fail open */ }
}
export async function clearLoginAttempts(key: string): Promise<void> {
  try { await redis.del(k(key)) } catch { /* fail open */ }
}""", 1)
assert 'fail open' in s
open(p, 'w', encoding='utf8').write(s)

# 2. idle workers poll Redis; every poll is a billed command. Wait longer when the queue is empty, check stalled jobs less often.
for f in ['pdf', 'whatsapp', 'reminder', 'tyre-alerts']:
    p = R + f'workers/{f}.worker.ts'
    s = open(p, encoding='utf8').read()
    m = re.search(r"new Worker<?[^(]*\(", s)
    assert m, f
    i = s.index('connection', m.end())
    line_end = s.index('\n', i)
    seg = s[i:line_end]
    assert 'redis' in seg, (f, seg)
    s = s[:line_end + 1] + "    drainDelay:      Number(process.env['WORKER_DRAIN_DELAY_SEC'] ?? 30),      // seconds to wait on an empty queue (library default 5) — fewer Redis commands\n    stalledInterval: Number(process.env['WORKER_STALLED_INTERVAL_MS'] ?? 300_000),\n" + s[line_end + 1:]
    open(p, 'w', encoding='utf8').write(s)
    print('ok', f)
