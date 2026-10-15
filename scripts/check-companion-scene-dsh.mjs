import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {readFile,writeFile,mkdir} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {join} from 'node:path'
import {connectIsolatedDsh} from './isolated-dsh-cdp.mjs'
const owned=await connectIsolatedDsh();owned.close()
const targets=await(await fetch('http://127.0.0.1:9222/json/list')).json()
const page=targets.find(item=>item.type==='page'&&item.url.startsWith('dsh-app://app/'));assert.ok(page)
const socket=new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true})})
let next=0;const pending=new Map()
socket.addEventListener('message',({data})=>{const message=JSON.parse(data),task=pending.get(message.id);if(task){pending.delete(message.id);clearTimeout(task.timer);message.error?task.reject(Error(message.error.message)):task.resolve(message.result)}})
const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++next,timer=setTimeout(()=>{pending.delete(id);reject(Error(method+' timeout'))},10000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}))})
const evaluate=async expression=>{const result=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description??result.exceptionDetails.text);return result.result.value}
try{
 const row=await evaluate('window.__DSH_BOOT__.entries.find(item=>item.id==="@metaone01/dsh-better-float")')
 const disk=await readFile('lib/client.js','utf8')
 assert.ok((await evaluate(`fetch(${JSON.stringify(row.url)}).then(response=>response.text())`)).startsWith(disk.trimEnd()),'Isolated Host must serve current renderer')
 assert.equal(await evaluate('typeof window.__BF_ACCEPTANCE__.openSource'),'function','Updated test fixture required')
 const browser=await build({stdin:{contents:`export {captureControls} from './src/detach/semantic-adapter.ts'`,resolveDir:process.cwd()},bundle:true,write:false,format:'iife',globalName:'DshSceneCapture'})
 await evaluate(browser.outputFiles[0].text)
 const snapshot=await evaluate(`(()=>{const label=[...document.querySelectorAll('span')].find(node=>node.textContent==='Workspaces'||node.textContent==='工作区');if(!label)throw Error('Missing actual workspace title');window.__BF_REAL_WORKSPACE__=label.parentElement.parentElement;try{return DshSceneCapture.captureControls(window.__BF_REAL_WORKSPACE__).read(0)}catch(error){return {error:error.message}}})()`)
 if(snapshot.error)throw Error('Actual workspace: '+snapshot.error)
 assert.equal(snapshot.adapter,'workspace-v1')
 assert.equal(snapshot.appearance?.mode,'captured','This visual check requires a visible, decorated source workspace')
 assert.ok(snapshot.scene.items.some(item=>item.icon),'Actual source folder SVG must be exported')
 assert.ok(snapshot.controls.some(item=>/Default workspace|默认工作区/.test(item.text??'')))
 assert.ok(snapshot.controls.length>=3 && snapshot.controls.length<=6)
 await evaluate(`(async()=>{window.__BF_REAL_HANDLE__=await window.__BF_ACCEPTANCE__.openSource(window.__BF_REAL_WORKSPACE__);return true})()`)
 assert.ok(await evaluate('window.__BF_REAL_HANDLE__.id.startsWith("controls-")'))
 await new Promise(resolve=>setTimeout(resolve,400))
 const desktopPid=Number(execFileSync('powershell',['-NoProfile','-NonInteractive','-Command','(Get-NetTCPConnection -State Listen -LocalPort 9222 | Where-Object LocalAddress -eq "127.0.0.1").OwningProcess'],{encoding:'utf8',windowsHide:true}).trim())
 assert.ok(Number.isSafeInteger(desktopPid)&&desktopPid>0)
 const native=JSON.parse(execFileSync('powershell',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',join(process.cwd(),'scripts','capture-isolated-companion.ps1'),'-DesktopPid',String(desktopPid),'-OutputPath',join(process.cwd(),'docs','screenshots','workspace-adapter-managed-popup.png')],{encoding:'utf8',windowsHide:true,timeout:15000}).trim())
 const hashes=async name=>createHash('sha256').update(await readFile(name)).digest('hex')
 const companionRuntimeHashes=Object.fromEntries(await Promise.all(['main.cjs','preload.cjs','controls-renderer.js','controls-window.html','controls.css'].map(async file=>[file,await hashes(`lib/companion/${file}`)])))
 const report={date:new Date().toISOString(),scope:'isolated DSH actual workspace DOM + installed plugin Host + managed companion; no default user DOM or data',
   projectionLabels:snapshot.controls.filter(control=>control.kind==='button').map(control=>control.text),projectedControls:snapshot.controls.map(control=>({kind:control.kind,text:control.text})),
   limitedWorkspaceAdapter:true,displayOnly:false,openedViaInstalledHost:true,nativeWindow:native,actualWorkspaceInteractionsNotClaimed:true,popupVisualAcceptancePending:true,sourceScreenshotCaptured:false,
   appearanceEvidence:{mode:snapshot.appearance.mode,bytes:new TextEncoder().encode(JSON.stringify(snapshot)).byteLength,items:snapshot.scene.items.length,safeIcons:snapshot.scene.items.filter(item=>item.icon).length,...snapshot.workspaceVisual},
   rendererBundleSha256:await hashes('lib/client.js'),hostBundleSha256:await hashes('lib/index.js'),companionBundleSha256:await hashes('lib/companion/main.cjs'),companionRuntimeHashes}
 await writeFile('docs/companion-workspace-managed-open-2026-10-11.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2))
}finally{
 await evaluate('window.__BF_REAL_HANDLE__?.close();delete window.__BF_REAL_HANDLE__;delete window.__BF_REAL_WORKSPACE__;delete window.DshSceneCapture').catch(()=>{})
 let exited=false
 for(let attempt=0;attempt<100;attempt++){
   try{await readFile('.dsh-debug-userdata-companion/credentials/pairing.json')}
   catch(error){if(error.code==='ENOENT'){exited=true;break}throw error}
   await new Promise(resolve=>setTimeout(resolve,100))
 }
 socket.close()
 assert.equal(exited,true,'Isolated companion must idle-exit before next lifecycle test')
}
