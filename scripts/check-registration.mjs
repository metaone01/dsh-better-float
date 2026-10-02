/**
 * Check that the client bundle registers under the package name.
 *
 * The harness indexes a plugin's browser half by package name, so if the bundle
 * registers under a different id the host looks for `dsh-better-float`, finds
 * nothing, and the plugin loads without ever running. That failure is silent —
 * no error, no UI — which is exactly why it needs a check rather than an
 * assumption.
 */
import { readFileSync } from 'node:fs'

const text = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

const callIndex = text.indexOf('__ModuleLoader__.load')
console.log('=== the registration call ===')
console.log(text.slice(callIndex, callIndex + 170))

console.log('\n=== every string literal id in the bundle ===')
const ids = []
const pattern = /\bid:\s*(['"])(.*?)\1/gu
let match
while ((match = pattern.exec(text)) !== null) {
  ids.push({ value: match[2], at: match.index })
}
for (const id of ids) {
  // Position tells the two apart: the registration is the last one, after the
  // implementation has been defined.
  const role = id.at > callIndex ? 'REGISTRATION' : 'shortcut command'
  console.log(`  ${role.padEnd(17)} ${id.value}`)
}

const registration = ids.filter((id) => id.at > callIndex).map((id) => id.value)
const expected = 'dsh-better-float'

console.log('\n=== verdict ===')
console.log(`  registers as:  ${registration.join(', ') || '(nothing found)'}`)
console.log(`  expected:      ${expected}`)
const ok = registration.length === 1 && registration[0] === expected
console.log(`  matches:       ${ok}`)
if (!ok) {
  console.log('\n  The host indexes the browser half by package name. A mismatch means')
  console.log('  the plugin loads but never runs, with no error to explain why.')
  process.exit(1)
}
