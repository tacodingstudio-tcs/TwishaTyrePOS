// apps/api/src/routes/license.ts — public (no sign-in): the screen that asks for a license must work before anyone can log in.
//   GET  /api/license/status      is this PC licensed? (and the Machine ID to send to the software owner)
//   POST /api/license/activate    { license: "TWL1…" } saves it if it is good for this PC

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { licenseStatus, activateLicense } from '../lib/license.js'

export const licenseRoutes: FastifyPluginAsync = async (app) => {
  app.get('/status', async () => licenseStatus())

  app.post('/activate', async (req, reply) => {
    const { license } = z.object({ license: z.string().trim().min(20).max(4000) }).parse(req.body)
    const status = activateLicense(license)
    return reply.status(status.valid ? 200 : 422).send(status)
  })
}
