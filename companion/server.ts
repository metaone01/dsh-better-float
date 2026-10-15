import { createServer, type Socket } from 'node:net'
import { randomBytes } from 'node:crypto'
import { receiveFrames, sendFrame, proof, matches, frameBytes, MAX_FRAME, type Pairing } from '../src/host/pipe-protocol.ts'
import { LEASE_MS, validCompanionRequest, type TestWindow } from '../src/shared/companion.ts'
import { validIntent, type ControlSnapshot, type ControlIntent, type ControlAction } from '../src/shared/control-adapter.ts'

export interface TestSurface { close(): void; alive(): boolean; update?(snapshot:ControlSnapshot):void }
interface OwnedWindow {
  surface:TestSurface;lease:string;expires:number;loading?:boolean;snapshot?:ControlSnapshot;
  actions:ControlAction[];seq:number;ack:number
}
export function createCompanionServer(pairing: Pairing,
  createWindow: (id: string,snapshot?:ControlSnapshot,onIntent?:(intent:ControlIntent)=>boolean) => Promise<TestSurface>, leaseMs = LEASE_MS,
  onShutdown?:()=>void) {
  const sockets = new Set<Socket>()
  const owned = new Map<Socket,Map<string,OwnedWindow>>()
  let disposed = false
  let openedWindow=false
  const cleanup = (socket: Socket): void => {
    for (const item of owned.get(socket)?.values() ?? []) item.surface.close()
    owned.delete(socket)
    sockets.delete(socket)
  }
  const sweep = setInterval(() => {
    for (const windows of owned.values()) for (const [id,window] of windows) {
      if (window.expires <= Date.now() || (!window.loading && !window.surface.alive())) { window.surface.close(); windows.delete(id) }
    }
  }, Math.min(1000,leaseMs/2))
  sweep.unref()
  const server = createServer(socket => {
    if (disposed || sockets.size >= 8) { socket.destroy(); return }
    sockets.add(socket)
    const windows = new Map<string,OwnedWindow>()
    owned.set(socket,windows)
    const challenge = randomBytes(32).toString('hex')
    let session = ''
    let lastSequence = 0
    let active = 0
    let rateStart = Date.now()
    let count = 0
    const authTimer = setTimeout(() => socket.destroy(),1500)
    socket.on('error', () => {})
    socket.on('close', () => { clearTimeout(authTimer); cleanup(socket) })
    sendFrame(socket,{type:'challenge',version:1,nonce:challenge})
    receiveFrames(socket, frame => {
      if (!session) {
        if (frame.type !== 'auth' || typeof frame.nonce !== 'string' || !/^[a-f0-9]{64}$/.test(frame.nonce)
          || !matches(pairing.secret,`client:${challenge}:${frame.nonce}`,frame.proof)) { socket.destroy(); return }
        session = `${challenge}:${frame.nonce}`
        clearTimeout(authTimer)
        sendFrame(socket,{type:'ready',proof:proof(pairing.secret,`server:${session}`)})
        return
      }
      if (Date.now()-rateStart >= 1000) { rateStart = Date.now(); count = 0 }
      if (++count > 50 || active >= 16 || frame.type !== 'request' || typeof frame.seq !== 'number'
        || !Number.isSafeInteger(frame.seq) || frame.seq <= lastSequence
        || !(validCompanionRequest(frame.payload) || (onShutdown && frame.payload && typeof frame.payload==='object'
          && Object.keys(frame.payload).length===1 && (frame.payload as {op?:unknown}).op==='shutdown'))
        || !matches(pairing.secret,`request:${session}:${frame.seq}:${JSON.stringify(frame.payload)}`,frame.proof)) {
        socket.destroy(); return
      }
      lastSequence = frame.seq
      const request = frame.payload as import('../src/shared/companion.ts').CompanionRequest | {op:'shutdown'}
      const seq = frame.seq
      active++
      void (async () => {
        try {
          let outgoing:readonly ControlAction[]|undefined
          if (request.op === 'open-test' || request.op === 'open-controls') {
            if (windows.has(request.id)) throw new Error('duplicate id')
            if (windows.size >= 3 || [...owned.values()].reduce((n,map)=>n+map.size,0) >= 12) throw new Error('window limit')
            // Reserve before async loading; concurrent requests cannot bypass limits.
            const reservation:OwnedWindow = {surface:{close() {},alive:()=>false},lease:request.lease,expires:Date.now()+leaseMs,loading:true,
              snapshot:request.op==='open-controls'?request.snapshot:undefined,actions:[],seq:0,ack:0}
            windows.set(request.id,reservation)
            try {
              const surface = await createWindow(request.id,reservation.snapshot,intent=>{
                const item=windows.get(request.id)
                if(!item || socket.destroyed || !validIntent(intent) || item.actions.length>=32 || item.expires<=Date.now())return false
                const control=item.snapshot?.controls.find(control=>control.key===intent.key)
                if(!control || control.binding!==intent.binding || control.disabled || (intent.kind==='input' ? control.kind!=='input' || control.readOnly : control.kind!=='button'))return false
                item.actions.push({...intent,seq:++item.seq})
                return true
              })
              if (disposed || socket.destroyed || windows.get(request.id) !== reservation) { surface.close(); return }
              reservation.surface=surface
              openedWindow=true
              reservation.loading=false
              reservation.expires=Date.now()+leaseMs
            } catch { windows.delete(request.id); throw new Error('window creation failed') }
          } else if(request.op==='sync-controls') {
            const window=windows.get(request.id)
            if(window?.lease===request.lease) {
              if(window.loading || !window.snapshot || request.snapshot.revision<window.snapshot.revision
                || request.ack<window.ack || request.ack>window.seq)throw new Error('Invalid revision or acknowledgement')
              window.ack=request.ack
              window.actions=window.actions.filter(action=>action.seq>request.ack)
              window.snapshot=request.snapshot
              window.expires=Date.now()+leaseMs
              window.surface.update?.(request.snapshot)
              outgoing=window.actions.slice(0,8)
            }
          } else if (request.op === 'close') {
            const window = windows.get(request.id)
            if (window?.lease === request.lease) { window.surface.close(); windows.delete(request.id) }
          } else if (request.op === 'release') {
            for (const [id,window] of windows) if (window.lease === request.lease) { window.surface.close(); windows.delete(id) }
          } else if (request.op === 'pulse') {
            for (const window of windows.values()) if (window.lease === request.lease) window.expires = Date.now()+leaseMs
          }
          const visible: TestWindow[] = [...windows].filter(([,item])=>item.surface.alive()
            && (request.op === 'ping' || ('lease' in request && item.lease === request.lease))).map(([id,item])=>({id,lease:item.lease}))
          const reply = (result: unknown) => ({type:'reply',seq,result,proof:proof(pairing.secret,`reply:${session}:${seq}:${JSON.stringify(result)}`)})
          const value = {version:1,testOnly:true,windows:visible}
          const actions:ControlAction[] = []
          if(outgoing !== undefined) {
            for(const action of outgoing) {
              const candidate = {ok:true,value:{...value,actions:[...actions,action]}}
              if(frameBytes(reply(candidate)) > MAX_FRAME) break
              actions.push(action)
            }
            if(outgoing.length>0 && actions.length===0) throw new Error('action exceeds frame limit')
          }
          // Sending does not dequeue: only the source acknowledgement removes actions.
          const result = {ok:true,value:{...value,...outgoing===undefined?{}:{actions}}}
          if (!socket.destroyed) sendFrame(socket,reply(result))
          if(request.op==='shutdown')setImmediate(()=>onShutdown?.())
        } catch {
          const result = {ok:false,error:{code:'companion/rejected',message:'Request rejected',details:{}}}
          if (!socket.destroyed) sendFrame(socket,{type:'reply',seq,result,proof:proof(pairing.secret,`reply:${session}:${seq}:${JSON.stringify(result)}`)})
        } finally { active-- }
      })().catch(() => socket.destroy())
    })
  })
  return {
    server,
    windowCount():number {return [...owned.values()].reduce((total,windows)=>total+windows.size,0)},
    hasOpenedWindow():boolean {return openedWindow},
    async listen(): Promise<void> { await new Promise<void>((resolve,reject) => {
      server.once('error',reject)
      server.listen(pairing.pipe,() => { server.off('error',reject); resolve() })
    }) },
    async dispose(): Promise<void> {
      disposed = true
      clearInterval(sweep)
      for (const socket of sockets) { cleanup(socket); socket.destroy() }
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}
