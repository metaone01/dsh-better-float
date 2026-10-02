/**
 * Install better-float into the profile DSH Desktop actually boots.
 *
 * ## The two mistakes this script exists to prevent
 *
 * **Wrong profile.** The first version installed into `profiles/web`. That is
 * the profile the CLI boots (`dsh web`), not the app's. The shell settles it:
 *
 * ```js
 * function resolveDesktopPaths(dshHome = resolveDshHome()) {
 *   return { profile: join(dshHome, "profiles", "desktop") }
 * }
 * ```
 *
 * **Wrong home.** The second version hardcoded
 * `%APPDATA%/dsh-desktop/harness`. The shell never assigns `DSH_HOME`, so
 * `resolveDshHome` falls back to `~/.dsh`, and the AppData home is a leftover no
 * current build reads.
 *
 * Both failures are silent: files present, patch correct, app unchanged. So the
 * home is now resolved from the documented precedence rather than hardcoded, and
 * every step is verified against the shell's own code where that is possible.
 *
 * ## Why the desktop profile may not exist yet
 *
 * It is created on first launch by `DesktopProjectManager.applyRelease()` →
 * `createPluginProfile()` → `initProfile(dir, WEB_PROFILE.bundles)`. This script
 * writes the same initial contents when the directory is absent, so a plugin can
 * be installed before the app has ever run. The template mirrors
 * `PROFILE_TEMPLATES.web` plus `shell.overlay`'s host bundle, which is what
 * `createPluginProfile` passes; only the directory name differs.
 *
 * Run with `npm run install:dsh`.
 */
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { candidateHomes, resolveHarnessHome, surveyHomes } from './harness-home.mjs'
import { applyInsert, insertEntry, PACKAGE as PLUGIN_PACKAGE } from './patch-edit.mjs'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

const resolved = resolveHarnessHome()
const HARNESS_HOME = resolved.home
const PROFILE = join(HARNESS_HOME, 'profiles', 'desktop')
const PROFILE_MODULES = join(PROFILE, 'node_modules')
const PATCH = join(PROFILE, 'cordis.patch.yml')

const PACKAGE = PLUGIN_PACKAGE

/**
 * Initial profile contents, mirrored from the shell's own templates.
 *
 * Duplicated rather than imported because the originals live inside `app.asar`.
 * A mismatch would produce a profile the app silently repairs on next launch
 * rather than one that fails loudly, so these are kept literal and checked by
 * the verification step.
 */
const PROFILE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
const PROFILE_PATCH_TEMPLATE = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
`
const PROFILE_PNPM_WORKSPACE = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`

const problems = []
const notes = []

/** Report a step's outcome. */
const step = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) problems.push(label)
}

console.log('better-float · DSH Desktop installer\n')

/* ------------------------------------------------------------ resolution --- */

console.log('harness home')
console.log(`  resolved from ${resolved.source}`)
console.log(`  -> ${HARNESS_HOME}`)

// Report every other candidate so a stale install is visible rather than
// mysterious: a plugin sitting in a home the app does not read looks installed
// and does nothing. `%APPDATA%/@deepseek-ai/dsh-desktop` in particular is the
// Electron userData directory, not a harness home — it holds logs and caches and
// no `profiles/` tree, so naming it here prevents it being mistaken for a target.
const others = surveyHomes().filter((candidate) => candidate.path !== HARNESS_HOME)
for (const candidate of others) {
  if (!candidate.exists) continue
  const role = candidate.isHome ? 'a harness home this build does not read' : 'not a harness home (app data / logs)'
  console.log(`  also present: ${candidate.path}`)
  console.log(`    ${role}`)
}

/* --------------------------------------------------------- preconditions --- */

console.log('\npreconditions')
step(existsSync(HARNESS_HOME), 'harness home exists', HARNESS_HOME)

const clientBundle = join(projectRoot, 'lib', 'client.js')
const hostBundle = join(projectRoot, 'lib', 'index.js')
step(existsSync(clientBundle), 'client bundle built', 'run `npm run build` first')
step(existsSync(hostBundle), 'host bundle built', 'run `npm run build` first')

// The bundle's Cordis service list and the manifest's module-graph dependency
// list are different contracts. Check both before copying the package: the
// first controls the context passed to apply(), while the second makes the
// provider packages arrive before this entry.
const declared = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')).dsh?.client?.inject
const builtSource = existsSync(clientBundle) ? readFileSync(clientBundle, 'utf8') : ''
const emittedInject = /inject\s*=\s*\[([^\]]*)\]/u.exec(builtSource)
const emittedNames = emittedInject === null
  ? []
  : [...emittedInject[1].matchAll(/["']([^"']+)["']/gu)].map((m) => m[1])

step(
  Array.isArray(declared) && declared.length > 0,
  'package.json declares dsh.client.inject',
  Array.isArray(declared) && declared.length > 0 ? declared.join(', ') : 'missing — the host will order nothing and supply no service',
)
step(
  emittedNames.length > 0,
  'the client bundle exports an inject list',
  emittedNames.length > 0 ? emittedNames.join(', ') : 'missing — Cordis will supply no service and apply() will throw',
)
if (Array.isArray(declared) && emittedNames.length > 0) {
  const graphDependencies = [
    '@deepseek-ai/dsh-client-ui-renderer',
    '@deepseek-ai/dsh-client-shortcuts',
    '@deepseek-ai/dsh-client-ui-layout',
  ]
  const missing = graphDependencies.filter((name) => !declared.includes(name))
  step(missing.length === 0, 'the manifest lists provider/declaration packages', missing.length === 0 ? graphDependencies.join(', ') : `missing: ${missing.join(', ')}`)
}

step(!PROFILE.startsWith('G:'), 'target is the profile, not the read-only app bundle')

/* ---------------------------------------------- create the profile if new -- */

const profileWasAbsent = !existsSync(PROFILE)
if (profileWasAbsent) {
  console.log('\ninitializing the desktop profile (absent — the app creates it on first launch)')
  mkdirSync(PROFILE_MODULES, { recursive: true })

  const manifestPath = join(PROFILE, 'package.json')
  if (!existsSync(manifestPath)) {
    const manifest = {
      name: 'dsh-profile-desktop',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: [...PROFILE_BUNDLES] } },
    }
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    step(true, 'wrote the profile manifest', PROFILE_BUNDLES.join(' + '))
  }

  const workspacePath = join(PROFILE, 'pnpm-workspace.yaml')
  if (!existsSync(workspacePath)) {
    writeFileSync(workspacePath, PROFILE_PNPM_WORKSPACE, 'utf8')
    step(true, 'wrote pnpm-workspace.yaml')
  }

  notes.push('the profile was created here; the app reuses it rather than re-initializing')
} else {
  step(true, 'desktop profile already exists', PROFILE)
}

// The insert is appended to whatever is already there, so a populated layer is
// expected rather than a reason to stop. The one hard requirement is that no
// *other* plugin's rows are disturbed, and that this plugin has at most one row
// after the edit — a duplicate command id makes `shortcuts.register` throw,
// which fails the whole boot rather than just this plugin.
if (!existsSync(PATCH)) {
  writeFileSync(PATCH, PROFILE_PATCH_TEMPLATE, 'utf8')
  step(true, 'created the profile patch layer')
} else {
  const current = readFileSync(PATCH, 'utf8')
  const rows = current.split('\n').filter((line) => /^- /.test(line.trim())).length
  const already = current.includes(`name: ${PACKAGE}`)
  step(true, 'patch layer is appendable', already ? 'replacing this plugin\'s own row' : `${rows} existing row(s) kept`)
  if (rows > 0) {
    notes.push(`appending to a layer that already holds ${rows} row(s); they are preserved`)
  }
}

if (problems.length > 0) {
  console.log(`\n${problems.length} precondition(s) failed. Nothing was modified.`)
  process.exit(1)
}

/* ------------------------------------------------------------- install ----- */

const target = join(PROFILE_MODULES, PACKAGE)

console.log('\ninstalling')
console.log(`  target: ${target}`)

// A previous install is removed first so a stale file cannot survive a rebuild.
// Confined to the one directory this script owns.
if (existsSync(target)) {
  rmSync(target, { recursive: true, force: true })
  notes.push('replaced a previous install of the same package')
}
mkdirSync(target, { recursive: true })

// The manifest is rebuilt rather than copied, so every field the host reads has
// to be carried over deliberately. A field missing here is missing at runtime,
// and the failure is invisible: the entry loads and then does nothing.
//
// `dsh.client` is what admits the package to the browser roster —
// `dsh-client-modules` scans Loader entries for exactly this field. Its `inject`
// member is *also* load-bearing and easy to lose: the host composes the boot
// graph, and therefore this entry's dependency order, from the manifest, before
// any bundle has executed. Omitting it leaves the plugin unordered and started
// without its services.
const sourceManifest = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'))
const sourceClient = sourceManifest.dsh?.client ?? {}
const clientDeclaration = {
  platform: sourceClient.platform ?? 'web',
  ...Array.isArray(sourceClient.inject) && sourceClient.inject.length > 0
    ? { inject: [...sourceClient.inject] }
    : {},
}

const manifest = {
  name: PACKAGE,
  version: sourceManifest.version,
  private: true,
  type: 'module',
  main: 'lib/index.js',
  exports: {
    '.': './lib/index.js',
    './client': './lib/client.js',
  },
  dsh: { client: clientDeclaration },
}
writeFileSync(join(target, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
step(true, 'wrote package.json with a dsh.client declaration', `platform: ${clientDeclaration.platform}${clientDeclaration.inject === undefined ? ' (no inject — services will be absent)' : `, inject: ${clientDeclaration.inject.join(', ')}`}`)

// Copied rather than linked: the archive-backed pool is read-only, and a link
// into the project would break the moment the project moves.
mkdirSync(join(target, 'lib'), { recursive: true })
copyFileSync(clientBundle, join(target, 'lib', 'client.js'))
copyFileSync(hostBundle, join(target, 'lib', 'index.js'))
step(true, 'copied client.js and index.js')

/* -------------------------------------------------------- profile patch ---- */

// Back up before writing, so a mistake is recoverable without a reinstall.
if (existsSync(PATCH)) {
  copyFileSync(PATCH, `${PATCH}.before-better-float`)
  notes.push(`backed up the previous patch to ${PATCH}.before-better-float`)
}

// The existing layer is preserved and the insert appended: the desktop profile
// carries the user's own settings rows, and rewriting the file from a template
// would discard them. The edit itself lives in `patch-edit.mjs` so the same code
// both performs it and can be checked for losslessness and idempotence before it
// runs — see `check-patch-edit.mjs` and `npm run check:patch`.
const existing = existsSync(PATCH) ? readFileSync(PATCH, 'utf8') : PROFILE_PATCH_TEMPLATE

const already = existing.includes(`name: ${PACKAGE}`)
const existingRows = existing.split('\n').filter((line) => /^- /.test(line.trim())).length
if (existingRows > 0) {
  notes.push(`kept ${existingRows} pre-existing patch row(s)${already ? ', replacing this plugin\'s own' : ''}`)
}

writeFileSync(PATCH, applyInsert(existing), 'utf8')
step(true, 'registered the plugin in the desktop profile patch')

/* -------------------------------------------------------------- verify ----- */

console.log('\nverifying')
step(existsSync(join(target, 'lib', 'client.js')), 'client bundle in place')
step(existsSync(join(target, 'lib', 'index.js')), 'host bundle in place')

const finalPatch = readFileSync(PATCH, 'utf8')
step(finalPatch.includes(PACKAGE), 'patch names the package')
step(finalPatch.includes('insert'), 'patch uses an insert row')

// Preserving the user's rows is the point of the append, so it is checked.
const preservedRows = finalPatch.split('\n').filter((line) => /^- id:/.test(line.trim())).length
if (preservedRows > 0) {
  notes.push(`kept ${preservedRows} pre-existing patch row(s) in place`)
}

// A package that loads but never registers produces no UI and no error, so
// registration is checked here rather than discovered in the app.
const clientText = readFileSync(join(target, 'lib', 'client.js'), 'utf8')
step(clientText.includes('__ModuleLoader__'), 'client bundle registers itself')
step(clientText.includes(PACKAGE), 'client bundle registers under the package name')
step(clientText.includes('handled'), 'the shortcut claims the keypress')
step(clientText.includes('.pick('), 'the shortcut starts a pick session')

/* --------------------------------------- clean up installs in other homes -- */

// A stale install in a home the app does not read would look like evidence that
// the plugin loaded, so it is removed rather than left behind. Only directories
// that are actual harness homes are swept — the Electron userData directory has
// no profiles tree and must not be touched.
for (const candidate of others) {
  if (!candidate.isHome) continue
  const stale = join(candidate.path, 'profiles', 'desktop', 'node_modules', PACKAGE)
  if (!existsSync(stale)) continue

  rmSync(stale, { recursive: true, force: true })

  const stalePatch = join(candidate.path, 'profiles', 'desktop', 'cordis.patch.yml')
  const staleBackup = `${stalePatch}.before-better-float`
  if (existsSync(stalePatch) && readFileSync(stalePatch, 'utf8').includes(PACKAGE)) {
    if (existsSync(staleBackup)) {
      // Restoring the backup is safer than rewriting, because the patch may hold
      // rows the user added after installing.
      copyFileSync(staleBackup, stalePatch)
      rmSync(staleBackup, { force: true })
    } else {
      writeFileSync(stalePatch, readFileSync(stalePatch, 'utf8')
        .split('\n')
        .filter((line) => !/better-float/u.test(line))
        .join('\n'), 'utf8')
    }
  }
  notes.push(`removed a stale install from ${candidate.path} (a home this build does not read)`)
}

/* -------------------------------------------------------------- report ----- */

console.log('')
if (notes.length > 0) {
  console.log('notes')
  for (const note of notes) console.log(`  - ${note}`)
  console.log('')
}

if (problems.length > 0) {
  console.log(`${problems.length} check(s) failed:`)
  for (const problem of problems) console.log(`  - ${problem}`)
  process.exit(1)
}

console.log(`installed successfully into ${PROFILE}\n`)
console.log('next: launch DSH Desktop, then press Ctrl+Shift+S (Cmd+Shift+S on macOS).')
