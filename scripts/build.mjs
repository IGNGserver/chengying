#!/usr/bin/env node
// Build the DSH bundle: Host plugin, reusable core, CLI, analysis worker and the
// browser module. Output goes to lib/ (git-ignored; `prepare` rebuilds it for
// git installs). Run from a build copy on local disk, never on the project volume.
import { build } from 'esbuild'
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outdir = join(root, 'lib')
await mkdir(outdir, { recursive: true })

const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const nodeExternal = [
  'sharp',
  'exiftool-vendored',
  'onnxruntime-node',
  '@deepseek-ai/*',
]

const common = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: 'linked',
  external: nodeExternal,
  logLevel: 'warning',
  define: { __CHENGYING_VERSION__: JSON.stringify(pkg.version) },
  // ESM bundles that inline CJS helpers need a real require().
  banner: { js: "import { createRequire as __cyCreateRequire } from 'node:module'; const require = __cyCreateRequire(import.meta.url);" },
}

await Promise.all([
  build({ ...common, entryPoints: { index: join(root, 'src/dsh/index.ts') }, outdir }),
  build({ ...common, entryPoints: { core: join(root, 'src/core/index.ts') }, outdir }),
  build({ ...common, entryPoints: { 'analysis-worker': join(root, 'src/core/analysis/worker.ts') }, outdir }),
  build({ ...common, entryPoints: { cli: join(root, 'src/cli.ts') }, outdir }),
])

const cliPath = join(outdir, 'cli.js')
const cli = await readFile(cliPath, 'utf8')
if (!cli.startsWith('#!')) await writeFile(cliPath, `#!/usr/bin/env node\n${cli}`)
await chmod(cliPath, 0o755)

// Browser module: React comes from the Web Client's module table, so the bundle
// is emitted as CommonJS and wrapped into the ModuleLoader factory format.
const client = await build({
  entryPoints: [join(root, 'src/client/index.tsx')],
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'cjs',
  target: 'es2022',
  jsx: 'transform',
  jsxFactory: 'React.createElement',
  jsxFragment: 'React.Fragment',
  external: ['react', 'react-dom'],
  logLevel: 'warning',
  define: { __CHENGYING_VERSION__: JSON.stringify(pkg.version), 'process.env.NODE_ENV': '"production"' },
})
const body = client.outputFiles[0].text
const wrapped = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(pkg.name)},
  factory(require) {
    const module = { exports: {} }; const exports = module.exports;
    (function (module, exports, require) {
${body}
    })(module, exports, require);
    return module.exports.default ?? module.exports;
  },
});
`
await writeFile(join(outdir, 'client.js'), wrapped)
console.log('built lib/{index,core,cli,analysis-worker,client}.js')
