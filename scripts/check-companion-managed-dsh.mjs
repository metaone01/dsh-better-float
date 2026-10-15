import assert from 'node:assert/strict'
import {readFile,writeFile,lstat} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {connectIsolatedDsh} from './isolated-dsh-cdp.mjs'
const owned=await connectIsolatedDsh();owned.close()

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))
const targets=await(await fetch('http://127.0.0.1:9222/json/list')).json()
const page=targets.find(item=>item.type==='page'&&item.url.startsWith('dsh-app://app/'));assert.ok(page)
const socket=new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('CDP connect timeout')),2000);socket.addEventListener('open',()=>{clearTimeout(timer);resolve()},{once:true})})
let next=0,checks=0;const pending=new Map()
socket.addEventListener('message',({data})=>{const message=JSON.parse(data),task=pending.get(message.id);if(task){pending.delete(message.id);clearTimeout(task.timer);message.error?task.reject(Error(message.error.message)):task.resolve(message.result)}})
const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++next,timer=setTimeout(()=>{pending.delete(id);reject(Error(method+' timeout'))},18000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}))})
const evaluate=async expression=>{const result=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description??result.exceptionDetails.text);return result.result.value}
async function expect(expression,expected,label){for(let index=0;index<100;index++){if(JSON.stringify(await evaluate(expression))===JSON.stringify(expected)){checks++;return}await pause(100)}assert.deepEqual(await evaluate(expression),expected,label)}
async function click(selector){
  const point=await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:Math.round(r.x+Math.min(20,r.width/2)),y:Math.round(r.y+r.height/2)}})()`)
  await send('Input.dispatchMouseEvent',{type:'mouseMoved',...point})
  for(const type of ['mousePressed','mouseReleased'])await send('Input.dispatchMouseEvent',{type,...point,button:'left',clickCount:1})
}
const pairingFile='.dsh-debug-userdata-companion/credentials/pairing.json'
async function absent(){for(let index=0;index<100;index++){try{await lstat(pairingFile)}catch(error){if(error.code==='ENOENT'){checks++;return}throw error}await pause(100)}throw Error('Managed credentials did not clear')}
try{
  await assert.rejects(lstat(pairingFile),{code:'ENOENT'});checks++
  await expect('!!window.__BF_ACCEPTANCE__ && !!document.querySelector("[data-better-float=layer]")',true,'Plugin active without companion')
  await send('Page.reload',{ignoreCache:true})
  await expect('!!window.__BF_ACCEPTANCE__ && !!document.querySelector("[data-better-float=layer]")',true,'Fresh fixture resets picker hover state')
  assert.equal(await evaluate('window.__BF_ACCEPTANCE__.semantic().then(handle=>{handle.close();return false},()=>true)'),true,'Full iframe fixture must fail closed');checks++
  await evaluate('window.__BF_ACCEPTANCE__.limited()')
  const artifact=await readFile('lib/client.js'),row=await evaluate('window.__DSH_BOOT__.entries.find(item=>item.id==="@metaone01/dsh-better-float")')
  assert.ok((await evaluate(`fetch(${JSON.stringify(row.url)}).then(response=>response.text())`)).startsWith(artifact.toString().trimEnd()));checks++
  await evaluate('window.__BF_ACCEPTANCE__.invoke()')
  const point=await evaluate('(()=>{const r=document.querySelector("[data-counter]").getBoundingClientRect();return{x:Math.round(r.x+20),y:Math.round(r.y+r.height/2)}})()')
  await send('Input.dispatchMouseEvent',{type:'mouseMoved',...point})
  for(let attempt=0;attempt<5;attempt++){
    const label=await evaluate('document.querySelector(".dsh-bf-label").textContent')
    if(label.startsWith('section'))break
    const inward=label.startsWith('div#dsh-bf-acceptance-fixture'),key=inward?'ArrowDown':'ArrowUp'
    for(const type of ['keyDown','keyUp'])await send('Input.dispatchKeyEvent',{type,key,code:key,windowsVirtualKeyCode:inward?40:38})
    await pause(150)
  }
  await expect('document.querySelector(".dsh-bf-label").textContent.startsWith("section")',true,'Exact fixture section')
  for(const type of ['mousePressed','mouseReleased'])await send('Input.dispatchMouseEvent',{type,...point,button:'left',clickCount:1})
  await expect('!!document.querySelector(".dsh-bf-panel [data-acceptance-target]")',true,'Original subtree in panel')
  await click('[data-action=detach]')
  await expect('!!document.querySelector("[data-role=companion-confirm]")',true,'First click starts backend and presents consent')
  assert.ok((await lstat(pairingFile)).isFile());checks++
  await click('[data-action=companion-cancel]')
  await expect('document.querySelector("[data-role=status]").textContent.includes("cancelled")',true,'Cancellation feedback')
  // No window was created: startup grace eventually releases the helper.
  await pause(7000);await absent()
  await click('[data-action=detach]')
  await expect('!!document.querySelector("[data-role=companion-confirm]")',true,'New click can start again')
  await pause(7000);await absent()
  assert.equal(await evaluate('!!document.querySelector("[data-role=companion-confirm]")'),true);checks++
  await click('[data-action=companion-allow]')
  await expect('document.querySelector(".dsh-bf-panel").dataset.companionState','connected','Approval after idle exit restarts and opens window')
  await click('.dsh-bf-panel .dsh-bf-btn:last-child')
  await expect('document.querySelector("[data-acceptance-target]").parentElement.id','dsh-bf-acceptance-fixture','Panel close restores source')
  await absent()
  await evaluate('(async()=>{window.__BF_MANAGED_HANDLE__=await window.__BF_ACCEPTANCE__.semantic();return true})()')
  assert.ok((await lstat(pairingFile)).isFile());checks++
  await evaluate('window.__BF_MANAGED_HANDLE__.close();delete window.__BF_MANAGED_HANDLE__')
  await absent()
  const companionRuntimeHashes=Object.fromEntries(await Promise.all(['main.cjs','preload.cjs','controls-renderer.js','controls-window.html','controls.css'].map(async file=>[file,createHash('sha256').update(await readFile(`lib/companion/${file}`)).digest('hex')])))
  const report={date:'2026-10-05',executedAt:new Date().toISOString(),checks,rendererBundleSha256:createHash('sha256').update(artifact).digest('hex'),hostBundleSha256:createHash('sha256').update(await readFile('lib/index.js')).digest('hex'),companionRuntimeHashes,
    scope:'isolated installed Host + real React fixture + trusted CDP panel/consent input + real managed companion, no debug port on helper',
    lazyStart:true,cancelIdleExit:true,delayedConsentRecovery:true,lastPanelCloseExit:true,nextDemandReopens:true,unsupportedIframeRejected:true,nativeShortcutVerified:false}
  await writeFile('docs/companion-managed-dsh-acceptance-2026-10-05.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2))
}finally{
  await evaluate('window.__BF_MANAGED_HANDLE__?.close();document.querySelector("[data-action=companion-cancel]")?.click();document.querySelector(".dsh-bf-panel .dsh-bf-btn:last-child")?.click();if(document.querySelector(".dsh-bf-root"))window.__BF_ACCEPTANCE__?.invoke()').catch(()=>{})
  socket.close()
}
