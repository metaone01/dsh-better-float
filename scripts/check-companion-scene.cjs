const{app,BrowserWindow}=require('electron')
const{build}=require('esbuild')
const{join,resolve}=require('node:path')
const{randomBytes,createHash}=require('node:crypto')
const{mkdtempSync}=require('node:fs')
const{mkdir,writeFile,readFile}=require('node:fs/promises')
const assert=require('node:assert/strict')
const root=resolve(__dirname,'..'),folder=mkdtempSync(join(root,'.dsh-debug-userdata-scene-'))
app.setPath('userData',join(folder,'electron'));app.on('window-all-closed',()=>{})
const timeout=setTimeout(()=>{console.error('Scene acceptance timed out');app.exit(1)},40000)
app.whenReady().then(async()=>{
 let source,manager,server,client,checks=0,boundaries
 const test=async(name,run)=>{await run();checks++;console.log('PASS '+name)}
 try{
  const{outputFiles}=await build({stdin:{contents:`export {createCompanionWindows} from './companion/window-manager.ts';export {createCompanionServer} from './companion/server.ts';export {createPipeClient} from './src/host/pipe-client.ts';export {protectPairingDirectory} from './src/host/pairing-security.ts';export {validSnapshot} from './src/shared/control-adapter.ts';`,resolveDir:root},bundle:true,platform:'node',format:'cjs',write:false,external:['electron']})
  const module={exports:{}};new Function('require','module','exports',outputFiles[0].text)(require,module,module.exports);const api=module.exports
  const credentials=join(folder,'credentials');await mkdir(credentials);await api.protectPairingDirectory(credentials)
  const pairing={pipe:`\\\\.\\pipe\\dsh-better-float-${randomBytes(16).toString('hex')}`,secret:randomBytes(32).toString('hex')}
  const file=join(credentials,'pairing.json');await writeFile(file,JSON.stringify(pairing),{mode:0o600})
  manager=api.createCompanionWindows(join(root,'lib','companion'),false);server=api.createCompanionServer(pairing,(...args)=>manager.open(...args));await server.listen();client=api.createPipeClient(file)
  source=new BrowserWindow({width:600,height:550,show:false,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}})
  await source.loadURL('data:text/html,<html><body></body></html>')
  const browser=await build({entryPoints:[join(__dirname,'scene-browser-cases.mjs')],bundle:true,write:false,format:'iife',globalName:'SceneFixture'})
  await source.webContents.executeJavaScript(browser.outputFiles[0].text)
  const evalSource=expression=>source.webContents.executeJavaScript(expression,true)
  await evalSource('SceneFixture.fixture()');let snapshot=await evalSource('SceneFixture.read(0)'),revision=0,ack=0
  await test('workspace-like source captures static text, SVG buttons and standalone folder icon',async()=>{
   assert.equal(api.validSnapshot(snapshot),true);assert.equal(snapshot.controls.length,3);assert.ok(snapshot.controls.every(control=>control.icon))
   assert.ok(snapshot.scene.items.some(item=>item.text==='工作区'));assert.ok(snapshot.scene.items.some(item=>item.text==='默认工作区'));assert.ok(snapshot.scene.items.some(item=>item.text==='新会话'))
   assert.equal(snapshot.scene.displayOnly,true);assert.ok(snapshot.scene.items.some(item=>item.icon))
   assert.deepEqual(await evalSource('SceneFixture.counts()'),{clicks:0,displayClicks:0})
  })
  await client.request({op:'open-controls',id:'scene',lease:'source',snapshot})
  const popup=BrowserWindow.getAllWindows().find(window=>window!==source),evalPopup=expression=>popup.webContents.executeJavaScript(expression,true)
  const settle=()=>new Promise(resolve=>setTimeout(resolve,120));await settle()
  const sync=async()=>{snapshot=await evalSource(`SceneFixture.read(${++revision})`);return client.request({op:'sync-controls',id:'scene',lease:'source',snapshot,ack})}
  await test('real popup is populated, scene geometry matches, and read-only boundary is visible',async()=>{
   assert.match(await evalPopup('document.title'),/Preview \/ 预览/u)
   const rendered=await evalPopup('({text:document.querySelector("#scene").textContent,icons:document.querySelectorAll("#controls svg").length,buttons:document.querySelectorAll("#controls button").length,status:document.querySelector("#status").textContent,node:typeof require})')
   assert.ok(rendered.text.includes('工作区') && rendered.text.includes('新会话'));assert.equal(rendered.icons,4);assert.equal(rendered.buttons,3);assert.ok(rendered.status.includes('仅展示'));assert.equal(rendered.node,'undefined')
   for(const item of snapshot.scene.items){const rect=await evalPopup(`(()=>{const n=document.querySelector('[data-scene="${item.key}"]'),r=n.getBoundingClientRect(),p=document.querySelector('#controls').getBoundingClientRect();return{x:r.left-p.left,y:r.top-p.top,width:r.width}})()`);assert.ok(Math.abs(rect.x-item.placement.x)<0.05 && Math.abs(rect.y-item.placement.y)<0.05);assert.ok(Math.abs(rect.width-item.placement.width)<0.05)}
   await writeFile(join(root,'docs','screenshots','companion-workspace-scene-fixed.png'),(await popup.webContents.capturePage()).toPNG())
  })
  await test('native SVG button action returns over authenticated pipe exactly once',async()=>{
   const point=await evalPopup('(()=>{const r=document.querySelector("[data-control=c0]").getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()')
   for(const type of ['mouseMove','mouseDown','mouseUp'])popup.webContents.sendInputEvent({type,...point,button:'left',clickCount:1})
   await settle();const result=await sync();assert.equal(result.actions.length,1)
   await evalSource(`SceneFixture.apply(${JSON.stringify(result.actions[0])})`);ack=result.actions[0].seq
   assert.equal((await sync()).actions.length,0);assert.deepEqual(await evalSource('SceneFixture.counts()'),{clicks:1,displayClicks:0})
  })
  await test('static role=button presentation never forwards an action',async()=>{
   const key=snapshot.scene.items.find(item=>item.text==='新会话').key
   const point=await evalPopup(`(()=>{const r=document.querySelector('[data-scene="${key}"]').getBoundingClientRect();return{x:Math.round(r.x+10),y:Math.round(r.y+10)}})()`)
   for(const type of ['mouseDown','mouseUp'])popup.webContents.sendInputEvent({type,...point,button:'left',clickCount:1})
   await settle();assert.equal((await sync()).actions.length,0)
   assert.equal(await evalPopup(`floatControls.action({kind:'click',key:'${key}'})`),false)
   assert.deepEqual(await evalSource('SceneFixture.counts()'),{clicks:1,displayClicks:0})
  })
  await test('static text/theme changes and popup reload preserve scene',async()=>{
   await evalSource('SceneFixture.mutate()');await sync();await settle()
   assert.ok((await evalPopup('document.querySelector("#scene").textContent')).includes('更新后的工作区'))
   assert.equal(await evalPopup('getComputedStyle(document.body).backgroundColor'),'rgb(45, 50, 60)')
   assert.equal(await evalPopup('document.querySelector("[data-control=c0]").getAttribute("aria-label")'),'搜索已更新')
   popup.webContents.reload();await settle();await settle()
   assert.match(await evalPopup('document.title'),/Preview \/ 预览/u)
   assert.ok((await evalPopup('document.querySelector("#scene").textContent')).includes('更新后的工作区'));assert.equal(await evalPopup('document.querySelectorAll("#controls svg").length'),4)
  })
  await test('standalone span opens as display-only and cannot send business actions',async()=>{
   const span=await evalSource('SceneFixture.captureSpan()');assert.equal(api.validSnapshot(span),true);assert.equal(span.controls.length,0)
   await client.request({op:'open-controls',id:'span',lease:'span',snapshot:span});await settle()
   const win=BrowserWindow.getAllWindows().find(window=>window!==source&&window!==popup)
   assert.equal(await win.webContents.executeJavaScript('document.body.dataset.presentation',true),'display-only')
   assert.ok((await win.webContents.executeJavaScript('document.querySelector("#scene").textContent',true)).includes('更新后的工作区'))
   assert.equal(await win.webContents.executeJavaScript('floatControls.action({kind:"click",key:"c0"})',true),false)
   await writeFile(join(root,'docs','screenshots','companion-span-display-fixed.png'),(await win.webContents.capturePage()).toPNG())
   await client.request({op:'close',id:'span',lease:'span'})
  })
  await test('unsupported and unsafe content fails preflight rather than opening empty window',async()=>{
   const result=await evalSource('(()=>{try{return {value:SceneFixture.boundaries()}}catch(error){return {error:error.message,stack:error.stack}}})()')
   if(result.error)throw Error(result.stack)
   boundaries=result.value;assert.equal(boundaries.checks,26)
  })
  await test('appearance fallback keeps static text and vector icons readable in default layout',async()=>{
   snapshot=await evalSource(`SceneFixture.read(${++revision})`)
   await client.request({op:'sync-controls',id:'scene',lease:'source',snapshot:{...snapshot,appearance:{mode:'fallback',reason:'budget'}},ack});await settle()
   const fallback=await evalPopup('(()=>{const node=document.querySelector("#scene span"),shape=document.querySelector("#scene svg path"),style=getComputedStyle(node);return{color:style.color,body:getComputedStyle(document.body).color,position:style.position,stroke:getComputedStyle(shape).stroke}})()')
   assert.equal(fallback.color,fallback.body);assert.equal(fallback.position,'relative');assert.equal(fallback.stroke,fallback.body)
   const button=await evalPopup('(()=>{const n=document.querySelector("[data-control=c0]"),r=n.querySelector("svg").getBoundingClientRect();return{color:getComputedStyle(n).color,stroke:getComputedStyle(n.querySelector("path")).stroke,width:r.width,height:r.height,label:n.querySelector(".icon-label").textContent,labelVisible:getComputedStyle(n.querySelector(".icon-label")).display!=="none"}})()')
   assert.equal(button.stroke,button.color)
   assert.ok(button.width>0 && button.height>0 && button.width<=24 && button.height<=24,'fallback icon must stay bounded')
   assert.equal(button.label,'搜索已更新');assert.equal(button.labelVisible,true)
  })
  await client.request({op:'close',id:'scene',lease:'source'})
  const hash=async name=>createHash('sha256').update(await readFile(join(root,name))).digest('hex')
  const runtimeFiles=['main.cjs','preload.cjs','controls-renderer.js','controls-window.html','controls.css']
  const companionRuntimeHashes=Object.fromEntries(await Promise.all(runtimeFiles.map(async file=>[file,await hash(`lib/companion/${file}`)])))
  const report={date:'2026-10-05',executedAt:new Date().toISOString(),checks,boundaryAssertions:boundaries.checks,scope:'isolated real Electron source/popup + authenticated Named Pipe; test launcher --no-sandbox; not installed default DSH acceptance',staticText:true,safeSvg:true,spanDisplayOnly:true,nativeActionsExactlyOnce:true,roleButtonDisplayOnly:true,reload:true,
   rendererBundleSha256:await hash('lib/client.js'),hostBundleSha256:await hash('lib/index.js'),companionBundleSha256:await hash('lib/companion/main.cjs'),companionRuntimeHashes}
  await writeFile(join(root,'docs','companion-scene-acceptance-2026-10-05.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));app.exitCode=0
 }catch(error){console.error(error);app.exitCode=1}
 finally{clearTimeout(timeout);client?.dispose();await server?.dispose();manager?.dispose();source?.destroy();app.exit(app.exitCode??0)}
})
