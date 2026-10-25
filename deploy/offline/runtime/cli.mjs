// Twisha POS — offline install: every step as its own command, so each can be run (and re-run) alone.
//
//   node scripts\cli.mjs check        1  is this laptop ready (Windows, disk, free ports, not "Run as administrator")
//   node scripts\cli.mjs db           2  create the database folder, the database, and apply the migrations
//   node scripts\cli.mjs services     3  start the database, the job store (Redis) and the app server
//   node scripts\cli.mjs shop         4  create the shop and its ONE login (first time only)
//   node scripts\cli.mjs open         5  open the app in a window
//   node scripts\cli.mjs start           all of 2-5 in order (what the Twisha POS icon does)
//   node scripts\cli.mjs stop            stop everything cleanly (with a backup)
//   node scripts\cli.mjs status | backup | restore <file> | reset-pin <4 digits> | unlock
//
// Every step is safe to repeat. Uses only Node's built-ins. All output lines that start with "STEP" are for the launcher.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import crypto from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = process.env.TWISHA_ROOT ?? path.resolve(HERE, '..')
const LOCAL = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')
const DATA = process.env.TWISHA_DATA ?? path.join(LOCAL, 'TwishaPOS')
const BACKUPS = process.env.TWISHA_BACKUPS ?? path.join(os.homedir(), 'Documents', 'TwishaPOS Backups')
const SHOP_FILE = path.join(ROOT, 'config', 'shop.json')
// "Detached" children get a console of their own. On a laptop where Windows Terminal is the default console host, every
// such child opens a terminal window (a flashing / lingering "cmd"). The launcher sets TWISHA_NO_DETACH=1: children then share
// its hidden console (and still outlive it). The step .bat files run in a visible console and keep the old behaviour.
const DETACH = process.env.TWISHA_NO_DETACH !== '1'
const HELPER = path.join(ROOT, 'TwishaPOS.exe')
/** Start a long-running program with no window that keeps running after this script ends (see the note in TwishaPOS.cs). */
function spawnHidden(program, args, logFile, o = {}) {
  spawn(HELPER, ['--spawn', logFile, o.cwd ?? ROOT, program, ...args], { windowsHide: true, stdio: 'ignore', env: { ...process.env, ...(o.env ?? {}) } }).unref()
}

const dir = {
  pg: path.join(ROOT, 'pg', 'bin'),
  redis: path.join(ROOT, 'redis'),
  app: path.join(ROOT, 'app'),
  web: path.join(ROOT, 'web'),
  sql: path.join(ROOT, 'sql'),
  pgdata: path.join(DATA, 'pg-data'),
  redisdata: path.join(DATA, 'redis-data'),
  logs: path.join(DATA, 'logs'),
}
for (const d of [DATA, dir.redisdata, dir.logs, BACKUPS]) fs.mkdirSync(d, { recursive: true })

const cfg = JSON.parse(fs.readFileSync(SHOP_FILE, 'utf8'))
const PORT = {
  api: Number(process.env.TWISHA_API_PORT ?? cfg.ports?.api ?? 4470),
  pg: Number(process.env.TWISHA_PG_PORT ?? cfg.ports?.pg ?? 54329),
  redis: Number(process.env.TWISHA_REDIS_PORT ?? cfg.ports?.redis ?? 63790),
}
const DB = 'billing_db'
const URL_APP = `http://127.0.0.1:${PORT.api}`

// ── small helpers ──────────────────────────────────────────────────────────────────────────────────────────────────
const log = (m) => { console.log(m); try { fs.appendFileSync(path.join(dir.logs, 'setup.log'), `${new Date().toISOString()} ${m}\n`) } catch { /* log only */ } }
const step = (m) => log(`STEP ${m}`)
const ok = (m) => log(`  ✔ ${m}`)
const fail = (m, hint) => { log(`  ✘ ${m}`); if (hint) log(`    → ${hint}`); process.exit(1) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const exe = (name) => path.join(dir.pg, `${name}.exe`)
const secretsFile = path.join(DATA, 'secrets.json')
const pidsFile = path.join(DATA, 'pids.json')

function secrets() {
  let s = {}
  try { s = JSON.parse(fs.readFileSync(secretsFile, 'utf8')) } catch { /* first run */ }
  let dirty = false
  if (!s.pgPassword) { s.pgPassword = crypto.randomBytes(18).toString('hex'); dirty = true }
  if (!s.jwtSecret) { s.jwtSecret = crypto.randomBytes(48).toString('hex'); dirty = true }
  if (dirty) fs.writeFileSync(secretsFile, JSON.stringify(s, null, 2))
  return s
}
const pids = () => { try { return JSON.parse(fs.readFileSync(pidsFile, 'utf8')) } catch { return {} } }
const savePids = (p) => fs.writeFileSync(pidsFile, JSON.stringify(p))

function run(cmd, args, o = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, env: { ...process.env, ...(o.env ?? {}) }, cwd: o.cwd, input: o.input, maxBuffer: 1 << 28 })
  if (r.error) return { status: 1, stdout: '', stderr: String(r.error.message) }
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}
const pgEnv = () => ({ PGPASSWORD: secrets().pgPassword })
const psql = (args, o = {}) => run(exe('psql'), ['-h', '127.0.0.1', '-p', String(PORT.pg), '-U', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', ...args], { env: pgEnv(), ...o })

const portOpen = (port) => new Promise((res) => {
  const s = net.connect({ port, host: '127.0.0.1' }); s.once('connect', () => { s.destroy(); res(true) }); s.once('error', () => res(false)); s.setTimeout(1500, () => { s.destroy(); res(false) })
})
const portFree = async (port) => !(await portOpen(port))
async function waitFor(fn, seconds, every = 700) { const end = Date.now() + seconds * 1000; while (Date.now() < end) { if (await fn()) return true; await sleep(every) } return false }
const pgRunning = () => run(exe('pg_ctl'), ['status', '-D', dir.pgdata]).status === 0
const apiUp = async () => { try { return (await fetch(`${URL_APP}/health`, { signal: AbortSignal.timeout(2500) })).ok } catch { return false } }

// ── 1 · check ─────────────────────────────────────────────────────────────────────────────────────────────────────
async function check() {
  step('Checking this laptop')
  let bad = 0
  const need = (cond, good, problem, hint) => { if (cond) ok(good); else { log(`  ✘ ${problem}`); if (hint) log(`    → ${hint}`); bad++ } }
  need(process.platform === 'win32' && os.arch() === 'x64', `Windows 64-bit (${os.release()})`, 'This needs 64-bit Windows 10 or 11', 'Use a Windows 10/11 laptop.')
  need(Number(os.release().split('.')[0]) >= 10, 'Windows 10 or newer', 'Windows is too old', 'Windows 10 (64-bit) or 11 is required.')
  const elevated = run('net', ['session']).status === 0
  need(!elevated, 'Not running as Administrator', 'Running as Administrator — the database refuses to start that way', 'Close this window and open it normally (double-click, not "Run as administrator").')
  let freeGB = 0
  try { freeGB = Number(fs.statfsSync(DATA).bavail) * Number(fs.statfsSync(DATA).bsize) / 2 ** 30 } catch { freeGB = 99 }
  need(freeGB >= 2, `Free disk space ${freeGB.toFixed(1)} GB`, `Only ${freeGB.toFixed(1)} GB free`, 'Free at least 2 GB on this drive.')
  for (const [name, port] of [['database', PORT.pg], ['job store', PORT.redis], ['app', PORT.api]]) {
    const inUse = await portOpen(port)
    if (inUse && (name === 'app' ? await apiUp() : (name === 'database' ? pgRunning() : true))) ok(`${name} port ${port} is Twisha POS's own (already running)`)
    else need(!inUse, `Port ${port} free (${name})`, `Port ${port} (${name}) is used by another program`, `Close that program, or set a different port in ${SHOP_FILE} under "ports".`)
  }
  for (const [what, p] of [['database engine', path.join(dir.pg, 'postgres.exe')], ['job store', path.join(dir.redis, 'redis-server.exe')], ['app', path.join(dir.app, 'src', 'server.ts')], ['screens', path.join(dir.web, 'index.html')]]) {
    need(fs.existsSync(p), `${what} files present`, `${what} files are missing (${p})`, 'Re-install Twisha POS.')
  }
  try { fs.accessSync(DATA, fs.constants.W_OK); ok(`Can write to ${DATA}`) } catch { bad++; log(`  ✘ Cannot write to ${DATA}`) }
  if (bad) fail(`${bad} problem${bad === 1 ? '' : 's'} found — fix them and run this step again`)
  ok('This laptop is ready')
}

// ── 2 · database ──────────────────────────────────────────────────────────────────────────────────────────────────
const pgReady = () => run(exe('pg_isready'), ['-h', '127.0.0.1', '-p', String(PORT.pg)]).status === 0
/** The port opens before the database accepts connections: after a power cut it first replays its log ("the database system is
 *  starting up"). Wait until it really answers, and say so, instead of giving up on the first refusal. */
async function waitPgReady() {
  if (pgReady()) return
  log('  … the database is checking itself after the last shutdown (this can take a minute)')
  if (!(await waitFor(async () => pgReady(), 240, 500))) fail('The database is taking too long to get ready', `See ${path.join(dir.logs, 'postgres.log')}`)
}

async function startPg() {
  if (pgRunning() && (await portOpen(PORT.pg))) { await waitPgReady(); return }
  if (await portOpen(PORT.pg)) fail(`Port ${PORT.pg} is in use by another program`, 'Close it, or change "ports.pg" in config\\shop.json.')
  // Start the server program itself (not through pg_ctl, which wraps it in a "cmd /C" console window), with no pipes: it
  // inherits the handles of whoever starts it, and a captured pipe would never reach end-of-file.
  if (DETACH) {
    const log = fs.openSync(path.join(dir.logs, 'postgres.log'), 'a')
    spawn(exe('postgres'), ['-D', dir.pgdata, '-p', String(PORT.pg)], { detached: true, stdio: ['ignore', log, log], windowsHide: true }).unref()
  } else spawnHidden(exe('postgres'), ['-D', dir.pgdata, '-p', String(PORT.pg)], path.join(dir.logs, 'postgres.log'))
  if (!(await waitFor(async () => (await portOpen(PORT.pg)) && pgRunning(), 90, 500)))
    fail('The database did not start', `See ${path.join(dir.logs, 'postgres.log')}`)
  await waitPgReady()
}

async function db() {
  step('Preparing the database')
  const s = secrets()
  if (!fs.existsSync(path.join(dir.pgdata, 'PG_VERSION'))) {
    const pw = path.join(DATA, 'pg.pw'); fs.writeFileSync(pw, s.pgPassword)
    const r = run(exe('initdb'), ['-D', dir.pgdata, '-U', 'postgres', '-A', 'scram-sha-256', `--pwfile=${pw}`, '-E', 'UTF8', '--locale-provider=icu', '--icu-locale=en-IN', '--locale=C'])
    fs.rmSync(pw, { force: true })
    if (r.status !== 0) fail('Could not create the database folder', r.stderr.slice(0, 600))
    fs.appendFileSync(path.join(dir.pgdata, 'postgresql.conf'), `
# ── Twisha POS ──
listen_addresses = '127.0.0.1'
port = ${PORT.pg}
max_connections = 120
shared_buffers = 192MB
work_mem = 8MB
timezone = 'Asia/Kolkata'
log_timezone = 'Asia/Kolkata'
`)
    ok('Database folder created')
  } else ok('Database folder already exists')

  await startPg(); ok('Database is running')
  const has = psql(['-d', 'postgres', '-At', '-c', `SELECT 1 FROM pg_database WHERE datname='${DB}'`])
  if (has.status !== 0) fail('Cannot talk to the database', has.stderr.slice(0, 400))
  if (!has.stdout.trim()) {
    const c = psql(['-d', 'postgres', '-c', `CREATE DATABASE ${DB} ENCODING 'UTF8'`])
    if (c.status !== 0) fail('Could not create the database', c.stderr.slice(0, 400))
    ok(`Database "${DB}" created`)
  } else ok(`Database "${DB}" exists`)

  psql(['-d', DB, '-c', 'CREATE TABLE IF NOT EXISTS public.twisha_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())'])
  const applied = new Set(psql(['-d', DB, '-At', '-c', 'SELECT name FROM public.twisha_migrations']).stdout.split(/\r?\n/).filter(Boolean))
  const files = [['00-setup', path.join(dir.sql, '00-setup.sql')]]
  const migDir = path.join(dir.sql, 'migrations')
  for (const d of fs.existsSync(migDir) ? fs.readdirSync(migDir).sort() : []) {
    const f = path.join(migDir, d, 'migration.sql'); if (fs.existsSync(f)) files.push([d, f])
  }
  let n = 0
  for (const [name, file] of files) {
    if (applied.has(name)) continue
    const r = psql(['-d', DB, '-f', file])
    if (r.status !== 0) fail(`Migration "${name}" failed`, r.stderr.slice(0, 600))
    psql(['-d', DB, '-c', `INSERT INTO public.twisha_migrations(name) VALUES ('${name}') ON CONFLICT DO NOTHING`])
    ok(`Applied ${name}`); n++
  }
  if (!n) ok('Database structure already up to date')
}

// ── 3 · services ──────────────────────────────────────────────────────────────────────────────────────────────────
function detached(cmd, args, logName, o = {}) {
  if (!DETACH) { spawnHidden(cmd, args, path.join(dir.logs, logName), o); return undefined }
  const out = fs.openSync(path.join(dir.logs, logName), 'a')
  const c = spawn(cmd, args, { detached: DETACH, stdio: ['ignore', out, out], windowsHide: true, cwd: o.cwd, env: { ...process.env, ...(o.env ?? {}) } })
  c.unref(); return c.pid
}

/** Windows scans a program before it runs it, and for the (unsigned) job-store program that can take 30-70 s — and the
 *  wait happens inside CreateProcess, i.e. inside whoever starts it. So a throw-away helper process does the starting. */
function startRedisInBackground() {
  const args = ['--port', String(PORT.redis), '--bind', '127.0.0.1', '--dir', dir.redisdata, '--appendonly', 'yes', '--save', '300', '10']
  if (!DETACH) { spawnHidden(path.join(dir.redis, 'redis-server.exe'), args, path.join(dir.logs, 'redis.log'), { cwd: dir.redis }); return }
  const code = `const fs=require('fs'),cp=require('child_process'),a=JSON.parse(process.env.TW_REDIS);
const out=fs.openSync(a.log,'a');
cp.spawn(a.exe,a.args,{detached:true,stdio:['ignore',out,out],windowsHide:true,cwd:a.cwd}).unref();`
  spawn(process.execPath, ['-e', code], {
    detached: true, stdio: 'ignore', windowsHide: true,
    env: { ...process.env, TW_REDIS: JSON.stringify({ exe: path.join(dir.redis, 'redis-server.exe'), args, cwd: dir.redis, log: path.join(dir.logs, 'redis.log') }) },
  }).unref()
}

async function services() {
  step('Starting the database, job store and app')
  if (!fs.existsSync(path.join(dir.pgdata, 'PG_VERSION'))) fail('The database has not been prepared yet', 'Run step 2 (SETUP-DATABASE) first.')
  await startPg(); ok('Database running')

  const p = pids()
  if (!(await portOpen(PORT.redis))) {
    startRedisInBackground()
    // On some laptops the job store needs up to a minute to open its port (Windows scans its files). Nothing the shop needs
    // waits for it — sign-in, billing, PDFs and exports all work without it, and the app connects as soon as it is up — so the
    // start-up does not hold for it.
    ok('Job store is starting in the background')
  } else ok('Job store running')

  if (!(await apiUp())) {
    if (await portOpen(PORT.api)) fail(`Port ${PORT.api} is in use by another program`)
    const s = secrets()
    const env = {
      NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(PORT.api),
      DATABASE_URL: `postgresql://postgres:${s.pgPassword}@127.0.0.1:${PORT.pg}/${DB}`,
      REDIS_URL: `redis://127.0.0.1:${PORT.redis}`, JWT_SECRET: s.jwtSecret, JWT_EXPIRES_IN: '12h',
      SERVE_WEB_DIR: dir.web, RUN_WORKERS_INLINE: 'true', SINGLE_TENANT: 'true', SINGLE_USER: 'true',
      STORAGE_TYPE: 'local', STORAGE_LOCAL_PATH: path.join(DATA, 'files'), TZ: 'Asia/Kolkata', PUPPETEER_SKIP_DOWNLOAD: 'true',
    }
    const tsx = path.join(dir.app, 'node_modules', 'tsx', 'dist', 'cli.mjs')
    p.api = detached(process.execPath, [tsx, 'src/server.ts'], 'api.log', { cwd: dir.app, env })
    if (!(await waitFor(apiUp, 120, 1000))) fail('The app did not start', `See ${path.join(dir.logs, 'api.log')}`)
  }
  savePids(p); ok(`App running at ${URL_APP}`)
}

// ── 4 · shop + the one login ─────────────────────────────────────────────────────────────────────────────────────
async function shop() {
  step('Creating the shop and its login')
  if (!(await apiUp())) fail('The app is not running', 'Run step 3 (START-SERVICES) first.')
  const post = async (url, body, token) => {
    const r = await fetch(`${URL_APP}${url}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })
    return { status: r.status, data: await r.json().catch(() => ({})) }
  }
  const check = await (await fetch(`${URL_APP}/api/tenants/check-phone/${cfg.ownerPhone}`)).json().catch(() => null)
  if (check && check.available === false) { ok(`The shop already exists — login number ${cfg.ownerPhone}`); return }
  if (!cfg.pin) fail('No PIN in config\\shop.json', 'The PIN is only needed the first time. Re-install, or add "pin": "1234" to config\\shop.json.')

  const reg = await post('/api/tenants/register', {
    businessName: cfg.shopName, ownerName: cfg.ownerName, phone: cfg.ownerPhone, pin: cfg.pin,
    city: cfg.city, stateCode: cfg.stateCode, lang: 'en', domainType: 'tyre', ...(cfg.gstin ? { gstin: cfg.gstin } : {}),
  })
  if (reg.status !== 201) fail(`Could not create the shop (${reg.status})`, JSON.stringify(reg.data).slice(0, 300))
  ok(`Shop "${cfg.shopName}" created for ${cfg.ownerName}`)

  const login = await post('/api/auth/login', { tenantPhone: cfg.ownerPhone, phone: cfg.ownerPhone, pin: cfg.pin })
  if (login.status !== 200) fail('Could not sign in to finish the setup', JSON.stringify(login.data).slice(0, 300))
  const token = login.data.accessToken, branchId = login.data.branch.id
  const patch = await fetch(`${URL_APP}/api/branches/${branchId}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      name: cfg.shopName, gstin: cfg.gstin, address: { line1: cfg.addressLine1, city: cfg.city },
      domainConfig: {
        business_phone: cfg.businessPhone, business_email: cfg.businessEmail, prices_include_gst: true, default_service_gst: 0,
        bill_series: { car: { prefix: '', start: cfg.carBillStart }, two_wheel: { prefix: '2W-', start: cfg.twoWheelBillStart } },
      },
    }),
  })
  if (!patch.ok) fail('Could not save the bill details', (await patch.text()).slice(0, 300))
  ok('Bill details saved (address, GSTIN, phone, e-mail, bill numbers)')

  // the PIN is not needed again — remove it from the file (the database keeps only a scrambled copy)
  try { const c = JSON.parse(fs.readFileSync(SHOP_FILE, 'utf8')); delete c.pin; fs.writeFileSync(SHOP_FILE, JSON.stringify(c, null, 2)); ok('PIN removed from the settings file') } catch { /* read-only install folder */ }
  log(`  Sign in with mobile ${cfg.ownerPhone}`)
}

// ── 5 · open ──────────────────────────────────────────────────────────────────────────────────────────────────────
function openApp() {
  step('Opening Twisha POS')
  if (process.env.TWISHA_NO_BROWSER === '1') { ok('Window not opened (test mode)'); return }
  const pf = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, path.join(LOCAL, 'Programs')].filter(Boolean)
  const cands = pf.flatMap((b) => [path.join(b, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), path.join(b, 'Google', 'Chrome', 'Application', 'chrome.exe')])
  const browser = cands.find((c) => fs.existsSync(c))
  if (browser) { spawn(browser, [`--app=${URL_APP}`, '--window-size=1400,900'], { detached: true, stdio: 'ignore' }).unref(); ok('Opened in an app window') }
  else { spawn('cmd', ['/c', 'start', '', URL_APP], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); ok('Opened in your browser') }
}

// ── stop · status · backup · restore · reset-pin · unlock ───────────────────────────────────────────────────────
async function backup(quiet = false) {
  step('Saving a backup')
  if (!pgRunning()) { if (!quiet) fail('The database is not running — nothing to back up'); return null }
  const d = new Date(), pad = (n) => String(n).padStart(2, '0')
  const file = path.join(BACKUPS, `TwishaPOS-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.dump`)
  const r = run(exe('pg_dump'), ['-h', '127.0.0.1', '-p', String(PORT.pg), '-U', 'postgres', '-Fc', '-f', file, DB], { env: pgEnv() })
  if (r.status !== 0) { fail('Backup failed', r.stderr.slice(0, 400)) }
  const all = fs.readdirSync(BACKUPS).filter((f) => /^TwishaPOS-.*\.dump$/.test(f)).sort()
  for (const old of all.slice(0, Math.max(0, all.length - 30))) fs.rmSync(path.join(BACKUPS, old), { force: true })
  ok(`Backup saved: ${file} (${(fs.statSync(file).size / 1048576).toFixed(1)} MB)`); return file
}

/** the process ids that are listening on a TCP port (read from netstat in code — no shell quoting involved) */
function listeningPids(port) {
  const out = new Set()
  const re = new RegExp('^\\s*TCP\\s+\\S+:' + port + '\\s+\\S+\\s+LISTENING\\s+(\\d+)')
  for (const l of run('netstat', ['-ano', '-p', 'TCP']).stdout.split('\n')) {
    const m = l.match(re)
    if (m) out.add(m[1])
  }
  return [...out]
}

async function stop(withBackup = true) {
  step('Stopping Twisha POS')
  if (withBackup && pgRunning()) await backup(true).catch(() => null)
  const p = pids()
  for (const k of ['api', 'redis']) if (p[k]) run('taskkill', ['/PID', String(p[k]), '/T', '/F'])
  // belt and braces: whatever still answers on our ports
  for (const port of [PORT.api, PORT.redis]) for (const pid of listeningPids(port)) run('taskkill', ['/PID', pid, '/T', '/F'])
  // the job store may still be waiting to be let through by Windows (no port yet): find it by its own program path
  run('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='redis-server.exe'" | Where-Object { $_.ExecutablePath -like '${dir.redis.replace(/'/g, "''")}\\*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`])
  savePids({})
  if (fs.existsSync(path.join(dir.pgdata, 'PG_VERSION'))) run(exe('pg_ctl'), ['stop', '-D', dir.pgdata, '-m', 'fast', '-w', '-t', '60'])
  ok('Everything stopped')
}

async function status() {
  const up = { database: pgRunning(), 'job store': await portOpen(PORT.redis), app: await apiUp() }
  for (const [k, v] of Object.entries(up)) log(`  ${v ? '●' : '○'} ${k}: ${v ? 'running' : 'stopped'}`)
  log(`  Data folder: ${DATA}`); log(`  Backups: ${BACKUPS}`); log(`  Address: ${URL_APP}`)
}

async function restore(file) {
  step('Restoring a backup')
  if (!file) { const l = fs.readdirSync(BACKUPS).filter((f) => f.endsWith('.dump')).sort().reverse(); log('Backups available:'); l.forEach((f) => log(`  ${path.join(BACKUPS, f)}`)); fail('Say which one: restore <full path>') }
  if (!fs.existsSync(file)) fail(`File not found: ${file}`)
  if (!process.argv.includes('--yes')) fail('This REPLACES everything in the app with the backup.', 'Add --yes to confirm.')
  await stop(false); await startPg()
  psql(['-d', 'postgres', '-c', `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${DB}'`])
  psql(['-d', 'postgres', '-c', `DROP DATABASE IF EXISTS ${DB}`]); psql(['-d', 'postgres', '-c', `CREATE DATABASE ${DB} ENCODING 'UTF8'`])
  const r = run(exe('pg_restore'), ['-h', '127.0.0.1', '-p', String(PORT.pg), '-U', 'postgres', '-d', DB, '--no-owner', file], { env: pgEnv() })
  if (r.status > 1) fail('Restore failed', r.stderr.slice(0, 600))
  ok('Backup restored — start the app again')
}

async function withTenantSchema(fn) {
  if (!pgRunning()) await startPg()
  const sch = psql(['-d', DB, '-At', '-c', `SELECT "schemaName" FROM public.tenants ORDER BY "createdAt" LIMIT 1`]).stdout.trim()
  if (!sch) fail('No shop found in this database')
  return fn(sch)
}

async function resetPin(pin) {
  step('Setting a new PIN')
  if (!/^\d{4}$/.test(pin ?? '')) fail('Give a 4-digit PIN: reset-pin 1234')
  await withTenantSchema(async (sch) => {
    const hash = run(process.execPath, ['-e', `import('bcrypt').then(async (m) => { const b = m.default ?? m; console.log(await b.hash(process.argv[1], 10)) })`, pin], { cwd: dir.app }).stdout.trim()
    if (!hash.startsWith('$2')) fail('Could not scramble the PIN', 'Re-install Twisha POS.')
    const r = psql(['-d', DB, '-c', `UPDATE "${sch}".users SET pin = '${hash}' WHERE role = 'owner'`])
    if (r.status !== 0) fail('Could not save the PIN', r.stderr.slice(0, 300))
  })
  await unlock(true); ok('New PIN saved — sign in with the owner mobile number and the new PIN')
}

async function unlock(quiet = false) {
  if (!quiet) step('Lifting the sign-in lock')
  if (!(await portOpen(PORT.redis))) { if (!quiet) fail('The app is not running', 'Start it first.'); return }
  const r = run(process.execPath, ['-e', `const R=require('ioredis');const c=new (R.default??R)(process.argv[1]);c.keys('login_attempts:*').then(async k=>{if(k.length)await c.del(...k);console.log(k.length);c.quit()})`, `redis://127.0.0.1:${PORT.redis}`], { cwd: dir.app })
  if (!quiet) ok(`Lock cleared (${r.stdout.trim() || 0})`)
}

// ── entry ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const [, , cmd, arg] = process.argv
const table = {
  check, db, services, shop, open: async () => openApp(),
  start: async () => { await check(); await db(); await services(); await shop(); if (!process.argv.includes('--no-open')) openApp() },
  stop: () => stop(!process.argv.includes('--no-backup')), status, backup: () => backup(), restore: () => restore(arg), 'reset-pin': () => resetPin(arg), unlock: () => unlock(),
}
if (!table[cmd]) { console.log('Commands: check | db | services | shop | open | start | stop | status | backup | restore <file> --yes | reset-pin <1234> | unlock'); process.exit(cmd ? 1 : 0) }
try { await table[cmd](); process.exit(0) } catch (e) { log(`  ✘ ${e?.stack ?? e}`); process.exit(1) }
