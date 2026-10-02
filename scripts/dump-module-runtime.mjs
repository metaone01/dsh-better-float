/**
 * Extract the client module-system runtime from the app archive.
 *
 * `dsh-client-modules/lib/index.js` holds the *host* half (composing and serving
 * bundles) — it defines the boot queue but delegates the actual module system to
 * `createClientModuleSystem`, which lives in the package's client bundle. That
 * client bundle is where `require` is really implemented, and therefore the only
 * place that can answer:
 *
 *   - Which specifiers `require` resolves, and from where (`PLATFORM_MODULES`)?
 *   - Does it hand the factory a prebuilt `require`, or expect the factory to
 *     declare its own?
 *   - What happens to a specifier that is not in the table — the "Dynamic
 *     require of ... is not supported" path?
 *
 * Run with `node scripts/dump-module-runtime.mjs`.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const ASAR = 'G:/Deepseek Harness Desktop/resources/app.asar'
const TARGET = 'dsh/node_modules/@deepseek-ai/dsh-client-modules/lib/client.js'
const OUT = 'G:/Code/fork/dsh-better-float/module-runtime.txt'

const buf = readFileSync(ASAR)
const headerSize = buf.readUInt32LE(12)
const header = JSON.parse(buf.subarray(16, 16 + headerSize).toString('utf8'))
const dataOffset = 16 + headerSize

let node = header
for (const segment of TARGET.split('/').filter(Boolean)) {
  node = node?.files?.[segment]
  if (node === undefined) throw new Error(`not found: ${TARGET}`)
}

const text = buf
  .subarray(dataOffset + Number(node.offset), dataOffset + Number(node.offset) + node.size)
  .toString('utf8')

const lines = [`=== ${TARGET} (${node.size} B) ===`]

// The whole runtime is small enough to keep in one file, but locate the entry
// point first so the interesting region is near the top of the report.
const anchors = [
  'createClientModuleSystem',
  'PLATFORM_MODULES',
  'not supported',
  'require',
]
for (const anchor of anchors) {
  const indexes = []
  let from = 0
  for (;;) {
    const at = text.indexOf(anchor, from)
    if (at === -1) break
    indexes.push(at)
    from = at + 1
    if (indexes.length > 24) break
  }
  lines.push(`  ${anchor}: ${indexes.length} hit(s) at ${indexes.slice(0, 24).join(', ')}`)
}

lines.push('')
lines.push('=== full bundle ===')
lines.push(text)

writeFileSync(OUT, lines.join('\n'), 'utf8')
console.log(`wrote ${OUT} (${node.size} B bundle)`)
