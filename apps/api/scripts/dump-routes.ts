// Writes every registered route to scripts/routes.txt (used by bench.mjs).
//   npx tsx --env-file=.env scripts/dump-routes.ts        (the API itself may keep running; this uses port 3299)
import { writeFileSync } from 'node:fs'
process.env['PORT'] = '3299'
const { app } = await import('../src/server.ts')
await app.ready()
writeFileSync(new URL('./routes.txt', import.meta.url), app.printRoutes({ commonPrefix: false }))
console.log('routes written')
process.exit(0)
