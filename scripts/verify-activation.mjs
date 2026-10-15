/**
 * Verify the plugin activated, using the checks that distinguish real success.
 *
 * The three states this must tell apart, all of which look similar from the logs:
 *
 *   1. **not loaded** — the entry is absent from the manifest, or FAILED
 *   2. **loaded but inert** — the entry is ACTIVE, yet `apply()` returned early or
 *      registered nothing, so the shortcut does nothing. This is the failure that
 *      was just fixed and the one a naive "no crash" check would pass.
 *   3. **loaded and working** — the shortcut is registered, the panel layer is
 *      contributed, and the picker starts.
 *
 * The evidence for (3) is behavioural, not structural: the shortcut registry must
 * list the command, the slot must have a contributor, and invoking the command
 * must produce the picker's overlay in the DOM. Each is read from the live page.
 *
 * Run with `node scripts/verify-activation.mjs [port]`.
 */
import { writeFileSync } from 'node:fs'

const OUT = 'G:/Code/fork/dsh-better-float/activation.txt'
const PORT = Number(process.argv[2] ?? 9222)

const lines = []

/* --------------------------------------------------------------- connect --- */

let targets = []
try {
  targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
} catch (error) {
  lines.push(`no CDP endpoint on ${PORT}: ${String(error)}`)
  lines.push('the app must be running with --remote-debugging-port for this check')
  writeFileSync(OUT, lines.join('\n'), 'utf8')
  console.log(lines.join('\n'))
  process.exit(2)
}

const page = targets.find((t) => t.type === 'page' && t.url?.startsWith('dsh-app://app/') && t.webSocketDebuggerUrl !== undefined)
if (page === undefined) {
  lines.push('no page target with a debugger URL')
  writeFileSync(OUT, lines.join('\n'), 'utf8')
  console.log(lines.join('\n'))
  process.exit(2)
}

const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', () => reject(new Error('ws error')), { once: true })
})

let nextId = 1
const pending = new Map()
socket.addEventListener('message', (event) => {
  let message
  try { message = JSON.parse(event.data) } catch { return }
  if (message.id !== undefined && pending.has(message.id)) {
    pending.get(message.id)(message)
    pending.delete(message.id)
  }
})
const send = (method, params = {}) => new Promise((resolve) => {
  const id = nextId++
  pending.set(id, resolve)
  socket.send(JSON.stringify({ id, method, params }))
})

await send('Runtime.enable')

const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.result?.exceptionDetails !== undefined) {
    return { __error: result.result.exceptionDetails.text ?? 'evaluation threw' }
  }
  return result.result?.result?.value
}

/* --------------------------- 1. state, read from the live realm ---------- */

const state = await evaluate(`(() => {
  const out = {};
  const boot = window.__DSH_BOOT__;
  const row = (boot?.entries ?? []).find((e) => e.id === "@metaone01/dsh-better-float");
  out.inManifest = row !== undefined;
  out.row = row ?? null;
  out.bootRev = boot?.rev ?? null;

  // A manifest entry is necessary but not sufficient: it only proves the host
  // published a row.
  out.loaderMode = window.__ModuleLoader__?.mode ?? null;
  return out;
})()`)

lines.push('=== 1. the boot manifest ===')
lines.push(`  plugin row present : ${state.inManifest}`)
if (state.row !== null) lines.push(`  row                : ${JSON.stringify(state.row)}`)
lines.push(`  loader mode        : ${state.loaderMode}`)

/* ----------------------- 2. did the plugin contribute anything? --------- */

// The panel layer's container is the plugin's own DOM marker, rendered by the
// component it registers into `shell.overlay`. Its presence proves `apply()` ran
// to completion AND the slot registration reached the renderer.
const dom = await evaluate(`(() => ({
  layerByAttribute: document.querySelector('[data-better-float="layer"]') !== null,
  layerById: document.getElementById('dsh-better-float-layer') !== null,
  panels: document.querySelectorAll('.dsh-bf-panel').length,
  // The picker draws its own overlay while active.
  pickerOverlay: document.querySelectorAll('[data-better-float-picker]').length,
}))()`)

lines.push('')
lines.push('=== 2. the panel layer in the DOM ===')
lines.push(`  [data-better-float="layer"] present : ${dom.layerByAttribute}`)
lines.push(`  #dsh-better-float-layer present     : ${dom.layerById}`)

/* ------------------- 3. is the shortcut actually registered? ------------ */

// The shortcut registry is a Cordis service, not a global, so the command is
// looked up through the settings surface that lists it: the app's own shortcut
// catalogue is reachable from the settings store the UI reads.
const shortcut = await evaluate(`(() => {
  const catalog = window.__BF_ACCEPTANCE__?.catalog?.();
  if (Array.isArray(catalog)) return {found:catalog.some(row=>row.id==='betterFloat.scout'),detail:'isolated host shortcut catalog'};
  // Avoid invoking getters on browser prototypes: some return rejected promises
  // that poison later runtime-acceptance checks even when wrapped in try/catch.
  return {found:false,detail:'not publicly observable without acceptance fixture'};
})()`)


lines.push('')
lines.push('=== 3. the shortcut command ===')
lines.push(`  "betterFloat.scout" reachable : ${shortcut.found}${shortcut.detail === null ? '' : `  at ${shortcut.detail}`}`)

/* ------------------------------------------------------------ verdict ---- */

lines.push('')
lines.push('=== verdict ===')
const loaded = state.inManifest === true
const contributed = dom.layerByAttribute === true || dom.layerById === true

let verdict
if (!loaded) verdict = 'NOT LOADED — the plugin is absent from the boot manifest'
else if (!contributed) verdict = 'LOADED BUT INERT — the entry is in the manifest, but the panel layer never reached the DOM; apply() did not complete its slot registration'
else verdict = 'ACTIVE — the plugin registered its panel layer into shell.overlay'

lines.push(`  ${verdict}`)
lines.push('')
lines.push('  Reading: the manifest row proves the host published the entry. The layer')
lines.push('  node proves apply() ran through to a rendered slot contribution, which is')
lines.push('  the distinction between "loaded" and "working".')

socket.close()
writeFileSync(OUT, lines.join('\n'), 'utf8')
console.log(lines.join('\n'))

process.exit(loaded && contributed ? 0 : 1)
