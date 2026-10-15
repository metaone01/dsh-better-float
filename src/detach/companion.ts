import { COMPANION_CHANNEL, validCompanionValue, type CompanionRequest, type CompanionResult } from '../shared/companion.ts'
import type { ControlSnapshot } from '../shared/control-adapter.ts'
import { browserIdentity } from '../shared/identity.ts'

/** Uses the authenticated host Connection route, never a new loopback server. */
export function createCompanionBridge() {
  const lease = `renderer-${browserIdentity()}`
  let disposed = false
  let heartbeat: ReturnType<typeof setTimeout> | null = null
  const inflight = new Set<AbortController>()
  const call = async (payload: CompanionRequest): Promise<CompanionResult> => {
    if(disposed) return {ok:false,error:{code:'companion/disposed',message:'Disposed',details:{}}}
    const abort = new AbortController()
    inflight.add(abort)
    const startsBackend=payload.op==='ping' || payload.op==='open-controls' || payload.op==='open-test'
    const timer = setTimeout(()=>abort.abort(),startsBackend?15000:2500)
    const rpcId = browserIdentity()
    try {
      const response = await fetch(`${COMPANION_CHANNEL.slice(1)}/request`,{ method:'POST',credentials:'same-origin',
        headers:{'content-type':'application/json'},signal:abort.signal,
        body:JSON.stringify({type:'client-request',rpcId,method:'request',payload}) })
      if(!response.ok) throw new Error('host route unavailable')
      const envelope = await response.json() as {rpcId?:string;result?:CompanionResult}
      if(envelope.rpcId !== rpcId || !envelope.result || typeof envelope.result.ok !== 'boolean') throw new Error('invalid reply')
      if(envelope.result.ok && !validCompanionValue(envelope.result.value)) throw new Error('invalid value')
      if(!envelope.result.ok && (!envelope.result.error || typeof envelope.result.error.code!=='string')) throw new Error('invalid failure')
      return envelope.result
    } catch { return {ok:false,error:{code:'companion/unavailable',message:'Companion unavailable',details:{}}} }
    finally {clearTimeout(timer);inflight.delete(abort)}
  }
  const pulse = (): void => {
    heartbeat = setTimeout(() => { void call({op:'pulse',lease}).then(result => {
      if(!disposed && result.ok && result.value.windows.length>0) pulse()
    }) },2000)
  }
  const stop = (): void => {if(heartbeat !== null)clearTimeout(heartbeat);heartbeat=null}
  const release = (): void => {
    stop()
    const rpcId = browserIdentity()
    // Best effort during unload; the lease is the authoritative fallback.
    void fetch(`${COMPANION_CHANNEL.slice(1)}/request`,{method:'POST',credentials:'same-origin',keepalive:true,
      headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId,method:'request',payload:{op:'release',lease}})}).catch(()=>{})
  }
  const onPageHide = (): void => { release() }
  window.addEventListener('pagehide',onPageHide)
  return {
    ping:()=>call({op:'ping'}),
    async openTest(id = `test-${browserIdentity()}`) {
      const result = await call({op:'open-test',lease,id})
      if(!disposed && result.ok) {stop();pulse()}
      return result
    },
    list:()=>call({op:'list',lease}),
    close: (id:string)=>call({op:'close',lease,id}),
    openControls:(id:string,snapshot:ControlSnapshot)=>call({op:'open-controls',lease,id,snapshot}),
    syncControls:(id:string,snapshot:ControlSnapshot,ack:number)=>call({op:'sync-controls',lease,id,snapshot,ack}),
    /** Stop renewing without sending release, for lease-expiry acceptance. */
    stopHeartbeat:stop,
    dispose():void {if(disposed)return;release();disposed=true;window.removeEventListener('pagehide',onPageHide);for(const abort of inflight)abort.abort()},
  }
}
export type CompanionBridge = ReturnType<typeof createCompanionBridge>
