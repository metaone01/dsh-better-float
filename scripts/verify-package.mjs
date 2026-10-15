import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const artifact = resolve(process.argv[2] ?? join(root, 'artifacts', source.name.replace(/^@/u, '').replaceAll('/', '-') + '-' + source.version + '.tgz'))
const scratch = await mkdtemp(join(tmpdir(), 'better-float-npm-check-'))
execFileSync('tar', ['-xzf', artifact, '-C', scratch])
const unpacked = join(scratch, 'package')
const manifest = JSON.parse(await readFile(join(unpacked, 'package.json'), 'utf8'))
assert.equal(manifest.name, source.name)
assert.equal(manifest.version, source.version)
assert.equal(manifest.license, 'MIT')
assert.notEqual(manifest.private, true)
assert.equal(manifest.publishConfig.registry, 'https://registry.npmjs.org/')
assert.deepEqual(manifest.scripts ?? {}, {}, 'Published package must contain no lifecycle or development scripts')
assert.deepEqual(manifest.devDependencies ?? {}, {}, 'Development tools must not ship in the published manifest')
assert.deepEqual(manifest.dependencies ?? {}, {}, 'Unexpected production dependencies need a packaging review')
assert.equal(manifest.peerDependenciesMeta.react.optional, true)
const expected = new Set([...source.files, 'package.json', 'README.md', 'LICENSE'])
const files = []
async function walk(folder, prefix = '') {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const relative = prefix + entry.name
    if (entry.isDirectory()) await walk(join(folder, entry.name), relative + '/')
    else {
      assert.equal(entry.isFile(), true, 'Package must contain regular files only: ' + relative)
      files.push(relative)
    }
  }
}
await walk(unpacked)
assert.deepEqual(files.sort(), [...expected].sort(), 'Packed file list differs from the explicit allowlist')
for (const file of [...Object.values(manifest.exports), manifest.dsh.bundle.patch]) {
  assert.ok((await stat(join(unpacked, file))).size > 0, 'Missing or empty declared entry: ' + file)
}
assert.ok((await readFile(join(unpacked, manifest.dsh.bundle.patch), 'utf8')).includes('name: ' + JSON.stringify(manifest.name)))
const license = await readFile(join(unpacked, 'LICENSE'), 'utf8')
assert.match(license, /MIT License/u)
assert.match(license, /Copyright \(c\) 2026 metaone01/u)
assert.match(license, /Permission is hereby granted, free of charge/u)
assert.match(license, /THE SOFTWARE IS PROVIDED "AS IS"/u)
let documentationLinks = 0
for (const file of files.filter(file => /\.md$/u.test(file))) {
  const content = await readFile(join(unpacked, file), 'utf8')
  for (const match of content.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/gu)) {
    const target = match[1].split('#')[0]
    if (!target || /^[a-z][a-z0-9+.-]*:/iu.test(target)) continue
    const resolved = resolve(dirname(join(unpacked, file)), decodeURIComponent(target))
    assert.ok(resolved.startsWith(unpacked + '/') || resolved.startsWith(unpacked + '\\'), 'Documentation link escapes package: ' + target)
    await stat(resolved)
    documentationLinks++
  }
}
for (const file of [...source.files, 'LICENSE', 'README.md']) {
  assert.deepEqual(await readFile(join(unpacked, file)), await readFile(join(root, file)), 'Artifact is stale: ' + file)
}
assert.match(await readFile(join(unpacked, 'README.md'), 'utf8'), /外部窗口提取为预览功能/u)
assert.match(await readFile(join(unpacked, 'README.en.md'), 'utf8'), /External window extraction is a preview feature/u)
const host = await import(pathToFileURL(join(unpacked, 'lib/index.js')).href)
assert.equal(typeof host.apply, 'function')
let client
vm.runInNewContext(await readFile(join(unpacked, 'lib/client.js'), 'utf8'), {
  window: { __ModuleLoader__: { load({ id, factory }) {
    assert.equal(id, manifest.name)
    client = factory(name => { assert.equal(name, 'react'); return { createElement() {} } })
  } } },
})
assert.equal(typeof client.apply, 'function')
assert.ok(Array.from(client.inject).includes('locale'))
// Resolve the already installed pnpm command; do not download or install tooling.
const locate = process.platform === 'win32' ? 'where.exe' : 'which'
const pnpmCommand = execFileSync(locate, ['pnpm'], { encoding: 'utf8' }).trim().split(/\r?\n/u)[0]
const consumer = join(scratch, 'profile')
await mkdir(consumer)
await writeFile(join(consumer, 'package.json'), JSON.stringify({ name: 'better-float-package-verification', private: true, dependencies: { [manifest.name]: 'file:' + artifact.replaceAll('\\', '/') } }, null, 2))
await writeFile(join(consumer, 'pnpm-workspace.yaml'), 'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\nallowBuilds: {}\n')
let pnpmVersion
let installation
if (process.platform === 'win32') {
  const launcher = await readFile(pnpmCommand, 'utf8')
  const modulePath = /"(?:%~dp0|%dp0%)[\\/]*([^"\r\n]*pnpm\.(?:mjs|cjs|js))"/u.exec(launcher)?.[1]
  if (!modulePath) throw new Error('Cannot resolve installed pnpm runtime from ' + pnpmCommand)
  const pnpmEntry = resolve(dirname(pnpmCommand), modulePath)
  const run = args => execFileSync(process.execPath, [pnpmEntry, ...args], { cwd: consumer, encoding: 'utf8', timeout: 60000 })
  pnpmVersion = run(['--version']).trim()
  assert.match(pnpmVersion, /^11\./u, 'Verify using pnpm v11')
  installation = run(['install', '--offline', '--reporter=append-only'])
} else {
  pnpmVersion = execFileSync(pnpmCommand, ['--version'], { encoding: 'utf8' }).trim()
  assert.match(pnpmVersion, /^11\./u, 'Verify using pnpm v11')
  installation = execFileSync(pnpmCommand, ['install', '--offline', '--reporter=append-only'], { cwd: consumer, encoding: 'utf8', timeout: 60000 })
}
console.log(installation)
const installed = join(consumer, 'node_modules', manifest.name)
const installedManifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'))
for (const file of [installedManifest.dsh.bundle.patch, ...Object.values(installedManifest.exports), './lib/companion/main.cjs']) {
  assert.ok((await stat(join(installed, file))).size > 0, 'Missing installed entry: ' + file)
}
const bytes = await readFile(artifact)
const report = {
  name: manifest.name, version: manifest.version, artifact, bytes: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'), files: files.length,
  documentationLinks, license: manifest.license, pnpmVersion,
  lifecycleScripts: [], buildAllowlist: {}, installedOverlayReadable: true,
  hostAndClientLoadable: true, companionRuntimeIncluded: true,
  actualDshInstallation: false, npmPublished: false,
}
await mkdir(join(root, 'artifacts'), { recursive: true })
await writeFile(join(root, 'artifacts', 'package-verification.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
