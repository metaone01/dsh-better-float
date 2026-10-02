/**
 * Verify the install from the outside.
 *
 * Trust but verify: an installer that reports success is not evidence that the
 * files are where the app looks for them. Both mistakes made while building this
 * — wrong profile, wrong home — passed every check the installer itself ran,
 * because the installer was checking its own assumptions. This reads the shipped
 * shell for the answers instead.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { candidateHomes, describeHome, resolveHarnessHome } from './harness-home.mjs'

const PACKAGE = 'dsh-better-float'

/* ------------------------------------------- what the shell says it boots -- */

/** Read a file from inside the app archive, or null. */
function readFromAsar(asarPath, innerPath) {
  if (!existsSync(asarPath)) return null
  const buf = readFileSync(asarPath)
  const headerSize = buf.readUInt32LE(12)
  const header = JSON.parse(buf.subarray(16, 16 + headerSize).toString('utf8'))
  const dataOffset = 16 + headerSize
  let node = header
  for (const segment of innerPath.split('/').filter(Boolean)) {
    node = node?.files?.[segment]
    if (node === undefined) return null
  }
  if (node === null || node.files !== undefined) return null
  const offset = Number(node.offset)
  return buf.subarray(dataOffset + offset, dataOffset + offset + node.size).toString('utf8')
}

const ASAR = 'G:/Deepseek Harness Desktop/resources/app.asar'
const shell = readFromAsar(ASAR, 'lib/main.js')

let bootedProfile = null
let setsDshHome = null
if (shell !== null) {
  bootedProfile = /join\(dshHome,\s*"profiles",\s*"([^"]+)"\)/u.exec(shell)?.[1] ?? null
  // The home the shell resolves to depends on whether it overrides DSH_HOME for
  // the harness child. It does not, which is why `~/.dsh` wins over AppData.
  setsDshHome = /DSH_HOME\s*[:=]\s*(?!")/u.test(shell)
}

/* ---------------------------------------------------------- the resolution -- */

const resolved = resolveHarnessHome()
const HOME = resolved.home
const PROFILE = join(HOME, 'profiles', bootedProfile ?? 'desktop')
const TARGET = join(PROFILE, 'node_modules', PACKAGE)

console.log('=== what the app reads ===')
console.log(`  shell boots profile   : ${bootedProfile ?? 'unknown'}`)
console.log(`  shell overrides DSH_HOME: ${setsDshHome === null ? 'unknown' : setsDshHome}`)
console.log(`  harness home resolved : ${HOME}`)
console.log(`    (from ${resolved.source})`)

console.log('\n=== installed package ===')
if (!existsSync(TARGET)) {
  console.log(`  NOT FOUND at ${TARGET}`)
  console.log('')
  console.log('  Candidate homes on this machine:')
  for (const home of candidateHomes()) {
    const info = describeHome(home)
    const plugin = join(home, 'profiles', bootedProfile ?? 'desktop', 'node_modules', PACKAGE)
    console.log(`    ${home}`)
    console.log(`      profiles/ present: ${info.hasProfiles}   plugin installed here: ${existsSync(plugin)}`)
  }
  process.exit(1)
}

const walk = (dir, depth = 0) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const size = entry.isFile() ? `${statSync(join(dir, entry.name)).size} B` : ''
    console.log(`  ${'  '.repeat(depth)}${entry.name}${entry.isDirectory() ? '/' : ''}  ${size}`)
    if (entry.isDirectory()) walk(join(dir, entry.name), depth + 1)
  }
}
walk(TARGET)

console.log('\n=== package.json as the harness reads it ===')
const manifest = JSON.parse(readFileSync(join(TARGET, 'package.json'), 'utf8'))
console.log(JSON.stringify(manifest, null, 2))
console.log(`\n  dsh.client.platform: ${manifest.dsh?.client?.platform ?? 'MISSING — the client half will not load'}`)

// The manifest's `inject` must survive installation. The host orders the boot
// graph from this file before any bundle runs, so a list that is dropped here
// cannot be recovered by the bundle's own export — the plugin loads and then
// silently does nothing.
const manifestInject = manifest.dsh?.client?.inject
console.log(`  dsh.client.inject  : ${Array.isArray(manifestInject) ? manifestInject.join(', ') : 'MISSING — the host will not supply any service, and apply() will throw'}`)

console.log('\n=== module registration in the client bundle ===')
const client = readFileSync(join(TARGET, 'lib', 'client.js'), 'utf8')
console.log(`  registers with the loader : ${client.includes('window.__ModuleLoader__.load')}`)
// The registration id is the one passed to `load`, which is emitted at the end
// of the bundle. Matching the first `id:` picks up the shortcut command id,
// which is deliberately a different name.
const loadIndex = client.indexOf('__ModuleLoader__.load')
const afterLoad = client.slice(loadIndex)
const registrationId = /\bid:\s*['"]([^'"]+)['"]/u.exec(afterLoad)?.[1] ?? null
console.log(`  registration id          : ${registrationId ?? 'not found'}`)
console.log(`  id matches the package   : ${registrationId === manifest.name}`)
console.log(`  exports apply()          : ${/function apply\(/u.test(client)}`)

console.log('\n=== the wiring that makes the shortcut do something ===')
// Each of these is a failure mode that loads cleanly and then does nothing.
console.log(`  shortcut resolution is 'handled' : ${/status:\s*["']handled["']/u.test(client)}`)
console.log(`  calls .pick()                    : ${/\.pick\(/u.test(client)}`)
console.log(`  registers into shell.overlay     : ${client.includes('shell.overlay')}`)

console.log('\n=== the profile patch (this is what activates it) ===')
console.log(readFileSync(join(PROFILE, 'cordis.patch.yml'), 'utf8'))

console.log('=== resolution check ===')
const candidate = join(PROFILE, 'node_modules', PACKAGE, 'package.json')
console.log(`  resolvable from the profile: ${existsSync(candidate)}`)
console.log(`  path: ${candidate}`)

console.log('\n=== installs in other homes (these are NOT read) ===')
let stale = 0
for (const home of candidateHomes()) {
  if (home === HOME) continue
  const plugin = join(home, 'profiles', bootedProfile ?? 'desktop', 'node_modules', PACKAGE)
  if (existsSync(plugin)) {
    console.log(`  STALE: ${plugin}`)
    stale += 1
  }
}
if (stale === 0) console.log('  none')

console.log('\n=== backup of the previous patch ===')
const backup = join(PROFILE, 'cordis.patch.yml.before-better-float')
console.log(`  ${existsSync(backup) ? 'present' : 'ABSENT'}  ${backup}`)
