import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {createServer} from 'node:net'
import {randomBytes} from 'node:crypto'
import {mkdtemp,mkdir,writeFile,readFile,lstat} from 'node:fs/promises'
import {resolve,join} from 'node:path'
import {build} from 'esbuild'
import {createRequire} from 'node:module'

const require=createRequire(import.meta.url)
const {outputFiles}=await build({stdin:{contents:`export {createPipeClient} from './src/host/pipe-client.ts';export {protectPairingDirectory} from './src/host/pairing-security.ts';`,resolveDir:process.cwd()},bundle:true,platform:'node',format:'cjs',write:false})
const module={exports:{}}
new Function('require','module','exports',outputFiles[0].text)(require,module,module.exports)
const {createPipeClient,protectPairingDirectory}=module.exports
assert.equal(process.platform,'win32','Real startup acceptance targets Windows')
const directory=await mkdtemp(resolve('.dsh-debug-userdata-startup-'))
await mkdir(join(directory,'electron'))
const credentials=join(directory,'credentials'),file=join(credentials,'pairing.json')
await protectPairingDirectory(credentials)
const old={pipe:`\\\\.\\pipe\\dsh-better-float-${randomBytes(16).toString('hex')}`,secret:randomBytes(32).toString('hex')}
await writeFile(file,JSON.stringify(old),{mode:0o600})
const children=[],clients=[]
let checks=0
async function freePort(){return new Promise((resolve,reject)=>{const server=createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port))})})}
async function launch(){
  const port=await freePort(),env={...process.env,DSH_BETTER_FLOAT_COMPANION_DIR:directory};delete env.ELECTRON_RUN_AS_NODE
  const child=spawn(resolve('node_modules/electron/dist/electron.exe'),[`--remote-debugging-port=${port}`,'--remote-debugging-address=127.0.0.1',resolve('lib/companion/main.cjs')],{env,stdio:['ignore','pipe','pipe'],windowsHide:true})
  const item={child,port,ready:null,output:'',exit:null};children.push(item)
  item.exited=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>{item.exit={code,signal};resolve(item.exit)})})
  const ready=new Promise((resolve,reject)=>{
    let lines=''
    child.stdout.on('data',chunk=>{item.output+=chunk;lines+=chunk;let index;while((index=lines.indexOf('\n'))>=0){const line=lines.slice(0,index);lines=lines.slice(index+1);try{const value=JSON.parse(line);if(value.status==='ready'){item.ready=value;resolve({ready:true,item})}}catch{}}})
    child.stderr.on('data',chunk=>{item.output+=chunk})
    child.once('error',reject)
  })
  item.result=Promise.race([ready,item.exited.then(exit=>({ready:false,item,exit})),new Promise((_,reject)=>{item.timer=setTimeout(()=>reject(Error('Startup timeout')),15000)})]).finally(()=>clearTimeout(item.timer))
  return item
}
async function close(item){
  if(item.exit)return
  const version=await(await fetch(`http://127.0.0.1:${item.port}/json/version`,{signal:AbortSignal.timeout(2000)})).json()
  const socket=new WebSocket(version.webSocketDebuggerUrl)
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Close connection timeout')),2000);socket.addEventListener('open',()=>{clearTimeout(timer);resolve()},{once:true});socket.addEventListener('error',()=>{clearTimeout(timer);reject(Error('Close connection failed'))},{once:true})})
  socket.send(JSON.stringify({id:1,method:'Browser.close'}))
  try{await Promise.race([item.exited,new Promise((_,reject)=>{item.closeTimer=setTimeout(()=>reject(Error('Graceful shutdown timeout')),10000)})])}finally{clearTimeout(item.closeTimer);socket.close()}
}
async function ping(){const client=createPipeClient(file);clients.push(client);assert.equal((await client.request({op:'ping'})).version,1);client.dispose()}
const check=async(label,run)=>{await run();checks++;console.log(`PASS ${label}`)}
try {
  const first=await launch();assert.equal((await first.result).ready,true)
  await check('real cold startup recovers a private orphan and publishes a fresh key',async()=>{
    assert.equal(first.ready.recoveredStalePairing,true)
    const current=JSON.parse(await readFile(file,'utf8'));assert.notEqual(current.secret,old.secret);await ping()
  })
  const before=await readFile(file,'utf8'),duplicate=await launch(),duplicateResult=await duplicate.result
  await check('duplicate process cannot replace the running owner or its credentials',async()=>{
    assert.equal(duplicateResult.ready,false);assert.equal(duplicateResult.exit.code,1)
    assert.match(duplicate.output,/already running/);assert.equal(await readFile(file,'utf8'),before);await ping()
  })
  await close(first)
  await check('graceful shutdown automatically removes owned credentials',async()=>assert.rejects(lstat(file),{code:'ENOENT'}))
  const one=await launch(),two=await launch(),results=await Promise.all([one.result,two.result])
  const winners=results.filter(result=>result.ready)
  await check('two simultaneous startups yield exactly one owner',async()=>{
    assert.equal(winners.length,1);assert.equal(results.find(result=>!result.ready).exit.code,1);await ping()
  })
  const winner=winners[0].item
  await check('abrupt exit leaves a credential for the recovery test',async()=>{
    // Only this script's just-spawned companion, with no source Desktop or windows.
    assert.ok(winner.child.pid>0);winner.child.kill('SIGKILL');await winner.exited
    assert.ok((await lstat(file)).isFile())
  })
  const restarted=await launch();assert.equal((await restarted.result).ready,true)
  await check('cold restart after abrupt exit recovers without manual deletion',async()=>{
    assert.equal(restarted.ready.recoveredStalePairing,true);await ping();await close(restarted);await assert.rejects(lstat(file),{code:'ENOENT'})
  })
  const report={date:'2026-10-04',scope:'real Electron companion in unique isolated userData; no Desktop/profile mutation',checks,
    orphanRecovered:true,duplicateRejected:true,concurrentOwners:1,abruptExitRecovered:true,gracefulCleanup:true}
  await writeFile('docs/companion-startup-fixed-2026-10-04.json',JSON.stringify(report,null,2)+'\n')
  console.log(JSON.stringify(report,null,2))
}finally{
  for(const client of clients)client.dispose()
  for(const item of children)if(!item.exit){try{await close(item)}catch{item.child.kill('SIGKILL');await item.exited}}
  // Keep the isolated Electron profile as evidence; no recursive removal.
}
