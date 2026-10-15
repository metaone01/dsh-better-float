import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile, mkdir, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const npm = process.env.npm_execpath
if (!npm || !/npm-cli\.js$/u.test(npm)) throw new Error('Run this tool with npm run pack:npm')
const runNpm = (args, cwd = root) => execFileSync(process.execPath, [npm, ...args], {
  cwd, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024,
})
console.log(runNpm(['run', 'build']))
const stage = await mkdtemp(join(tmpdir(), 'better-float-npm-stage-'))
const output = join(root, 'artifacts')
await mkdir(output, { recursive: true })
// Package only explicit runtime and documentation paths; never stage the workspace.
for (const file of [...new Set([...manifest.files, 'README.md', 'LICENSE'])]) {
  const target = join(stage, file)
  await mkdir(dirname(target), { recursive: true })
  await copyFile(join(root, file), target)
}
const published = { ...manifest }
delete published.scripts
delete published.devDependencies
await writeFile(join(stage, 'package.json'), JSON.stringify(published, null, 2) + '\n')
const result = JSON.parse(runNpm(['pack', '--ignore-scripts', '--json', '--pack-destination', output], stage))[0]
const artifact = join(output, result.filename)
await writeFile(join(output, 'package-manifest.json'), JSON.stringify({ ...result, artifact }, null, 2) + '\n')
const sha256 = createHash('sha256').update(await readFile(artifact)).digest('hex')
await writeFile(join(output, 'SHA256SUMS'), sha256 + '  ' + result.filename + '\n')
console.log(artifact)
execFileSync(process.execPath, [join(root, 'scripts', 'verify-package.mjs'), artifact], { cwd: root, stdio: 'inherit' })
