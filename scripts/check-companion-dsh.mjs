import assert from 'node:assert/strict'
import { readFile,writeFile,mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'

async function cdp(port) {
  const targets=await(await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(2000)})).json()
  const page=targets.find(target=>target.url?.startsWith(port===9222?'dsh-app://app/':'file:'))
  assert.ok(page,'test page target required')
  const socket=new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(Error('CDP timeout')),2000);socket.addEventListener('open',()=>{clearTimeout(t);resolve()},{once:true})})
  const pending=new Map();let next=0
  socket.addEventListener('message',({data})=>{const value=JSON.parse(data);const task=pending.get(value.id);if(!task)return;clearTimeout(task.timer);pending.delete(value.id);value.error?task.reject(Error(value.error.message)):task.resolve(value.result)})
  const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++next;const timer=setTimeout(()=>{pending.delete(id);reject(Error(method+' timeout'))},5000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}))})
  return {send,evaluate:async expression=>{const result=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description??result.exceptionDetails.text);return result.result.value},close(){for(const task of pending.values())clearTimeout(task.timer);pending.clear();socket.close()}}
}
const host=await cdp(9222)
let popup
let checks=0
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))
const check=async(expression,expected,label)=>{assert.deepEqual(await host.evaluate(expression),expected,label);checks++}
try {
  await check('!!window.__BF_ACCEPTANCE__ && !!document.querySelector("[data-better-float=layer]")',true,'actual plugin activated in DSH')
  const row=await host.evaluate('window.__DSH_BOOT__.entries.find(row=>row.id==="@metaone01/dsh-better-float")')
  const served=await host.evaluate(`fetch(${JSON.stringify(row.url)}).then(response=>response.text())`)
  const disk=await readFile('lib/client.js','utf8')
  assert.ok(served.startsWith(disk.trimEnd()),'installed client matches current artifact');checks++
  const pairing=JSON.parse(await readFile('.dsh-debug-userdata-companion/credentials/pairing.json','utf8'))
  assert.equal(served.includes(pairing.secret),false,'secret is not served to Renderer');checks++
  await host.evaluate('window.__BF_PIPE_TEST__=window.__BF_ACCEPTANCE__.companion()')
  await check('window.__BF_PIPE_TEST__.ping().then(result=>result.ok && result.value.testOnly)',true,'Renderer -> authenticated Host RPC -> authenticated pipe handshake')
  const latencies=[]
  for(let i=0;i<10;i++) {
    const measurement=await host.evaluate('(async()=>{const started=performance.now();const result=await window.__BF_PIPE_TEST__.ping();if(!result.ok)throw Error("ping failed");return performance.now()-started})()')
    latencies.push(measurement)
  }
  await check('window.__BF_PIPE_TEST__.openTest("acceptance-window").then(result=>result.ok && result.value.windows.length===1)',true,'actual companion window opens')
  popup=await cdp(9223)
  const info=await popup.evaluate('({title:document.title,text:document.body.innerText,nodeAvailable:typeof require})')
  assert.equal(info.title,'Better Float · Connection test');checks++
  assert.ok(info.text.includes('不是原控件'));checks++
  assert.equal(info.nodeAvailable,'undefined');checks++
  const shot=await popup.send('Page.captureScreenshot',{format:'png'})
  await mkdir('docs/screenshots',{recursive:true})
  await writeFile('docs/screenshots/companion-pipe-window.png',Buffer.from(shot.data,'base64'))
  popup.close();popup=null
  await pause(3000)
  await check('window.__BF_PIPE_TEST__.list().then(result=>result.ok && result.value.windows.length)',1,'Renderer heartbeat renews lease')
  await check('window.__BF_PIPE_TEST__.close("acceptance-window").then(result=>result.ok && result.value.windows.length)',0,'explicit close releases OS window')
  await check('window.__BF_PIPE_TEST__.openTest("lease-expiry").then(result=>result.ok)',true,'second OS window opens')
  await host.evaluate('window.__BF_PIPE_TEST__.stopHeartbeat()')
  await pause(9500)
  await check('window.__BF_PIPE_TEST__.list().then(result=>result.ok && result.value.windows.length)',0,'window expires without Renderer heartbeat')
  await check('window.__BF_PIPE_TEST__.openTest("dispose-window").then(result=>result.ok)',true,'disposal fixture opens')
  await host.evaluate('window.__BF_PIPE_TEST__.dispose();window.__BF_PIPE_TEST__=window.__BF_ACCEPTANCE__.companion()')
  await pause(200)
  const targets=await(await fetch('http://127.0.0.1:9223/json/list')).json()
  assert.equal(targets.filter(target=>target.type==='page').length,0,'renderer disposal closes actual OS window');checks++
  const sorted=latencies.sort((a,b)=>a-b)
  const result={checks,transport:'existing DSH Connection RPC + Windows Named Pipe',testOnly:true,
    rendererBundleSha256:createHash('sha256').update(disk).digest('hex'),
    sequentialPingMs:{samples:sorted.length,min:sorted[0],median:sorted[5],max:sorted.at(-1)},
    scope:'isolated installed plugin; system connection-test windows only, no control migration'}
  await writeFile('docs/companion-pipe-acceptance.json',JSON.stringify(result,null,2)+'\n')
  console.log(JSON.stringify(result,null,2))
} finally {
  try {await host.evaluate('window.__BF_PIPE_TEST__?.dispose();delete window.__BF_PIPE_TEST__')}catch{}
  popup?.close();host.close()
}
