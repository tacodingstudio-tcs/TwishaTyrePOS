// Builds the offline Windows bundle of Twisha POS into <out>\TwishaPOS (folder) — and, with Inno Setup present, the
// one-file installer. Run on the BUILD machine (this one, online):
//
//   node deploy/offline/build-offline.mjs                 full build
//   node deploy/offline/build-offline.mjs --skip-npm      reuse the last app/node_modules (quick re-build)
//   node deploy/offline/build-offline.mjs --out D:\drop   somewhere else
//
// Reads deploy/offline/shop.local.json (the shop, its owner's mobile and first PIN); falls back to shop.example.json.
// Downloads Node 22, PostgreSQL 16 and Redis 7.2 once into ../_offline-cache.

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..')
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : undefined }
const flag = (k) => process.argv.includes(`--${k}`)
const CACHE = path.resolve(arg('cache') ?? path.join(REPO, '..', 'tyre-build', '_offline-cache'))
const OUTROOT = path.resolve(arg('out') ?? path.join(REPO, '..', 'tyre-build', '_offline-out'))
const OUT = path.join(OUTROOT, 'TwishaPOS')
const SHOP = fs.existsSync(path.join(HERE, 'shop.local.json')) ? path.join(HERE, 'shop.local.json') : path.join(HERE, 'shop.example.json')

const DOWNLOADS = {
  node: ['node-v22.11.0-win-x64.zip', 'https://nodejs.org/dist/v22.11.0/node-v22.11.0-win-x64.zip'],
  pg: ['postgresql-16.4-windows-x64-binaries.zip', 'https://get.enterprisedb.com/postgresql/postgresql-16.4-1-windows-x64-binaries.zip'],
  redis: ['Redis-7.2.16-Windows-x64-cygwin.zip', 'https://github.com/redis-windows/redis-windows/releases/download/7.2.16/Redis-7.2.16-Windows-x64-cygwin.zip'],
}

const say = (m) => console.log(`\n▶ ${m}`)
const sh = (cmd, args, o = {}) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' && /\.(cmd|bat)$|^(npm|npx|pnpm)$/.test(cmd), ...o })
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.status})`)
}
const rm = (p) => fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
const cp = (a, b) => fs.cpSync(a, b, { recursive: true })

async function download(key) {
  const [file, url] = DOWNLOADS[key]
  const dest = path.join(CACHE, file)
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1e6) return dest
  fs.mkdirSync(CACHE, { recursive: true })
  console.log(`  downloading ${file} …`)
  const r = await fetch(url, { redirect: 'follow' })
  if (!r.ok) throw new Error(`download failed ${r.status} ${url}`)
  fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()))
  return dest
}
// Windows' own bsdtar reads .zip; the "tar" that ships with Git for Windows does not understand E:\ paths
const TAR = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'tar.exe') : 'tar'
const unzip = (zip, to) => { fs.mkdirSync(to, { recursive: true }); sh(TAR, ['-xf', zip, '-C', to]) }

async function main() {
  const shop = JSON.parse(fs.readFileSync(SHOP, 'utf8'))
  console.log(`Shop settings: ${path.relative(REPO, SHOP)}  →  ${shop.shopName} / ${shop.ownerName} / ${shop.ownerPhone}`)
  if (!/^[6-9]\d{9}$/.test(shop.ownerPhone)) throw new Error('ownerPhone must be a 10-digit mobile number')
  if (!/^\d{4}$/.test(shop.pin ?? '')) throw new Error('pin must be 4 digits')
  fs.mkdirSync(OUT, { recursive: true })

  // ── 1 · the screens ───────────────────────────────────────────────────────────────────────────────────────────
  if (!flag('skip-web')) {
    say('Building the screens (web app)')
    sh('pnpm', ['--filter', '@billing/web', 'build'], { cwd: REPO })
  }
  rm(path.join(OUT, 'web')); cp(path.join(REPO, 'apps', 'web', 'dist'), path.join(OUT, 'web'))

  // ── 2 · the app server, with real (movable) files ─────────────────────────────────────────────────────────────
  const APP = path.join(OUT, 'app')
  say('Preparing the app server')
  const apiPkg = JSON.parse(fs.readFileSync(path.join(REPO, 'apps', 'api', 'package.json'), 'utf8'))
  const req = createRequire(path.join(REPO, 'apps', 'api', 'package.json'))
  const verOf = (name, base = req) => JSON.parse(fs.readFileSync(base.resolve(`${name}/package.json`).replace(/package\.json$/, '') + 'package.json', 'utf8')).version
  const reqSafe = (name) => { try { return verOf(name) } catch { const m = req.resolve(name); let d = path.dirname(m); while (!fs.existsSync(path.join(d, 'package.json')) || JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf8')).name !== name) d = path.dirname(d); return JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf8')).version } }
  const deps = {}
  for (const name of Object.keys(apiPkg.dependencies)) if (!name.startsWith('@billing/')) deps[name] = reqSafe(name)       // the exact versions that were tested
  deps['tsx'] = reqSafe('tsx')
  const prismaVersion = JSON.parse(fs.readFileSync(path.join(REPO, 'packages', 'db', 'node_modules', 'prisma', 'package.json'), 'utf8')).version

  if (!flag('skip-npm') || !fs.existsSync(path.join(APP, 'node_modules'))) {
    rm(APP); fs.mkdirSync(APP, { recursive: true })
    fs.writeFileSync(path.join(APP, 'package.json'), JSON.stringify({ name: '@billing/api', version: apiPkg.version, private: true, type: 'module', dependencies: { ...deps, prisma: prismaVersion } }, null, 2))
    sh('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: APP, env: { ...process.env, PUPPETEER_SKIP_DOWNLOAD: 'true' } })
    // the workspace packages are plain TypeScript folders: copy them in as real directories (no links)
    for (const p of ['db', 'domain-registry', 'gst-engine', 'shared']) {
      const to = path.join(APP, 'node_modules', '@billing', p)
      fs.mkdirSync(to, { recursive: true })
      for (const f of ['src', 'package.json', ...(p === 'db' ? ['prisma'] : [])]) cp(path.join(REPO, 'packages', p, f), path.join(to, f))
    }
    say('Generating the database client for Windows')
    sh(process.execPath, [path.join(APP, 'node_modules', 'prisma', 'build', 'index.js'), 'generate', `--schema=${path.join(APP, 'node_modules', '@billing', 'db', 'prisma', 'schema.prisma')}`], { cwd: APP })
    rm(path.join(APP, 'node_modules', 'prisma')); rm(path.join(APP, 'node_modules', '@prisma', 'engines'))      // build-time tools, not needed to run
    rm(path.join(APP, 'node_modules', '@billing', 'db', 'prisma'))
  }
  rm(path.join(APP, 'src')); cp(path.join(REPO, 'apps', 'api', 'src'), path.join(APP, 'src'))
  rm(path.join(APP, 'src', '__tests__'))
  rm(path.join(APP, 'assets')); cp(path.join(REPO, 'apps', 'api', 'assets'), path.join(APP, 'assets'))

  // ── 3 · runtimes ──────────────────────────────────────────────────────────────────────────────────────────────
  say('Adding Node, PostgreSQL and Redis')
  const tmp = path.join(OUTROOT, '_tmp'); rm(tmp); fs.mkdirSync(tmp, { recursive: true })
  rm(path.join(OUT, 'node')); fs.mkdirSync(path.join(OUT, 'node'), { recursive: true })
  unzip(await download('node'), path.join(tmp, 'node'))
  const nodeDir = fs.readdirSync(path.join(tmp, 'node'))[0]
  fs.copyFileSync(path.join(tmp, 'node', nodeDir, 'node.exe'), path.join(OUT, 'node', 'node.exe'))
  if (fs.existsSync(path.join(tmp, 'node', nodeDir, 'LICENSE'))) fs.copyFileSync(path.join(tmp, 'node', nodeDir, 'LICENSE'), path.join(OUT, 'node', 'LICENSE'))

  rm(path.join(OUT, 'pg')); fs.mkdirSync(path.join(OUT, 'pg'), { recursive: true })
  unzip(await download('pg'), path.join(tmp, 'pg'))
  for (const d of ['bin', 'lib', 'share']) cp(path.join(tmp, 'pg', 'pgsql', d), path.join(OUT, 'pg', d))
  for (const junk of ['pgAdmin 4', 'StackBuilder', 'doc', 'symbols']) rm(path.join(OUT, 'pg', junk))
  // StackBuilder (a downloader for add-ons) is not needed — and it drags in a GUI toolkit
  for (const f of fs.readdirSync(path.join(OUT, 'pg', 'bin'))) if (/^stackbuilder\.exe$|^wx.*\.dll$/i.test(f)) rm(path.join(OUT, 'pg', 'bin', f))
  // PostgreSQL is built with Visual C++ and needs Microsoft's runtime DLLs. A laptop that has never had "Visual C++ Redistributable"
  // installed does not have them, and the database program then cannot even start (an empty "could not create the database"). The
  // redistributable files may be shipped app-local, next to the program that needs them.
  for (const f of ['vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll', 'msvcp140_1.dll', 'concrt140.dll']) {
    const from = path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32', f)
    if (!fs.existsSync(from)) { if (f === 'vcruntime140.dll' || f === 'vcruntime140_1.dll' || f === 'msvcp140.dll') throw new Error(`${f} not found on this build machine — install the Visual C++ Redistributable (x64) here once, then build again`); continue }
    fs.copyFileSync(from, path.join(OUT, 'pg', 'bin', f))
  }

  rm(path.join(OUT, 'redis')); unzip(await download('redis'), path.join(tmp, 'redis'))
  const rd = fs.readdirSync(path.join(tmp, 'redis'))
  const redisSrc = rd.length === 1 && fs.statSync(path.join(tmp, 'redis', rd[0])).isDirectory() ? path.join(tmp, 'redis', rd[0]) : path.join(tmp, 'redis')
  cp(redisSrc, path.join(OUT, 'redis'))
  rm(tmp)

  // ── 4 · database scripts, settings, step scripts ──────────────────────────────────────────────────────────────
  say('Adding the database scripts, settings and steps')
  rm(path.join(OUT, 'sql')); fs.mkdirSync(path.join(OUT, 'sql'), { recursive: true })
  fs.copyFileSync(path.join(REPO, 'deploy', 'neon-setup.sql'), path.join(OUT, 'sql', '00-setup.sql'))
  cp(path.join(REPO, 'packages', 'db', 'prisma', 'migrations'), path.join(OUT, 'sql', 'migrations'))
  rm(path.join(OUT, 'sql', 'migrations', 'migration_lock.toml'))
  fs.mkdirSync(path.join(OUT, 'config'), { recursive: true })
  fs.copyFileSync(SHOP, path.join(OUT, 'config', 'shop.json'))
  rm(path.join(OUT, 'scripts')); cp(path.join(HERE, 'runtime'), path.join(OUT, 'scripts'))
  const bats = path.join(HERE, 'steps')
  for (const f of fs.readdirSync(bats)) fs.copyFileSync(path.join(bats, f), path.join(OUT, f))
  fs.copyFileSync(path.join(REPO, 'apps', 'web', 'public', 'favicon.png'), path.join(OUT, 'favicon.png'))

  // ── 6 · prove that nothing the programs need is missing on a clean laptop ─────────────────────────────────────────
  say('Checking that every program has what it needs on a clean laptop')
  sh(process.execPath, [path.join(HERE, 'check-deps.mjs'), OUT])


  // ── 5 · the program on the desktop, and the one-file installer ────────────────────────────────────────────────────
  say('Building TwishaPOS.exe (the icon on the desktop)')
  sh('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(HERE, 'launcher', 'build.ps1'), '-Out', OUT])
  fs.copyFileSync(path.join(HERE, 'launcher', 'twisha.ico'), path.join(OUT, 'twisha.ico'))
  const isccAt = [process.env.ISCC, path.join(REPO, '..', 'tyre-build', '_tools', 'InnoSetup', 'ISCC.exe'), 'C:/Program Files (x86)/Inno Setup 6/ISCC.exe', 'C:/Program Files/Inno Setup 6/ISCC.exe'].filter(Boolean).find((f) => fs.existsSync(f))
  if (flag('skip-installer')) console.log('  (installer skipped)')
  else if (!isccAt) console.log('  Inno Setup not found — the folder is complete, but no one-file installer was made. Install Inno Setup 6 or set ISCC=<path to ISCC.exe>.')
  else {
    say('Building the installer (Twisha-POS-Setup.exe) — a few minutes')
    sh(isccAt, ['/Q', `/DSrcDir=${OUT}`, `/DOutDir=${OUTROOT}`, `/DAppVer=${apiPkg.version}`, path.join(HERE, 'installer', 'TwishaPOS.iss')])
    const setup = path.join(OUTROOT, 'Twisha-POS-Setup.exe')
    console.log(`
✔ Installer: ${setup}  (${(fs.statSync(setup).size / 1048576).toFixed(0)} MB)`)
  }

  const size = (p) => { let n = 0; const w = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); e.isDirectory() ? w(f) : (n += fs.statSync(f).size) } }; w(p); return n }
  console.log(`\n✔ Bundle ready: ${OUT}  (${(size(OUT) / 1048576).toFixed(0)} MB)`)
}
main().catch((e) => { console.error('\n✘ Build failed:', e.message); process.exit(1) })
