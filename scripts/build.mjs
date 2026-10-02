/**
 * Bundle the plugin into the two files the harness loads.
 *
 * ## The client half's registration shape, and why it is hand-built
 *
 * The loader calls a plugin's client half like this (read from a shipped bundle,
 * `dsh-client-locale/lib/client.js`):
 *
 * ```js
 * window.__ModuleLoader__.load({
 *   id: "@deepseek-ai/dsh-client-locale",
 *   factory: (require) => {
 *     var module = { exports: {} }
 *     var exports = module.exports
 *     let react = require("react")     // require is a FACTORY PARAMETER
 *     …
 *     exports.apply = apply
 *     return module.exports
 *   },
 * })
 * ```
 *
 * The one thing that must hold: `require("react")` has to be evaluated **inside
 * the factory function body**, because that is the only scope where `require`
 * exists. The loader's module table holds only the platform singletons from
 * `PLATFORM_MODULES`.
 *
 * ## The failure this shape exists to avoid
 *
 * An earlier build emitted `format: 'iife'` with `react` external. esbuild then
 * generated its own compatibility shim at the top of the IIFE:
 *
 * ```js
 * var __require = ((x) => typeof require !== "undefined" ? require : …)(function (x) {
 *   throw Error('Dynamic require of "' + x + '" is not supported')
 * })
 * var import_react = __require("react")   // ← module scope: no `require` here
 * ```
 *
 * `__require` closes over the *global* `require`, which does not exist in a
 * classic script, so the call threw. The host surfaced it as
 *
 * ```
 * web boot: 1 entry did not activate
 * dsh-better-float: import failed
 * Uncaught Error: Dynamic require of "react" is not supported
 * ```
 *
 * and the app refused to start. Declaring a local `require` inside the factory
 * does not help, because esbuild's shim is declared at module scope and nothing
 * shadows it from there.
 *
 * ## How the shape is produced
 *
 * The client half is built as CommonJS — the same `require`/`exports` convention
 * the factory body uses — and then wrapped in the loader call. No shim is
 * generated, because CommonJS output expects `require` to already exist, and it
 * does: as the factory's parameter.
 */
import { build } from 'esbuild'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const out = join(root, '..', 'lib')

/** Packages the host provides; never bundle these. */
const EXTERNAL = ['react', 'react/jsx-runtime', '@deepseek-ai/*']

/** The registration id must equal the package name; the host indexes by it. */
const PACKAGE = 'dsh-better-float'

await mkdir(out, { recursive: true })

/* ---------------------------------------------------------- client half ---- */

// Built to a temporary file so the wrapper can be composed around it. A banner
// would not do: a banner is emitted outside the IIFE, which is precisely the
// placement that broke the previous build.
const clientBody = join(out, '.client-body.js')

await build({
  entryPoints: [join(root, '..', 'src', 'client', 'index.ts')],
  outfile: clientBody,
  bundle: true,
  // CommonJS, because the wrapper supplies `require` and `exports` as parameters
  // of the factory. This is what keeps the external imports inside the only
  // scope where `require` exists.
  format: 'cjs',
  platform: 'browser',
  target: ['chrome120'],
  external: EXTERNAL,
  logLevel: 'info',
})

const body = await readFile(clientBody, 'utf8')

/**
 * The loader call wrapping the built body.
 *
 * `module` and `exports` are declared before the body because CommonJS output
 * assigns to them, and `return module.exports` is what the loader keeps as this
 * entry's exports.
 */
const wrapped = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(PACKAGE)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
${body.split('\n').map((line) => (line === '' ? '' : `    ${line}`)).join('\n')}
    return module.exports;
  },
});
`

await writeFile(join(out, 'client.js'), wrapped, 'utf8')

// The intermediate is an implementation detail; the loader only reads client.js.
await rm(clientBody, { force: true })

/* ------------------------------------------------------------ host half ---- */

// Inert by design, but the roster entry loads it, so it must exist and be valid
// ESM.
await build({
  entryPoints: [join(root, '..', 'src', 'index.ts')],
  outfile: join(out, 'index.js'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['node20'],
  logLevel: 'info',
})

// `lib/` is the shipped surface, so it holds only the two files the host reads.
// A build marker adds nothing the gates do not already report through their own
// timestamps, and anything extra here risks being copied into the install and
// mistaken for a loadable entry. Stale intermediates from earlier builds are
// swept for the same reason: a previous `.client-entry.js` would otherwise sit
// next to `client.js` and look like part of the artifact.
for (const leftover of ['.client-entry.js', 'BUILD.txt', '.client-body.js']) {
  await rm(join(out, leftover), { force: true })
}
