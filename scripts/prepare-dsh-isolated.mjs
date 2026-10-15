import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const isolated = join(root, '.dsh-debug-userdata-e0e1-20261003')
const profile = join(isolated, 'harness', 'profiles', 'desktop')
const source = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
// Only the explicitly named acceptance profile is touched, never normal .dsh.
await mkdir(profile, { recursive: true })
const json = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n')
await json(join(profile, 'package.json'), { name:'dsh-profile-desktop', private:true, dependencies:{},
  dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app']}} })
const pairingArgument=process.argv.find(arg=>arg.startsWith('--pairing-file='))
const pairingFile=pairingArgument?resolve(pairingArgument.slice('--pairing-file='.length)):join(root,'.dsh-debug-userdata-companion','credentials','pairing.json')
const config = process.argv.includes('--companion') ? `{ companionPairingFile: ${JSON.stringify(pairingFile)}${process.argv.includes('--managed')?`, companionExecutable: ${JSON.stringify(join(root,'node_modules','electron','dist','electron.exe'))}, companionEntry: ${JSON.stringify(join(root,'lib','companion','main.cjs'))}`:''} }` : '{}'
await writeFile(join(profile, 'cordis.patch.yml'), `- id: webserver\n  config:\n    host: 127.0.0.1\n    port: 0\n- insert:\n    - name: "@metaone01/dsh-better-float"\n      config: ${config}\n    - name: dsh-better-float-acceptance-fixture\n      config: { isolatedHome: ${JSON.stringify(join(isolated,'harness'))} }\n`)
await writeFile(join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\n')
for (const name of ['@metaone01/dsh-better-float','dsh-better-float-acceptance-fixture']) {
  const pkg = join(profile, 'node_modules', name)
  await mkdir(join(pkg,'lib'), { recursive:true })
  await json(join(pkg,'package.json'), { name, version:source.version, private:true, type:'module', main:'lib/index.js',
    exports:{'.':'./lib/index.js','./client':'./lib/client.js'},
    dsh:{client:name === '@metaone01/dsh-better-float' ? source.dsh.client : { platform:'web',
      inject:['@deepseek-ai/dsh-client-ui-renderer','@deepseek-ai/dsh-client-shortcuts','@deepseek-ai/dsh-api-session-controller'] }} })
  if (name === '@metaone01/dsh-better-float') {
    for (const file of ['client.js','index.js']) await copyFile(join(root,'lib',file),join(pkg,'lib',file))
  } else {
    await copyFile(join(root,'scripts','dsh-acceptance-fixture-client.js'),join(pkg,'lib','client.js'))
    await copyFile(join(root,'scripts','dsh-acceptance-fixture-host.mjs'),join(pkg,'lib','index.js'))
  }
}
console.log(`Prepared isolated profile ${profile}; no sessions or credentials copied, no dependencies installed.`)
