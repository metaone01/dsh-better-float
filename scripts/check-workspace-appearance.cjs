const{app,BrowserWindow}=require('electron')
const{build}=require('esbuild')
const{join,resolve}=require('node:path')
const{randomBytes,createHash}=require('node:crypto')
const{mkdtempSync}=require('node:fs')
const{mkdir,writeFile,readFile}=require('node:fs/promises')
const assert=require('node:assert/strict')
const root=resolve(__dirname,'..'),folder=mkdtempSync(join(root,'.dsh-debug-userdata-workspace-appearance-'))
app.setPath('userData',join(folder,'electron'));app.on('window-all-closed',()=>{})
const timeout=setTimeout(()=>{console.error('Workspace appearance timed out');app.exit(1)},60000)
app.whenReady().then(async()=>{
 let source,popup,manager,server,client,checks=0,revision=0,ack=0,boundaries,screenshotComparisons=[]
 const test=async(name,run)=>{await run();checks++;console.log('PASS '+name)}
 const pause=()=>new Promise(resolve=>setTimeout(resolve,120))
 try{
  const{outputFiles}=await build({stdin:{contents:`export {createCompanionWindows} from './companion/window-manager.ts';export {createCompanionServer} from './companion/server.ts';export {createPipeClient} from './src/host/pipe-client.ts';export {protectPairingDirectory} from './src/host/pairing-security.ts';`,resolveDir:root},bundle:true,platform:'node',format:'cjs',write:false,external:['electron']})
  const module={exports:{}};new Function('require','module','exports',outputFiles[0].text)(require,module,module.exports);const api=module.exports
  const credentials=join(folder,'credentials');await mkdir(credentials);await api.protectPairingDirectory(credentials)
  const separator=String.fromCharCode(92)
  const pairing={pipe:[separator+separator+'.','pipe',`dsh-better-float-${randomBytes(16).toString('hex')}`].join(separator),secret:randomBytes(32).toString('hex')}
  const file=join(credentials,'pairing.json');await writeFile(file,JSON.stringify(pairing),{mode:0o600})
  manager=api.createCompanionWindows(join(root,'lib','companion'),false);server=api.createCompanionServer(pairing,(...args)=>manager.open(...args));await server.listen();client=api.createPipeClient(file)
  source=new BrowserWindow({width:640,height:700,show:false,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}})
  await source.loadURL('data:text/html,<html><body></body></html>')
  const browser=await build({entryPoints:[join(__dirname,'workspace-appearance-browser-cases.mjs')],bundle:true,write:false,format:'iife',globalName:'WorkspaceVisual'})
  await source.webContents.executeJavaScript(browser.outputFiles[0].text)
  const ev=expression=>source.webContents.executeJavaScript(expression,true)
  await test('safe vectors, hidden content, metadata and oversized-decoration retry boundaries',async()=>{boundaries=await ev('WorkspaceVisual.boundaries()');assert.equal(boundaries.checks,18)})
  const snapshot=await ev('WorkspaceVisual.fixture()');await client.request({op:'open-controls',id:'visual',lease:'source',snapshot})
  popup=BrowserWindow.getAllWindows().find(w=>w!==source);const pe=expression=>popup.webContents.executeJavaScript(expression,true)
  const sync=async()=>{const next=await ev(`WorkspaceVisual.read(${++revision})`);const result=await client.request({op:'sync-controls',id:'visual',lease:'source',snapshot:next,ack});for(const action of result.actions??[]){if(action.seq<=ack)continue;ack=action.seq;await ev(`WorkspaceVisual.apply(${JSON.stringify(action)})`)}return next}
  const click=async key=>{await pause();const point=await pe(`(()=>{const n=document.querySelector('[data-control="${key}"]');n.scrollIntoView();const r=n.getBoundingClientRect();return{x:Math.round(r.x+20),y:Math.round(r.y+r.height/2)}})()`);for(const type of ['mouseDown','mouseUp'])popup.webContents.sendInputEvent({type,...point,button:'left',clickCount:1});await pause();await sync();await sync();await pause()}
  const compare=async(name)=>{
    await pe('scrollTo(0,0)');await pause()
    const original=await ev('WorkspaceVisual.rootRect()'),copy=await pe('(()=>{const r=document.querySelector("#controls").getBoundingClientRect();return{x:r.x,y:r.y,width:268,height:350}})()')
    // Compare only the exported header and first three rows, not non-exported rows or the auxiliary footer.
    const crop=r=>({x:Math.floor(r.x),y:Math.floor(r.y),width:268,height:144})
    const before=await source.webContents.capturePage(crop(original)),after=await popup.webContents.capturePage(crop(copy))
    const left=before.toBitmap(),right=after.toBitmap();assert.deepEqual(before.getSize(),after.getSize())
    let different=0;for(let pixel=0;pixel<left.length;pixel+=4)if(!left.subarray(pixel,pixel+4).equals(right.subarray(pixel,pixel+4)))different++
    const result={name,differentPixels:different,totalPixels:left.length/4,ratio:different/(left.length/4)};screenshotComparisons.push(result);console.log(JSON.stringify(result))
    await writeFile(join(root,'docs','screenshots',`workspace-appearance-source-${name}.png`),before.toPNG());await writeFile(join(root,'docs','screenshots',`workspace-appearance-popup-${name}.png`),after.toPNG())
    assert.ok(result.ratio<=0.005,`Appearance pixel difference ${result.ratio}`)
  }
  await test('light theme keeps title, timestamp, indentation, background and safe SVG geometry',async()=>{
    await pause();assert.equal(await pe('document.body.dataset.appearance'),'captured');assert.equal(await pe('document.querySelector("[data-control=c3]").textContent'),'');assert.ok((await pe('document.querySelector("[data-control=c3]").getAttribute("aria-label")')).includes('Default workspace'))
    assert.equal(await pe('document.querySelectorAll("#scene svg").length'),1);assert.equal((await ev('WorkspaceVisual.eventLog()')).length,0)
    await compare('light')
  })
  await test('theme updates and reload preserve captured scene without source actions',async()=>{await ev('WorkspaceVisual.theme(true)');await sync();await pause();await compare('dark');popup.webContents.reload();await pause();await pause();assert.equal(await pe('document.body.dataset.appearance'),'captured');assert.equal(await pe('document.querySelectorAll("#scene svg").length'),1);assert.equal((await ev('WorkspaceVisual.eventLog()')).length,0)})
  await test('scene overlay does not intercept row actions or replay them',async()=>{await click('c3');assert.equal((await ev('WorkspaceVisual.state()')).expanded,false);await click('c3');assert.equal((await ev('WorkspaceVisual.state()')).expanded,true);await click('c5');assert.equal((await ev('WorkspaceVisual.state()')).selected,1);assert.equal((await ev('WorkspaceVisual.eventLog()')).length,3);assert.ok((await ev('WorkspaceVisual.eventLog()')).every(e=>!e.trusted))})
  await test('paging shifts source row geometry without source events and input still searches',async()=>{const before=(await ev('WorkspaceVisual.eventLog()')).length;await click('c2');assert.equal((await ev('WorkspaceVisual.eventLog()')).length,before);assert.ok((await pe('document.querySelector("#scene").textContent')).includes('Session 2'));await pe('document.querySelector("input").focus()');popup.webContents.insertText('Session 4');await pause();await sync();await sync();await pause();assert.equal((await ev('WorkspaceVisual.state()')).query,'Session 4');assert.ok((await pe('document.querySelector("#scene").textContent')).includes('Session 4'))})
  await test('explicit fallback restores visible semantic labels and omits decoration',async()=>{const next=await ev(`WorkspaceVisual.read(${++revision})`);delete next.scene;delete next.workspaceVisual;next.appearance={mode:'fallback',reason:'budget'};await client.request({op:'sync-controls',id:'visual',lease:'source',snapshot:next,ack});await pause();assert.equal(await pe('document.body.dataset.appearance'),'fallback');assert.ok((await pe('document.querySelector("[data-control=c3]").textContent')).includes('Session 4'));assert.equal(await pe('document.querySelector("#scene").childElementCount'),0)})
  const hash=async file=>createHash('sha256').update(await readFile(join(root,file))).digest('hex')
  const companionRuntimeHashes=Object.fromEntries(await Promise.all(['main.cjs','preload.cjs','controls-renderer.js','controls-window.html','controls.css'].map(async file=>[file,await hash(`lib/companion/${file}`)])))
  const report={executedAt:new Date().toISOString(),checks,boundaryAssertions:boundaries.checks,screenshotComparisons,scope:'Electron fixture + authenticated Named Pipe + native popup input; not actual DSH or default profile',rendererBundleSha256:await hash('lib/client.js'),hostBundleSha256:await hash('lib/index.js'),companionRuntimeHashes,popupVisualAcceptancePending:true}
  await writeFile(join(root,'docs','companion-workspace-appearance-acceptance-2026-10-11.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2))
 }catch(error){console.error(error);app.exitCode=1}
 finally{await server?.dispose();manager?.dispose();source?.destroy();clearTimeout(timeout);app.exit(app.exitCode??0)}
})
