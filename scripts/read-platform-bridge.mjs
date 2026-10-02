/** Read-only inspection of the packaged shell bundle's platform bridge. */
import { readFileSync } from 'node:fs'

const asarPath = 'G:/Deepseek Harness Desktop/resources/app.asar'
const innerPath = 'dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/index-CTOadNHm.js'
const buf = readFileSync(asarPath)
const headerSize = buf.readUInt32LE(12)
const header = JSON.parse(buf.subarray(16, 16 + headerSize).toString('utf8'))
const dataOffset = 16 + headerSize

let node = header
for (const segment of innerPath.split('/')) {
  node = node?.files?.[segment]
}
if (node === undefined || node.files !== undefined) throw new Error(`missing ${innerPath}`)

const text = buf.subarray(dataOffset + Number(node.offset), dataOffset + Number(node.offset) + node.size).toString('utf8')

function readInner(inner) {
  let current = header
  for (const segment of inner.split('/').filter(Boolean)) current = current?.files?.[segment]
  if (current === undefined || current.files !== undefined) return null
  return buf.subarray(dataOffset + Number(current.offset), dataOffset + Number(current.offset) + current.size).toString('utf8')
}
const needles = [
  'dshPlatform',
  'dshDesktop',
  'browser: {',
  'onOpenRequested',
  'setBounds',
  'closeWindow',
]

for (const needle of needles) {
  console.log(`\n=== ${needle} ===`)
  let cursor = 0
  let count = 0
  while (count < 20) {
    const index = text.indexOf(needle, cursor)
    if (index < 0) break
    console.log(`@${index}: ${text.slice(Math.max(0, index - 500), Math.min(text.length, index + 1000))}`)
    cursor = index + needle.length
    count += 1
  }
  if (count === 0) console.log('not found')
}

for (const inner of [
  'dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js',
  'lib/preload-app.cjs',
  'lib/main.js',
]) {
  const source = readInner(inner)
  console.log(`\n=== ${inner} ===`)
  if (source === null) {
    console.log('not found')
    continue
  }
  for (const needle of ['browser', 'open', 'setBounds', 'contextBridge', 'ipcRenderer', 'dshPlatform', 'onOpenRequested']) {
    let cursor = 0
    let count = 0
    while (count < 12) {
      const index = source.indexOf(needle, cursor)
      if (index < 0) break
      console.log(`@${index} ${needle}: ${source.slice(Math.max(0, index - 350), Math.min(source.length, index + 750))}`)
      cursor = index + needle.length
      count += 1
    }
  }
}

function walk(entry, prefix, out) {
  if (entry?.files === undefined) {
    out.push(prefix)
    return
  }
  for (const [name, child] of Object.entries(entry.files)) walk(child, `${prefix}/${name}`, out)
}

const paths = []
walk(header, '', paths)
console.log('\n=== packaged paths with host/window names ===')
for (const path of paths.filter((value) => /preload|main|desktop|window|electron/u.test(value)).slice(0, 240)) {
  console.log(path)
}
