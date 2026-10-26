// Compiles the app server's own code (apps/api/src + the @billing/* workspace packages) into ONE plain JavaScript file,
// so the packaged app starts with `node server.bundle.mjs` instead of transpiling TypeScript on every start.
// Third-party packages stay as ordinary node_modules (some read their own data files and cannot be bundled).
//
//   node deploy/offline/bundle-api.mjs <apiSrcDir> <outFile>
//
// The file must sit in <app>/src/lib/ so that the "../../assets/…" paths the code builds from import.meta.url still point at <app>/assets.
import { createRequire } from 'node:module'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..')
const [srcDir, outFile] = process.argv.slice(2)
if (!srcDir || !outFile) { console.error('Usage: node bundle-api.mjs <apps/api/src dir> <out .mjs file>'); process.exit(2) }

const req = createRequire(path.join(REPO, 'apps', 'api', 'package.json'))
const tsxDir = path.dirname(req.resolve('tsx'))
const esbuild = createRequire(path.join(tsxDir, 'x.js'))('esbuild')

// Packages that stay OUTSIDE the bundle: native code (cannot be packed into a text file) or packages that read their own data files at run time.
// Everything else is packed in, so the server opens a few dozen files at start-up instead of ~2,400 — on a laptop where every file open is
// slow (antivirus, old disk) that is the difference between ~45 s and a few seconds.
const KEEP = new Set(['@prisma/client', '.prisma/client', 'bcrypt', 'pdfkit', 'msgpackr-extract', 'pino-pretty', 'node-cron'])
const pkgName = (spec) => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0])
const keepOutside = {
  name: 'keep-some-packages-outside',
  setup(build) {
    build.onResolve({ filter: /^[^./]/ }, (args) => {
      if (args.kind === 'entry-point' || path.isAbsolute(args.path)) return null
      if (args.path.startsWith('node:')) return { path: args.path, external: true }
      if (KEEP.has(pkgName(args.path))) return { path: args.path, external: true }
      return null                                                      // our own @billing/* code and every other package: packed in
    })
  },
}

const result = await esbuild.build({
  entryPoints: [path.join(srcDir, 'server.ts')],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: false,
  logLevel: 'error',
  plugins: [keepOutside],
  banner: { js: "import { createRequire as __cr } from 'node:module'; import { fileURLToPath as __fu } from 'node:url'; import { dirname as __dn } from 'node:path'; const require = __cr(import.meta.url); const __filename = __fu(import.meta.url); const __dirname = __dn(__filename);" },
})
if (result.errors.length) process.exit(1)
console.log(`bundled → ${outFile} (${(fs.statSync(outFile).size / 1024).toFixed(0)} KB)`)
