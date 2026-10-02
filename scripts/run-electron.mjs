/**
 * Launch a spike under Electron with a clean environment.
 *
 * ## Why this exists
 *
 * This machine has `ELECTRON_RUN_AS_NODE=1` set in the environment. Electron
 * honours that variable by degrading into a plain Node process: it never loads
 * its own main-process module, `require('electron')` returns an empty object,
 * and `electron --version` reports the bundled Node's version instead of
 * Electron's. The symptom is a confusing `TypeError: Cannot read properties of
 * undefined (reading 'whenReady')` from a script that is correct.
 *
 * Rather than requiring every developer to remember to unset it, the launcher
 * removes it for the child process and reports what Electron it found. That also
 * means the same command works on a machine that does not set it at all.
 *
 * Usage: `npm run spike` / `npm run spike:versions`
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

/** The Electron binary, resolved from the installed package. */
const binary = join(root, 'node_modules', 'electron', 'dist', 'electron.exe')

if (!existsSync(binary)) {
  process.stderr.write(
    'Electron is not installed. Run:\n'
    + '  npm install\n'
    + '  node node_modules/electron/install.js\n',
  )
  process.exit(1)
}

const script = process.argv[2]
if (script === undefined) {
  process.stderr.write('Usage: node scripts/run-electron.mjs <script>\n')
  process.exit(1)
}

// Strip the variable that would silently turn this into a Node run, and report
// it, because a silent difference between what was asked for and what ran is
// exactly the kind of thing that costs an afternoon.
const env = { ...process.env }
const hadRunAsNode = env.ELECTRON_RUN_AS_NODE !== undefined
delete env.ELECTRON_RUN_AS_NODE

if (hadRunAsNode) {
  process.stdout.write(
    '[run-electron] removed ELECTRON_RUN_AS_NODE=1 — without this, Electron runs as plain Node\n'
    + '              and its main-process module is unavailable.\n',
  )
}

/**
 * Flags that keep the probe working in a restricted or virtualised environment.
 *
 * Without a usable GPU the compositor process exits immediately and `loadURL`
 * fails with `ERR_FAILED`, which looks like a script bug. Software rendering
 * produces the same layout and style results, which is all these spikes measure,
 * so the only thing given up is paint timing.
 */
const flags = [
  '--disable-gpu',
  '--disable-gpu-compositing',
  '--disable-software-rasterizer',
  '--no-sandbox',
  '--disable-dev-shm-usage',
  // Keeps the GPU cache out of a directory another Electron may be holding.
  '--disable-gpu-shader-disk-cache',
]

const child = spawn(binary, [...flags, script], { stdio: 'inherit', env })
child.on('exit', (code) => process.exit(code ?? 0))
