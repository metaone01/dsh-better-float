import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {createRequire} from 'node:module'
import {randomBytes} from 'node:crypto'
import {connect} from 'node:net'
const require=createRequire(import.meta.url)
const {outputFiles}=await build({stdin:{contents:`export {createCompanionServer} from './companion/server.ts';
export {receiveFrames,sendFrame,proof} from './src/host/pipe-protocol.ts';
export {validSnapshot,validIntent} from './src/shared/control-adapter.ts';`,resolveDir:process.cwd()},bundle:true,platform:'node',format:'cjs',write:false})
const module={exports:{}}
new Function('require','module','exports',outputFiles[0].text)(require,module,module.exports)
const {createCompanionServer,receiveFrames,sendFrame,proof,validSnapshot,validIntent}=module.exports
const snapshot={revision:0,title:'Controls',controls:[{key:'c0',kind:'button',text:'Count 0',disabled:false},
  {key:'c1',kind:'input',value:'draft',placeholder:'Text',disabled:false,readOnly:false}]}
let checks=0
const test=async(label,run)=>{await run();checks++;console.log('PASS '+label)}
await test('snapshot and intents are strictly bounded',()=>{
  assert.equal(validSnapshot(snapshot),true)
  assert.equal(validSnapshot({...snapshot,revision:-1}),false)
  assert.equal(validSnapshot({...snapshot,controls:[snapshot.controls[0],snapshot.controls[0]]}),false)
  assert.equal(validSnapshot({...snapshot,controls:[{...snapshot.controls[1],value:'x'.repeat(513)}]}),false)
  assert.equal(validIntent({kind:'input',key:'c1',value:'text'}),true)
  assert.equal(validIntent({kind:'exec',key:'c0'}),false)
})
// This fixture tests the pipe protocol only. It never reads a pairing file or
// bypasses production credential ACL checks; the random key remains in memory.
const pairing={pipe:`\\\\.\\pipe\\dsh-better-float-${randomBytes(16).toString('hex')}`,secret:randomBytes(32).toString('hex')}
if(process.platform!=='win32')throw Error('This protocol fixture currently targets Windows')
let intent,updated,closed=0
const server=createCompanionServer(pairing,async(_id,initial,accept)=>{
  intent=accept;updated=initial;let alive=true
  return{alive:()=>alive,close:()=>{if(alive){alive=false;closed++}},update:next=>updated=next}
})
await server.listen()
const socket=connect(pairing.pipe)
socket.on('error',()=>{})
let session='',seq=0
const tasks=new Map()
const ready=new Promise((resolve,reject)=>{
  const timeout=setTimeout(()=>reject(Error('handshake timeout')),2000)
  const nonce=randomBytes(32).toString('hex')
  receiveFrames(socket,frame=>{
    if(frame.type==='challenge') {session=`${frame.nonce}:${nonce}`;sendFrame(socket,{type:'auth',nonce,proof:proof(pairing.secret,`client:${session}`)})}
    else if(frame.type==='ready'){clearTimeout(timeout);resolve()}
    else if(frame.type==='reply') {const task=tasks.get(frame.seq);if(task){clearTimeout(task.timer);tasks.delete(frame.seq);task.resolve(frame.result)}}
  })
})
const call=payload=>new Promise((resolve,reject)=>{
  const id=++seq,timer=setTimeout(()=>{tasks.delete(id);reject(Error('request timeout'))},2000)
  tasks.set(id,{resolve,reject,timer})
  sendFrame(socket,{type:'request',seq:id,payload,proof:proof(pairing.secret,`request:${session}:${id}:${JSON.stringify(payload)}`)})
})
try {
  await ready
  await test('semantic window receives only declarative initial state',async()=>{
    assert.equal((await call({op:'open-controls',id:'one',lease:'source',snapshot})).ok,true)
    assert.deepEqual(updated,snapshot)
  })
  await test('click and input actions are correlated and sequential',async()=>{
    assert.equal(intent({kind:'click',key:'c0'}),true)
    assert.equal(intent({kind:'input',key:'c1',value:'edited'}),true)
    const result=await call({op:'sync-controls',id:'one',lease:'source',snapshot:{...snapshot,revision:1},ack:0})
    assert.deepEqual(result.value.actions,[{kind:'click',key:'c0',seq:1},{kind:'input',key:'c1',value:'edited',seq:2}])
  })
  await test('lost response can be replayed until source acknowledges without losing actions',async()=>{
    const repeat=await call({op:'sync-controls',id:'one',lease:'source',snapshot:{...snapshot,revision:2},ack:0})
    assert.equal(repeat.value.actions.length,2)
    const ack=await call({op:'sync-controls',id:'one',lease:'source',snapshot:{...snapshot,revision:3},ack:2})
    assert.deepEqual(ack.value.actions,[])
  })
  await test('future or regressing acknowledgements and snapshots are rejected',async()=>{
    assert.equal((await call({op:'sync-controls',id:'one',lease:'source',snapshot:{...snapshot,revision:4},ack:99})).ok,false)
    assert.equal((await call({op:'sync-controls',id:'one',lease:'source',snapshot:{...snapshot,revision:2},ack:2})).ok,false)
    assert.equal((await call({op:'sync-controls',id:'one',lease:'source',snapshot:{...snapshot,revision:4},ack:1})).ok,false)
  })
  await test('other leases cannot update the content or receive actions',async()=>{
    const result=await call({op:'sync-controls',id:'one',lease:'other',snapshot:{...snapshot,revision:9},ack:0})
    assert.equal(result.value.actions,undefined);assert.equal(updated.revision,3)
  })
  await test('readOnly/disabled state blocks control intents',async()=>{
    const disabled={...snapshot,revision:4,controls:snapshot.controls.map(control=>({...control,disabled:true}))}
    await call({op:'sync-controls',id:'one',lease:'source',snapshot:disabled,ack:2})
    assert.equal(intent({kind:'click',key:'c0'}),false)
    assert.equal(intent({kind:'input',key:'c1',value:'bad'}),false)
  })
  await test('display-only scene never accepts native control intents',async()=>{
    const display={revision:0,title:'Display',controls:[],scene:{items:[{key:'v0',text:'Static span',placement:{x:0,y:0,width:100,height:24},style:0}],styles:[{color:'black'}],displayOnly:true}}
    assert.equal(validSnapshot(display),true)
    let displayIntent
    const originalFactoryIntent=intent
    assert.equal((await call({op:'open-controls',id:'display',lease:'display',snapshot:display})).ok,true)
    displayIntent=intent;assert.equal(displayIntent({kind:'click',key:'c0'}),false);assert.equal(displayIntent({kind:'input',key:'c0',value:'bad'}),false)
    await call({op:'close',id:'display',lease:'display'})
    intent=originalFactoryIntent
  })
  await test('bounded queue refuses overflow and response batches fit frame limit',async()=>{
    await call({op:'sync-controls',id:'one',lease:'source',snapshot:{...snapshot,revision:5},ack:2})
    for(let index=0;index<32;index++)assert.equal(intent({kind:'input',key:'c1',value:'x'.repeat(512)}),true)
    assert.equal(intent({kind:'click',key:'c0'}),false)
    const result=await call({op:'sync-controls',id:'one',lease:'source',snapshot:{...snapshot,revision:6},ack:2})
    assert.equal(result.value.actions.length,8)
  })
  await test('explicit close releases surface and rejects late intents',async()=>{
    await call({op:'close',id:'one',lease:'source'})
    assert.equal(closed,2);assert.equal(intent({kind:'click',key:'c0'}),false)
  })
  console.log(`${checks} semantic protocol checks passed; credential ACL and live DSH adapter acceptance are separate gates.`)
}finally{socket.destroy();for(const task of tasks.values())clearTimeout(task.timer);await server.dispose()}
