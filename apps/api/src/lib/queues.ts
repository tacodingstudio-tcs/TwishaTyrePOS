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
