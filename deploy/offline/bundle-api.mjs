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

// everything that is not our own code stays outside the bundle
const keepOutside = {
  name: 'keep-packages-outside',
  setup(build) {
    build.onResolve({ filter: /^[^./]/ }, (args) => {
      if (args.kind === 'entry-point' || path.isAbsolute(args.path) || args.path.startsWith('@billing/')) return null
      if (args.path.startsWith('node:')) return { path: args.path, external: true }
      return { path: args.path, external: true }
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
  logLevel: 'warning',
  plugins: [keepOutside],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
})
if (result.errors.length) process.exit(1)
console.log(`bundled → ${outFile} (${(fs.statSync(outFile).size / 1024).toFixed(0)} KB)`)
