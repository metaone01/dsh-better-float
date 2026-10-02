/**
 * Establish the correct interop form for `require("react")`.
 *
 * The shell binds the seed word `react` to a *synthetic namespace* built by a
 * rolldown helper: `rs({__proto__: null, default: pf}, [j])`. That object has a
 * `default` property holding the real React, and the React API members are added
 * non-enumerably (the `[j]` second argument to the helper). Whether
 * `require("react").createElement` resolves therefore depends entirely on the
 * helper's definition — which is the one fact still unverified, and the one that
 * decides whether `require("react")` may be used directly or must go through an
 * interop step first.
 *
 * This reads the helper `rs` out of the shell bundle and reports exactly what it
 * produces, then checks how the *official* plugins written against the same seed
 * access React — because matching their pattern is the safe form by construction.
 *
 * Run with `node scripts/read-interop-helper.mjs`.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const ASAR = 'G:/Deepseek Harness Desktop/resources/app.asar'
const SHELL = 'dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/index-CTOadNHm.js'
const OUT = 'G:/Code/fork/dsh-better-float/interop.txt'

const buf = readFileSync(ASAR)
const headerSize = buf.readUInt32LE(12)
const header = JSON.parse(buf.subarray(16, 16 + headerSize).toString('utf8'))
const dataOffset = 16 + headerSize

function readInner(innerPath) {
  let node = header
  for (const segment of innerPath.split('/').filter(Boolean)) {
    node = node?.files?.[segment]
    if (node === undefined) return null
  }
  if (node === null || node.files !== undefined) return null
  return buf.subarray(dataOffset + Number(node.offset), dataOffset + Number(node.offset) + node.size)
}

const shell = readInner(SHELL).toString('utf8')
const lines = ['=== the interop helper `rs` in the shell ===']

// `rs` is called as rs({__proto__:null,default:pf},[j]) — find its definition.
const def = /function\s+rs\s*\(/u.exec(shell) ?? /(?:const|var|let)\s+rs\s*=\s*(?:function\s*)?\(/u.exec(shell)
lines.push(`definition at ${def?.index ?? -1}`)
if (def !== null) lines.push(shell.slice(def.index, def.index + 900))

/* --------------------- how official plugins use the seed words ------------- */

const OFFICIAL = [
  'dsh/node_modules/@deepseek-ai/dsh-client-locale/lib/client.js',
  'dsh/node_modules/@deepseek-ai/dsh-client-ui-layout/lib/client.js',
  'dsh/node_modules/@deepseek-ai/dsh-client-shortcuts/lib/client.js',
  'dsh/node_modules/@deepseek-ai/dsh-client-ui-slots/lib/client.js',
]

lines.push('')
lines.push('=== how official plugins bind react / jsx-runtime ===')
for (const path of OFFICIAL) {
  const text = readInner(path)?.toString('utf8')
  if (text === undefined || text === null) { lines.push(`  ${path}: not found`); continue }
  lines.push('')
  lines.push(`### ${path}`)
  // The import prelude is the first ~30 lines after the factory opens.
  const start = text.indexOf('factory:')
  lines.push(text.slice(start, start + 900).split('\n').slice(0, 22).map((l) => `  ${l}`).join('\n'))

  // Any use of a `.default` on a react-named binding is the interop tell.
  const defaults = [...text.matchAll(/\b(react\w*)\.default\b/gu)].map((m) => m[1])
  lines.push(`  bindings with .default: ${defaults.length === 0 ? 'none' : [...new Set(defaults)].join(', ')}`)
  const toEsm = (text.match(/__toESM/gu) ?? []).length
  lines.push(`  __toESM occurrences: ${toEsm}`)
}

writeFileSync(OUT, lines.join('\n'), 'utf8')
console.log(`wrote ${OUT}`)
