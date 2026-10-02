/**
 * Relaunch the app with a remote debugging port, for diagnosis only.
 *
 * The app's renderer cannot be inspected from outside without
 * `--remote-debugging-port`, and every log-based conclusion so far has been an
 * inference. With the port open, the client module system's own state and the
 * real exception object become readable, which replaces inference with evidence.
 *
 * `--remote-debugging-port` binds to loopback only, so this does not widen
 * exposure beyond the local machine. The flag is diagnostic: a normal launch
 * should not carry it.
 *
 * Run with `node scripts/relaunch-debuggable.mjs [port]`.
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'

const APP = 'G:/Deepseek Harness Desktop/DeepSeek Harness.exe'
const PORT = Number(process.argv[2] ?? 9222)
const OUT = 'G:/Code/fork/dsh-better-float/relaunch.txt'

if (!existsSync(APP)) {
  console.error(`not found: ${APP}`)
  process.exit(1)
}

const lines = []

/** Running instances with their window handles. */
function instances() {
  let raw
  try {
    raw = execFileSync('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      'Get-Process | Where-Object { $_.ProcessName -like "*DeepSeek*" } | ' +
        'ForEach-Object { "$($_.Id)|$($_.MainWindowHandle)" }',
    ], { encoding: 'utf8', windowsHide: true })
  } catch { return [] }
  return raw.trim().split(/\r?\n/u)
    .filter((l) => /^\d+\|\d+$/u.test(l))
    .map((l) => { const [pid, h] = l.split('|'); return { pid: Number(pid), handle: Number(h) } })
}

const before = instances()
lines.push(`=== before: ${before.length} process(es) ===`)

// Only window-less processes are reaped, and only the roots; Electron's helpers
// exit with the main process. A short settle lets the instance lock clear.
const roots = [...new Set(before.filter((i) => i.handle === 0).map((i) => i.pid))]
if (roots.length > 0) {
  lines.push(`  killing window-less: ${roots.join(', ')}`)
  for (const pid of roots) {
    try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }) } catch {}
  }
  await new Promise((r) => setTimeout(r, 2500))
  lines.push(`  after reap: ${instances().length} running`)
}

if (instances().some((i) => i.handle !== 0)) {
  lines.push('  a window is already open; refusing to disturb it')
  writeFileSync(OUT, lines.join('\n'), 'utf8')
  console.log(lines.join('\n'))
  process.exit(0)
}

lines.push('')
lines.push(`=== launching with --remote-debugging-port=${PORT} ===`)
const child = spawn(APP, ['--no-sandbox', `--remote-debugging-port=${PORT}`], {
  detached: false,
  stdio: 'ignore',
  env: Object.fromEntries(
    Object.entries(process.env).filter(([k]) => k !== 'ELECTRON_RUN_AS_NODE'),
  ),
})
lines.push(`  pid ${child.pid}`)

let windowed = null
for (let attempt = 0; attempt < 45; attempt += 1) {
  await new Promise((r) => setTimeout(r, 1000))
  windowed = instances().find((i) => i.handle !== 0)
  if (windowed !== undefined) break
}

lines.push(`  window after wait: ${windowed === undefined ? 'none' : `pid ${windowed.pid}`}`)

// Confirm the debugging endpoint answers before handing back.
let cdpOk = false
for (let attempt = 0; attempt < 10; attempt += 1) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/version`)
    if (res.ok) { lines.push(`  CDP responsive: ${JSON.stringify(await res.json()).slice(0, 200)}`); cdpOk = true; break }
  } catch { /* not up yet */ }
  await new Promise((r) => setTimeout(r, 1000))
}
if (!cdpOk) lines.push('  CDP did not respond')

writeFileSync(OUT, lines.join('\n'), 'utf8')
console.log(lines.join('\n'))

// Hold the parent: the window dies with the launching shell.
await new Promise((resolve) => {
  process.on('SIGINT', resolve)
  process.on('SIGTERM', resolve)
})
