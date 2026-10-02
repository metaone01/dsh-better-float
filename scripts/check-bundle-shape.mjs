/**
 * Verify the built client bundle has the loader registration shape the host needs.
 *
 * The previous build passed every check this repo had and still broke the app,
 * because none of them looked at where `require("react")` ended up. The host
 * reports a wrong shape as `web boot: 1 entry did not activate`, which is a
 * startup failure — so this checks the structure directly.
 */
import { readFileSync } from 'node:fs'

const BUNDLE = 'lib/client.js'
const PACKAGE = 'dsh-better-float'

const text = readFileSync(BUNDLE, 'utf8')
const lines = text.split('\n')

const checks = []
const check = (ok, label, detail = '') => checks.push({ ok, label, detail })

/* ------------------------------- loader call present ----------------------- */

check(text.includes('window.__ModuleLoader__.load('), 'calls the loader')
check(
  new RegExp(`id:\\s*["']${PACKAGE}["']`, 'u').test(text),
  'registers under the package name',
)

/* ------------------- the factory takes `require` as a parameter ----------- */

const factoryLine = lines.findIndex((line) => /factory:\s*\(\s*require\s*\)/.test(line))
check(factoryLine >= 0, 'factory declares a `require` parameter', factoryLine < 0 ? 'not found' : `line ${factoryLine + 1}`)

/* ------------- every external require sits INSIDE the factory body -------- */

/**
 * Walk the bundle tracking brace depth from the factory's opening brace, and
 * confirm each `require("<external>")` occurs while that depth is positive.
 *
 * This is the check that matters. A require at depth 0 is evaluated in module
 * scope, where the factory's parameter does not exist, and the host turns that
 * into a failed entry and a refusal to start.
 */
let depth = 0
let sawFactory = false
const externalRequires = []

for (const [index, line] of lines.entries()) {
  if (!sawFactory && /factory:\s*\(\s*require\s*\)\s*=>\s*\{/u.test(line)) {
    sawFactory = true
    depth += (line.match(/\{/gu) ?? []).length - (line.match(/\}/gu) ?? []).length
    continue
  }
  if (!sawFactory) continue

  const requireMatch = /require\(\s*["']([^"']+)["']\s*\)/u.exec(line)
  if (requireMatch !== null) externalRequires.push({ name: requireMatch[1], depth, line: index + 1 })

  depth += (line.match(/\{/gu) ?? []).length - (line.match(/\}/gu) ?? []).length
}

for (const entry of externalRequires) {
  check(
    entry.depth > 0,
    `require("${entry.name}") is inside the factory`,
    entry.depth > 0 ? `line ${entry.line}` : `line ${entry.line} is at module scope`,
  )
}

/* ---------------------- no esbuild compatibility shim --------------------- */

// `__require` is esbuild's IIFE shim. Its presence means `react` was rewritten
// into a call that cannot succeed in a classic script.
check(
  !/__require\s*=/.test(text),
  'no esbuild `__require` shim (which would throw at module scope)',
)
check(
  !/Dynamic require of/.test(text),
  'no dynamic-require failure path',
)

/* --------------------------------- exports ------------------------------- */

check(
  /return module\.exports/u.test(text),
  'returns module.exports from the factory',
)
// CommonJS output re-exports a binding as `apply: () => apply`, so both that and
// a direct assignment are accepted. An artifact that exports nothing at all
// would load cleanly and then do nothing, which is the failure being guarded.
check(
  /(exports\.apply\s*=|apply:\s*(?:\(\)\s*=>\s*)?apply\b)/u.test(text),
  'exposes `apply` on the exports',
)

/* ------------------------------- inject declaration ---------------------- */

/**
 * The `inject` list, and the services it names.
 *
 * This is the check whose absence cost the most time. Cordis supplies a plugin's
 * context with exactly the names in `inject`; a service that is not declared is
 * *absent*, so reading `ctx.slots` throws and the entry ends FAILED. The host
 * reports that only as `1 entry did not activate`, and no amount of reading the
 * bundle's loader shape reveals it.
 *
 * `inject` must therefore be exported, and must name every service the bundle
 * reads off `ctx`. Both halves are checked, because either one alone is
 * insufficient.
 */
const injectExport = /inject:\s*\(\)\s*=>\s*inject\b|exports\.inject\s*=|inject\s*=\s*\[/u.test(text)
check(injectExport, 'exports an `inject` list')

// Which service names does the bundle read off `ctx`?
const ctxServices = new Set()
for (const match of text.matchAll(/\bctx\.([A-Za-z_$][\w$]*)/gu)) ctxServices.add(match[1])
// `ctx.effect` and `ctx.loader` are Cordis core members, not injectable services.
const CORE = new Set(['effect', 'loader', 'reflect', 'on', 'emit', 'logger', 'get', 'inject'])
const needed = [...ctxServices].filter((name) => !CORE.has(name)).sort()

// The declared names, read out of the emitted array literal.
const declaredMatch = /inject\s*=\s*\[([^\]]*)\]/u.exec(text)
const declared = declaredMatch === null
  ? []
  : [...declaredMatch[1].matchAll(/["']([^"']+)["']/gu)].map((m) => m[1])

for (const name of needed) {
  check(
    declared.includes(name),
    `declares \`${name}\` in inject (read off ctx)`,
    declared.includes(name) ? '' : 'read from ctx but missing — the service will be absent at mount',
  )
}

/* --------------------------- package.json agreement ---------------------- */

/**
 * `dsh.client.inject` is the module-graph dependency list. It names provider
 * packages, and is deliberately different from the Cordis service names in
 * the bundle's exported `inject` array.
 *
 * The host orders the boot graph from the manifest before any bundle runs, so it
 * cannot read this file's export to discover the dependency. The two lists must
 * agree; a mismatch means the entry is started before its dependency row has
 * registered, which fails intermittently rather than cleanly.
 */
let manifestInject = null
let manifestPlatform = null
try {
  const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
  manifestInject = manifest.dsh?.client?.inject ?? null
  manifestPlatform = manifest.dsh?.client?.platform ?? null
} catch { /* reported below */ }

check(manifestPlatform === 'web', 'package.json declares dsh.client.platform = "web"',
  manifestPlatform === null ? 'missing' : `found ${JSON.stringify(manifestPlatform)}`)
check(Array.isArray(manifestInject), 'package.json declares dsh.client.inject',
  manifestInject === null ? 'missing — the host will not order this entry after its dependencies' : '')
const graphDependencies = [
  '@deepseek-ai/dsh-client-ui-renderer',
  '@deepseek-ai/dsh-client-shortcuts',
  '@deepseek-ai/dsh-client-ui-layout',
]
for (const name of graphDependencies) {
  check(
    Array.isArray(manifestInject) && manifestInject.includes(name),
    `package.json dsh.client.inject lists dependency \`${name}\``,
    Array.isArray(manifestInject) && manifestInject.includes(name) ? '' : 'absent from the manifest list',
  )
}

/* -------------------------------- report --------------------------------- */

console.log(`=== ${BUNDLE} (${text.length} chars) ===\n`)

const failed = checks.filter((entry) => !entry.ok)
for (const entry of checks) {
  console.log(`  ${entry.ok ? 'ok  ' : 'FAIL'} ${entry.label}${entry.detail === '' ? '' : ` — ${entry.detail}`}`)
}

console.log('')
if (externalRequires.length === 0) {
  console.log('  (no external requires found — react may have been bundled, which would')
  console.log('   create a second reconciler; check the `external` list in build.mjs)')
}

console.log(failed.length === 0
  ? `\nBUNDLE SHAPE OK (${checks.length} checks)`
  : `\n${failed.length} of ${checks.length} checks FAILED`)

process.exit(failed.length === 0 ? 0 : 1)
