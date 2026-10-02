/**
 * Locate the ModuleLoader implementation anywhere in the app archive.
 *
 * A first attempt scanned only `renderer/` and `lib/main`, on the assumption that
 * the loader must live in the page's own boot code. It found nothing — so that
 * assumption was wrong, and the loader is somewhere else. This version searches
 * every JavaScript file in the archive and reports every definition-shaped hit,
 * rather than guessing which directory holds it.
 *
 * Run with `node scripts/find-loader-anywhere.mjs`.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const ASAR = 'G:/Deepseek Harness Desktop/resources/app.asar'
const OUT = 'G:/Code/fork/dsh-better-float/loader-impl.txt'

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

const files = []
const walk = (node, prefix, depth) => {
  if (depth > 10) return
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const path = prefix === '' ? name : `${prefix}/${name}`
    if (entry.files !== undefined) walk(entry, path, depth + 1)
    else files.push({ path, size: entry.size })
  }
}
walk(header, '', 0)

const js = files.filter((f) => f.path.endsWith('.js'))
const lines = [`=== ${files.length} files, ${js.length} .js ===`]

// Which packages even mention the name? Both a definition and a call site
// mention it, so this narrows 12k files to a handful before the expensive read.
const mentions = []
for (const file of js) {
  const bytes = readInner(file.path)
  if (bytes === null) continue
  const text = bytes.toString('utf8')
  if (!text.includes('__ModuleLoader__')) continue
  const definitions = [...text.matchAll(/__ModuleLoader__\s*[=:]\s*(?!load|["']load)|["']__ModuleLoader__["']\s*:/gu)]
  mentions.push({
    path: file.path,
    size: file.size,
    calls: (text.match(/__ModuleLoader__\.load/gu) ?? []).length,
    definitionHits: definitions.length,
    firstDefinition: definitions[0]?.index ?? -1,
    text,
  })
}

mentions.sort((a, b) => b.definitionHits - a.definitionHits || a.calls - b.calls)
lines.push(`=== ${mentions.length} files mention __ModuleLoader__ ===`)
for (const mention of mentions) {
  lines.push(`  defs=${mention.definitionHits} calls=${mention.calls}  ${mention.path}  (${mention.size} B)`)
}

// The implementation is the file that defines the name and does not merely call
// into it. Report the top candidates with a window around the definition.
for (const candidate of mentions.filter((m) => m.definitionHits > 0).slice(0, 3)) {
  lines.push('')
  lines.push(`### DEFINITION in ${candidate.path} (${candidate.size} B) at ${candidate.firstDefinition}`)
  lines.push(candidate.text.slice(
    Math.max(0, candidate.firstDefinition - 4000),
    candidate.firstDefinition + 12000,
  ))
}

// Nothing defined the name: report the call sites' shared neighbourhood instead,
// since the loader may be built under a different identifier and only assigned.
if (mentions.every((m) => m.definitionHits === 0)) {
  lines.push('')
  lines.push('=== no definition-shaped hit; showing the smallest call site in full ===')
  const smallest = mentions.filter((m) => m.calls > 0).sort((a, b) => a.size - b.size)[0]
  if (smallest !== undefined) {
    lines.push(`### ${smallest.path} (${smallest.size} B)`)
    lines.push(smallest.text.slice(0, 12000))
  }
}

writeFileSync(OUT, lines.join('\n'), 'utf8')
console.log(`wrote ${OUT}`)
