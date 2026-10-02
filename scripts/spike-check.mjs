/**
 * Static verification of the built artefacts and the source constraints.
 *
 * The harness rejects a plugin at load time for reasons that are not obvious
 * from a successful build: a forbidden value import, a missing manifest key, a
 * bundle that never registers with the module loader. Catching those here means
 * the failure is a clear message from this script rather than an opaque one
 * from the host.
 *
 * Run with `npm run spike:check`. Exits non-zero if anything fails, so it can
 * be dropped straight into CI.
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const notes = []

/**
 * Record a check result.
 * @param ok - whether it passed.
 * @param label - what was checked.
 * @param detail - extra context on failure.
 */
const check = (ok, label, detail = '') => {
  if (ok) {
    notes.push(`  ok    ${label}`)
  } else {
    failures.push(`  FAIL  ${label}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

/** Read a file as UTF-8, or null when it does not exist. */
const read = async (path) => {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

/** List every `.ts`/`.tsx` file under a directory, recursively. */
async function sourceFiles(directory) {
  const out = []
  const walk = async (current) => {
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'lib') continue
        await walk(full)
      } else if (/\.tsx?$/u.test(entry.name)) {
        out.push(full)
      }
    }
  }
  await walk(directory)
  return out
}

/* ------------------------------------------------------------- manifest ---- */

const manifestRaw = await read(join(root, 'package.json'))
let manifest = null
try {
  manifest = JSON.parse(manifestRaw ?? '{}')
} catch (error) {
  check(false, 'package.json parses', String(error))
}

if (manifest !== null) {
  check(manifest.name === 'dsh-better-float', 'package name matches the roster id')
  check(manifest.dsh?.client?.platform === 'web', 'declares dsh.client.platform = web',
    `got ${JSON.stringify(manifest.dsh?.client?.platform)}`)
  check(manifest.dsh?.bundle?.patch === './cordis.patch.yml', 'declares the bundle patch entry point')
  check(manifest.exports?.['.'] !== undefined, 'exports a host half')
  check(manifest.exports?.['./client'] !== undefined, 'exports a client half')

  const patch = await read(join(root, 'cordis.patch.yml'))
  check(patch !== null && patch.includes('dsh-better-float'),
    'cordis.patch.yml names this package')
}

/* --------------------------------------------------------------- build ----- */

const clientJs = await read(join(root, 'lib', 'client.js'))
const indexJs = await read(join(root, 'lib', 'index.js'))

check(clientJs !== null, 'lib/client.js exists (run npm run build)')
check(indexJs !== null, 'lib/index.js exists (run npm run build)')

if (clientJs !== null) {
  check(clientJs.includes('window.__ModuleLoader__.load'),
    'client bundle registers with the host module loader')
  check(clientJs.includes("id: \"dsh-better-float\""),
    'client bundle registers under the package name')
  // The host indexes a plugin's browser half by package name. Registering under
  // the shortcut command id instead would load the plugin without ever running
  // it, and report nothing — so the distinction deserves its own check.
  const loadIndex = clientJs.indexOf('__ModuleLoader__.load')
  const registrationId = /\bid:\s*['"]([^'"]+)['"]/u.exec(clientJs.slice(loadIndex))?.[1] ?? null
  check(registrationId === manifest?.name,
    'client registration id equals the package name',
    `got ${registrationId ?? 'none'}, expected ${manifest?.name ?? '?'}`)
  // A bundled React would create a second reconciler and break hooks; a
  // bundled host package would trip the purity gate.
  check(!/react-dom/.test(clientJs), 'client bundle does not embed react-dom')
  check(!/@deepseek-ai\/dsh-/.test(clientJs),
    'client bundle does not embed a host package')

  // The shortcut must claim its keypress. A command whose `resolve` returns
  // `pass` registers cleanly, appears in the settings UI, and then silently does
  // nothing when pressed — the hardest failure mode here to notice, because
  // every other signal says the plugin loaded.
  check(/status:\s*["']handled["']/u.test(clientJs),
    'the shortcut claims the keypress with a `handled` resolution')
  // `pick` is the entry to the picker. Without a call to it the shortcut is
  // claimed and still does nothing.
  check(/\.pick\(/u.test(clientJs),
    'the shortcut resolution actually starts a pick session')
  // The panel surface must reach the frame-wide seat, or the panels have no
  // registered host and the feature has nowhere to live.
  check(clientJs.includes('shell.overlay'),
    'the panel surface registers into the shell.overlay seat')
}

if (indexJs !== null) {
  check(/export\s*\{/.test(indexJs), 'host half is ESM with exports')
}

/* ------------------------------------------------- source constraints ------ */

const sources = await sourceFiles(join(root, 'src'))
check(sources.length > 0, 'found source files to scan')

/**
 * The purity gate forbids value-importing anything from `@deepseek-ai/*` outside
 * the platform externals. `import type` is erased at build time and is allowed,
 * so the pattern below matches only value imports.
 */
const VALUE_IMPORT = /^\s*import\s+(?!type\s)[^;]*from\s+['"]@deepseek-ai\//mu

for (const file of sources) {
  const body = await read(file)
  if (body === null) continue
  const label = relative(root, file)
  check(!VALUE_IMPORT.test(body), `no host value-import in ${label}`)
}

/* -------------------------------------------------------- known traps ------ */

const shortcut = await read(join(root, 'src', 'client', 'index.ts'))
if (shortcut !== null) {
  // Reserved-letter lists from the harness's shortcut registry: a binding that
  // collides is silently rejected, so catching it here saves a debugging round.
  check(!/modifiers:\s*\[\s*'primary'\s*\]\s*,\s*code:\s*'Key[A-Z]'/u.test(shortcut)
    || shortcut.includes("'primary', 'shift'"),
    'shortcut binding avoids the reserved primary+letter set')
  check(shortcut.includes("id: OVERVIEW_COMMAND_ID")
    && shortcut.includes("code: 'KeyS', modifiers: ['primary', 'alt', 'shift']")
    && !shortcut.includes("code: 'KeyA', modifiers: ['primary', 'shift']"),
    'overview uses a configurable non-reserved primary+shift binding')
}

const standIn = await read(join(root, 'src', 'capture', 'stand-in.ts'))
if (standIn !== null) {
  check(standIn.includes('Reflect.apply'),
    'stand-in restores the captured implementation rather than a rebound partial')
  check(!/Node\.prototype\.(removeChild|insertBefore|appendChild|replaceChild)\s*=/u.test(standIn),
    'stand-in patches the instance, never Node.prototype')
}

const clone = await read(join(root, 'src', 'capture', 'tier2-clone.ts'))
if (clone !== null) {
  // innerHTML parses and can execute; it must never be used to move content.
  check(!/\.innerHTML\s*=/u.test(clone),
    'clone path never writes via innerHTML')
  check(clone.includes('cloneNode'), 'clone path copies nodes, not markup')
}

const reflect = await read(join(root, 'src', 'capture', 'events-reflect.ts'))
if (reflect !== null) {
  check(reflect.includes('__reactProps$'),
    'event reflection reads React props from the moved node')
}

/* --------------------------------------------------- measured behaviours --- */

/**
 * The `container-type` trap, which the spike bench established by measurement.
 *
 * Chromium keeps the declared `container-type` in the computed style even on a
 * `display: contents` element, while no `@container` rule resolves against it.
 * So detecting the gap by comparing the computed value against `normal` always
 * reports "no gap" and silently skips the repair. The detection must also
 * require that the element generates a box.
 */
const inplace = await read(join(root, 'src', 'capture', 'css-inplace.ts'))
if (inplace !== null) {
  const guard = inplace.slice(inplace.indexOf('export function isContainerQueryContainer'))
  const body = guard.slice(0, guard.indexOf('\n}'))
  check(body.includes('generatesBox'),
    'container detection requires a generated box, not just a declared container-type')
  check(!/return\s+type\s*!==\s*''\s*&&\s*type\s*!==\s*'normal'\s*$/mu.test(body),
    'container detection does not rely on the computed value alone')
}

/**
 * The `getComputedStyle` naming trap.
 *
 * `getPropertyValue()` accepts only kebab-case names. Passing a camelCase name
 * returns an empty string, which is indistinguishable from "the rule never
 * applied" — it caused four of the five S4 probes to report a false failure.
 */
const bench = await read(join(root, 'spikes', 'bench.js'))
if (bench !== null) {
  check(bench.includes('readProperty'),
    'the spike bench normalises property names before reading computed styles')
  check(!/getPropertyValue\(\s*probe\.property\s*\)/u.test(bench),
    'the spike bench does not pass raw camelCase names to getPropertyValue')
}

/* ---------------------------------------------------------------- report ---- */

process.stdout.write('better-float static checks\n\n')
process.stdout.write(`${notes.join('\n')}\n`)

if (failures.length > 0) {
  process.stdout.write(`\n${failures.join('\n')}\n`)
  process.stdout.write(`\n${failures.length} check(s) failed.\n`)
  process.exit(1)
}

process.stdout.write(`\nAll ${notes.length} checks passed.\n`)
