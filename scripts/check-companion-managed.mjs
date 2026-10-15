import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {createRequire} from 'node:module'
import {randomBytes} from 'node:crypto'
import {mkdtemp,mkdir,writeFile,readFile,lstat} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {createServer} from 'node:net'

const require=createRequire(import.meta.url)
const {outputFiles}=await build({stdin:{contents:`export {createCompanionProcess} from './src/host/companion-process.ts';
export {createCompanionServer} from './companion/server.ts';export {protectPairingDirectory} from './src/host/pairing-security.ts';`,resolveDir:process.cwd()},bundle:true,platform:'node',format:'cjs',write:false})
const module={exports:{}}
new Function('require','module','exports',outputFiles[0].text)(require,module,module.exports)
const {createCompanionProcess,createCompanionServer,protectPairingDirectory}=module.exports
const folder=await mkdtemp(resolve('.dsh-debug-userdata-managed-'))
await mkdir(join(folder,'credentials'));await mkdir(join(folder,'electron'))
const file=join(folder,'credentials','pairing.json')
const manager=createCompanionProcess(file,{executable:resolve('node_modules/electron/dist/electron.exe'),entry:resolve('lib/companion/main.cjs')})
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))
let checks=0
const test=async(name,run)=>{await run();checks++;console.log(`PASS ${name}`)}
const wait=async(predicate,label)=>{for(let index=0;index<80;index++){if(await predicate())return;await pause(100)}throw Error(label)}
try {
  await test('manager creation, cancelled requests and release do not start a process',async()=>{
    assert.equal(manager.ownedPid(),undefined)
    await assert.rejects(lstat(file),{code:'ENOENT'})
    await assert.rejects(manager.request({op:'ping'},AbortSignal.abort()))
    await assert.rejects(manager.request({op:'release',lease:'none'}))
    assert.equal(manager.ownedPid(),undefined)
  })
  await test('unsafe configured entry is rejected without spawning',async()=>{
    const invalid=createCompanionProcess(file,{executable:resolve('node_modules/electron/dist/electron.exe'),entry:resolve('package.json')})
    try{await assert.rejects(invalid.request({op:'ping'}),/Invalid companion launch/);assert.equal(invalid.ownedPid(),undefined)}finally{await invalid.dispose()}
  })
  await test('parallel first clicks start one authenticated companion with no window before consent',async()=>{
    const results=await Promise.all(Array.from({length:4},()=>manager.request({op:'ping'})))
    assert.ok(manager.ownedPid()>0)
    assert.ok(results.every(result=>result.windows.length===0))
  })
  const firstPid=manager.ownedPid()
  await test('two lease windows survive closing only the first',async()=>{
    await manager.request({op:'open-test',id:'one',lease:'first'})
    await manager.request({op:'open-test',id:'two',lease:'second'})
    await manager.request({op:'close',id:'one',lease:'first'})
    for(let index=0;index<4;index++){await pause(500);assert.equal((await manager.request({op:'pulse',lease:'second'})).windows.length,1)}
    assert.equal(manager.ownedPid(),firstPid)
  })
  await test('closing the last window exits managed process and removes credentials',async()=>{
    await manager.request({op:'close',id:'two',lease:'second'})
    await wait(()=>manager.ownedPid()===undefined,'Process did not idle-exit')
    await assert.rejects(lstat(file),{code:'ENOENT'})
  })
  await test('explicit next click starts a fresh process after idle exit',async()=>{
    await manager.request({op:'open-test',id:'three',lease:'third'})
    assert.notEqual(manager.ownedPid(),firstPid)
    assert.equal((await manager.request({op:'list',lease:'third'})).windows.length,1)
  })
  await test('only explicit demand recovers after the test-owned child crashes',async()=>{
    const crashPid=manager.ownedPid();assert.ok(crashPid>0)
    // This handle was created by this test's manager in its unique profile.
    process.kill(crashPid,'SIGKILL')
    await wait(()=>manager.ownedPid()===undefined,'Test child did not exit')
    await assert.rejects(manager.request({op:'pulse',lease:'third'}))
    await pause(300);assert.equal(manager.ownedPid(),undefined)
    const opened=await manager.request({op:'open-test',id:'four',lease:'fourth'})
    assert.equal(opened.windows.length,1);assert.notEqual(manager.ownedPid(),crashPid)
    assert.equal((await manager.request({op:'list',lease:'third'})).windows.length,0,'Old lease cannot resurrect')
  })
  await test('Host disposal gracefully closes windows, credentials and owned child',async()=>{
    await manager.dispose();assert.equal(manager.ownedPid(),undefined)
    await assert.rejects(lstat(file),{code:'ENOENT'})
    await assert.rejects(manager.request({op:'ping'}))
  })
  await protectPairingDirectory(join(folder,'credentials'))
  const pairing={pipe:`\\\\.\\pipe\\dsh-better-float-${randomBytes(16).toString('hex')}`,secret:randomBytes(32).toString('hex')}
  await writeFile(file,JSON.stringify(pairing),{flag:'wx',mode:0o600})
  const external=createCompanionServer(pairing,async()=>({close(){},alive(){return true}}))
  await external.listen()
  const other=createCompanionProcess(file,{executable:resolve('node_modules/electron/dist/electron.exe'),entry:resolve('lib/companion/main.cjs')})
  try {
    await test('healthy externally started service is reused but never terminated',async()=>{
      assert.equal((await other.request({op:'ping'})).version,1)
      assert.equal(other.ownedPid(),undefined)
      await other.dispose();assert.equal(external.server.listening,true)
      assert.deepEqual(JSON.parse(await readFile(file,'utf8')),pairing)
    })
  }finally{await other.dispose();await external.dispose()}
  await test('unresponsive external pipe is not killed, replaced or overwritten',async()=>{
    const sockets=new Set(),blocked=createServer(socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});socket.resume()})
    await new Promise((resolve,reject)=>{blocked.once('error',reject);blocked.listen(pairing.pipe,resolve)})
    const refused=createCompanionProcess(file,{executable:resolve('node_modules/electron/dist/electron.exe'),entry:resolve('lib/companion/main.cjs')})
    try{
      await assert.rejects(refused.request({op:'ping'}))
      assert.equal(refused.ownedPid(),undefined);assert.equal(blocked.listening,true)
      assert.deepEqual(JSON.parse(await readFile(file,'utf8')),pairing)
    }finally{await refused.dispose();for(const socket of sockets)socket.destroy();await new Promise(resolve=>blocked.close(resolve))}
  })
  const report={date:'2026-10-05',checks,scope:'real Electron managed companion with unique profile and authenticated Named Pipe; no user Desktop touched',
    lazyStart:true,concurrentStartCoalesced:true,lastWindowAutoExit:true,otherLeasePreserved:true,crashRecoveryOnExplicitDemand:true,disposeGraceful:true,externalOwnerPreserved:true}
  await writeFile('docs/companion-managed-acceptance-2026-10-05.json',JSON.stringify(report,null,2)+'\n')
  console.log(JSON.stringify(report,null,2))
}finally{await manager.dispose()}
