const{app,BrowserWindow}=require('electron')
const{build}=require('esbuild')
const{join,resolve}=require('node:path')
const{randomBytes,createHash}=require('node:crypto')
const{mkdtempSync}=require('node:fs')
const{mkdir,writeFile,readFile}=require('node:fs/promises')
const assert=require('node:assert/strict')
const root=resolve(__dirname,'..'),folder=mkdtempSync(join(root,'.dsh-debug-userdata-workspace-'))
app.setPath('userData',join(folder,'electron'));app.on('window-all-closed',()=>{})
const timeout=setTimeout(()=>{console.error('Workspace acceptance timed out');app.exit(1)},45000)
app.whenReady().then(async()=>{
 let source,manager,server,client,checks=0,boundaries,ack=0,revision=0
 const test=async(name,run)=>{await run();checks++;console.log('PASS '+name)}
 try{
  const{outputFiles}=await build({stdin:{contents:`export {createCompanionWindows} from './companion/window-manager.ts';export {createCompanionServer} from './companion/server.ts';export {createPipeClient} from './src/host/pipe-client.ts';export {protectPairingDirectory} from './src/host/pairing-security.ts';`,resolveDir:root},bundle:true,platform:'node',format:'cjs',write:false,external:['electron']})
  const module={exports:{}};new Function('require','module','exports',outputFiles[0].text)(require,module,module.exports);const api=module.exports
  const credentials=join(folder,'credentials');await mkdir(credentials);await api.protectPairingDirectory(credentials)
  const pairing={pipe:`\\\\.\\pipe\\dsh-better-float-${randomBytes(16).toString('hex')}`,secret:randomBytes(32).toString('hex')}
  const file=join(credentials,'pairing.json');await writeFile(file,JSON.stringify(pairing),{mode:0o600})
  manager=api.createCompanionWindows(join(root,'lib','companion'),false);server=api.createCompanionServer(pairing,(...args)=>manager.open(...args));await server.listen();client=api.createPipeClient(file)
  source=new BrowserWindow({width:640,height:700,show:false,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}})
  await source.loadURL('data:text/html,<html><body></body></html>')
  const browser=await build({entryPoints:[join(__dirname,'workspace-browser-cases.mjs')],bundle:true,write:false,format:'iife',globalName:'WorkspaceFixture'})
  await source.webContents.executeJavaScript(browser.outputFiles[0].text)
  const ev=expression=>source.webContents.executeJavaScript(expression,true)
  await test('workspace recognition, privacy, replacement, dynamic rows and bounds',async()=>{boundaries=await ev('WorkspaceFixture.boundaryChecks()');assert.equal(boundaries.checks,30)})
  const snapshot=await ev('WorkspaceFixture.fixture()');await client.request({op:'open-controls',id:'workspace',lease:'source',snapshot})
  const popup=BrowserWindow.getAllWindows().find(w=>w!==source),pe=expression=>popup.webContents.executeJavaScript(expression,true)
  const pause=()=>new Promise(resolve=>setTimeout(resolve,150))
  const sync=async()=>{const result=await client.request({op:'sync-controls',id:'workspace',lease:'source',snapshot:await ev(`WorkspaceFixture.read(${++revision})`),ack});for(const action of result.actions??[]){if(action.seq<=ack)continue;ack=action.seq;await ev(`WorkspaceFixture.apply(${JSON.stringify(action)})`)}return result}
  const click=async key=>{await pause();const point=await pe(`(()=>{const n=document.querySelector('[data-control="${key}"]');n.scrollIntoView();const r=n.getBoundingClientRect();return{x:Math.round(r.x+20),y:Math.round(r.y+r.height/2)}})()`);for(const type of ['mouseDown','mouseUp'])popup.webContents.sendInputEvent({type,...point,button:'left',clickCount:1});await pause();await sync();await sync();await pause()}
  await test('popup is a bounded six-control workspace projection with clear limits',async()=>{await pause();assert.equal(await pe('document.body.dataset.adapter'),'workspace-v1');assert.equal(await pe('document.querySelectorAll("#controls input,#controls button").length'),6);assert.ok((await pe('document.querySelector("#status").textContent')).includes('拖放'));await writeFile(join(root,'docs','screenshots','workspace-adapter-fixture.png'),(await popup.webContents.capturePage()).toPNG())})
  await test('native popup row click collapses and expands source tree',async()=>{await click('c3');assert.equal((await ev('WorkspaceFixture.sourceState()')).expanded,false);await click('c3');assert.equal((await ev('WorkspaceFixture.sourceState()')).expanded,true)})
  await test('native popup page change is local and session selection fires once',async()=>{const before=(await ev('WorkspaceFixture.eventLog()')).length;await click('c2');assert.equal((await ev('WorkspaceFixture.eventLog()')).length,before);await click('c3');assert.equal((await ev('WorkspaceFixture.sourceState()')).selected,2);assert.equal((await ev('WorkspaceFixture.eventLog()')).filter(e=>e.kind==='select').length,1)})
  await test('server rejects missing/stale binding and preserves action binding',async()=>{const old=await pe('document.querySelector("[data-control=c3]").dataset.binding');assert.equal(await pe('window.floatControls.action({key:"c3",kind:"click"})'),false);assert.equal(await pe('window.floatControls.action({key:"c3",kind:"click",binding:"stale_binding"})'),false);assert.equal((await sync()).actions.length,0);assert.ok(old.length>=8)})
  await test('native popup text input opens source search and forwards only supported query',async()=>{await pe('document.querySelector("input").focus()');popup.webContents.insertText('Session 4');await pause();await sync();await sync();assert.equal((await ev('WorkspaceFixture.sourceState()')).query,'Session 4');await click('c3');assert.equal((await ev('WorkspaceFixture.sourceState()')).selected,4)})
  await test('reload rehydrates bound controls without firing source actions',async()=>{const before=(await ev('WorkspaceFixture.eventLog()')).length;popup.webContents.reload();await pause();assert.equal(await pe('document.body.dataset.adapter'),'workspace-v1');assert.ok(await pe('document.querySelector("input").dataset.binding'));assert.equal((await ev('WorkspaceFixture.eventLog()')).length,before)})
  await client.request({op:'close',id:'workspace',lease:'source'})
  const hash=async file=>createHash('sha256').update(await readFile(join(root,file))).digest('hex')
  const companionRuntimeHashes=Object.fromEntries(await Promise.all(['main.cjs','preload.cjs','controls-renderer.js','controls-window.html','controls.css'].map(async file=>[file,await hash(`lib/companion/${file}`)])))
  const report={executedAt:new Date().toISOString(),checks,boundaryAssertions:boundaries.checks,scope:'real Electron source/popup fixture + authenticated production Named Pipe and window manager + native popup input; test launcher --no-sandbox; not installed DSH',rendererBundleSha256:await hash('lib/client.js'),hostBundleSha256:await hash('lib/index.js'),companionRuntimeHashes}
  await writeFile(join(root,'docs','companion-workspace-acceptance-2026-10-11.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));app.exitCode=0
 }catch(error){console.error(error);app.exitCode=1}
 finally{clearTimeout(timeout);client?.dispose();await server?.dispose();manager?.dispose();source?.destroy();app.exit(app.exitCode??0)}
})
