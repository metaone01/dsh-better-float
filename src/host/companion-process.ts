import { spawn, type ChildProcess } from 'node:child_process'
import { lstat } from 'node:fs/promises'
import { basename, dirname, isAbsolute } from 'node:path'
import { createPipeClient } from './pipe-client.ts'
import { readPrivatePairing } from './pairing-security.ts'
import { validPairing, type Pairing } from './pipe-protocol.ts'
import type { CompanionRequest, CompanionValue } from '../shared/companion.ts'

export interface CompanionLaunch { readonly executable:string; readonly entry:string }
interface OwnedProcess { readonly child:ChildProcess; readonly exited:Promise<void>; finished:boolean;pairing?:Pairing }

/** Launch paths come only from operator configuration, never Renderer requests. */
export function createCompanionProcess(pairingFile:string,launch?:CompanionLaunch) {
  let pipe=createPipeClient(pairingFile)
  let owned:OwnedProcess|null=null
  let checking:Promise<void>|null=null
  let disposed=false
  const reset=():void=>{pipe.dispose();pipe=createPipeClient(pairingFile)}
  const waitExit=async(record:OwnedProcess,ms:number):Promise<boolean>=>{
    let timer:ReturnType<typeof setTimeout>|undefined
    try{return await Promise.race([record.exited.then(()=>true),new Promise<boolean>(resolve=>{timer=setTimeout(()=>resolve(false),ms)})])}
    finally{if(timer)clearTimeout(timer)}
  }
  const stopOwned=async():Promise<void>=>{
    const record=owned
    if(!record)return
    if(!record.finished) {
      const control=createPipeClient(pairingFile)
      try{
        const current=await readPrivatePairing(pairingFile)
        if(record.pairing && validPairing(current) && current.pipe===record.pairing.pipe && current.secret===record.pairing.secret)
          await control.request({op:'shutdown'})
      }catch{}finally{control.dispose()}
      if(!await waitExit(record,1500)) {
        // Only the live ChildProcess handle created here; no PID/name discovery.
        record.child.kill()
        if(!await waitExit(record,1500))throw new Error('Managed companion could not stop')
      }
    }
    if(owned===record)owned=null
  }
  const start=async():Promise<void>=>{
    if(!launch || disposed)throw new Error('Companion automatic startup is not configured')
    if(!isAbsolute(pairingFile) || !isAbsolute(launch.executable) || !isAbsolute(launch.entry)
      || basename(launch.executable).toLowerCase()!==(process.platform==='win32'?'electron.exe':'electron')
      || basename(launch.entry)!=='main.cjs' || basename(dirname(pairingFile))!=='credentials'
      || basename(pairingFile)!=='pairing.json')throw new Error('Invalid companion launch configuration')
    for(const path of [launch.executable,launch.entry]) {
      const info=await lstat(path)
      if(!info.isFile() || info.isSymbolicLink())throw new Error('Invalid companion launch file')
    }
    if(disposed)throw new Error('Companion manager disposed')
    const env={...process.env,DSH_BETTER_FLOAT_COMPANION_DIR:dirname(dirname(pairingFile)),DSH_BF_MANAGED:'1',DSH_BF_PARENT_PID:String(process.pid)}
    delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE
    const child=spawn(launch.executable,[launch.entry],{env,stdio:['ignore','pipe','ignore'],windowsHide:true})
    const record:OwnedProcess={child,finished:false,exited:new Promise(resolve=>{
      child.once('exit',()=>{record.finished=true;resolve()})
      child.once('error',()=>{record.finished=true;resolve()})
    })}
    owned=record
    await new Promise<void>((resolve,reject)=>{
      let pending='',settled=false
      const settle=(error?:Error):void=>{
        if(settled)return
        settled=true;clearTimeout(timer);child.stdout?.removeListener('data',read)
        error?reject(error):resolve()
      }
      const read=(chunk:Buffer):void=>{
        pending+=chunk.toString('utf8')
        if(pending.length>16384){settle(new Error('Companion startup output limit'));return}
        let end
        while((end=pending.indexOf('\n'))>=0) {
          const line=pending.slice(0,end);pending=pending.slice(end+1)
          try { if(JSON.parse(line).status==='ready'){settle();return} } catch {}
        }
      }
      const timer=setTimeout(()=>settle(new Error('Companion startup timeout')),8000)
      child.stdout?.on('data',read)
      void record.exited.then(()=>settle(new Error('Companion startup refused or exited')))
    })
    // Drain stdout without retaining payloads. Readiness still requires pipe auth.
    child.stdout?.resume()
    if(disposed)throw new Error('Companion manager disposed')
    await pipe.request({op:'ping'})
    const current=await readPrivatePairing(pairingFile)
    if(!validPairing(current))throw new Error('Companion pairing invalid')
    record.pairing=current
  }
  const ensure=():Promise<void>=>{
    if(checking)return checking
    checking=(async()=>{
      if(disposed)throw new Error('Companion manager disposed')
      try{await pipe.request({op:'ping'});return}catch{}
      if(!launch)throw new Error('Companion unavailable')
      await stopOwned();reset()
      try{await start()}catch(error){await stopOwned();reset();throw error}
    })().finally(()=>{checking=null})
    return checking
  }
  return {
    async request(request:CompanionRequest,signal?:AbortSignal):Promise<CompanionValue> {
      if(disposed || signal?.aborted)throw new Error('Companion request cancelled')
      // Sync/close/release must never resurrect a process or replay old actions.
      if(request.op==='ping' || request.op==='open-controls' || request.op==='open-test')await ensure()
      if(disposed || signal?.aborted)throw new Error('Companion request cancelled')
      return pipe.request(request)
    },
    ownedPid():number|undefined {return owned&&!owned.finished?owned.child.pid:undefined},
    async dispose():Promise<void> {
      disposed=true;pipe.dispose()
      // Wait for an in-flight launch to observe disposal before final cleanup.
      await checking?.catch(()=>{})
      await stopOwned();pipe.dispose()
    },
  }
}
