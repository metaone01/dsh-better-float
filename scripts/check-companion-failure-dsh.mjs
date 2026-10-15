import assert from 'node:assert/strict'
const mode=process.argv[2]
assert.ok(['prepare','disconnected'].includes(mode),'Expected prepare or disconnected')
const targets=await(await fetch('http://127.0.0.1:9222/json/list')).json()
const page=targets.find(target=>target.url==='dsh-app://app/')
assert.ok(page,'Isolated DSH page required')
const socket=new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('CDP timeout')),2000);socket.addEventListener('open',()=>{clearTimeout(timer);resolve()},{once:true})})
const pending=new Map();let next=0
socket.addEventListener('message',({data})=>{const message=JSON.parse(data);const task=pending.get(message.id);if(task){pending.delete(message.id);clearTimeout(task.timer);message.error?task.reject(Error(message.error.message)):task.resolve(message.result)}})
const call=expression=>new Promise((resolve,reject)=>{const id=++next,timer=setTimeout(()=>{pending.delete(id);reject(Error('Evaluation timeout'))},5000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression,awaitPromise:true,returnByValue:true}}))}).then(result=>{if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description??result.exceptionDetails.text);return result.result.value})
try{
  if(mode==='prepare') {
    const result=await call('(async()=>{if(!window.__BF_ACCEPTANCE__?.semantic)throw Error("Expected isolated fixture");if(window.__BF_SEMANTIC__)throw Error("Already active");window.__BF_SEMANTIC__=await window.__BF_ACCEPTANCE__.semantic();return {source:document.querySelector("[data-acceptance-target]").isConnected,panel:window.__BF_SEMANTIC__.id}})()')
    assert.equal(result.source,true);console.log('Prepared active semantic window for companion disconnect acceptance')
  } else {
    await new Promise(resolve=>setTimeout(resolve,600))
    const result=await call('(async()=>{const bridge=window.__BF_ACCEPTANCE__.companion();const start=performance.now();const response=await bridge.ping();bridge.dispose();return {active:!!document.querySelector("[data-better-float=layer]"),source:!!document.querySelector("[data-acceptance-target]")?.isConnected,ok:response.ok,code:response.ok?null:response.error.code,elapsedMs:performance.now()-start}})()')
    assert.equal(result.active,true);assert.equal(result.source,true);assert.equal(result.ok,false);assert.ok(result.elapsedMs<3000)
    await call('window.__BF_SEMANTIC__?.close();delete window.__BF_SEMANTIC__')
    console.log(JSON.stringify({checks:4,...result,scope:'companion stopped; installed DSH and original source remain alive'},null,2))
  }
}finally{for(const task of pending.values())clearTimeout(task.timer);pending.clear();socket.close()}
