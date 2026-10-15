import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'

async function attach(port,prefix){
  const targets=await(await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(2000)})).json()
  const page=targets.find(item=>item.type==='page' && item.url.startsWith(prefix));assert.ok(page,'Dedicated test page')
  const socket=new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('CDP timeout')),2000);socket.addEventListener('open',()=>{clearTimeout(timer);resolve()},{once:true});socket.addEventListener('error',()=>{clearTimeout(timer);reject(Error('CDP connection failed'))},{once:true})})
  let next=0;const pending=new Map()
  socket.addEventListener('message',({data})=>{const message=JSON.parse(data),task=pending.get(message.id);if(task){pending.delete(message.id);clearTimeout(task.timer);message.error?task.reject(Error(message.error.message)):task.resolve(message.result)}})
  const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++next,timer=setTimeout(()=>{pending.delete(id);reject(Error(method+' timeout'))},5000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}))})
  const evaluate=async expression=>{const result=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description??result.exceptionDetails.text);return result.result.value}
  return{send,evaluate,close(){socket.close()}}
}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
const host=await attach(9222,'dsh-app://app/')
let popup,frozen=false,checks=0
const count=async()=> (await(await fetch('http://127.0.0.1:9223/json/list')).json()).filter(item=>item.type==='page').length
async function expect(client,expression,expected,label){
  for(let attempt=0;attempt<40;attempt++){const actual=await client.evaluate(expression);if(JSON.stringify(actual)===JSON.stringify(expected)){checks++;return}await sleep(150)}
  assert.deepEqual(await client.evaluate(expression),expected,label)
}
try {
  assert.equal(await count(),0,'No pre-existing companion windows')
  await expect(host,'!!window.__BF_ACCEPTANCE__ && !!document.querySelector("[data-better-float=layer]")',true,'Current plugin active')
  const artifact=await readFile('lib/client.js','utf8'),row=await host.evaluate('window.__DSH_BOOT__.entries.find(item=>item.id==="@metaone01/dsh-better-float")')
  assert.ok((await host.evaluate(`fetch(${JSON.stringify(row.url)}).then(response=>response.text())`)).startsWith(artifact.trimEnd()));checks++
  await host.evaluate('(async()=>{window.__BF_ACCEPTANCE__.setCount(0);window.__BF_BOUNDARY_VALUES__=[];const input=document.querySelector("[data-state-input]");window.__BF_BOUNDARY_LISTENER__=()=>window.__BF_BOUNDARY_VALUES__.push(input.value);input.addEventListener("input",window.__BF_BOUNDARY_LISTENER__);window.__BF_BOUNDARY_HANDLE__=await window.__BF_ACCEPTANCE__.semantic();return true})()')
  assert.equal(await count(),1);checks++
  popup=await attach(9223,'file:')
  await expect(popup,'!!document.querySelector("[data-control=c1]")',true,'Independent input ready')
  await host.send('Page.setWebLifecycleState',{state:'frozen'});frozen=true
  const accepted=await popup.evaluate('(async()=>{const results=[];for(let index=0;index<8;index++)results.push(await window.floatControls.action({key:"c1",kind:"input",value:"汉".repeat(505+index)}));return results})()')
  assert.deepEqual(accepted,Array(8).fill(true));checks++
  await host.send('Page.setWebLifecycleState',{state:'active'});frozen=false
  const values=Array.from({length:8},(_,index)=>'汉'.repeat(505+index))
  await expect(host,'window.__BF_BOUNDARY_VALUES__',values,'Every queued Unicode edit executes once in source React')
  await expect(host,'document.querySelector("[data-state-input]").value',values.at(-1),'Final hook input value')
  await expect(popup,'document.querySelector("[data-control=c1]").value',values.at(-1),'Source state syncs back to popup')
  const failure=await host.evaluate('(async()=>{window.__BF_BOUNDARY_BRIDGE__=window.__BF_ACCEPTANCE__.companion();return window.__BF_BOUNDARY_BRIDGE__.openControls("oversized-selection",{revision:0,title:"Oversized",controls:Array.from({length:6},(_,index)=>({key:`c${index}`,kind:"input",value:"汉".repeat(512),placeholder:"",disabled:false,readOnly:false}))})})()')
  assert.equal(failure.ok,false);assert.equal(failure.error.code,'companion/frame-too-large');checks++
  assert.equal(await count(),1,'Existing independent window survives another lease oversized request');checks++
  const point=await popup.evaluate('(()=>{const r=document.querySelector("[data-control=c0]").getBoundingClientRect();return{x:Math.round(r.x+20),y:Math.round(r.y+r.height/2)}})()')
  for(const type of ['mousePressed','mouseReleased'])await popup.send('Input.dispatchMouseEvent',{type,...point,button:'left',clickCount:1})
  await expect(host,'document.querySelector("[data-counter]").textContent','Count 1','Trusted popup click still reaches source after local rejection')
  await expect(host,'document.querySelector("[data-state-input]").value',values.at(-1),'React rerender preserves input hook state')
  assert.equal((await host.evaluate('window.__BF_BOUNDARY_BRIDGE__.ping()')).ok,true);checks++
  await sleep(1000);assert.equal(await count(),1,'Live semantic lease continues renewing');checks++
  await host.evaluate('window.__BF_BOUNDARY_HANDLE__.close();window.__BF_BOUNDARY_BRIDGE__.dispose()')
  for(let index=0;index<30 && await count();index++)await sleep(100)
  assert.equal(await count(),0);checks++
  const report={date:'2026-10-04',checks,rendererBundleSha256:createHash('sha256').update(artifact).digest('hex'),
    scope:'real isolated installed Host/Renderer, original React fixture and sandbox companion; semantic diagnostic entry, not consent/global drag',
    unicodeActionsDeliveredOnce:8,unicodeValueCodeUnits:512,oversizeError:failure.error.code,otherLeaseWindowSurvived:true,postRejectionTrustedClick:true}
  await writeFile('docs/companion-boundaries-dsh-fixed-2026-10-04.json',JSON.stringify(report,null,2)+'\n')
  console.log(JSON.stringify(report,null,2))
}finally{
  if(frozen)await host.send('Page.setWebLifecycleState',{state:'active'}).catch(()=>{})
  await host.evaluate('window.__BF_BOUNDARY_HANDLE__?.close();window.__BF_BOUNDARY_BRIDGE__?.dispose();document.querySelector("[data-state-input]")?.removeEventListener("input",window.__BF_BOUNDARY_LISTENER__);delete window.__BF_BOUNDARY_HANDLE__;delete window.__BF_BOUNDARY_BRIDGE__;delete window.__BF_BOUNDARY_LISTENER__;delete window.__BF_BOUNDARY_VALUES__').catch(()=>{})
  popup?.close();host.close()
}
