/**
 * Confirm better-float is live in the running app.
 *
 * The app serves a local HTTP endpoint whose page carries `window.__DSH_BOOT__`,
 * the boot manifest the client module system builds from the Loader's
 * `dsh.client` scan. If the plugin is named in that manifest it loaded, which is
 * stronger evidence than the absence of a crash — and the crash path is checked
 * too, because a failed entry is reported there rather than in the manifest.
 *
 * Run with `node scripts/probe-running-app.mjs`.
 */
import { execSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const PACKAGE = 'dsh-better-float'
const LOG_DIR = 'C:/Users/metaone/AppData/Roaming/@deepseek-ai/dsh-desktop/logs'

/* ---------------------------------------------- is the app up, and where? --- */

let pids = []
try {
  const out = execSync('tasklist /FI "IMAGENAME eq DeepSeek Harness.exe" /FO CSV /NH', {
    encoding: 'utf8',
    windowsHide: true,
  })
  pids = out.trim().split('\n')
    .map((line) => line.split('","')[1]?.replace(/"/gu, ''))
    .filter((pid) => /^\d+$/u.test(pid ?? ''))
} catch { /* not running */ }

console.log(`=== app ===\n  processes: ${pids.length}`)
if (pids.length === 0) {
  console.log('  the app is not running; start it first')
  process.exit(1)
}

let ports = []
try {
  const netstat = execSync('netstat -ano -p tcp', { encoding: 'utf8', windowsHide: true })
  for (const line of netstat.split('\n')) {
    if (!/LISTENING/u.test(line)) continue
    const cols = line.trim().split(/\s+/u)
    if (!pids.includes(cols[4] ?? '')) continue
    const port = (cols[1] ?? '').split(':').pop()
    if (port !== undefined && /^\d+$/u.test(port)) ports.push(port)
  }
} catch { /* no sockets */ }

console.log(`  listening: ${ports.length === 0 ? 'none found' : ports.map((p) => `127.0.0.1:${p}`).join(', ')}`)

/* --------------------------------------------------------- crash reports ---- */

const crashes = existsSync(LOG_DIR)
  ? readdirSync(LOG_DIR)
    .filter((name) => name.endsWith('.log'))
    .map((name) => ({ name, mtime: statSync(join(LOG_DIR, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  : []

console.log('\n=== crash reports (newest first) ===')
if (crashes.length === 0) console.log('  none')
for (const crash of crashes.slice(0, 4)) {
  console.log(`  ${crash.name}  (${Math.round((Date.now() - crash.mtime) / 1000)}s ago)`)
}

// A report written since this launch means the entry still fails; one that
// predates it only tells us about the previous build.
const newest = crashes[0]
const freshCrash = newest !== undefined && Date.now() - newest.mtime < 300_000
if (freshCrash) {
  console.log('\n  a crash report was written recently:')
  console.log(readFileSync(join(LOG_DIR, newest.name), 'utf8'))
}

/* --------------------------------------- is the plugin in the boot manifest? -- */

/** The launch token, as the app records it in its own log. */
function launchToken() {
  if (!existsSync(LOG_DIR)) return null
  for (const name of readdirSync(LOG_DIR)) {
    if (!name.endsWith('.log') || name.startsWith('crash-')) continue
    const match = /token=([A-Za-z0-9_-]+)/u.exec(readFileSync(join(LOG_DIR, name), 'utf8'))
    if (match !== null) return match[1]
  }
  return null
}

const token = launchToken()

console.log('\n=== the boot manifest ===')
let confirmed = false
for (const port of ports) {
  for (const suffix of [token === null ? '' : `/?token=${token}`, '/']) {
    const url = `http://127.0.0.1:${port}${suffix}`
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 6000)
      const res = await fetch(url, { signal: controller.signal })
      clearTimeout(timer)
      const body = await res.text()
      const inManifest = body.includes(`"${PACKAGE}"`)
      console.log(`  ${res.status}  ${url.replace(token ?? '@@', 'TOKEN')}`)
      console.log(`      page ${body.length} B; carries __DSH_BOOT__: ${body.includes('__DSH_BOOT__')}`)
      console.log(`      manifest names ${PACKAGE}: ${inManifest}`)
      if (inManifest) confirmed = true
      break
    } catch (error) {
      console.log(`  --  ${url.replace(token ?? '@@', 'TOKEN')}  (${String(error).slice(0, 70)})`)
    }
  }
  if (confirmed) break
}

/* ----------------------------------------------- the plugin's served bundle -- */

if (confirmed) {
  console.log('\n=== the plugin bundle the app is serving ===')
  for (const port of ports) {
    const url = `http://127.0.0.1:${port}/plugins/${PACKAGE}/client.js`
    try {
      const res = await fetch(url)
      const body = await res.text()
      console.log(`  ${res.status}  ${body.length} B`)
      console.log(`      factory takes require      : ${/factory:\s*\(\s*require\s*\)/u.test(body)}`)
      console.log(`      no dynamic-require failure : ${!/Dynamic require of/u.test(body)}`)
      console.log(`      registers into shell.overlay: ${body.includes('shell.overlay')}`)
    } catch (error) {
      console.log(`  --  ${String(error).slice(0, 70)}`)
    }
  }
}

console.log(`\n${confirmed
  ? `${PACKAGE} IS in the boot manifest — the plugin loaded`
  : `could not confirm from the manifest; use the DOM checks in TESTING-IN-DSH.md §4`}`)
process.exit(confirmed && !freshCrash ? 0 : 1)
