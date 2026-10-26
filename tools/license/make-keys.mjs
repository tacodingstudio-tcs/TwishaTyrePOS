// One-time: creates the signing key pair for licenses.
//   node tools/license/make-keys.mjs E:\softwares\_license-keys
// private.pem  → stays with YOU (never in the repo, never in an installer). Whoever has it can make licenses.
// The public key (printed) goes into apps/api/src/lib/license.ts → LICENSE_PUBLIC_KEY.
import { generateKeyPairSync } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const dir = process.argv[2]
if (!dir) { console.error('Usage: node make-keys.mjs <folder for private.pem>'); process.exit(2) }
const file = path.join(dir, 'private.pem')
if (fs.existsSync(file)) { console.error(`${file} already exists — refusing to overwrite it (every license made with it would stop working).`); process.exit(1) }
fs.mkdirSync(dir, { recursive: true })
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
fs.writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
console.log(`Private key written to ${file} — back it up somewhere safe (a pen drive kept offline).`)
console.log('\nPublic key (put in LICENSE_PUBLIC_KEY):\n' + publicKey.export({ type: 'spki', format: 'der' }).toString('base64'))
