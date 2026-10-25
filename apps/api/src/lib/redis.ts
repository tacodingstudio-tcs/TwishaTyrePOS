import Redis from 'ioredis'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const IORedis = (Redis as any).default ?? Redis

const URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379'

/** Log a connection problem at most once every 30 s — an outage must not flood the log (and the host's log quota). */
function quietErrors(client: { on: (e: string, f: (err: Error) => void) => void }, label: string) {
  let last = 0
  client.on('error', (err: Error) => {
    if (Date.now() - last < 30_000) return
    last = Date.now()
    console.error(`[Redis${label}] Connection error:`, err.message)
  })
}

// Singleton client for the BullMQ workers (they need maxRetriesPerRequest: null and wait for Redis to come back).
export const redis = new IORedis(URL, {
  maxRetriesPerRequest: null, // Required by BullMQ
  lazyConnect: true,
})
quietErrors(redis, '')

redis.on('connect', () => {
  console.info('[Redis] Connected')
})

/**
 * Client for anything that runs inside a web request (cache, sign-in counter, queue producers).
 * When Redis is down, unreachable or over its plan limit, a command FAILS within ~1.5 s instead of waiting forever,
 * so callers can fall back (skip the cache, allow the sign-in) and the request still answers.
 */
export const redisFast = new IORedis(URL, {
  lazyConnect: true,
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
  connectTimeout: 1500,
  commandTimeout: 1500,
  retryStrategy: (times: number) => Math.min(times * 500, 5000),
})
quietErrors(redisFast, ' fast')
redisFast.connect().catch(() => { /* retried by retryStrategy */ })
