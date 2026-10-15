import assert from 'node:assert/strict'
import {readFile,writeFile,mkdir} from 'node:fs/promises'
import {createHash} from 'node:crypto'

async function attach(port,prefix){
  const targets=await(await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(2000)})).json()
  const page=targets.find(item=>item.type==='page' && item.url.startsWith(prefix))
  assert.ok(page,'Expected test page')
  const socket=new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(Error('CDP timeout')),2000);socket.addEventListener('open',()=>{clearTimeout(t);resolve()},{once:true})})
  const pending=new Map();let next=0
  socket.addEventListener('message',({data})=>{const message=JSON.parse(data);const task=pending.get(message.id);if(task){clearTimeout(task.timer);pending.delete(message.id);message.error?task.reject(Error(message.error.message)):task.resolve(message.result)}})
  const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++next,timer=setTimeout(()=>{pending.delete(id);reject(Error(method+' timeout'))},5000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}))})
  const evaluate=async expression=>{const result=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description??result.exceptionDetails.text);return result.result.value}
  return{send,evaluate,close(){for(const task of pending.values())clearTimeout(task.timer);pending.clear();socket.close()}}
}
const host=await attach(9222,'dsh-app://app/')
let popup,checks=0,keepPanel=false
const mode=process.argv[2]??'normal'
assert.ok(['normal','prepare-failure','check-failure'].includes(mode),'Unknown acceptance mode')
async function expect(client,expression,expected,label){
  for(let attempt=0;attempt<25;attempt++){
    const value=await client.evaluate(expression)
    if(JSON.stringify(value)===JSON.stringify(expected)){checks++;return}
    await new Promise(resolve=>setTimeout(resolve,200))
  }
  const diagnostics=await host.evaluate('({status:document.querySelector("[data-role=status]")?.textContent,panelTitle:document.querySelector(".dsh-bf-panel")?.getAttribute("aria-label"),visible:document.visibilityState})').catch(()=>null)
  assert.deepEqual(await client.evaluate(expression),expected,`${label}; ${JSON.stringify(diagnostics)}`)
}
async function click(client,selector){
  const point=await client.evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});if(!node)throw Error('Missing button');const r=node.getBoundingClientRect();return{x:Math.round(r.x+Math.min(20,r.width/2)),y:Math.round(r.y+r.height/2)}})()`)
  await client.send('Input.dispatchMouseEvent',{type:'mouseMoved',...point})
  for(const type of ['mousePressed','mouseReleased'])await client.send('Input.dispatchMouseEvent',{type,...point,button:'left',clickCount:1})
}
const windowCount=async()=> (await(await fetch('http://127.0.0.1:9223/json/list')).json()).filter(item=>item.type==='page').length
async function noPopup(label){
  for(let index=0;index<25;index++){if(await windowCount()===0){checks++;return}await new Promise(resolve=>setTimeout(resolve,200))}
  assert.equal(await windowCount(),0,label)
}
async function approve(){
  await click(host,'[data-action=detach]')
  await expect(host,'!!document.querySelector("[data-role=companion-confirm]")',true,'Consent is required')
  await click(host,'[data-action=companion-allow]')
  await expect(host,'document.querySelector(".dsh-bf-panel")?.dataset.companionState','connected','Approved session connects')
  popup=await attach(9223,'file:')
  await expect(popup,'!!document.querySelector("[data-control=c0]")',true,'Companion controls rendered')
}
try{
  if(mode==='check-failure'){
    await expect(host,'document.querySelector("[data-role=status]").textContent.includes("Connection lost")',true,'Companion exit shows disconnect status')
    await expect(host,'!!document.querySelector(".dsh-bf-panel [data-acceptance-target]")',true,'Original source remains in live panel')
    await click(host,'[data-action=detach]')
    await expect(host,'document.querySelector("[data-role=status]").textContent.includes("Companion is unavailable")',true,'Retry without backend fails clearly')
    await expect(host,'document.querySelector("[data-role=companion-confirm]")',null,'Unavailable backend cannot offer approval')
    await expect(host,'document.querySelector("[data-counter]").textContent','Count 0','Disconnect does not execute queued actions')
    console.log(JSON.stringify({checks,scope:'actual panel detach button after companion exit; source retained, unavailable retry has no consent or new window'},null,2))
  }else{
  assert.equal(await windowCount(),0,'Do not interfere with existing windows')
  await host.evaluate('if(!window.__BF_ACCEPTANCE__)throw Error("Expected isolated fixture");window.__BF_ACCEPTANCE__.setCount(0);window.__BF_ACCEPTANCE__.events.length=0')
  await host.evaluate('if(document.querySelector(".dsh-bf-root"))window.__BF_ACCEPTANCE__.invoke()')
  const artifact=await readFile('lib/client.js','utf8')
  const row=await host.evaluate('window.__DSH_BOOT__.entries.find(item=>item.id==="@metaone01/dsh-better-float")')
  assert.ok((await host.evaluate(`fetch(${JSON.stringify(row.url)}).then(response=>response.text())`)).startsWith(artifact.trimEnd()),'Current installed artifact');checks++
  await host.evaluate('window.__BF_ACCEPTANCE__.invoke()')
  await expect(host,'!!document.querySelector(".dsh-bf-root")',true,'Installed command opens picker')
  const point=await host.evaluate('(()=>{const r=document.querySelector("[data-counter]").getBoundingClientRect();return{x:Math.round(r.x+20),y:Math.round(r.y+r.height/2)}})()')
  await host.send('Input.dispatchMouseEvent',{type:'mouseMoved',...point})
  // A seeded hover can already point at the section after a previous run.
  // Select the exact fixture subtree, not its fixed-position outer shell.
  for(let attempt=0;attempt<4;attempt++){
    const label=await host.evaluate('document.querySelector(".dsh-bf-label").textContent')
    if(label.startsWith('section'))break
    const inward=label.startsWith('div#dsh-bf-acceptance-fixture')
    const key=inward?'ArrowDown':'ArrowUp'
    for(const type of ['keyDown','keyUp'])await host.send('Input.dispatchKeyEvent',{type,key,code:key,windowsVirtualKeyCode:inward?40:38})
    await expect(host,`document.querySelector(".dsh-bf-label").textContent !== ${JSON.stringify(label)}`,true,'Picker hierarchy step settled')
  }
  await expect(host,'document.querySelector(".dsh-bf-label").textContent.startsWith("section")',true,'Exact React fixture section selected')
  for(const type of ['mousePressed','mouseReleased'])await host.send('Input.dispatchMouseEvent',{type,...point,button:'left',clickCount:1})
  await expect(host,'!!document.querySelector(".dsh-bf-panel [data-acceptance-target]")',true,'Original React subtree is live in panel')
  await click(host,'[data-action=detach]')
  await expect(host,'!!document.querySelector("[data-role=companion-confirm]")',true,'Actual detach button presents confirmation')
  await noPopup('No OS window before consent')
  await expect(host,'document.querySelector("[data-role=companion-confirm]").textContent.includes("unsaved input")',false,'Consent does not expose input values')
  if(mode==='normal'){
    await mkdir('docs/screenshots',{recursive:true})
    const clip=await host.evaluate('(()=>{const r=document.querySelector(".dsh-bf-panel").getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,scale:1}})()')
    const screenshot=await host.send('Page.captureScreenshot',{format:'png',clip})
    await writeFile('docs/screenshots/companion-detach-consent.png',Buffer.from(screenshot.data,'base64'))
  }
  await click(host,'[data-action=companion-cancel]')
  await expect(host,'document.querySelector("[data-role=status]").textContent.includes("cancelled")',true,'Cancel feedback')
  await noPopup('Cancel opens nothing')
  await approve()
  if(mode==='prepare-failure'){
    keepPanel=true
    console.log('Prepared approved live-panel companion session for process-exit acceptance')
  }else{
  await click(popup,'[data-control=c0]')
  await expect(host,'document.querySelector("[data-counter]").textContent','Count 1','Popup action updates original React')
  await expect(popup,'document.querySelector("[data-control=c0]").textContent','Count 1','React state returns')
  await popup.evaluate('document.querySelector("[data-control=c1]").focus();document.querySelector("[data-control=c1]").select()')
  await popup.send('Input.insertText',{text:'edited through detach'})
  await expect(host,'document.querySelector("[data-state-input]").value','edited through detach','Controlled input receives popup edit')
  await click(popup,'[data-control=c0]')
  await expect(host,'document.querySelector("[data-counter]").textContent','Count 2','React rerender after edit')
  await expect(host,'document.querySelector("[data-state-input]").value','edited through detach','Input hook state survives rerender')
  await mkdir('docs/screenshots',{recursive:true})
  const controlsShot=await popup.send('Page.captureScreenshot',{format:'png'})
  await writeFile('docs/screenshots/companion-detach-controls.png',Buffer.from(controlsShot.data,'base64'))
  await click(host,'[data-action=detach]')
  await expect(host,'document.querySelector("[data-role=companion-confirm]")',null,'Connected request does not prompt/create again')
  assert.equal(await windowCount(),1,'One active popup');checks++
  await host.evaluate('document.querySelector("[data-state-input]").type="password"')
  await noPopup('Sensitive type change ends session')
  popup.close();popup=null
  await expect(host,'document.querySelector("[data-role=status]").textContent.includes("Connection lost")',true,'Disconnect feedback is explicit')
  await host.evaluate('document.querySelector("[data-state-input]").type="text"')
  await approve()
  await click(host,'.dsh-bf-panel .dsh-bf-btn:last-child')
  await noPopup('Panel close releases OS window')
  popup.close();popup=null
  await expect(host,'document.querySelector("[data-acceptance-target]").parentElement.id','dsh-bf-acceptance-fixture','Source restored on panel close')
  await expect(host,'document.querySelector("[data-state-input]").value','edited through detach','Original value preserved')
  const report={checks,date:'2026-10-04',rendererBundleSha256:createHash('sha256').update(artifact).digest('hex'),
    scope:'installed panel detach button + per-session consent + Named Pipe companion + original React; native picker command entered through diagnostic registry',
    nativeDetachButton:true,nativeShortcutVerified:false}
  await mkdir('docs/screenshots',{recursive:true})
  await writeFile('docs/companion-detach-ui-fixed-2026-10-04.json',JSON.stringify(report,null,2)+'\n')
  console.log(JSON.stringify(report,null,2))
  }
  }
}finally{
  if(!keepPanel)try{await host.evaluate('document.querySelector("[data-action=companion-cancel]")?.click();document.querySelector(".dsh-bf-panel .dsh-bf-btn:last-child")?.click();if(document.querySelector(".dsh-bf-root"))window.__BF_ACCEPTANCE__?.invoke()')}catch{}
  popup?.close();host.close()
}
