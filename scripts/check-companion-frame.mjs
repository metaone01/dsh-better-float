import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {build} from 'esbuild'
import {createRequire} from 'node:module'
import {randomBytes} from 'node:crypto'
import {mkdtemp,writeFile,unlink,rmdir} from 'node:fs/promises'
import {join,resolve} from 'node:path'

const require=createRequire(import.meta.url)
const {outputFiles}=await build({stdin:{contents:`export {frameBytes,sendFrame,receiveFrames,proof,MAX_FRAME,PipeFrameSizeError} from './src/host/pipe-protocol.ts';
export {createPipeClient} from './src/host/pipe-client.ts';export {protectPairingDirectory} from './src/host/pairing-security.ts';`,resolveDir:process.cwd()},bundle:true,platform:'node',format:'cjs',write:false})
const load=net=>{const module={exports:{}};new Function('require','module','exports',outputFiles[0].text)(id=>id==='node:net'&&net?net:require(id),module,module.exports);return module.exports}
const {frameBytes,sendFrame,receiveFrames,proof,MAX_FRAME,PipeFrameSizeError,protectPairingDirectory}=load()
let checks=0
const test=async(name,run)=>{await run();checks++;console.log(`PASS ${name}`)}
await test('complete frame including newline accepts exactly 8192 bytes',()=>{
  const frame='a'.repeat(MAX_FRAME-3),socket={writableLength:0,write(wire){assert.equal(Buffer.byteLength(wire),MAX_FRAME)}}
  assert.equal(frameBytes(frame),MAX_FRAME);sendFrame(socket,frame)
  assert.throws(()=>sendFrame(socket,frame+'a'),PipeFrameSizeError)
})
await test('receiver uses the same complete-frame byte limit',()=>{
  const socket=new EventEmitter();let received=0,destroyed=false
  socket.destroy=()=>{socket.destroyed=true;destroyed=true}
  receiveFrames(socket,()=>received++)
  const prefix='{"v":"',suffix='"}\n'
  const bounded=prefix+'a'.repeat(MAX_FRAME-Buffer.byteLength(prefix+suffix))+suffix
  socket.emit('data',Buffer.from(bounded));assert.equal(received,1);assert.equal(destroyed,false)
  socket.emit('data',Buffer.from(bounded.replace('"}\n','a"}\n')));assert.equal(received,1);assert.equal(destroyed,true)
})
const folder=await mkdtemp(resolve('.dsh-debug-userdata-frame-check-'))
await protectPairingDirectory(folder)
const file=join(folder,'pairing.json'),pairing={pipe:`\\\\.\\pipe\\dsh-better-float-${randomBytes(16).toString('hex')}`,secret:randomBytes(32).toString('hex')}
await writeFile(file,JSON.stringify(pairing),{mode:0o600})
let socket,connections=0,client
class FakeSocket extends EventEmitter {
  writableLength=0;destroyed=false;session='';challenge=randomBytes(32).toString('hex')
  constructor(){super();queueMicrotask(()=>this.emit('data',Buffer.from(JSON.stringify({type:'challenge',version:1,nonce:this.challenge})+'\n')))}
  write(wire){
    const frame=JSON.parse(wire)
    if(frame.type==='auth'){
      this.session=`${this.challenge}:${frame.nonce}`
      queueMicrotask(()=>this.emit('data',Buffer.from(JSON.stringify({type:'ready',proof:proof(pairing.secret,`server:${this.session}`)})+'\n')))
    }else{
      const result={ok:true,value:{version:1,testOnly:true,windows:[]}}
      queueMicrotask(()=>this.emit('data',Buffer.from(JSON.stringify({type:'reply',seq:frame.seq,result,proof:proof(pairing.secret,`reply:${this.session}:${frame.seq}:${JSON.stringify(result)}`)})+'\n')))
    }
  }
  destroy(){this.destroyed=true;this.emit('close')}
}
try {
  client=load({connect(){connections++;socket=new FakeSocket();return socket}}).createPipeClient(file)
  await client.request({op:'ping'})
  await test('backpressure rejects only current requests and releases their pending slots',async()=>{
    socket.writableLength=MAX_FRAME*16+1
    for(let index=0;index<20;index++)await assert.rejects(client.request({op:'ping'}),/backpressure/)
    assert.equal(socket.destroyed,false);assert.equal(connections,1)
    socket.writableLength=0
    await Promise.all(Array.from({length:16},()=>client.request({op:'ping'})))
    assert.equal(connections,1)
  })
  console.log(`${checks} complete-frame/backpressure checks passed; backpressure uses a signed fake socket.`)
}finally{client?.dispose();await unlink(file);await rmdir(folder)}
