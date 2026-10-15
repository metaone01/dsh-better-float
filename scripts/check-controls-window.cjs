const{app,BrowserWindow}=require('electron')
const{build}=require('esbuild')
const{join}=require('node:path')
const{writeFile,mkdir}=require('node:fs/promises')
const assert=require('node:assert/strict')
app.setPath('userData',join(__dirname,'..','.dsh-debug-userdata-controls-window'))
app.on('window-all-closed',()=>{})
const timer=setTimeout(()=>{console.error('Controls window check timed out');app.exit(1)},30000)
app.whenReady().then(async()=>{
  let manager
  try{
    const{outputFiles}=await build({entryPoints:[join(__dirname,'..','companion','window-manager.ts')],bundle:true,platform:'node',format:'cjs',write:false,external:['electron']})
    const module={exports:{}}
    new Function('require','module','exports',outputFiles[0].text)(require,module,module.exports)
    manager=module.exports.createCompanionWindows(join(__dirname,'..','lib','companion'),false)
    let checks=0
    const snapshot={revision:0,title:'Controls regression',controls:[{key:'c0',kind:'button',text:'Count 0',disabled:false},
      {key:'c1',kind:'input',value:'draft',placeholder:'Text',disabled:false,readOnly:false}]}
    const actions=[]
    const surface=await manager.open('one',snapshot,intent=>{actions.push(intent);return true})
    const window=BrowserWindow.getAllWindows()[0]
    const evalJs=expression=>window.webContents.executeJavaScript(expression,true)
    const tick=()=>evalJs('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    await tick()
    const check=async(expression,expected,label)=>{assert.deepEqual(await evalJs(expression),expected,label);checks++}
    await check('typeof require','undefined','no renderer Node access')
    await check('typeof floatControls.action','function','white-listed preload API is available')
    await check('document.querySelector("[data-control=c0]").textContent','Count 0','initial snapshot rendered')
    const button=await evalJs('(()=>{const r=document.querySelector("[data-control=c0]").getBoundingClientRect();return{x:Math.round(r.x+30),y:Math.round(r.y+r.height/2)}})()')
    for(const type of ['mouseMove','mouseDown','mouseUp']){window.webContents.sendInputEvent({type,...button,button:'left',clickCount:1});await tick()}
    assert.deepEqual(actions,[{key:'c0',kind:'click'}]);checks++
    await evalJs('document.querySelector("[data-control=c1]").focus()')
    window.webContents.insertText(' from popup')
    await tick()
    assert.ok(actions.some(action=>action.kind==='input' && action.value.includes('from popup')));checks++
    await evalJs('document.querySelector("[data-control=c1]").blur()')
    surface.update({...snapshot,revision:1,controls:[{...snapshot.controls[0],text:'Count 1'},
      {...snapshot.controls[1],value:'external state',readOnly:true}]})
    await tick()
    await check('document.querySelector("[data-control=c0]").textContent','Count 1','state update reaches popup')
    await check('document.querySelector("[data-control=c1]").value','external state','source state reaches input')
    await check('document.querySelector("[data-control=c1]").readOnly',true,'read-only state reaches popup')
    surface.update({...snapshot,revision:0})
    await tick()
    await check('document.querySelector("[data-control=c0]").textContent','Count 1','old snapshot cannot overwrite new revision')
    const other=new BrowserWindow({show:false,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,preload:join(__dirname,'..','lib','companion','preload.cjs')}})
    await other.loadURL('data:text/html,<html><body>Unowned fixture</body></html>')
    assert.equal(await other.webContents.executeJavaScript('floatControls.action({kind:"click",key:"c0"})',true),false);checks++
    other.destroy()
    await mkdir(join(__dirname,'..','docs','screenshots'),{recursive:true})
    await writeFile(join(__dirname,'..','docs','screenshots','companion-controls-prototype.png'),(await window.webContents.capturePage()).toPNG())
    surface.close()
    assert.equal(surface.alive(),false);checks++
    console.log(`Companion controls window: ${checks} assertions passed, including trusted input and unowned preload rejection; not full DSH/ACL acceptance.`)
    app.exit(0)
  }catch(error){console.error(error);app.exit(1)}finally{clearTimeout(timer);manager?.dispose()}
})
