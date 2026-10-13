// apps/api/src/routes/tyre.ts
// Tyre shop module — mounted at /api/tyre.
//
//   tyre-catalog.ts   size finder, sizes/brands, dead stock
//   tyre-sales.ts     the counter sale (tyres + fitting + exchange + payment → bill, warranty, vehicle)
//   tyre-vehicles.ts  customer vehicles, service reminders, warranty register & claims
//   tyre-reports.ts   home numbers, sales / margin by size, brand, product
//   tyre-comms.ts     invoice PDF, WhatsApp send, delivery log, settings
//
// Products, stock, purchases, parties, invoices and payments are the shared billing core
// (/api/products, /api/inventory, /api/parties, /api/invoices, /api/payments).
// Tyre-only data lives in raw-SQL tables (see lib/tyre-ddl.ts), scoped per tenant schema and branch.

import type { FastifyPluginAsync } from 'fastify'
import { tyreCatalogRoutes } from './tyre-catalog.js'
import { tyreSalesRoutes }   from './tyre-sales.js'
import { tyreVehicleRoutes } from './tyre-vehicles.js'
import { tyreReportRoutes }  from './tyre-reports.js'
import { tyreCommsRoutes }   from './tyre-comms.js'

export const tyreRoutes: FastifyPluginAsync = async (app) => {
  await app.register(tyreCatalogRoutes)
  await app.register(tyreSalesRoutes)
  await app.register(tyreVehicleRoutes)
  await app.register(tyreReportRoutes)
  await app.register(tyreCommsRoutes)
}
