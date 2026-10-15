import { app } from 'electron'
import { randomBytes } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { createCompanionServer } from './server.ts'
import { protectPairingDirectory } from '../src/host/pairing-security.ts'
import { createCompanionWindows } from './window-manager.ts'
import { LEASE_MS } from '../src/shared/companion.ts'
import { verifyExistingPairing, recoverStalePairing, removeOwnedPairing, PairingStartupError } from './pairing-lifecycle.ts'

const directory = resolve(process.env.DSH_BETTER_FLOAT_COMPANION_DIR ?? '.dsh-debug-userdata-companion')
const pairingFile = join(directory,'credentials','pairing.json')
const suffix = randomBytes(16).toString('hex')
const pairing = {pipe:process.platform === 'win32' ? `\\\\.\\pipe\\dsh-better-float-${suffix}`
  : join(directory,`dsh-better-float-${suffix}.sock`),secret:randomBytes(32).toString('hex')}
app.setPath('userData',join(directory,'electron'))
if(!app.requestSingleInstanceLock()) {
  console.error('Companion already running for this data directory.')
  app.exit(1)
}
app.on('window-all-closed', () => {})
let shuttingDown = false
let pairingOwned=false
const managed=process.env.DSH_BF_MANAGED==='1'
let idleTimer:ReturnType<typeof setInterval>|undefined
const windows=createCompanionWindows(__dirname)
const server=createCompanionServer(pairing,windows.open,LEASE_MS,managed?()=>void shutdown():undefined)
const shutdown = async (): Promise<void> => {
  if (shuttingDown) return
  shuttingDown = true
  if(idleTimer)clearInterval(idleTimer)
  await server.dispose()
  windows.dispose()
  if(pairingOwned)await removeOwnedPairing(pairingFile,pairing).catch(()=>{})
  app.quit()
}
app.on('before-quit',event => { if(!shuttingDown){event.preventDefault();void shutdown()} })
process.on('SIGINT',()=>void shutdown())
process.on('SIGTERM',()=>void shutdown())
app.whenReady().then(async () => {
  // Do not repair broad ACLs on an existing credential before deciding it is safe.
  await verifyExistingPairing(pairingFile)
  await protectPairingDirectory(dirname(pairingFile))
  const recoveredStalePairing = await recoverStalePairing(pairingFile)
  await server.listen()
  await writeFile(pairingFile,JSON.stringify(pairing),{flag:'wx',mode:0o600})
  pairingOwned=true
  if(managed) {
    let lastDemand=Date.now(),hadWindow=false
    idleTimer=setInterval(()=>{
      const parent=Number(process.env.DSH_BF_PARENT_PID)
      if(!Number.isSafeInteger(parent) || parent<=0){void shutdown();return}
      try{process.kill(parent,0)}catch{void shutdown();return}
      if(server.windowCount()>0){lastDemand=Date.now();hadWindow=true;return}
      // Allow initial consent review; opening after expiry will start a fresh process.
      if(Date.now()-lastDemand>=((hadWindow||server.hasOpenedWindow())?1500:15000))void shutdown()
    },250)
  }
  console.log(JSON.stringify({status:'ready',pid:process.pid,pairingFile,transport:'named-pipe',testOnly:true,recoveredStalePairing}))
}).catch(async error => {
  const reason = error instanceof PairingStartupError ? error.reason : 'permissions-or-startup'
  console.error(`Companion could not start: ${reason}. Existing credentials were not overwritten.`)
  await server.dispose();windows.dispose();app.exit(1)
})
