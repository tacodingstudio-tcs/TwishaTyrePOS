// Proves the offline bundle runs on a laptop with NOTHING installed: reads the "imports" table of every program (.exe / .dll) in
// node, pg and redis and lists the DLLs they need that are neither shipped next to them nor part of Windows itself.
// (A missing Visual C++ runtime on a clean laptop makes the database program fail to start — exactly the symptom this catches.)
//
//   node deploy/offline/check-deps.mjs [bundle folder]        exit code 1 when something is missing

import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(process.argv[2] ?? path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..', '..', '..', 'tyrePOS-build-tools', '_offline-out', 'TwishaPOS'))

// DLLs that every Windows 10 / 11 installation has (matched by lower-case name or prefix)
const OS = [/^api-ms-win-/, /^ext-ms-win-/, /^(kernel32|kernelbase|user32|gdi32|advapi32|ntdll|ws2_32|wsock32|mswsock|msvcrt|ucrtbase|shell32|shlwapi|ole32|oleaut32|rpcrt4|bcrypt|bcryptprimitives|crypt32|secur32|sspicli|version|userenv|iphlpapi|normaliz|netapi32|setupapi|psapi|dbghelp|imm32|comctl32|comdlg32|winmm|dnsapi|wldap32|nsi|cfgmgr32|powrprof|ncrypt|wintrust|imagehlp|d3d11|dxgi|dwmapi|uxtheme|opengl32|glu32|shcore|combase|win32u|sechost|cryptbase|cryptsp|rsaenh|gdiplus|mpr|ntmarta|wtsapi32|authz|dpapi|profapi|netutils|samcli|samlib|dhcpcsvc|dnsapi|winhttp|wininet|urlmon|msasn1|mfplat|ws2help|rasadhlp|fwpuclnt|sxs|ntshrui|cscapi|slc|logoncli|wevtapi|pdh|tdh|wmi|wbemprox|wbemsvc|fastprox|wbemcomn|cabinet|msi|cldapi|srvcli|mscms|usp10|lpk|msctf|windows\.storage|propsys|dwrite|d2d1|d3d9|ntdsapi|virtdisk|bcrypt|credui|kernel\.appcore|vcruntime140_threads|winspool|oleacc|msimg32)\.(dll|drv)$/]
const isOS = (n) => OS.some((re) => re.test(n))

function imports(file) {
  const b = fs.readFileSync(file)
  if (b.readUInt16LE(0) !== 0x5a4d) return null
  const pe = b.readUInt32LE(0x3c)
  if (b.toString('latin1', pe, pe + 4) !== 'PE\0\0') return null
  const nSec = b.readUInt16LE(pe + 6), optSize = b.readUInt16LE(pe + 20), opt = pe + 24
  const magic = b.readUInt16LE(opt)
  const dd = opt + (magic === 0x20b ? 112 : 96)                      // data directories
  const impRva = b.readUInt32LE(dd + 8)
  if (!impRva) return []
  const secs = []
  for (let i = 0; i < nSec; i++) { const s = opt + optSize + i * 40; secs.push({ va: b.readUInt32LE(s + 12), vs: b.readUInt32LE(s + 8), raw: b.readUInt32LE(s + 20), rs: b.readUInt32LE(s + 16) }) }
  const off = (rva) => { for (const s of secs) if (rva >= s.va && rva < s.va + Math.max(s.vs, s.rs)) return rva - s.va + s.raw; return -1 }
  const out = []
  for (let d = off(impRva); d >= 0 && d + 20 <= b.length; d += 20) {
    const nameRva = b.readUInt32LE(d + 12); if (!nameRva) break
    const o = off(nameRva); if (o < 0) break
    out.push(b.toString('latin1', o, b.indexOf(0, o)).toLowerCase())
  }
  return out
}

const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]))
let bad = 0
for (const part of ['node', 'pg/bin', 'redis']) {
  const dir = path.join(ROOT, part)
  if (!fs.existsSync(dir)) { console.log(`✘ ${part}: folder missing`); bad++; continue }
  const here = new Set(fs.readdirSync(dir).map((f) => f.toLowerCase()))
  const missing = new Map()
  for (const f of fs.readdirSync(dir).filter((x) => /\.(exe|dll)$/i.test(x))) {
    let deps; try { deps = imports(path.join(dir, f)) } catch { deps = null }
    for (const dll of deps ?? []) if (!here.has(dll) && !isOS(dll)) { if (!missing.has(dll)) missing.set(dll, new Set()); missing.get(dll).add(f) }
  }
  if (missing.size === 0) console.log(`✔ ${part}: everything these programs need is either next to them or part of Windows`)
  else { bad++; for (const [dll, by] of missing) console.log(`✘ ${part}: ${dll} is needed by ${[...by].slice(0, 4).join(', ')} but is not shipped`) }
}
process.exit(bad ? 1 : 0)
