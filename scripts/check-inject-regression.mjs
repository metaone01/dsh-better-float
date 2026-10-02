/**
 * Regression test: the inject checks must fail on the shape that was broken.
 *
 * A check that passes on the good artifact proves nothing unless it also fails on
 * the bad one. The bug being guarded is subtle — a bundle that registers
 * correctly, exports `apply`, and loads cleanly, but never declares the services
 * it reads off `ctx` — so the check's value is entirely in its negative case.
 *
 * Two independent breakages are exercised, one per half of the contract:
 *
 *   1. the bundle's `inject` array is emptied (the export is gone)
 *   2. the manifest's `dsh.client.inject` is removed (the host loses its ordering)
 *
 * Each is asserted to produce a failure, then the good artifacts are restored and
 * re-verified, so a run of this script cannot leave the tree broken.
 *
 * Run with `node scripts/check-inject-regression.mjs`.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const BUNDLE = 'lib/client.js'
const MANIFEST = 'package.json'
const NODE = process.execPath

const lines = []

function runCheck() {
  try {
    return { ok: true, output: execFileSync(NODE, ['./scripts/check-bundle-shape.mjs'], { encoding: 'utf8' }) }
  } catch (error) {
    return { ok: false, output: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

const goodBundle = readFileSync(BUNDLE, 'utf8')
const goodManifest = readFileSync(MANIFEST, 'utf8')

const restore = () => {
  writeFileSync(BUNDLE, goodBundle, 'utf8')
  writeFileSync(MANIFEST, goodManifest, 'utf8')
}

/* -------------------------------------------------- baseline must pass ---- */

lines.push('=== baseline ===')
{
  const result = runCheck()
  lines.push(`  ${result.ok ? 'PASS' : 'FAIL'}  (expect PASS)`)
  if (!result.ok) lines.push(result.output.split('\n').slice(-6).join('\n'))
}

/* --------------------------- break the bundle's inject export ------------- */

lines.push('')
lines.push("=== break 1: empty the bundle's `inject` array ===")
{
  const broken = goodBundle.replace('var inject = ["slots", "shortcuts"];', 'var inject = [];')
  if (broken === goodBundle) {
    lines.push('  could not locate the inject array — the emitted form changed;')
    lines.push('  update the pattern in this script rather than trusting a silent no-op.')
  } else {
    writeFileSync(BUNDLE, broken, 'utf8')
    const result = runCheck()
    const relevant = result.output.split('\n').filter((l) => l.includes('FAIL') || l.includes('checks'))
    lines.push(`  ${result.ok ? 'WRONG — still passed' : 'correctly FAILED'}  (expect FAIL)`)
    for (const line of relevant) lines.push(`    ${line.trim()}`)
  }
  restore()
}

/* ------------------- break the manifest's dsh.client.inject -------------- */

lines.push('')
lines.push('=== break 2: remove `dsh.client.inject` from the manifest ===')
{
  const parsed = JSON.parse(goodManifest)
  delete parsed.dsh.client.inject
  writeFileSync(MANIFEST, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8')
  const result = runCheck()
  const relevant = result.output.split('\n').filter((l) => l.includes('FAIL') || l.includes('checks'))
  lines.push(`  ${result.ok ? 'WRONG — still passed' : 'correctly FAILED'}  (expect FAIL)`)
  for (const line of relevant) lines.push(`    ${line.trim()}`)
  restore()
}

/* ---------------------------------------------------- restored state ------ */

lines.push('')
lines.push('=== restored ===')
{
  const result = runCheck()
  lines.push(`  ${result.ok ? 'PASS' : 'FAIL'}  (expect PASS)`)
  if (!result.ok) lines.push(result.output.split('\n').slice(-6).join('\n'))
  const stillBroken = readFileSync(BUNDLE, 'utf8') !== goodBundle
    || readFileSync(MANIFEST, 'utf8') !== goodManifest
  lines.push(`  tree restored exactly: ${!stillBroken}`)
}

console.log(lines.join('\n'))
