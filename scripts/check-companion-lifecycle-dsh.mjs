import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'

const stage=process.argv[2]??'cycles'
assert.ok(['cycles','prepare','background','freeze','reload'].includes(stage),'Unknown lifecycle stage')
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
const reportFile='docs/companion-lifecycle-fixed-2026-10-04.json'
async function attach(port,prefix){
  const targets=await(await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(2000)})).json()
  const page=targets.find(item=>item.type==='page' && item.url.startsWith(prefix))
  assert.ok(page,'Expected isolated page target')
  const socket=new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('CDP connection timeout')),2000);socket.addEventListener('open',()=>{clearTimeout(timer);resolve()},{once:true});socket.addEventListener('error',()=>{clearTimeout(timer);reject(Error('CDP connection failed'))},{once:true})})
  let next=0;const pending=new Map()
  socket.addEventListener('message',({data})=>{const message=JSON.parse(data);const task=pending.get(message.id);if(task){pending.delete(message.id);clearTimeout(task.timer);message.error?task.reject(Error(message.error.message)):task.resolve(message.result)}})
  socket.addEventListener('close',()=>{for(const task of pending.values()){clearTimeout(task.timer);task.reject(Error('Target disconnected'))}pending.clear()})
  const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++next,timer=setTimeout(()=>{pending.delete(id);reject(Error(method+' timeout'))},5000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}))})
  const evaluate=async expression=>{const result=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description??result.exceptionDetails.text);return result.result.value}
  return{send,evaluate,close(){socket.close()}}
}
const host=await attach(9222,'dsh-app://app/')
let checks=0,leaveSession=false,frozen=false
let popup
const countWindows=async()=> (await(await fetch('http://127.0.0.1:9223/json/list',{signal:AbortSignal.timeout(2000)})).json()).filter(item=>item.type==='page').length
async function expect(expression,expected,label){
  for(let attempt=0;attempt<30;attempt++){
    const actual=await host.evaluate(expression)
    if(JSON.stringify(actual)===JSON.stringify(expected)){checks++;return}
    await sleep(150)
  }
  assert.deepEqual(await host.evaluate(expression),expected,label)
}
async function closed(label){
  for(let attempt=0;attempt<70;attempt++){if(await countWindows()===0){checks++;return}await sleep(150)}
  assert.equal(await countWindows(),0,label)
}
async function open(){
  await host.evaluate('(async()=>{if(window.__BF_SOAK_HANDLE__)throw Error("Session already open");window.__BF_SOAK_HANDLE__=await window.__BF_ACCEPTANCE__.semantic();return true})()')
  assert.equal(await countWindows(),1,'One independent controls window');checks++
}
async function close(){
  await host.evaluate('window.__BF_SOAK_HANDLE__?.close();delete window.__BF_SOAK_HANDLE__')
  await closed('Explicit close reclaims window')
}
try{
  await expect('!!window.__BF_ACCEPTANCE__ && !!document.querySelector("[data-better-float=layer]")',true,'Boot and fixture active')
  const artifact=await readFile('lib/client.js','utf8')
  const row=await host.evaluate('window.__DSH_BOOT__.entries.find(item=>item.id==="@metaone01/dsh-better-float")')
  assert.ok((await host.evaluate(`fetch(${JSON.stringify(row.url)}).then(response=>response.text())`)).startsWith(artifact.trimEnd()),'Current installed client artifact');checks++
  const observations={}
  if(stage==='cycles'){
    assert.equal(await countWindows(),0,'No pre-existing companion windows')
    const source=await host.evaluate('({identity:!!document.querySelector("[data-acceptance-target]"),anchors:document.querySelectorAll("dsh-float-anchor").length})')
    for(let cycle=0;cycle<20;cycle++){
      await open();await close()
      if(cycle%5===4)console.log(`Lifecycle churn: ${cycle+1}/20 completed`)
    }
    await expect('document.querySelectorAll("dsh-float-anchor").length',source.anchors,'No structural anchor leaks')
    await expect('!!document.querySelector("[data-acceptance-target]")?.isConnected',true,'Source still connected after churn')
    observations.cycles=20
  }else if(stage==='prepare'){
    assert.equal(await countWindows(),0,'No pre-existing companion windows')
    await open();leaveSession=true
    observations.readyForBackground=true
  }else if(stage==='background'){
    await expect('document.visibilityState','hidden','Actual source document is hidden')
    const seconds=Number(process.argv[3]??360)
    assert.ok(seconds>=20 && seconds<=600,'Expected bounded background observation')
    const samples=[]
    const started=performance.now()
    while(performance.now()-started<seconds*1000){
      await sleep(5000)
      const count=await countWindows()
      const visibility=await host.evaluate('document.visibilityState')
      samples.push({elapsedSeconds:Math.round((performance.now()-started)/1000),windows:count,visibility})
      if(samples.length%3===0)console.log(`Background: ${samples.at(-1).elapsedSeconds}s, windows=${count}, visibility=${visibility}`)
      if(count===0)break
    }
    observations.durationSeconds=Math.round((performance.now()-started)/1000)
    observations.samples=samples
    observations.remainedConnected=samples.length>0 && samples.every(sample=>sample.windows===1 && sample.visibility==='hidden')
    observations.note=observations.remainedConnected?'Bounded soak passed; not overnight acceptance':'Window was reclaimed or source visibility changed; not a continuous-background pass'
    await expect('!!document.querySelector("[data-acceptance-target]")?.isConnected',true,'Source intact after background observation')
    leaveSession=true
  }else if(stage==='freeze'){
    if(await countWindows()===0){await host.evaluate('window.__BF_SOAK_HANDLE__?.close();delete window.__BF_SOAK_HANDLE__');await open()}
    await host.send('Page.setWebLifecycleState',{state:'frozen'});frozen=true
    await sleep(11500)
    assert.equal(await countWindows(),0,'Frozen source cannot renew its window lease');checks++
    await host.send('Page.setWebLifecycleState',{state:'active'});frozen=false
    await sleep(600)
    await expect('!!document.querySelector("[data-acceptance-target]")?.isConnected',true,'Original source survives freeze')
    await sleep(1200)
    assert.equal(await countWindows(),0,'Resume cannot silently recreate a window or replay old actions');checks++
    await host.evaluate('window.__BF_SOAK_HANDLE__?.close();delete window.__BF_SOAK_HANDLE__')
    await open();await close()
    observations.frozenSeconds=11.5
    observations.explicitReopenPassed=true
  }else if(stage==='reload'){
    assert.equal(await countWindows(),0,'No pre-existing windows')
    await open()
    await host.send('Page.reload',{ignoreCache:true})
    await closed('Page unload reclaims companion window')
    await expect('!!window.__BF_ACCEPTANCE__ && !!document.querySelector("[data-better-float=layer]")',true,'Reload activates plugin again')
    assert.equal(await countWindows(),0,'Reload does not reconnect automatically');checks++
    observations.reloaded=true
  }
  let report
  try{report=JSON.parse(await readFile(reportFile,'utf8'))}catch{report={date:'2026-10-04',scope:'isolated installed plugin and host React fixture; semantic diagnostic API, not native keyboard or global drag',stages:{}}}
  report.rendererBundleSha256=createHash('sha256').update(artifact).digest('hex')
  report.stages[stage]={checks,...observations}
  await writeFile(reportFile,JSON.stringify(report,null,2)+'\n')
  console.log(JSON.stringify({stage,checks,...observations,samples:observations.samples?`stored ${observations.samples.length} samples`:undefined},null,2))
}finally{
  if(frozen)await host.send('Page.setWebLifecycleState',{state:'active'}).catch(()=>{})
  if(!leaveSession)await host.evaluate('window.__BF_SOAK_HANDLE__?.close();delete window.__BF_SOAK_HANDLE__').catch(()=>{})
  popup?.close();host.close()
}
