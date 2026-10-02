/**
 * Launch DSH Desktop with a real GUI, replacing any GUI-less instance.
 *
 * ## Why this is a script and not a one-line `Start-Process`
 *
 * Two things about this Electron build make a naive launch fail, both of them
 * silent — the app starts, runs, and shows nothing:
 *
 * 1. **Sandbox.** The build needs `--no-sandbox` on this machine. Without it the
 *    GPU/renderer handshake fails and no window is created.
 * 2. **Parent lifetime.** The window is torn down the moment the launching
 *    shell exits. A launch that returns immediately therefore produces a
 *    process tree that outlives its window — four processes, no UI. Holding the
 *    parent open for the lifetime of the window is what keeps the GUI alive.
 *
 * A previous launch hit case 2 and left exactly that: four live processes with
 * `MainWindowHandle=0`. So this script first reaps any instance without a window
 * (otherwise the new one collides on the single-instance lock and exits), then
 * launches and stays alive.
 *
 * Run with `node scripts/launch-dsh.mjs`.
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

const APP = 'G:/Deepseek Harness Desktop/DeepSeek Harness.exe'

if (!existsSync(APP)) {
  console.error(`not found: ${APP}`)
  process.exit(1)
}

/** Every running instance with its window handle, via one CIM query. */
function instances() {
  let raw
  try {
    raw = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-Process | Where-Object { $_.ProcessName -like "*DeepSeek*" } | ' +
          'ForEach-Object { "$($_.Id)|$($_.MainWindowHandle)" }',
      ],
      { encoding: 'utf8', windowsHide: true },
    )
  } catch {
    return []
  }
  return raw
    .trim()
    .split(/\r?\n/u)
    .filter((line) => /^\d+\|\d+$/u.test(line))
    .map((line) => {
      const [pid, handle] = line.split('|')
      return { pid: Number(pid), handle: Number(handle) }
    })
}

/* ---------------------------------------------------------- reap the dead --- */

const before = instances()
const windowed = before.filter((instance) => instance.handle !== 0)
const headless = before.filter((instance) => instance.handle === 0)

console.log('=== before ===')
console.log(`  running: ${before.length}   with a window: ${windowed.length}   without: ${headless.length}`)

if (headless.length > 0) {
  // Only the main process needs killing; Electron's children exit with it.
  const roots = [...new Set(headless.map((instance) => instance.pid))]
  console.log(`  killing window-less processes: ${roots.join(', ')}`)
  for (const pid of roots) {
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
    } catch { /* already gone */ }
  }
  // The single-instance lock is released asynchronously.
  await new Promise((resolve) => setTimeout(resolve, 2500))
  console.log(`  after reap: ${instances().length} running`)
}

if (windowed.length > 0) {
  console.log('\nthe app already has a window; leaving it alone')
  process.exit(0)
}

/* ------------------------------------------------------------- launch it --- */

console.log('\n=== launching ===')
const child = spawn(APP, ['--no-sandbox'], {
  detached: false,
  stdio: 'ignore',
  // Strip ELECTRON_RUN_AS_NODE: with it set, Electron runs as plain Node and
  // never creates a window at all.
  env: Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key !== 'ELECTRON_RUN_AS_NODE'),
  ),
})

console.log(`  pid ${child.pid}`)

// Wait for a window to appear. A process count is not evidence of a GUI —
// that is precisely the state this script exists to fix.
let alive = null
for (let attempt = 0; attempt < 40; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 1000))
  const seen = instances()
  alive = seen.find((instance) => instance.handle !== 0)
  if (alive !== undefined) break
  if (seen.length === 0) break
}

const final = instances()
console.log('\n=== after ===')
console.log(`  running: ${final.length}   with a window: ${final.filter((i) => i.handle !== 0).length}`)

if (alive === undefined) {
  console.error('\nno window appeared — the GUI did not come up')
  process.exit(1)
}

console.log(`  window on pid ${alive.pid}`)
console.log('\nthe app is up. press Ctrl+Shift+S to test the picker.')

// Hold the parent open: the window dies with the launching shell, so returning
// here would undo the launch. SIGINT lets Ctrl+C stop the wait without killing
// the app, since the app is a sibling rather than a child of this script.
await new Promise((resolve) => {
  process.on('SIGINT', resolve)
  process.on('SIGTERM', resolve)
})

console.log('\ndetached; the app keeps running')
