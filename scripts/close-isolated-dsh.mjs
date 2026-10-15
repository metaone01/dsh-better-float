import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {connectIsolatedDsh} from './isolated-dsh-cdp.mjs'
const cdp=await connectIsolatedDsh()
console.log('Closing only verified isolated Desktop PID',cdp.desktopPid)
await cdp.send('Browser.close').catch(()=>{})
cdp.close()
const remaining=execFileSync('powershell',['-NoProfile','-NonInteractive','-Command',`@(Get-CimInstance Win32_Process -Filter 'ProcessId = ${cdp.desktopPid}').Count`],{encoding:'utf8',windowsHide:true}).trim()
assert.equal(remaining,'0','Isolated Desktop must exit')
console.log('Verified isolated Desktop exited')
