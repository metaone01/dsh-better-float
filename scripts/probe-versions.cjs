/**
 * Report the runtime versions the design depends on.
 *
 * CommonJS on purpose: `require('electron')` is the form that resolves in
 * Electron's main process, and it matches how the harness's own desktop app is
 * written. Launch through `scripts/run-electron.mjs`, which also removes the
 * `ELECTRON_RUN_AS_NODE` variable that would otherwise silently degrade this
 * into a plain Node run.
 *
 * Two facts here are load-bearing and both are version-gated: `moveBefore` needs
 * Chromium 133+, and `adoptNode` is what every cross-document move depends on.
 * The package version is not trusted — it disagreed with the shipped binary
 * during development — so the engine is asked directly.
 */
const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')

/**
 * A local file rather than a `data:` URL.
 *
 * A `data:` URL is a distinct origin with its own restrictions, and it failed
 * outright on the first run in a limited environment. A `file://` document
 * gives the probe the same origin semantics as the real deployment, so what it
 * reports is what the plugin will actually get.
 */
const BLANK = join(__dirname, '..', 'spikes', 'blank.html')

/** Expressions evaluated inside the page, in order. */
const PROBE = [
  'navigator.userAgent',
  '(navigator.userAgent.match(/Chrome\\/(\\d+)/) || [])[1]',
  "typeof Element.prototype.moveBefore === 'function'",
  "typeof Document.prototype.adoptNode === 'function'",
  "'documentPictureInPicture' in window",
  "typeof BroadcastChannel === 'function'",
  "Object.prototype.hasOwnProperty.call(HTMLElement.prototype, 'popover')",
  "'highlight' in CSS",
  "typeof CSSStyleSheet === 'function' && 'replaceSync' in CSSStyleSheet.prototype",
  "'adoptedStyleSheets' in Document.prototype",
  "CSS.supports('container-type', 'inline-size')",
  "CSS.supports('selector(:has(*))')",
  'window.devicePixelRatio',
]

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 400, height: 300 })
  await window.loadFile(BLANK)

  const values = await window.webContents.executeJavaScript(`[${PROBE.join(',')}]`, true)
  const [
    userAgent, chromium, hasMoveBefore, hasAdoptNode, hasDocumentPiP,
    hasBroadcastChannel, hasPopover, hasHighlight, hasStyleSheet,
    hasAdoptedStyleSheets, hasContainerQueries, hasHas, dpr,
  ] = values

  const capabilities = {
    moveBefore: hasMoveBefore
      ? `available (Chromium ${chromium} >= 133) — Tier 0 can preserve state`
      : `MISSING — Chromium ${chromium} predates 133`,
    adoptNode: hasAdoptNode ? 'available' : 'MISSING — cross-document move impossible',
    documentPictureInPicture: hasDocumentPiP ? 'available (browser fallback backend)' : 'absent',
    broadcastChannel: hasBroadcastChannel ? 'available' : 'MISSING — cross-window sync impossible',
    popover: hasPopover ? 'supported' : 'absent',
    highlightApi: hasHighlight ? 'supported' : 'absent',
    constructedStyleSheets: hasStyleSheet && hasAdoptedStyleSheets
      ? 'supported — shareable across same-origin documents'
      : 'absent',
    containerQueries: hasContainerQueries ? 'supported' : 'unsupported',
    hasSelector: hasHas ? 'supported' : 'unsupported',
  }

  process.stdout.write('\nbetter-float runtime probe\n\n')
  process.stdout.write(`electron          ${process.versions.electron}\n`)
  process.stdout.write(`chromium          ${chromium ?? 'unknown'}\n`)
  process.stdout.write(`node              ${process.versions.node}\n`)
  process.stdout.write(`devicePixelRatio  ${dpr}\n\n`)

  process.stdout.write('capabilities\n')
  for (const [name, value] of Object.entries(capabilities)) {
    process.stdout.write(`  ${name.padEnd(26)} ${value}\n`)
  }

  process.stdout.write('\nconclusion\n')
  if (hasMoveBefore) {
    process.stdout.write(
      '  moveBefore is available, so Tier 0 (the live move) can be the default\n'
      + '  extraction path: iframe, focus, animation and popover state survive.\n',
    )
  } else {
    process.stdout.write(
      `  moveBefore is MISSING at Chromium ${chromium}. Tier 0 must degrade to\n`
      + '  adoptNode + insertBefore, which resets iframes, focus and animations.\n',
    )
  }

  app.exit(0)
}).catch((error) => {
  process.stderr.write(`probe failed: ${String(error)}\n`)
  app.exit(1)
})
