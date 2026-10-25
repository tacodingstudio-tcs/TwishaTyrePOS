// apps/api/src/lib/queues.ts
// Central queue definitions — shared by API (producers) and worker (consumers)

import { Queue } from 'bullmq'
import { redis } from './redis.js'

// WhatsApp message queue
// Triggered by payment reminders and invoice share actions
export const whatsappQueue = new Queue('whatsapp-send', {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { count: 200 },
    removeOnFail:     { count: 100 },
  },
})

/** Add a job, but never wait on a dead Redis: rejects after `ms` so the caller can report "queue unavailable". */
export async function addJob(queue: Queue, name: string, data: unknown, ms = 2500): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      queue.add(name, data as never),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('The message queue is not reachable right now')), ms) }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
