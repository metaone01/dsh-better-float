import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {createRequire} from 'node:module'
import {randomBytes} from 'node:crypto'
import {mkdtemp,writeFile,unlink,rmdir} from 'node:fs/promises'
import {resolve,join} from 'node:path'

const require=createRequire(import.meta.url)
const{outputFiles}=await build({stdin:{contents:`export {createCompanionServer} from './companion/server.ts';
export {createPipeClient} from './src/host/pipe-client.ts';export {protectPairingDirectory} from './src/host/pairing-security.ts';
export {validCompanionRequest} from './src/shared/companion.ts';export {MAX_FRAME,PipeFrameSizeError} from './src/host/pipe-protocol.ts';`,resolveDir:process.cwd()},bundle:true,platform:'node',format:'cjs',write:false})
const module={exports:{}}
new Function('require','module','exports',outputFiles[0].text)(require,module,module.exports)
const{createCompanionServer,createPipeClient,protectPairingDirectory,validCompanionRequest,MAX_FRAME,PipeFrameSizeError}=module.exports
const folder=await mkdtemp(resolve('.dsh-debug-userdata-companion-boundary-'))
await protectPairingDirectory(folder)
const suffix=randomBytes(16).toString('hex')
const pairing={pipe:process.platform==='win32'?`\\\\.\\pipe\\dsh-better-float-${suffix}`:join(folder,`dsh-better-float-${suffix}.sock`),secret:randomBytes(32).toString('hex')}
const file=join(folder,'pairing.json')
await writeFile(file,JSON.stringify(pairing),{mode:0o600})
let created=0,closed=0
const server=createCompanionServer(pairing,async()=>{created++;let alive=true;return{alive:()=>alive,close:()=>{if(alive){alive=false;closed++}},update(){}}})
await server.listen()
const client=createPipeClient(file)
try{
  await client.request({op:'open-test',id:'already-open',lease:'existing'})
  const request={op:'open-controls',id:'large-selection',lease:'new-selection',snapshot:{revision:0,title:'UTF-8 snapshot',
    controls:Array.from({length:6},(_,index)=>({key:`c${index}`,kind:'input',value:'汉'.repeat(512),placeholder:'',disabled:false,readOnly:false}))}}
  assert.equal(validCompanionRequest(request),true,'Six inputs at documented size are accepted by schema')
  const estimate={type:'request',seq:2,payload:request,proof:'0'.repeat(64)}
  const requestBytes=Buffer.byteLength(JSON.stringify(estimate)+'\n')
  let failed=false
  const concurrent=client.request({op:'list',lease:'existing'})
  try{await client.request(request)}catch(error){assert.ok(error instanceof PipeFrameSizeError);failed=true}
  assert.equal(failed,true,'Oversize must be explicitly rejected, not truncated')
  assert.equal((await concurrent).windows.length,1,'Concurrent request on the shared connection survives')
  await new Promise(resolve=>setTimeout(resolve,50))
  assert.equal(closed,0,'An oversized new selection must not close another live lease on the shared Host pipe')
  assert.equal((await client.request({op:'pulse',lease:'existing'})).windows.length,1,'Existing lease can still renew')
  const valid={...request,id:'ascii-selection',snapshot:{...request.snapshot,controls:request.snapshot.controls.map(control=>({...control,value:'a'.repeat(512)}))}}
  assert.equal((await client.request(valid)).windows.length,1,'A later bounded request reuses the working connection')
  await client.request({op:'close',id:'ascii-selection',lease:'new-selection'})
  assert.equal((await client.request({op:'list',lease:'existing'})).windows.length,1,'Closing new lease leaves the old lease intact')
  const report={date:'2026-10-04',scope:'authenticated pipe client/server fixture with protected pairing file; no Desktop source mutation',
    validSchema:true,requestUtf8Bytes:requestBytes,frameLimit:MAX_FRAME,newRequestFailed:failed,created,existingWindowsClosed:0,
    concurrentRequestSurvived:true,existingLeaseRenewed:true,boundedRequestAfterRejection:true}
  await writeFile('docs/companion-snapshot-boundary-fixed-2026-10-04.json',JSON.stringify(report,null,2)+'\n')
  console.log(JSON.stringify(report,null,2))
}finally{
  client.dispose();await server.dispose()
  await unlink(file)
  await rmdir(folder)
}
