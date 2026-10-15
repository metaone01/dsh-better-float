const {app,BrowserWindow}=require('electron')
const {build}=require('esbuild')
const {join,resolve}=require('node:path')
const {randomBytes,createHash}=require('node:crypto')
const {mkdtempSync}=require('node:fs')
const {mkdir,writeFile,readFile}=require('node:fs/promises')
const {tmpdir}=require('node:os')
const {spawn,execFileSync,execFile}=require('node:child_process')
const {promisify}=require('node:util')
const {createServer}=require('node:net')
const {pathToFileURL}=require('node:url')
const assert=require('node:assert/strict')
const root=resolve(__dirname,'..'),folder=mkdtempSync(join(tmpdir(),'better-float-dsh-regression-'))
app.setPath('userData',join(folder,'electron'));app.on('window-all-closed',()=>{})
const deadline=setTimeout(()=>{console.error('Isolated DSH regression timed out');app.exit(1)},90000)
app.whenReady().then(async()=>{
  let manager,server,desktop,cdp,checks=0,workspaceReport,composerReport
  const pause=()=>new Promise(resolve=>setTimeout(resolve,150))
  const test=async(name,run)=>{await run();checks++;console.log('PASS '+name)}
  const wait=async(expression)=>{for(let attempt=0;attempt<100;attempt++){const result=await cdp.evaluate(expression);if(result)return result;await pause()}throw Error('Isolated DSH condition timed out')}
  try{
    await new Promise((resolve,reject)=>{const port=createServer();port.on('error',reject);port.listen(9222,'127.0.0.1',()=>port.close(resolve))})
    const node=await build({stdin:{contents:"export {createCompanionWindows} from './companion/window-manager.ts';export {createCompanionServer} from './companion/server.ts';export {protectPairingDirectory} from './src/host/pairing-security.ts'",resolveDir:root},bundle:true,platform:'node',format:'cjs',write:false,external:['electron']})
    const module={exports:{}};new Function('require','module','exports',node.outputFiles[0].text)(require,module,module.exports)
    const credentials=join(folder,'credentials');await mkdir(credentials);await module.exports.protectPairingDirectory(credentials)
    const slash=String.fromCharCode(92),pairing={pipe:[slash+slash+'.','pipe','dsh-better-float-'+randomBytes(16).toString('hex')].join(slash),secret:randomBytes(32).toString('hex')}
    const pairingFile=join(credentials,'pairing.json');await writeFile(pairingFile,JSON.stringify(pairing),{mode:0o600})
    manager=module.exports.createCompanionWindows(join(root,'lib/companion'),false);server=module.exports.createCompanionServer(pairing,(...args)=>manager.open(...args));await server.listen()
    execFileSync('C:/Program Files/nodejs/node.exe',[join(root,'scripts/prepare-dsh-isolated.mjs'),'--companion','--pairing-file='+pairingFile],{cwd:root,windowsHide:true,stdio:'pipe'})
    const env={...process.env,DSH_HOME:join(root,'.dsh-debug-userdata-e0e1-20261003/harness')};delete env.ELECTRON_RUN_AS_NODE
    desktop=spawn('G:/Deepseek Harness Desktop/DeepSeek Harness.exe',['--remote-debugging-port=9222','--remote-debugging-address=127.0.0.1','--user-data-dir='+join(root,'.dsh-debug-userdata-e0e1-20261003/electron')],{env,stdio:'ignore',windowsHide:true})
    await new Promise((resolve,reject)=>{desktop.once('error',reject);desktop.once('spawn',resolve)})
    const connect=await import(pathToFileURL(join(root,'scripts/isolated-dsh-cdp.mjs')).href)
    for(let attempt=0;attempt<60;attempt++){
      try{const response=await fetch('http://127.0.0.1:9222/json/list');if((await response.json()).some(page=>page.url.startsWith('dsh-app://app/'))){cdp=await connect.connectIsolatedDsh();break}}catch{}
      await pause()
    }
    assert.ok(cdp,'Only the explicitly isolated DSH may be inspected')
    await cdp.send('Page.bringToFront')
    await wait('!!window.__BF_ACCEPTANCE__ && !!document.querySelector("[data-composer-input]")')
    const browser=await build({stdin:{contents:"export {captureControls} from './src/detach/semantic-adapter.ts';export {visualBounds} from './src/detach/visual-bounds.ts'",resolveDir:root},bundle:true,format:'iife',globalName:'DshBoundaryFix',write:false})
    await cdp.evaluate(browser.outputFiles[0].text)
    await test('actual workspace slot selection keeps captured layout instead of semantic fallback',async()=>{
      workspaceReport=await wait(`(()=>{const source=document.querySelector('[data-slot="sidebar.workspaces"]');if(!source)return false;try{const snapshot=DshBoundaryFix.captureControls(source).read(0),own=source.getBoundingClientRect(),visual=DshBoundaryFix.visualBounds(source);return {display:getComputedStyle(source).display,own:{width:own.width,height:own.height},visual:{width:visual.width,height:visual.height},appearance:snapshot.appearance.mode,reason:snapshot.appearance.reason,scene:!!snapshot.scene,controlCount:snapshot.controls.length}}catch{return false}})()`)
      assert.equal(workspaceReport.display,'contents');assert.equal(workspaceReport.own.width,0);assert.equal(workspaceReport.appearance,'captured');assert.equal(workspaceReport.scene,true)
      await cdp.evaluate("window.workspaceHandlePromise=window.__BF_ACCEPTANCE__.openSource(document.querySelector('[data-slot=\"sidebar.workspaces\"]'));true")
      await wait('!!window.workspaceHandlePromise');await cdp.evaluate('window.workspaceHandlePromise.then(handle=>{window.workspaceHandle=handle;return true})')
      const popup=BrowserWindow.getAllWindows()[0];assert.ok(popup);await pause()
      assert.equal(await popup.webContents.executeJavaScript('document.body.dataset.appearance'),'captured')
      assert.ok((await popup.webContents.executeJavaScript('document.querySelector("#scene").textContent')).length>0)
      await mkdir(join(root,'docs/screenshots'),{recursive:true});await writeFile(join(root,'docs/screenshots/workspace-slot-dsh-fixed.png'),(await popup.webContents.capturePage()).toPNG())
      await cdp.evaluate('window.workspaceHandle.close();true');await pause()
    })
    await test('actual full composerSeat passes production picker, panel, consent and bridge',async()=>{
      composerReport=await cdp.evaluate(`(()=>{window.composerSource=document.querySelector('[data-composer-input]');window.composerSeat=composerSource.closest('[class*="composerSeat"]');window.residentEditor=composerSource.__lexicalEditor;const snapshot=DshBoundaryFix.captureControls(composerSeat).read(0);window.composerBefore=residentEditor.getEditorState();return {adapter:snapshot.adapter,readOnly:snapshot.controls[0].readOnly,valueLength:snapshot.controls[0].value.length,multiline:snapshot.controls[0].multiline,editorPresent:!!residentEditor,scene:!!snapshot.scene,appearance:snapshot.appearance.mode}})()`)
      assert.equal(composerReport.adapter,'composer-v1');assert.equal(composerReport.multiline,true);assert.equal(composerReport.editorPresent,true)
      const expected=await cdp.evaluate(`composerSeat.tagName.toLowerCase()+'.'+composerSeat.className.trim().split(/\\s+/).slice(0,3).join('.')`)
      const point=await cdp.evaluate('(()=>{const r=composerSource.getBoundingClientRect();return{x:Math.round(r.x+20),y:Math.round(r.y+20)}})()')
      await cdp.evaluate('window.__BF_ACCEPTANCE__.invoke()');await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',...point})
      for(let step=0;step<15;step++){
        if((await cdp.evaluate('document.querySelector(".dsh-bf-label").textContent')).split('  ')[0]===expected)break
        for(const type of ['keyDown','keyUp'])await cdp.send('Input.dispatchKeyEvent',{type,key:'ArrowUp',code:'ArrowUp',windowsVirtualKeyCode:38})
        await pause()
      }
      assert.equal((await cdp.evaluate('document.querySelector(".dsh-bf-label").textContent')).split('  ')[0],expected)
      for(const type of ['mousePressed','mouseReleased'])await cdp.send('Input.dispatchMouseEvent',{type,...point,button:'left',clickCount:1})
      await wait('!!composerSeat.closest(".dsh-bf-panel")')
      const clickSource=async selector=>{
        const target=await cdp.evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});n.scrollIntoView();const r=n.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`)
        for(const type of ['mousePressed','mouseReleased'])await cdp.send('Input.dispatchMouseEvent',{type,...target,button:'left',clickCount:1})
      }
      await clickSource('[data-action=detach]');await wait('!!document.querySelector("[data-role=companion-confirm]")');await clickSource('[data-action=companion-allow]')
      await wait('document.querySelector(".dsh-bf-panel").dataset.companionState==="connected"')
      const popup=BrowserWindow.getAllWindows()[0];await pause();assert.ok(popup)
      assert.equal(await popup.webContents.executeJavaScript('!!document.querySelector("textarea")'),true)
      assert.equal(await cdp.evaluate('composerSource.__lexicalEditor===residentEditor && residentEditor.getEditorState()===composerBefore'),true)
      composerReport.productionPickerPanelConsent=true
      await writeFile(join(root,'docs/screenshots/composer-dsh-fixed.png'),(await popup.webContents.capturePage()).toPNG())
    })
    if(!composerReport.readOnly)await test('actual pure-text draft survives popup IME guard, explicit save and source readback without send',async()=>{
      const popup=BrowserWindow.getAllWindows()[0]
      const pe=expression=>popup.webContents.executeJavaScript(expression,true)
      // Background the owned source explicitly; an OS foreground lock may deny focus().
      await promisify(execFile)('powershell',['-NoProfile','-NonInteractive','-File',join(root,'scripts/set-isolated-dsh-window.ps1'),'minimize'],{windowsHide:true})
      popup.show();popup.focus();await pause()
      // A bounded offline draft edit only. No submit/button or account API is invoked.
      await pe('document.querySelector("textarea").focus()');popup.webContents.insertText('隔离测试：中文草稿\n第二行');await pause()
      await pe('document.querySelector("textarea").dispatchEvent(new CompositionEvent("compositionstart"))')
      assert.equal(await pe('document.querySelector("#draft-actions button").disabled'),true)
      await pe('document.querySelector("textarea").dispatchEvent(new CompositionEvent("compositionend"))')
      await pe('document.querySelector("#draft-actions button").click()')
      for(let attempt=0;attempt<50;attempt++){if((await pe('document.querySelector("#draft-actions span").textContent')).includes('已确认同步'))break;await pause()}
      const syncStatus=await pe('document.querySelector("#draft-actions span").textContent')
      if(!syncStatus.includes('已确认同步'))console.log(JSON.stringify({syncStatus,source:await cdp.evaluate(`(()=>{let snapshot,error;try{snapshot=DshBoundaryFix.captureControls(composerSource).read(0)}catch(e){error=e.message}return{error,readOnly:snapshot?.controls[0].readOnly,valueLength:snapshot?.controls[0].value.length,isComposing:residentEditor.isComposing(),editable:residentEditor.isEditable(),focused:document.hasFocus(),active:document.activeElement===composerSource,nodes:residentEditor.getEditorState().toJSON().root.children.map(p=>({type:p.type,children:p.children?.map(n=>({type:n.type,format:n.format,textLength:n.text?.length}))}))}})()`),popup:await pe('({disabled:document.querySelector("textarea").disabled,readOnly:document.querySelector("textarea").readOnly,valueLength:document.querySelector("textarea").value.length,status:document.querySelector("#status").textContent})')},null,2))
      assert.ok(syncStatus.includes('已确认同步'),syncStatus)
      const readback=await cdp.evaluate("DshBoundaryFix.captureControls(composerSource).read(0).controls[0].value")
      assert.ok(readback.includes('隔离测试：中文草稿\n第二行'))
      assert.equal(await cdp.evaluate('DshBoundaryFix.captureControls(composerSource).read(0).controls[0].readOnly'),false)
      await cdp.evaluate("residentEditor.setEditorState(composerBefore,{tag:'skip-dom-selection'});true")
    })
    const hashes={};for(const file of ['lib/client.js','lib/index.js','lib/companion/controls-renderer.js'])hashes[file]=createHash('sha256').update(await readFile(join(root,file))).digest('hex')
    const report={executedAt:new Date().toISOString(),checks,workspace:workspaceReport,composer:composerReport,hashes,scope:'actual isolated DSH, workspace slot selection and full composerSeat production picker/panel/consent, production bridge, authenticated Named Pipe and native companion; not default-profile or complete composer functionality acceptance',defaultProfileModified:false,messageSubmitted:false}
    await writeFile(join(root,'docs/companion-selection-composer-dsh-2026-10-11.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2))
  }catch(error){console.error(error);app.exitCode=1}
  finally{
    if(cdp){await cdp.evaluate('window.composerHandle?.close();window.workspaceHandle?.close();true').catch(()=>{});await cdp.send('Browser.close').catch(()=>{});cdp.close()}
    // Never kill by executable name: only this test's recorded child may be stopped.
    if(desktop && desktop.exitCode===null)desktop.kill()
    await server?.dispose();manager?.dispose();clearTimeout(deadline);app.exit(app.exitCode??0)
  }
})
