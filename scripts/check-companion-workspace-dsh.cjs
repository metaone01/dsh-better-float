const{app,BrowserWindow}=require('electron')
const{build}=require('esbuild')
const{join,resolve}=require('node:path')
const{randomBytes,createHash}=require('node:crypto')
const{mkdtempSync}=require('node:fs')
const{readFile,writeFile,unlink}=require('node:fs/promises')
const assert=require('node:assert/strict')
const throughPanel=process.argv.includes('--through-panel')
const root=resolve(__dirname,'..'),folder=mkdtempSync(join(root,'.dsh-debug-userdata-workspace-dsh-'))
app.setPath('userData',join(folder,'electron'));app.on('window-all-closed',()=>{})
const timeout=setTimeout(()=>{console.error('Installed workspace acceptance timed out');app.exit(1)},90000)
app.whenReady().then(async()=>{
 let cdp,manager,server,pairing,credentialOwned=false,checks=0,sourceEvents,intentLog=[],snapshotLog=[],durableSessionReuse=false,appearanceEvidence
 const credentialFile=join(root,'.dsh-debug-userdata-companion','credentials','pairing.json')
 const test=async(name,run)=>{await run();checks++;console.log('PASS '+name)}
 try{
  cdp=await(await import('./isolated-dsh-cdp.mjs')).connectIsolatedDsh();const ev=cdp.evaluate
  await ev(`(()=>{const sidebar=document.querySelector('[data-sidebar-collapsed="true"]');if(sidebar)sidebar.querySelector('[data-slot="sidebar"] button[aria-keyshortcuts="Control+B"]')?.click()})()`)
  const disk=await readFile(join(root,'lib','client.js'),'utf8'),row=await ev('window.__DSH_BOOT__.entries.find(x=>x.id==="@metaone01/dsh-better-float")')
  assert.ok((await ev(`fetch(${JSON.stringify(row.url)}).then(r=>r.text())`)).startsWith(disk.trimEnd()),'Current plugin must be installed and served')
  assert.equal(await ev('typeof window.__BF_ACCEPTANCE__.seedWorkspaceSessions'),'function')
  const{outputFiles}=await build({stdin:{contents:`export {createCompanionWindows} from './companion/window-manager.ts';export {createCompanionServer} from './companion/server.ts';export {protectPairingDirectory} from './src/host/pairing-security.ts';`,resolveDir:root},bundle:true,platform:'node',format:'cjs',write:false,external:['electron']})
  const module={exports:{}};new Function('require','module','exports',outputFiles[0].text)(require,module,module.exports);const api=module.exports
  const browser=await build({stdin:{contents:`export {captureControls} from './src/detach/semantic-adapter.ts'`,resolveDir:root},bundle:true,write:false,format:'iife',globalName:'WorkspaceDiagnostic'})
  await ev(browser.outputFiles[0].text)
  await assert.rejects(readFile(credentialFile),{code:'ENOENT'})
  pairing={pipe:`\\\\.\\pipe\\dsh-better-float-${randomBytes(16).toString('hex')}`,secret:randomBytes(32).toString('hex')}
  manager=api.createCompanionWindows(join(root,'lib','companion'),false);server=api.createCompanionServer(pairing,async(id,snapshot,onIntent)=>{
    const surface=await manager.open(id,snapshot,intent=>{const accepted=onIntent(intent);intentLog.push({...intent,accepted});return accepted})
    return{...surface,update:next=>{snapshotLog.push(next.controls.find(control=>control.key==='c3'));if(snapshotLog.length>4)snapshotLog.shift();surface.update(next)}}
  });await server.listen()
  await api.protectPairingDirectory(join(root,'.dsh-debug-userdata-companion','credentials'))
  await writeFile(credentialFile,JSON.stringify(pairing),{flag:'wx',mode:0o600});credentialOwned=true
  const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))
  const wait=async(expression,expected,label)=>{for(let i=0;i<60;i++){const value=await ev(expression);if(JSON.stringify(value)===JSON.stringify(expected))return;await pause(100)}assert.deepEqual(await ev(expression),expected,label)}
  const sourceClick=async selector=>{
    await ev(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`);await pause(100)
    const point=await ev(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:Math.round(r.x+Math.min(20,r.width/2)),y:Math.round(r.y+r.height/2)}})()`)
    const visible=await ev(`(()=>{const n=document.elementFromPoint(${point.x},${point.y});return !!n?.closest(${JSON.stringify(selector)})})()`)
    if(!visible)console.log('CLICK GEOMETRY',JSON.stringify(await ev(`(()=>{const n=document.querySelector(${JSON.stringify(selector)}),rows=[];for(let p=n;p;p=p.parentElement){const s=getComputedStyle(p);rows.push({tag:p.tagName,classes:p.className,rect:p.getBoundingClientRect().toJSON(),position:s.position,overflow:s.overflow,display:s.display,flexShrink:s.flexShrink})}return{selector:${JSON.stringify(selector)},point:${JSON.stringify(point)},hit:document.elementFromPoint(${point.x},${point.y})?.outerHTML.slice(0,500),rows}})()`)))
    assert.equal(visible,true,'Source click target is actually visible and unobstructed')
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',...point})
    for(const type of ['mousePressed','mouseReleased'])await cdp.send('Input.dispatchMouseEvent',{type,...point,button:'left',clickCount:1})
  }
  if(process.argv.includes('--require-existing-seed')){
    await wait(`['0','1','2'].every(index=>[...document.querySelectorAll('[data-row-key^="session:"]')].some(row=>row.getAttribute('data-row-key')==='session:session-bf-workspace-20261011-ws-'+index && row.textContent.includes('BF Acceptance '+index)))`,true,'All offline sessions resume before seed endpoint is called')
    durableSessionReuse=true
  }
  await test('isolated real Host seeds three balanced offline journals without model submission',async()=>{const ids=await ev('window.__BF_ACCEPTANCE__.seedWorkspaceSessions()');assert.equal(ids.length,3);await wait(`document.querySelectorAll('[data-row-key^="session:"]').length >= 3`,true,'Seeded sessions visible')})
  await test('recognized actual workspace opens via installed plugin and authenticated Host',async()=>{
    await ev(`(()=>{const label=[...document.querySelectorAll('span')].find(n=>n.textContent==='Workspaces'||n.textContent==='工作区');window.__BF_WORKSPACE_ROOT__=label.parentElement.parentElement;window.__BF_WORKSPACE_INITIAL__={selected:window.__BF_WORKSPACE_ROOT__.querySelector('[aria-selected="true"]')?.getAttribute('data-row-key'),expanded:window.__BF_WORKSPACE_ROOT__.querySelector('[data-row-key^="workspace:"]').getAttribute('aria-expanded')};window.__BF_WORKSPACE_EVENTS__=[];window.__BF_WORKSPACE_LISTENER__=e=>window.__BF_WORKSPACE_EVENTS__.push({kind:e.type,trusted:e.isTrusted,row:e.target.closest('[role=treeitem]')?.getAttribute('data-row-key')??null});for(const kind of ['click','input'])window.__BF_WORKSPACE_ROOT__.addEventListener(kind,window.__BF_WORKSPACE_LISTENER__);document.querySelector('#dsh-bf-acceptance-fixture').style.left='650px';})()`)
    if(throughPanel){
      const expected=await ev(`(()=>{const n=window.__BF_WORKSPACE_ROOT__;return n.tagName.toLowerCase()+(n.id?'#'+n.id:'')+(n.className.trim()?'.'+n.className.trim().split(/\\s+/).slice(0,3).join('.'):'')})()`)
      const point=await ev(`(()=>{const n=[...window.__BF_WORKSPACE_ROOT__.querySelectorAll('span')].find(n=>n.textContent==='Workspaces'||n.textContent==='工作区'),r=n.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`)
      await ev('window.__BF_ACCEPTANCE__.invoke()')
      await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',...point})
      for(let step=0;step<12;step++){
        if((await ev('document.querySelector(".dsh-bf-label").textContent')).split('  ')[0]===expected)break
        for(const type of ['keyDown','keyUp'])await cdp.send('Input.dispatchKeyEvent',{type,key:'ArrowUp',code:'ArrowUp',windowsVirtualKeyCode:38})
        await pause(100)
      }
      assert.equal((await ev('document.querySelector(".dsh-bf-label").textContent')).split('  ')[0],expected,'Picker chooses exact workspace root')
      for(const type of ['mousePressed','mouseReleased'])await cdp.send('Input.dispatchMouseEvent',{type,...point,button:'left',clickCount:1})
      await wait('!!window.__BF_WORKSPACE_ROOT__.closest(".dsh-bf-panel")',true,'Actual workspace live extracted into production panel')
      await sourceClick('[data-action=detach]')
      await wait('!!document.querySelector("[data-role=companion-confirm]")',true,'Production consent opens')
      await sourceClick('[data-action=companion-allow]')
      await wait('document.querySelector(".dsh-bf-panel").dataset.companionState','connected','Production panel connects')
    }else await ev('(async()=>{window.__BF_WORKSPACE_HANDLE__=await window.__BF_ACCEPTANCE__.openSource(window.__BF_WORKSPACE_ROOT__);return true})()')
    assert.equal(BrowserWindow.getAllWindows().length,1)
  })
  const popup=BrowserWindow.getAllWindows()[0],pe=expression=>popup.webContents.executeJavaScript(expression,true)
  const waitPopup=async(expression,label)=>{for(let i=0;i<60;i++){if(await pe(expression))return;await pause(100)}assert.equal(await pe(expression),true,label)}
  const click=async key=>{await pause(250);const point=await pe(`(()=>{const n=document.querySelector('[data-control="${key}"]');n.scrollIntoView();const r=n.getBoundingClientRect();return{x:Math.round(r.x+20),y:Math.round(r.y+r.height/2)}})()`);for(const type of ['mouseDown','mouseUp'])popup.webContents.sendInputEvent({type,...point,button:'left',clickCount:1});await pause(400)}
  await test('native popup expands and collapses real React workspace exactly once',async()=>{
    await pause(300);assert.equal(await pe('document.body.dataset.adapter'),'workspace-v1')
    await click('c3');await wait(`window.__BF_WORKSPACE_ROOT__.querySelector('[data-row-key^="workspace:"]').getAttribute('aria-expanded')`,'false','Collapsed source')
    await waitPopup('document.querySelector("[data-control=c3]").getAttribute("aria-label").startsWith("▸")','Collapsed popup state')
    await click('c3');await wait(`window.__BF_WORKSPACE_ROOT__.querySelector('[data-row-key^="workspace:"]').getAttribute('aria-expanded')`,'true','Expanded source')
    assert.equal((await ev('window.__BF_WORKSPACE_EVENTS__')).filter(e=>e.kind==='click').length,2)
  })
  await test('native paging and session selection changes actual Desktop selection',async()=>{
    const before=(await ev('window.__BF_WORKSPACE_EVENTS__')).length;await click('c2');await waitPopup('document.querySelector("[data-control=c1]").textContent.includes("2/2")','Page two rendered');assert.equal((await ev('window.__BF_WORKSPACE_EVENTS__')).length,before)
    const expected=await ev('window.__BF_WORKSPACE_ROOT__.querySelectorAll("[role=treeitem]")[3].getAttribute("data-row-key")')
    await click('c3');await wait('window.__BF_WORKSPACE_ROOT__.querySelector("[aria-selected=true]")?.getAttribute("data-row-key")',expected,'Selected source row')
  })
  await test('native query opens real search, empty result updates, and clearing restores tree',async()=>{
    await pe('document.querySelector("input").focus()');popup.webContents.insertText('BF_NO_MATCH_20261011');await wait('window.__BF_WORKSPACE_ROOT__.querySelector("input").value','BF_NO_MATCH_20261011','Actual source query')
    await waitPopup('document.querySelectorAll("#controls button").length===2','Empty results rendered')
    popup.webContents.sendInputEvent({type:'keyDown',keyCode:'A',modifiers:['control']});popup.webContents.sendInputEvent({type:'keyUp',keyCode:'A',modifiers:['control']});popup.webContents.sendInputEvent({type:'keyDown',keyCode:'Backspace'});popup.webContents.sendInputEvent({type:'keyUp',keyCode:'Backspace'})
    await wait('window.__BF_WORKSPACE_ROOT__.querySelector("input").value','','Query cleared');await waitPopup('document.querySelectorAll("#controls button").length>=3','Grouped rows restored')
  })
  await test('positive real search result can select another session and clear back to grouped view',async()=>{
    const target=await ev('window.__BF_WORKSPACE_ROOT__.querySelector("[aria-selected=true]")?.getAttribute("data-row-key")==="session:session-bf-workspace-20261011-ws-0"?1:0'),query=`BF Acceptance ${target}`
    await pe('document.querySelector("input").focus()');popup.webContents.insertText(query);await wait('window.__BF_WORKSPACE_ROOT__.querySelector("input").value',query,'Positive source query');await waitPopup(`document.querySelector('[data-control=c3]')?.getAttribute('aria-label').includes(${JSON.stringify(query)})===true`,'Positive results rendered')
    assert.equal(await ev('window.__BF_WORKSPACE_ROOT__.querySelector("[role=treeitem]").getAttribute("aria-selected")'),'false','Result is a different session before click')
    await click('c3')
    await wait('window.__BF_WORKSPACE_ROOT__.querySelector("[aria-selected=true]")?.getAttribute("data-row-key")',`session:session-bf-workspace-20261011-ws-${target}`,'Search result switches actual session; host exits search to grouped view')
    await wait('window.__BF_WORKSPACE_ROOT__.querySelector("input").value','','Host clears positive query on selection')
    await waitPopup('document.querySelectorAll("#controls button").length>=3','Host grouped view synchronized after search selection')
  })
  await test('real source updates, popup reload and boundaries remain visible',async()=>{
    const before=(await ev('window.__BF_WORKSPACE_EVENTS__')).length;popup.webContents.reload();await waitPopup('document.body.dataset.adapter==="workspace-v1" && document.querySelector("[data-control=c3]")?.getAttribute("aria-label").includes("Default workspace")===true && document.querySelector("[data-control=c5]")?.getAttribute("aria-label").startsWith("●")===true','Reload restores populated grouped view and selected session');assert.equal((await ev('window.__BF_WORKSPACE_EVENTS__')).length,before)
    await pe('scrollTo(0,0)');await pause(250)
    assert.ok((await pe('document.querySelector("#status").textContent')).includes('新会话创建仍在原 Desktop'))
    const decorated=await ev('WorkspaceDiagnostic.captureControls(window.__BF_WORKSPACE_ROOT__).read(0)')
    assert.equal(decorated.appearance.mode,'captured','Real workspace appearance must not silently fall back')
    assert.equal(await pe('document.body.dataset.appearance'),'captured')
    const rendered=await pe('(()=>{const root=document.querySelector("#controls").getBoundingClientRect();return [...document.querySelectorAll("#scene>span")].map(node=>{const r=node.getBoundingClientRect(),style=getComputedStyle(node);return {key:node.dataset.scene,text:node.textContent,x:r.x-root.x,y:r.y-root.y,width:r.width,height:r.height,style:Object.fromEntries(["color","font-family","font-size","font-weight","line-height"].map(key=>[key,style.getPropertyValue(key).trim()])),icon:!!node.querySelector("svg")}})})()')
    assert.equal(rendered.length,decorated.scene.items.length)
    for(const item of decorated.scene.items){const copy=rendered.find(node=>node.key===item.key);assert.equal(copy.text,item.text);assert.equal(copy.icon,!!item.icon);for(const property of ['x','y','width'])assert.ok(Math.abs(copy[property]-item.placement[property])<0.02,`scene ${item.key} ${property}`);if(!item.icon)for(const property of Object.keys(copy.style))if(decorated.scene.styles[item.style][property])assert.equal(copy.style[property],decorated.scene.styles[item.style][property],`scene ${item.key} ${property}`)}
    appearanceEvidence={mode:decorated.appearance.mode,bytes:new TextEncoder().encode(JSON.stringify(decorated)).byteLength,sourceHeight:decorated.workspaceVisual.sourceHeight,omittedIcons:decorated.workspaceVisual.omittedIcons,items:rendered.length,safeIcons:rendered.filter(item=>item.icon).length,computedStylesAndRelativeGeometryMatched:true,sourcePixelComparison:false}
    await writeFile(join(root,'docs','screenshots',throughPanel?'workspace-adapter-panel-dsh.png':'workspace-adapter-actual-dsh.png'),(await popup.webContents.capturePage()).toPNG())
    sourceEvents=await ev('window.__BF_WORKSPACE_EVENTS__');assert.ok(sourceEvents.every(e=>!e.trusted))
  })
  await test('source handle close releases actual popup without touching default Desktop',async()=>{
    if(throughPanel){await sourceClick('.dsh-bf-panel .dsh-bf-btn:last-child');await wait('!window.__BF_WORKSPACE_ROOT__.closest(".dsh-bf-panel")',true,'Panel close restores actual workspace')}
    else await ev('window.__BF_WORKSPACE_HANDLE__.close();delete window.__BF_WORKSPACE_HANDLE__')
    await pause(400);assert.ok(popup.isDestroyed())
  })
  const hash=async file=>createHash('sha256').update(await readFile(join(root,file))).digest('hex')
  const companionRuntimeHashes=Object.fromEntries(await Promise.all(['main.cjs','preload.cjs','controls-renderer.js','controls-window.html','controls.css'].map(async file=>[file,await hash(`lib/companion/${file}`)])))
  const report={executedAt:new Date().toISOString(),checks,scope:'isolated actual DSH React workspace + installed plugin authenticated Host + production Pipe server/window manager in Electron test harness + native popup input; test helper --no-sandbox; not managed main or default profile acceptance',desktopPid:cdp.desktopPid,sourceEvents,rendererBundleSha256:await hash('lib/client.js'),hostBundleSha256:await hash('lib/index.js'),companionRuntimeHashes,popupVisualAcceptancePending:true,sourceScreenshotCaptured:false,sourceScreenshotReason:'hidden source CDP screenshot timed out in prior run; source is verified by DOM/business assertions, not screenshot',fullWorkspaceAcceptance:false}
  report.durableSessionReuse=durableSessionReuse
  report.productionPickerPanelConsent=throughPanel
  report.appearanceEvidence=appearanceEvidence
  await writeFile(join(root,'docs',throughPanel?'companion-workspace-panel-dsh-acceptance-2026-10-11.json':'companion-workspace-dsh-acceptance-2026-10-11.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));app.exitCode=0
 }catch(error){console.error(error);console.log('BINDING DIAGNOSTIC',JSON.stringify({intentLog,snapshotLog}));console.log('POPUP DIAGNOSTIC',await BrowserWindow.getAllWindows()[0]?.webContents.executeJavaScript('({text:document.body.innerText,scroll:scrollY,buttons:[...document.querySelectorAll("button")].map(b=>({key:b.dataset.control,text:b.textContent,disabled:b.disabled,binding:b.dataset.binding}))})').catch(()=>null));if(cdp)console.log('WORKSPACE DIAGNOSTIC',await cdp.evaluate(`({errors:window.__BF_WORKSPACE_ERRORS__,events:window.__BF_WORKSPACE_EVENTS__,rows:[...document.querySelectorAll('[role=treeitem]')].map(row=>({key:row.getAttribute('data-row-key'),text:row.textContent,expanded:row.getAttribute('aria-expanded')})),text:document.body.innerText.slice(0,1000)})`).catch(()=>null));app.exitCode=1}
 finally{
  if(throughPanel && cdp)await cdp.evaluate('document.querySelector(".dsh-bf-panel .dsh-bf-btn:last-child")?.click();if(document.querySelector(".dsh-bf-root"))window.__BF_ACCEPTANCE__.invoke()').catch(()=>{})
  if(cdp)await cdp.evaluate(`(()=>{window.__BF_WORKSPACE_HANDLE__?.close();const root=window.__BF_WORKSPACE_ROOT__;if(root){for(const kind of ['click','input'])root.removeEventListener(kind,window.__BF_WORKSPACE_LISTENER__);const input=root.querySelector('input');if(input?.value){Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'');input.dispatchEvent(new Event('input',{bubbles:true}))}const workspace=root.querySelector('[data-row-key^="workspace:"]');if(workspace && workspace.getAttribute('aria-expanded')!==window.__BF_WORKSPACE_INITIAL__?.expanded)workspace.click();if(window.__BF_WORKSPACE_INITIAL__?.selected)[...root.querySelectorAll('[data-row-key]')].find(row=>row.getAttribute('data-row-key')===window.__BF_WORKSPACE_INITIAL__.selected)?.click()}document.querySelector('#dsh-bf-acceptance-fixture').style.left='50px';for(const key of ['__BF_WORKSPACE_ROOT__','__BF_WORKSPACE_EVENTS__','__BF_WORKSPACE_INITIAL__','__BF_WORKSPACE_LISTENER__','__BF_WORKSPACE_HANDLE__'])delete window[key]})()`).catch(()=>{})
  if(cdp)await cdp.evaluate('clearInterval(window.__BF_WORKSPACE_MONITOR__);delete window.__BF_WORKSPACE_MONITOR__;delete window.__BF_WORKSPACE_DIAGNOSTIC__;delete window.__BF_WORKSPACE_ERRORS__;delete window.WorkspaceDiagnostic').catch(()=>{})
  await server?.dispose();manager?.dispose()
  if(credentialOwned){const credential=JSON.parse(await readFile(credentialFile,'utf8'));assert.equal(credential.pipe,pairing.pipe);assert.equal(credential.secret,pairing.secret);await unlink(credentialFile)}
  cdp?.close();clearTimeout(timeout);app.exit(app.exitCode??0)
 }
})
