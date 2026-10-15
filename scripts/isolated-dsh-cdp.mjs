import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {resolve} from 'node:path'

export async function connectIsolatedDsh() {
  const owners=JSON.parse(execFileSync('powershell',['-NoProfile','-NonInteractive','-Command',`$rows = @(Get-NetTCPConnection -State Listen -LocalPort 9222 | Where-Object LocalAddress -eq '127.0.0.1' | ForEach-Object { Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $_.OwningProcess) } | Select-Object ProcessId,CommandLine); ConvertTo-Json -InputObject $rows -Compress`],{encoding:'utf8',windowsHide:true}).trim())
  assert.equal(owners.length,1,'Exactly one isolated CDP owner required')
  assert.ok(owners[0].CommandLine.includes(`--user-data-dir=${resolve('.dsh-debug-userdata-e0e1-20261003/electron')}`),'Refusing non-isolated Desktop')
  const targets=await(await fetch('http://127.0.0.1:9222/json/list')).json(),page=targets.find(t=>t.type==='page'&&t.url.startsWith('dsh-app://app/'))
  assert.ok(page)
  const socket=new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true})})
  let next=0;const pending=new Map()
  socket.addEventListener('message',({data})=>{const msg=JSON.parse(data),p=pending.get(msg.id);if(p){pending.delete(msg.id);clearTimeout(p.timer);msg.error?p.reject(Error(msg.error.message)):p.resolve(msg.result)}})
  const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++next,timer=setTimeout(()=>{pending.delete(id);reject(Error(method+' timeout'))},10000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}))})
  const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description??r.exceptionDetails.text);return r.result.value}
  return {send,evaluate,desktopPid:owners[0].ProcessId,close:()=>socket.close()}
}
