const{app,BrowserWindow}=require('electron')
const{build}=require('esbuild')
const{join,resolve}=require('node:path')
const{randomBytes,createHash}=require('node:crypto')
const{mkdtempSync}=require('node:fs')
const{mkdir,writeFile,readFile}=require('node:fs/promises')
const assert=require('node:assert/strict')
const root=resolve(__dirname,'..')
const folder=mkdtempSync(join(root,'.dsh-debug-userdata-appearance-'))
app.setPath('userData',join(folder,'electron'))
app.on('window-all-closed',()=>{})
const timeout=setTimeout(()=>{console.error('Appearance acceptance timed out');app.exit(1)},60000)
app.whenReady().then(async()=>{
  let source,manager,server,client
  let checks=0
  const screenshots=[]
  const test=async(name,run)=>{await run();checks++;console.log(`PASS ${name}`)}
  try{
    const{outputFiles}=await build({stdin:{contents:`export {createCompanionWindows} from './companion/window-manager.ts';
      export {createCompanionServer} from './companion/server.ts';export {createPipeClient} from './src/host/pipe-client.ts';
      export {protectPairingDirectory} from './src/host/pairing-security.ts';export {validSnapshot} from './src/shared/control-adapter.ts';
      export {MAX_FRAME,frameBytes} from './src/host/pipe-protocol.ts';`,resolveDir:root},bundle:true,platform:'node',format:'cjs',write:false,external:['electron']})
    const module={exports:{}};new Function('require','module','exports',outputFiles[0].text)(require,module,module.exports)
    const api=module.exports
    const credentials=join(folder,'credentials');await mkdir(credentials)
    await api.protectPairingDirectory(credentials)
    const secret=randomBytes(32).toString('hex'),suffix=randomBytes(16).toString('hex')
    const pairing={pipe:process.platform==='win32'?`\\\\.\\pipe\\dsh-better-float-${suffix}`:join(folder,'appearance.sock'),secret}
    const file=join(credentials,'pairing.json');await writeFile(file,JSON.stringify(pairing),{mode:0o600})
    manager=api.createCompanionWindows(join(root,'lib','companion'),false)
    server=api.createCompanionServer(pairing,(...args)=>manager.open(...args));await server.listen();client=api.createPipeClient(file)
    source=new BrowserWindow({width:500,height:400,show:false,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}})
    await source.loadURL('data:text/html,<html><body></body></html>')
    const browser=await build({entryPoints:[join(__dirname,'appearance-browser-cases.mjs')],bundle:true,write:false,format:'iife',globalName:'AppearanceFixture'})
    await source.webContents.executeJavaScript(browser.outputFiles[0].text)
    const evalSource=expression=>source.webContents.executeJavaScript(expression,true)
    await evalSource('AppearanceFixture.fixture()')
    const snapshot=await evalSource('AppearanceFixture.read(0)')
    await test('source captures deduplicated, bounded computed styles and inherited backdrop',async()=>{
      assert.equal(api.validSnapshot(snapshot),true);assert.equal(snapshot.appearance.mode,'captured')
      assert.equal(snapshot.appearance.theme['background-color'],'rgb(245, 247, 251)')
      assert.equal(snapshot.appearance.styles[snapshot.appearance.assignments.c0]['border-top-left-radius'],'10px')
      assert.ok(snapshot.appearance.frame.width>0 && snapshot.appearance.frame.height>0)
      assert.equal(snapshot.appearance.placements.c0.width,snapshot.appearance.placements.c1.width)
    })
    await test('schema rejects CSS injection, URLs, layout escape, wrong references and excess budget',async()=>{
      for(const style of [{'background-image':'url(https://example.invalid/x)'},{color:'red;position:fixed'},{position:'fixed'},{color:'var(--x)'},{'font-family':'evil\\22;body{}'}]){
        assert.equal(api.validSnapshot({...snapshot,appearance:{...snapshot.appearance,styles:[style],assignments:{c0:0,c1:0}}}),false)
      }
      assert.equal(api.validSnapshot({...snapshot,appearance:{...snapshot.appearance,assignments:{c0:0,c1:99}}}),false)
      assert.equal(api.validSnapshot({...snapshot,appearance:{...snapshot.appearance,assignments:{c0:0}}}),false)
      assert.equal(api.validSnapshot({...snapshot,appearance:{...snapshot.appearance,placements:null}}),false)
      assert.equal(api.validSnapshot({...snapshot,appearance:{...snapshot.appearance,placements:[]}}),false)
      const large=Array.from({length:6},()=>Object.fromEntries(Object.keys(snapshot.appearance.styles[0]).map(key=>[key,'x'.repeat(160)])))
      assert.equal(api.validSnapshot({...snapshot,appearance:{...snapshot.appearance,styles:large}}),false)
    })
    await client.request({op:'open-controls',id:'styled',lease:'source',snapshot})
    const popup=BrowserWindow.getAllWindows().find(window=>window!==source)
    const evalPopup=expression=>popup.webContents.executeJavaScript(expression,true)
    const settle=async()=>{for(let i=0;i<30;i++){if(await evalPopup('!!document.querySelector("[data-control=c1]")'))break;await new Promise(resolve=>setTimeout(resolve,30))}await new Promise(resolve=>setTimeout(resolve,100))}
    await settle()
    await test('initial content size follows captured frame within documented bounds',async()=>{
      assert.deepEqual(popup.getContentSize(),[Math.min(2048,Math.max(240,Math.ceil(snapshot.appearance.frame.width+48))),
        Math.min(2048,Math.max(180,Math.ceil(snapshot.appearance.frame.height+48)))])
    })
    await test('sandbox and CSP stay intact while all captured control styles and sizes match',async()=>{
      assert.equal(await evalPopup('typeof require'),'undefined')
      assert.equal(await evalPopup('document.querySelector("meta[http-equiv=Content-Security-Policy]").content'),"default-src 'none'; script-src 'self'; style-src 'self'; base-uri 'none'; form-action 'none'")
      for(let index=0;index<2;index++){
        const original=await evalSource(`AppearanceFixture.styles(${index})`)
        const copied=await evalPopup(`(()=>{const node=document.querySelector('[data-control=c${index}]'),root=document.querySelector('#controls'),style=getComputedStyle(node),result={};for(const key of ${JSON.stringify(Object.keys(original.style))})result[key]=style.getPropertyValue(key).trim();const r=node.getBoundingClientRect(),p=root.getBoundingClientRect();return{style:result,rect:{x:r.x,y:r.y,width:r.width,height:r.height},relative:{x:r.left-p.left,y:r.top-p.top}}})()`)
        assert.deepEqual(copied.style,original.style,`c${index} styles`)
        assert.equal(copied.rect.width,original.rect.width);assert.equal(copied.rect.height,original.rect.height)
        const expected=snapshot.appearance.placements[`c${index}`]
        assert.ok(Math.abs(copied.relative.x-expected.x)<0.01 && Math.abs(copied.relative.y-expected.y)<0.01,`c${index} relative placement`)
        const crop=rect=>({x:Math.floor(rect.x),y:Math.floor(rect.y),width:Math.ceil(rect.width),height:Math.ceil(rect.height)})
        const before=await source.webContents.capturePage(crop(original.rect)),after=await popup.webContents.capturePage(crop(copied.rect))
        const left=before.toBitmap(),right=after.toBitmap();let different=0,firstDifference=null
        for(let pixel=0;pixel<Math.min(left.length,right.length);pixel+=4)if(!left.subarray(pixel,pixel+4).equals(right.subarray(pixel,pixel+4))){different++;if(!firstDifference)firstDifference={x:(pixel/4)%before.getSize().width,y:Math.floor((pixel/4)/before.getSize().width),source:[...left.subarray(pixel,pixel+4)],popup:[...right.subarray(pixel,pixel+4)]}}
        if(different>2)console.log(JSON.stringify({control:index,different,firstDifference}))
        screenshots.push({control:`c${index}`,sourceSize:before.getSize(),popupSize:after.getSize(),differentPixels:different,totalPixels:left.length/4})
        assert.deepEqual(after.getSize(),before.getSize());assert.ok(different<=2,`c${index} native screenshot rasterization drift: ${different} pixels`)
        await writeFile(join(root,'docs','screenshots',`appearance-source-c${index}.png`),before.toPNG())
        await writeFile(join(root,'docs','screenshots',`appearance-popup-c${index}.png`),after.toPNG())
      }
    })
    let revision=0,ack=0
    const sync=async extra=>{const next=await evalSource(`AppearanceFixture.read(${++revision})`);return client.request({op:'sync-controls',id:'styled',lease:'source',snapshot:{...next,...extra},ack})}
    await test('theme changes update styles, value-only deltas retain appearance, reload rehydrates it',async()=>{
      await evalSource('AppearanceFixture.mutate("dark")');await sync();await new Promise(resolve=>setTimeout(resolve,100))
      assert.equal(await evalPopup('getComputedStyle(document.body).backgroundColor'),'rgb(22, 28, 38)')
      assert.equal(await evalPopup('getComputedStyle(document.querySelector("[data-control=c0]")).color'),'rgb(230, 240, 250)')
      const next=await evalSource(`AppearanceFixture.read(${++revision})`);delete next.appearance;next.controls[1].value='from source'
      await client.request({op:'sync-controls',id:'styled',lease:'source',snapshot:next,ack});await new Promise(resolve=>setTimeout(resolve,100))
      assert.equal(await evalPopup('document.querySelector("[data-control=c1]").value'),'from source')
      assert.equal(await evalPopup('getComputedStyle(document.body).backgroundColor'),'rgb(22, 28, 38)')
      await popup.webContents.reload();await settle()
      assert.equal(await evalPopup('document.body.dataset.appearance'),'captured')
      assert.equal(await evalPopup('getComputedStyle(document.body).backgroundColor'),'rgb(22, 28, 38)')
    })
    await test('trusted popup button/input events still execute original handlers exactly once',async()=>{
      const point=await evalPopup('(()=>{const r=document.querySelector("[data-control=c0]").getBoundingClientRect();return{x:Math.round(r.x+20),y:Math.round(r.y+r.height/2)}})()')
      for(const type of ['mouseMove','mouseDown','mouseUp'])popup.webContents.sendInputEvent({type,...point,button:'left',clickCount:1})
      await new Promise(resolve=>setTimeout(resolve,100));const clicked=await sync()
      assert.equal(clicked.actions.length,1);assert.equal(clicked.actions[0].kind,'click')
      for(const action of clicked.actions){await evalSource(`AppearanceFixture.apply(${JSON.stringify(action)})`);ack=action.seq}
      assert.equal((await sync()).actions.length,0)
      assert.equal(await evalSource('AppearanceFixture.read(0).controls[0].text'),'Count 1')
      await evalPopup('document.querySelector("[data-control=c1]").focus()');popup.webContents.insertText(' popup')
      await new Promise(resolve=>setTimeout(resolve,100));const typed=await sync()
      assert.ok(typed.actions.some(action=>action.kind==='input' && action.value.includes('popup')))
      for(const action of typed.actions){await evalSource(`AppearanceFixture.apply(${JSON.stringify(action)})`);ack=action.seq}
      assert.ok((await evalSource('AppearanceFixture.read(0).controls[1].value')).includes('popup'))
      await evalPopup('document.querySelector("[data-control=c1]").blur()')
    })
    await test('disabled visual updates and invalid snapshots cannot alter live styles',async()=>{
      await evalSource('AppearanceFixture.mutate("disabled")');await sync();await new Promise(resolve=>setTimeout(resolve,100))
      assert.equal(await evalPopup('document.querySelector("[data-control=c0]").disabled'),true)
      assert.equal(await evalPopup('getComputedStyle(document.querySelector("[data-control=c0]")).opacity'),'0.65')
      const valid=await evalSource(`AppearanceFixture.read(${++revision})`)
      const surfaceSnapshot=await evalPopup('floatControls.state()')
      assert.equal(surfaceSnapshot.appearance.mode,'captured')
      assert.equal(api.validSnapshot({...valid,appearance:{...valid.appearance,theme:{'background-color':'url(x)'}}}),false)
      await evalSource('AppearanceFixture.mutate("enabled")')
    })
    await test('explicit fallback removes prior styles without closing other leases',async()=>{
      await client.request({op:'open-test',id:'other',lease:'other'})
      await sync({appearance:{mode:'fallback',reason:'budget'}});await new Promise(resolve=>setTimeout(resolve,100))
      assert.equal(await evalPopup('document.body.dataset.appearance'),'fallback')
      assert.ok((await evalPopup('document.getElementById("status").textContent')).includes('预算'))
      assert.equal(await evalPopup('getComputedStyle(document.querySelector("[data-control=c0]")).borderTopLeftRadius'),'6px')
      assert.equal((await client.request({op:'list',lease:'other'})).windows.length,1)
      await client.request({op:'close',id:'other',lease:'other'})
      await sync();await new Promise(resolve=>setTimeout(resolve,100))
      assert.equal(await evalPopup('document.body.dataset.appearance'),'captured')
    })
    await test('browser polling sends changed styles only and frame retry keeps business data',async()=>{
      const result=await evalSource('AppearanceFixture.runDeltaChecks()');assert.equal(result.checks,9)
    })
    await test('actual oversized styled frame rejects locally, bounded fallback preserves existing window',async()=>{
      const styles=snapshot.appearance
      const hugeStyle=Object.fromEntries(Object.keys(styles.styles[0]).map(key=>[key,'x'.repeat(100)]))
      const big={revision:0,title:'Budget',controls:Array.from({length:6},(_,index)=>({key:`c${index}`,kind:'input',value:'a'.repeat(512),placeholder:'p'.repeat(120),disabled:false,readOnly:false})),
        appearance:{mode:'captured',theme:styles.theme,assignments:Object.fromEntries(Array.from({length:6},(_,index)=>[`c${index}`,0])),styles:[hugeStyle]}}
      assert.equal(api.validSnapshot(big),true,'oversized transport case must still satisfy snapshot schema')
      const request={op:'open-controls',id:'budget',lease:'budget',snapshot:big}
      assert.ok(api.frameBytes({type:'request',seq:999,payload:request,proof:'0'.repeat(64)})>api.MAX_FRAME)
      await assert.rejects(client.request(request),error=>error?.message?.includes('frame'))
      assert.equal((await client.request({op:'list',lease:'source'})).windows.length,1)
      const bounded={...big,appearance:{mode:'fallback',reason:'budget'}}
      assert.equal((await client.request({...request,snapshot:bounded})).windows.length,1)
      await client.request({op:'close',id:'budget',lease:'budget'})
    })
    await test('CSSOM mapping skips unsafe/unreadable cascade and invalid geometry without source events',async()=>{
      await evalSource('AppearanceFixture.enableInteractions()')
      const before=await evalSource('AppearanceFixture.events()')
      const result=await evalSource('AppearanceFixture.runInteractionBoundaries()');assert.equal(result.checks,11)
      assert.equal(await evalSource('AppearanceFixture.events()'),before)
      const mapped=await evalSource(`AppearanceFixture.read(${++revision})`)
      assert.equal(api.validSnapshot(mapped),true);assert.ok(mapped.appearance.interactions?.c0)
      const states=mapped.appearance.interactions.c0
      assert.equal(states.hover['background-color'],'rgb(10,120,220)')
      assert.equal(states.hover.color,'rgb(28, 48, 70)','static important wins over normal hover')
      for(const bad of [{...states,hover:{color:'red;position:fixed'}},{...states,hover:{'background-image':'url(x)'}},{...states,extra:{}},{}]){
        assert.equal(api.validSnapshot({...mapped,appearance:{...mapped.appearance,interactions:{c0:bad}}}),false)
      }
      assert.equal(api.validSnapshot({...mapped,appearance:{...mapped.appearance,interactions:{c9:states}}}),false)
      await sync();await new Promise(resolve=>setTimeout(resolve,100))
    })
    await test('native hover and keyboard focus-visible are local, combined states and reload retain mapping',async()=>{
      popup.show();popup.focus();popup.webContents.focus()
      await new Promise(resolve=>setTimeout(resolve,100))
      await evalPopup('document.activeElement?.blur()')
      const point=await evalPopup('(()=>{const r=document.querySelector("[data-control=c0]").getBoundingClientRect();return{x:Math.round(r.x+20),y:Math.round(r.y+r.height/2)}})()')
      popup.webContents.sendInputEvent({type:'mouseMove',...point})
      await new Promise(resolve=>setTimeout(resolve,100))
      assert.equal(await evalPopup('document.querySelector("[data-control=c0]").matches(":hover")'),true)
      assert.equal(await evalPopup('getComputedStyle(document.querySelector("[data-control=c0]")).backgroundColor'),'rgb(10, 120, 220)')
      assert.equal(await evalPopup('getComputedStyle(document.querySelector("[data-control=c0]")).color'),'rgb(28, 48, 70)')
      popup.webContents.sendInputEvent({type:'mouseMove',x:2,y:2})
      await evalPopup('document.activeElement?.blur()')
      for(const type of ['keyDown','keyUp'])popup.webContents.sendInputEvent({type,keyCode:'Tab'})
      await new Promise(resolve=>setTimeout(resolve,100))
      const focus=await evalPopup('(()=>{const n=document.activeElement,s=getComputedStyle(n);return{key:n.dataset.control,visible:n.matches(":focus-visible"),outline:s.outlineColor,width:s.outlineWidth,border:s.borderTopColor}})()')
      assert.ok(focus.key==='c0' || focus.key==='c1');assert.equal(focus.visible,true,JSON.stringify(focus))
      assert.equal(focus.outline,'rgb(130, 40, 200)');assert.equal(focus.width,'2px');assert.equal(focus.border,'rgb(200, 50, 80)')
      const focusedPoint=await evalPopup('(()=>{const r=document.activeElement.getBoundingClientRect();return{x:Math.round(r.x+20),y:Math.round(r.y+r.height/2)}})()')
      popup.webContents.sendInputEvent({type:'mouseMove',...focusedPoint});await new Promise(resolve=>setTimeout(resolve,100))
      assert.equal(await evalPopup('getComputedStyle(document.activeElement).backgroundColor'),'rgb(90, 30, 150)')
      assert.equal((await sync()).actions.length,0,'hover/focus creates no business action')
      assert.equal(await evalSource('AppearanceFixture.events()'),0,'source sees no hover/focus/input/click side effects')
      await popup.webContents.reload();await settle()
      assert.equal(await evalPopup('document.body.dataset.interactions'),'limited')
      popup.webContents.sendInputEvent({type:'mouseMove',...point});await new Promise(resolve=>setTimeout(resolve,100))
      assert.equal(await evalPopup('getComputedStyle(document.querySelector("[data-control=c0]")).backgroundColor'),'rgb(10, 120, 220)')
      await sync({appearance:{mode:'fallback',reason:'unavailable'}});await new Promise(resolve=>setTimeout(resolve,100))
      assert.equal(await evalPopup('document.body.dataset.hasLayout'),'false')
      assert.equal(await evalPopup('document.body.dataset.interactions'),'none')
      assert.equal(await evalPopup('getComputedStyle(document.querySelector("[data-control=c0]")).backgroundColor'),'rgb(255, 255, 255)')
    })
    await client.request({op:'close',id:'styled',lease:'source'})
    const companionRuntimeHashes=Object.fromEntries(await Promise.all(['main.cjs','preload.cjs','controls-renderer.js','controls-window.html','controls.css'].map(async file=>[file,createHash('sha256').update(await readFile(join(root,'lib','companion',file))).digest('hex')])))
    const report={date:'2026-10-05',executedAt:new Date().toISOString(),checks,scope:'real isolated source/companion Electron windows + authenticated Named Pipe + native popup input; sandbox:true webPreferences but test launcher uses --no-sandbox; not installed DSH acceptance',
      screenshots,cspUnchanged:true,themeSync:true,styleDeltas:true,explicitBudgetFallback:true,
      interactionChecks:{cssomBoundaryAssertions:11,nativeHover:true,nativeKeyboardFocusVisible:true,combinedStates:true,reload:true,sourceEventCount:await evalSource('AppearanceFixture.events()')},
      rendererBundleSha256:createHash('sha256').update(await readFile(join(root,'lib','client.js'))).digest('hex'),
      companionBundleSha256:createHash('sha256').update(await readFile(join(root,'lib','companion','main.cjs'))).digest('hex'),companionRuntimeHashes}
    await writeFile(join(root,'docs','companion-appearance-acceptance-2026-10-05.json'),JSON.stringify(report,null,2)+'\n')
    console.log(JSON.stringify(report,null,2));app.exitCode=0
  }catch(error){console.error(error);app.exitCode=1}
  finally{clearTimeout(timeout);client?.dispose();await server?.dispose();manager?.dispose();source?.destroy();app.exit(app.exitCode??0)}
})
