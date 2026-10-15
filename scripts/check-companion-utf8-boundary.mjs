import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {createRequire} from 'node:module'
import {randomBytes} from 'node:crypto'
import {connect} from 'node:net'
import {writeFile} from 'node:fs/promises'

const require=createRequire(import.meta.url)
const{outputFiles}=await build({stdin:{contents:`export {createCompanionServer} from './companion/server.ts';
export {receiveFrames,sendFrame,proof,matches,MAX_FRAME} from './src/host/pipe-protocol.ts';`,resolveDir:process.cwd()},bundle:true,platform:'node',format:'cjs',write:false})
const module={exports:{}}
new Function('require','module','exports',outputFiles[0].text)(require,module,module.exports)
const{createCompanionServer,receiveFrames,sendFrame,proof,matches,MAX_FRAME}=module.exports
assert.equal(process.platform,'win32','This isolated frame fixture targets Windows')
const pairing={pipe:`\\\\.\\pipe\\dsh-better-float-${randomBytes(16).toString('hex')}`,secret:randomBytes(32).toString('hex')}
let accept
const server=createCompanionServer(pairing,async(_id,_snapshot,onIntent)=>{accept=onIntent;let alive=true;return{alive:()=>alive,close:()=>alive=false,update(){}}})
await server.listen()
const socket=connect(pairing.pipe);socket.on('error',()=>{})
let session='',next=0
let maxReplyBytes=0
const pending=new Map()
const ready=new Promise((resolve,reject)=>{
  const timeout=setTimeout(()=>reject(Error('Auth timeout')),2000)
  const nonce=randomBytes(32).toString('hex')
  receiveFrames(socket,frame=>{
    if(frame.type==='challenge'){session=`${frame.nonce}:${nonce}`;sendFrame(socket,{type:'auth',nonce,proof:proof(pairing.secret,`client:${session}`)})}
    else if(frame.type==='ready'){assert.ok(matches(pairing.secret,`server:${session}`,frame.proof));clearTimeout(timeout);resolve()}
    else if(frame.type==='reply'){
      assert.ok(matches(pairing.secret,`reply:${session}:${frame.seq}:${JSON.stringify(frame.result)}`,frame.proof))
      const bytes=Buffer.byteLength(JSON.stringify(frame)+'\n');assert.ok(bytes<=MAX_FRAME);maxReplyBytes=Math.max(maxReplyBytes,bytes)
      const task=pending.get(frame.seq);if(task){clearTimeout(task.timer);pending.delete(frame.seq);task.resolve(frame.result)}
    }
  })
})
const call=payload=>new Promise((resolve,reject)=>{
  const seq=++next,timer=setTimeout(()=>{pending.delete(seq);reject(Error('Reply timeout'))},2000)
  pending.set(seq,{resolve,reject,timer})
  sendFrame(socket,{type:'request',seq,payload,proof:proof(pairing.secret,`request:${session}:${seq}:${JSON.stringify(payload)}`)})
})
try{
  await ready
  const snapshot={revision:0,title:'UTF-8 boundary',controls:Array.from({length:3},(_,index)=>({key:`c${index}`,kind:'input',value:'',placeholder:'',disabled:false,readOnly:false}))}
  assert.equal((await call({op:'open-controls',id:'unicode',lease:'source',snapshot})).ok,true)
  const actions=[]
  for(let index=0;index<8;index++){
    const intent={key:'c0',kind:'input',value:'汉'.repeat(505+index)}
    assert.equal(accept(intent),true,'Every input is within the accepted 512-code-unit limit')
    actions.push({...intent,seq:index+1})
  }
  const result=await call({op:'sync-controls',id:'unicode',lease:'source',snapshot:{...snapshot,revision:1},ack:0})
  const body={type:'reply',seq:2,result:{ok:true,value:{version:1,testOnly:true,windows:[{id:'unicode',lease:'source'}],actions}},proof:'0'.repeat(64)}
  assert.equal(result.ok,true,'Accepted valid Unicode input burst should return a successful bounded action batch')
  assert.ok(result.value.actions.length>0 && result.value.actions.length<8,'Unicode burst is split instead of rejected or enlarged')
  let revision=1,ack=0,batches=0
  const sync=async()=>call({op:'sync-controls',id:'unicode',lease:'source',snapshot:{...snapshot,revision:++revision},ack})
  const replay=await sync()
  assert.deepEqual(replay.value.actions,result.value.actions,'Without ack, exactly the same prefix is retried')
  const delivered=[]
  let current=result
  while(current.value.actions.length){
    assert.equal(current.ok,true);assert.ok(current.value.actions.length<=8)
    for(const action of current.value.actions){assert.equal(action.seq,ack+1);delivered.push(action);ack=action.seq}
    batches++;assert.ok(batches<=8)
    current=await sync();assert.equal(current.ok,true)
  }
  assert.deepEqual(delivered,actions,'All accepted values arrive in order without truncation or coalescing')
  assert.equal((await sync()).value.actions.length,0,'Final ack clears the queue')
  const mixed=[]
  for(let index=0;index<32;index++){
    const intent={key:`c${index%3}`,kind:'input',value:['汉'.repeat(512),'😀'.repeat(256),'\u0000'.repeat(512),'\\'.repeat(512)][index%4]}
    assert.equal(accept(intent),true)
    mixed.push({...intent,seq:9+index})
  }
  assert.equal(accept({key:'c0',kind:'input',value:'queue overflow'}),false,'Queue remains bounded at 32')
  const drained=[];let mixedBatches=0
  current=await sync();assert.equal(current.ok,true)
  while(current.value.actions.length){
    for(const action of current.value.actions){assert.equal(action.seq,ack+1);drained.push(action);ack=action.seq}
    mixedBatches++;assert.ok(mixedBatches<=32)
    current=await sync();assert.equal(current.ok,true)
  }
  assert.deepEqual(drained,mixed,'Chinese, emoji and JSON escapes on multiple controls drain losslessly')
  const invalid=await call({op:'sync-controls',id:'unicode',lease:'source',snapshot:{...snapshot,revision:++revision},ack:ack+1})
  assert.equal(invalid.ok,false,'Unissued ack is rejected')
  assert.equal((await sync()).ok,true,'Invalid ack does not break the connection')
  const report={date:'2026-10-04',scope:'authenticated Named Pipe with production server/protocol and mock surface; not live Desktop UI',
    acceptedActions:actions.length,maxValueCodeUnits:512,unbatchedReplyUtf8Bytes:Buffer.byteLength(JSON.stringify(body)+'\n'),frameLimit:MAX_FRAME,
    successfulReply:result.ok,unicodeBatches:batches,retryPrefixPreserved:true,mixedActions:drained.length,mixedBatches,maxReplyBytes,queueAndAckChecksPassed:true}
  await writeFile('docs/companion-utf8-boundary-fixed-2026-10-04.json',JSON.stringify(report,null,2)+'\n')
  console.log(JSON.stringify(report,null,2))
}finally{socket.destroy();for(const task of pending.values())clearTimeout(task.timer);await server.dispose()}
