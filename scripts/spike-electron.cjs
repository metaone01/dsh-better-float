/**
 * Spike runner: an Electron window that answers the plan's blocking questions.
 *
 * Launch with `npm run spike`. The automatable spikes run themselves as soon as
 * the page loads, and their findings are written to `spikes/report.json` and
 * printed here. S0 is the only one that needs a person, because it measures what
 * the engine reports after the cursor leaves the window; it arms itself and says
 * so on screen. Press Ctrl/Cmd+S in the window to save at any point, or close it
 * to save and exit.
 *
 * CommonJS, launched through `scripts/run-electron.mjs` so that the
 * `ELECTRON_RUN_AS_NODE` variable cannot silently degrade this into a plain Node
 * run — which is exactly what happened on the first attempt.
 */
const { app, BrowserWindow } = require('electron')
const { writeFile } = require('node:fs/promises')
const { join } = require('node:path')

const page = join(__dirname, '..', 'spikes', 'bench.html')
const report = join(__dirname, '..', 'spikes', 'report.json')

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1120,
    height: 840,
    show: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  })

  // Surface the bench's own progress lines, so the terminal shows what happened.
  window.webContents.on('console-message', (_event, _level, message) => {
    if (typeof message === 'string' && message.startsWith('[spike]')) {
      process.stdout.write(`${message}\n`)
    }
  })

  await window.loadFile(page)

  /**
   * Read the findings the bench has collected.
   * @returns the parsed results, or null when the page is not ready.
   */
  const collect = async () => {
    try {
      const raw = await window.webContents.executeJavaScript(
        'JSON.stringify(window.__spikeResults ?? null)',
        true,
      )
      return JSON.parse(raw)
    } catch {
      return null
    }
  }

  /**
   * Write the report and print a compact summary.
   *
   * The summary is the point: a reader should be able to tell what the design
   * should do next without opening the JSON.
   */
  const save = async () => {
    const results = await collect()
    if (results === null || Object.keys(results).length === 0) {
      process.stdout.write('\n[spike] no findings yet.\n')
      return
    }

    await writeFile(report, `${JSON.stringify(results, null, 2)}\n`, 'utf8')

    process.stdout.write('\n[spike] summary\n')
    for (const [id, finding] of Object.entries(results)) {
      const value = finding ?? {}
      const mark = value.verdict === 'pass' ? 'PASS'
        : value.verdict === 'fail' ? 'FAIL'
          : value.verdict === 'partial' ? 'PART'
            : '—'
      const detail = value.preserved ?? value.operationsClean ?? value.reproduced ?? ''
      process.stdout.write(`  ${mark.padEnd(5)} ${id.padEnd(26)} ${detail}\n`)
    }

    process.stdout.write(`\n[spike] full report: ${report}\n`)

    // The two conclusions that change what gets implemented next.
    const s2 = results.S2_moveBeforeState
    if (s2 !== undefined) {
      process.stdout.write(
        s2.verdict === 'pass'
          ? '\n  S2: moveBefore preserves all four state kinds — Tier 0 can be the default path.\n'
          : `\n  S2: only ${s2.preserved} preserved — see the report for which state is lost,\n`
            + '      and weight that against the clone path it would replace.\n',
      )
    }
    const s0 = results.S0_pointerPastEdge
    if (s0 !== undefined) {
      process.stdout.write(
        s0.exactPlacementViable
          ? '  S0: out-of-window coordinates are delivered — exact window placement is possible.\n'
          : '  S0: no outside coordinates — detaching must arm an edge band (already implemented).\n',
      )
    }
  }

  // Wait for the bench to finish its automatic runs, then report once.
  let settled = false
  const waitForCompletion = setInterval(async () => {
    if (settled) return
    try {
      const done = await window.webContents.executeJavaScript(
        'window.__spikeComplete === true',
        true,
      )
      if (done === true) {
        settled = true
        clearInterval(waitForCompletion)
        await save()
        // The window stays open so S0 can still be performed by hand. The
        // process is kept alive deliberately; closing the window ends it.
      }
    } catch {
      // Mid-load; try again on the next tick.
    }
  }, 500)

  window.webContents.on('before-input-event', async (_event, input) => {
    const isSave = input.type === 'keyDown'
      && input.key.toLowerCase() === 's'
      && (input.control || input.meta)
    if (isSave) await save()
  })

  window.on('closed', async () => {
    clearInterval(waitForCompletion)
    await save()
    app.exit(0)
  })
}).catch((error) => {
  process.stderr.write(`spike runner failed: ${String(error)}\n`)
  app.exit(1)
})
