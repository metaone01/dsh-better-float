import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { resolve, join } from 'node:path'
import { connect } from 'node:net'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const require = createRequire(import.meta.url)
const {outputFiles} = await build({stdin:{contents:`export {createPipeClient} from './src/host/pipe-client.ts';
export {createCompanionServer} from './companion/server.ts'; export {validPairing,proof,receiveFrames,sendFrame} from './src/host/pipe-protocol.ts';
export {validCompanionRequest} from './src/shared/companion.ts'; export {apply} from './src/index.ts';
export {protectPairingDirectory,readPrivatePairing} from './src/host/pairing-security.ts';`,resolveDir:process.cwd()},
bundle:true,platform:'node',format:'cjs',write:false})
const module = {exports:{}}
new Function('require','module','exports',outputFiles[0].text)(require,module,module.exports)
const {createPipeClient,createCompanionServer,validPairing,validCompanionRequest,proof,receiveFrames,sendFrame,apply,protectPairingDirectory,readPrivatePairing} = module.exports
const folder = await mkdtemp(resolve('.dsh-debug-userdata-companion-check-'))
await protectPairingDirectory(folder)
const name = randomBytes(16).toString('hex')
const pairing = {pipe:process.platform==='win32'?`\\\\.\\pipe\\dsh-better-float-${name}`:join(folder,`dsh-better-float-${name}.sock`),secret:randomBytes(32).toString('hex')}
const file = join(folder,'pairing.json')
await writeFile(file,JSON.stringify(pairing),{mode:0o600})
let checks = 0
const test = async (label,run) => {await run();checks++;console.log(`PASS ${label}`)}
const pause = ms=>new Promise(resolve=>setTimeout(resolve,ms))
let created = 0, closed = 0
const server = createCompanionServer(pairing,async()=> {
  created++
  await pause(5)
  let alive = true
  return {alive:()=>alive,close:()=>{if(alive){alive=false;closed++}}}
},200)
const clients = []
const client = filename=>{const value=createPipeClient(filename??file);clients.push(value);return value}
let current = client()
try {
  await test('credential permissions are restricted and verified',async()=>assert.deepEqual(await readPrivatePairing(file),pairing))
  await test('broad credential file permissions fail closed and recover after ACL repair',async()=> {
    if(process.platform==='win32') {
      const modify=async(broaden)=>{
        const source=`$ErrorActionPreference='Stop'; $target=$env:DSH_BF_TEST_CREDENTIAL; $acl=[System.IO.File]::GetAccessControl($target); ${broaden ? `
$rule=[System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-545'),'Read','Allow'); $acl.AddAccessRule($rule);`
          : `$sid=[System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-545'); $acl.PurgeAccessRules($sid);`}
[System.IO.File]::SetAccessControl($target,$acl)`
        await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(source,'utf16le').toString('base64')],{
          env:{...process.env,DSH_BF_TEST_CREDENTIAL:file},windowsHide:true,timeout:5000,
        })
      }
      await modify(true)
      try {await assert.rejects(readPrivatePairing(file),/Credential ACL/)}finally{await modify(false)}
      assert.deepEqual(await readPrivatePairing(file),pairing)
    } else {
      const{chmod}=await import('node:fs/promises')
      await chmod(file,0o644)
      try{await assert.rejects(readPrivatePairing(file),/Unsafe credential/)}finally{await chmod(file,0o600)}
    }
  })
  await test('only task-owned pipe names and 256-bit secrets accepted',()=> {
    assert.equal(validPairing(pairing),true)
    assert.equal(validPairing({...pairing,pipe:'\\\\server\\pipe\\anything'}),false)
    assert.equal(validPairing({...pairing,secret:'weak'}),false)
    assert.equal(validCompanionRequest({op:'open-test',lease:'test',id:'one',url:'https://example.com'}),false)
    assert.equal(validCompanionRequest({op:'execute',code:'bad'}),false)
  })
  await test('absent companion fails without blocking startup',async()=> {
    await assert.rejects(current.request({op:'ping'}))
    const effects=[]
    apply({effect:run=>{effects.push(run())},inject:()=>()=>{}},{companionPairingFile:file})
    for(const cleanup of effects.reverse()) if(typeof cleanup==='function')cleanup()
  })
  await server.listen()
  await test('mutual HMAC auth and signed reply round trip',async()=>assert.equal((await current.request({op:'ping'})).testOnly,true))
  await test('wrong secret is rejected and cannot create windows',async()=> {
    const wrong=join(folder,'wrong.json')
    await writeFile(wrong,JSON.stringify({...pairing,secret:randomBytes(32).toString('hex')}),{mode:0o600})
    await assert.rejects(client(wrong).request({op:'ping'}))
    assert.equal(created,0)
  })
  await test('authenticated RPC performs only test window creation',async()=> {
    const result=await current.request({op:'open-test',lease:'renderer-one',id:'one'})
    assert.deepEqual(result.windows,[{lease:'renderer-one',id:'one'}])
  })
  await test('duplicate identities cannot create a second window',async()=> {
    await assert.rejects(current.request({op:'open-test',lease:'renderer-one',id:'one'}))
    assert.equal(created,1)
  })
  await test('a lease cannot list or close another lease',async()=> {
    assert.deepEqual((await current.request({op:'list',lease:'other'})).windows,[])
    await current.request({op:'close',lease:'other',id:'one'})
    assert.equal((await current.request({op:'list',lease:'renderer-one'})).windows.length,1)
  })
  await test('concurrent requests respect window quota reservations',async()=> {
    const results=await Promise.allSettled(['two','three','four'].map(id=>current.request({op:'open-test',lease:'renderer-one',id})))
    assert.equal(results.filter(value=>value.status==='fulfilled').length,2)
    assert.equal(created,3)
  })
  await test('lease expiry closes windows even while Host socket stays alive',async()=> {
    await pause(350)
    assert.deepEqual((await current.request({op:'list',lease:'renderer-one'})).windows,[])
    assert.equal(closed,3)
  })
  await test('renewal keeps a live window and release reclaims it',async()=> {
    await current.request({op:'open-test',lease:'renew',id:'renew'})
    await pause(120)
    await current.request({op:'pulse',lease:'renew'})
    await pause(120)
    assert.equal((await current.request({op:'list',lease:'renew'})).windows.length,1)
    await current.request({op:'release',lease:'renew'})
    assert.equal(closed,4)
  })
  await test('separate Host sockets own their windows independently',async()=> {
    const second=client()
    await current.request({op:'open-test',lease:'same',id:'same'})
    await second.request({op:'open-test',lease:'same',id:'same'})
    current.dispose()
    await pause(20)
    assert.equal((await second.request({op:'list',lease:'same'})).windows.length,1)
    second.dispose()
    await pause(20)
    assert.equal(closed,6)
    current=client()
  })
  await test('disposed Host client cannot reconnect',async()=> {
    const dead=client();dead.dispose();await assert.rejects(dead.request({op:'ping'}))
  })
  await test('malformed and oversized unauthenticated frames fail closed',async()=> {
    for(const data of ['{bad json}\n','x'.repeat(9000)]) {
      const raw=connect(pairing.pipe)
      raw.on('error',()=>{})
      raw.resume()
      await new Promise(resolve=>raw.once('connect',resolve))
      raw.write(data)
      await new Promise((resolve,reject)=>{const t=setTimeout(()=>{raw.destroy();reject(Error('connection not closed'))},2000);raw.on('close',()=>{clearTimeout(t);resolve()})})
    }
    assert.equal(created,6)
  })
  await test('signed requests cannot be replayed inside an authenticated session',async()=> {
    const raw=connect(pairing.pipe)
    raw.on('error',()=>{})
    const nonce=randomBytes(32).toString('hex')
    let session='',signed
    const closed=new Promise((resolve,reject)=>{const timer=setTimeout(()=>{raw.destroy();reject(Error('replay was accepted'))},2000);raw.once('close',()=>{clearTimeout(timer);resolve()})})
    receiveFrames(raw,frame=>{
      if(frame.type==='challenge') {
        session=`${frame.nonce}:${nonce}`
        sendFrame(raw,{type:'auth',nonce,proof:proof(pairing.secret,`client:${session}`)})
      } else if(frame.type==='ready') {
        const payload={op:'ping'}
        signed={type:'request',seq:1,payload,proof:proof(pairing.secret,`request:${session}:1:${JSON.stringify(payload)}`)}
        sendFrame(raw,signed)
      } else if(frame.type==='reply') sendFrame(raw,signed)
    })
    await closed
    assert.equal(created,6)
  })
  await test('Host route is restricted and disposes its registrations',async()=> {
    const handlers=new Map(),stops=[]
    const ctx={effect:run=>{const stop=run();stops.push(stop);return stop},
      inject:(_names,run)=>{run(ctx);return()=>{}},connection:{fetch:{register:route=>{handlers.set(route.path,route.fetch);return async()=>handlers.delete(route.path)}}}}
    apply(ctx,{companionPairingFile:file})
    const invoke=async(method,payload)=> (await (await handlers.get('/api/better-float-companion/request')(new Request('http://localhost/api/better-float-companion/request',{
      method:'POST',body:JSON.stringify({type:'client-request',rpcId:'test',method,payload}),headers:{'content-type':'application/json'} }))).json()).result
    assert.equal((await invoke('request',{op:'ping'})).ok,true)
    assert.equal((await invoke('request',{op:'launch',exe:'bad'})).ok,false)
    assert.equal((await invoke('request',{op:'shutdown'})).ok,false,'Renderer cannot invoke process lifecycle control')
    assert.equal((await invoke('other',{op:'ping'})).ok,false)
    for(const stop of stops.reverse())if(typeof stop==='function')await stop()
    assert.equal(handlers.size,0)
  })
  await test('Host has safe disabled and missing-service modes',async()=> {
    const stops=[];let handler
    const ctx={effect:run=>{const stop=run();stops.push(stop)},inject:(_names,run)=>{run(ctx);return()=>{}},connection:{fetch:{register:route=>{handler=route.fetch;return()=>{}}}}}
    apply(ctx)
    const reply=await handler(new Request('http://localhost/api/better-float-companion/request',{method:'POST',body:JSON.stringify({type:'client-request',rpcId:'test',method:'request',payload:{op:'ping'}})}))
    assert.equal((await reply.json()).result.error.code,'companion/not-configured')
    apply({...ctx,connection:{}})
    for(const stop of stops.reverse())if(typeof stop==='function')await stop()
  })
  await test('pairing secrets are never embedded in renderer artifact',async()=> {
    const source=await readFile('src/detach/companion.ts','utf8')
    assert.equal(source.includes(pairing.secret),false)
    assert.equal(source.includes('node:net'),false)
  })
  console.log(`${checks} companion checks passed (Named Pipe round trips; not live Desktop acceptance).`)
} finally {
  for(const instance of clients)instance.dispose()
  await server.dispose()
}
