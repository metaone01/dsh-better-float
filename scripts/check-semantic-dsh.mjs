import assert from 'node:assert/strict'
import {readFile,writeFile,mkdir} from 'node:fs/promises'
import {createHash} from 'node:crypto'

async function attach(port,prefix){
  const targets=await(await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(2000)})).json()
  const page=targets.find(item=>item.type==='page' && item.url.startsWith(prefix))
  assert.ok(page,'Expected isolated DSH or companion controls page')
  const socket=new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('CDP connect timeout')),2000);socket.addEventListener('open',()=>{clearTimeout(timer);resolve()},{once:true})})
  const pending=new Map();let next=0
  socket.addEventListener('message',({data})=>{const message=JSON.parse(data);const task=pending.get(message.id);if(task){pending.delete(message.id);clearTimeout(task.timer);message.error?task.reject(Error(message.error.message)):task.resolve(message.result)}})
  const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++next;const timer=setTimeout(()=>{pending.delete(id);reject(Error(method+' timeout'))},5000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}))})
  const evaluate=async expression=>{const result=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description??result.exceptionDetails.text);return result.result.value}
  return{send,evaluate,close(){for(const task of pending.values())clearTimeout(task.timer);pending.clear();socket.close()}}
}
const host=await attach(9222,'dsh-app://app/')
let popup,checks=0
const wait=async(client,expression,expected,label)=>{
  for(let attempt=0;attempt<20;attempt++){
    const value=await client.evaluate(expression)
    if(JSON.stringify(value)===JSON.stringify(expected)){checks++;return}
    await new Promise(resolve=>setTimeout(resolve,200))
  }
  assert.deepEqual(await client.evaluate(expression),expected,label)
}
try{
  const targets=await(await fetch('http://127.0.0.1:9223/json/list')).json()
  assert.equal(targets.filter(item=>item.type==='page').length,0,'Do not interfere with existing companion windows')
  await host.evaluate('if(!window.__BF_ACCEPTANCE__?.semantic)throw Error("Expected isolated fixture");window.__BF_ACCEPTANCE__.setCount(0);window.__BF_ACCEPTANCE__.events.length=0')
  const row=await host.evaluate('window.__DSH_BOOT__.entries.find(item=>item.id==="@metaone01/dsh-better-float")')
  const served=await host.evaluate(`fetch(${JSON.stringify(row.url)}).then(response=>response.text())`)
  const artifact=await readFile('lib/client.js','utf8')
  assert.ok(served.startsWith(artifact.trimEnd()),'Final current plugin artifact required');checks++
  await host.evaluate('(async()=>{window.__BF_SEMANTIC__=await window.__BF_ACCEPTANCE__.semantic();return true})()')
  popup=await attach(9223,'file:')
  await wait(popup,'!!document.querySelector("[data-control=c0]")',true,'Control initialized')
  await wait(host,'!!document.querySelector("[data-acceptance-target]")?.isConnected',true,'Original source remains connected')
  const point=await popup.evaluate('(()=>{const r=document.querySelector("[data-control=c0]").getBoundingClientRect();return{x:Math.round(r.x+30),y:Math.round(r.y+r.height/2)}})()')
  for(const type of ['mousePressed','mouseReleased'])await popup.send('Input.dispatchMouseEvent',{type,...point,button:'left',clickCount:1})
  await wait(host,'document.querySelector("[data-counter]").textContent','Count 1','Popup click reaches original React hook')
  await wait(popup,'document.querySelector("[data-control=c0]").textContent','Count 1','React state returns to companion')
  await wait(host,'window.__BF_ACCEPTANCE__.events',['button:false','ancestor'],'One synthetic original event; no business-action replay')
  for(let index=0;index<3;index++)for(const type of ['mousePressed','mouseReleased'])await popup.send('Input.dispatchMouseEvent',{type,...point,button:'left',clickCount:1})
  await wait(host,'document.querySelector("[data-counter]").textContent','Count 4','Repeated clicks delivered once each')
  await wait(popup,'document.querySelector("[data-control=c0]").textContent','Count 4','Repeated state updates return')
  await wait(host,'window.__BF_ACCEPTANCE__.events.length',8,'No duplicate actions after acknowledgement')
  await host.evaluate('document.querySelector("[data-counter]").disabled=true')
  await wait(popup,'document.querySelector("[data-control=c0]").disabled',true,'Disabled propagated')
  await wait(popup,'floatControls.action({kind:"click",key:"c0"})',false,'Disabled intent rejected by owner')
  await wait(host,'document.querySelector("[data-counter]").textContent','Count 4','Disabled action does not run business handler')
  await host.evaluate('document.querySelector("[data-counter]").disabled=false')
  await popup.evaluate('document.querySelector("[data-control=c1]").focus();document.querySelector("[data-control=c1]").select()')
  await popup.send('Input.insertText',{text:'edited in companion'})
  await wait(host,'document.querySelector("[data-state-input]").value','edited in companion','Popup input reaches React controlled onChange')
  for(const type of ['mousePressed','mouseReleased'])await popup.send('Input.dispatchMouseEvent',{type,...point,button:'left',clickCount:1})
  await wait(host,'document.querySelector("[data-counter]").textContent','Count 5','React rerender after input')
  await wait(host,'document.querySelector("[data-state-input]").value','edited in companion','Edited input survives React rerender: hook state, not only DOM value')
  await wait(popup,'document.querySelector("[data-control=c0]").textContent','Count 5','Rerendered state returns')
  await popup.evaluate('document.querySelector("[data-control=c1]").blur()')
  await host.evaluate('window.__BF_ACCEPTANCE__.update()')
  await wait(popup,'document.querySelector("[data-control=c1]").value','external update','External React update returns to popup')
  await host.evaluate('document.querySelector("[data-state-input]").readOnly=true')
  await wait(popup,'document.querySelector("[data-control=c1]").readOnly',true,'Readonly propagated')
  await wait(popup,'floatControls.action({kind:"input",key:"c1",value:"not allowed"})',false,'Readonly intent rejected by owner')
  await wait(host,'document.querySelector("[data-state-input]").value','external update','Readonly source remains unchanged')
  await mkdir('docs/screenshots',{recursive:true})
  const screenshot=await popup.send('Page.captureScreenshot',{format:'png'})
  await writeFile('docs/screenshots/companion-controls-dsh.png',Buffer.from(screenshot.data,'base64'))
  await host.evaluate('window.__BF_ACCEPTANCE__.unmount()')
  popup.close();popup=null
  let reclaimed=false
  for(let index=0;index<20;index++){
    const current=await(await fetch('http://127.0.0.1:9223/json/list')).json()
    if(current.filter(item=>item.type==='page').length===0){reclaimed=true;break}
    await new Promise(resolve=>setTimeout(resolve,200))
  }
  assert.ok(reclaimed,'React source unmount reclaims actual companion window');checks++
  const report={checks,date:'2026-10-03',rendererBundleSha256:createHash('sha256').update(artifact).digest('hex'),
    scope:'final installed DSH plugin -> credential ACL -> authenticated pipe -> companion preload -> original React; diagnostic fixture entry',
    nativeDetachButton:false,sourceEventsTrusted:false,screenshot:'docs/screenshots/companion-controls-dsh.png'}
  await writeFile('docs/companion-controls-acceptance.json',JSON.stringify(report,null,2)+'\n')
  console.log(JSON.stringify(report,null,2))
}finally{
  try{await host.evaluate('window.__BF_SEMANTIC__?.close();delete window.__BF_SEMANTIC__')}catch{}
  popup?.close();host.close()
}
