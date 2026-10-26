// The PC's "Machine ID": a short code made from the Windows install and the motherboard / model names.
// The same input always gives the same code, and it can be worked out on the PC with a PowerShell script too
// (tools/license/machine-id.ps1), so a license can be made before the app is even installed.
//
//   node apps/api/src/lib/machine-id.mjs      → prints this PC's Machine ID
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import os from 'node:os'

const BS = String.fromCharCode(92)                                   // a backslash (registry paths)
const reg = (...p) => p.join(BS)

function regValue(key, name) {
  try {
    const out = execFileSync('reg', ['query', key, '/v', name], { encoding: 'utf8', windowsHide: true, timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] })
    const line = out.split(/\r?\n/).map((l) => l.trim()).find((l) => l.toLowerCase().startsWith(name.toLowerCase() + ' '))
    return line ? line.replace(/^\S+\s+REG_\w+\s*/i, '').trim() : ''
  } catch { return '' }
}

let cached = null
/** "XXXXX-XXXXX-XXXXX-XXXXX" */
export function machineId() {
  if (cached) return cached
  const BIOS = reg('HKLM', 'HARDWARE', 'DESCRIPTION', 'System', 'BIOS')
  const parts = process.platform === 'win32'
    ? [regValue(reg('HKLM', 'SOFTWARE', 'Microsoft', 'Cryptography'), 'MachineGuid'), regValue(BIOS, 'SystemManufacturer'),
       regValue(BIOS, 'SystemProductName'), regValue(BIOS, 'BaseBoardProduct')]
    : [os.hostname(), os.arch(), os.platform(), '']                    // development only: the app is shipped on Windows
  const hex = createHash('sha256').update(`twl1|${parts.join('|')}`, 'utf8').digest('hex').slice(0, 20).toUpperCase()
  cached = [hex.slice(0, 5), hex.slice(5, 10), hex.slice(10, 15), hex.slice(15, 20)].join('-')
  return cached
}

if (process.argv[1] && process.argv[1].endsWith('machine-id.mjs')) console.log(machineId())
