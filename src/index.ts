import { createCompanionProcess } from './host/companion-process.ts'
import { PipeFrameSizeError } from './host/pipe-protocol.ts'
import { COMPANION_CHANNEL, validCompanionRequest } from './shared/companion.ts'

interface HostContext {
  effect(run: () => unknown, label?: string): unknown
  inject(names: string[], run: (ctx: HostContext) => void): unknown
  connection: {fetch:{register(route:{path:string;methods:readonly string[];requestBody:'buffered';fetch:(request:Request)=>Promise<Response>}):()=>Promise<void>}}
}
/** Lazy optional backend: only an explicit window request can launch it. */
export function apply(ctx: HostContext, config: {companionPairingFile?:string;companionExecutable?:string;companionEntry?:string} = {}): void {
  const configured = typeof config.companionPairingFile === 'string' ? config.companionPairingFile : ''
  const launch=typeof config.companionExecutable==='string' && typeof config.companionEntry==='string'
    ? {executable:config.companionExecutable,entry:config.companionEntry} : undefined
  const pipe = configured ? createCompanionProcess(configured,launch) : null
  ctx.effect(()=>()=>pipe?.dispose(),'better-float: pipe disposal')
  ctx.effect(()=>ctx.inject(['connection'],child=> {
    if(typeof child.connection?.fetch?.register !== 'function') return
    const handle = async (endpoint:unknown,payload:unknown,signal:AbortSignal) => {
      if(endpoint !== 'request' || !validCompanionRequest(payload)) return {ok:false,error:{code:'companion/invalid',message:'Invalid window request',details:{}}}
      if(!pipe || signal.aborted) return {ok:false,error:{code:'companion/not-configured',message:'Companion is not configured',details:{}}}
      try {return {ok:true,value:await pipe.request(payload,signal)}}
      catch (error) {
        if(error instanceof PipeFrameSizeError) return {ok:false,error:{code:'companion/frame-too-large',message:'Selection exceeds the UTF-8 frame limit; source stays in Desktop',details:{}}}
        return {ok:false,error:{code:'companion/unavailable',message:'Companion unavailable; source stays in Desktop',details:{}}}
      }
    }
    child.effect(()=>child.connection.fetch.register({path:`${COMPANION_CHANNEL}/request`,methods:['POST'],requestBody:'buffered',
      fetch:async request => {
        let envelope: {rpcId?:unknown;method?:unknown;payload?:unknown;type?:unknown}
        try { envelope = await request.json() as typeof envelope }
        catch {return new Response(null,{status:400})}
        if(!envelope || envelope.type!=='client-request' || typeof envelope.rpcId!=='string' || envelope.rpcId.length>100) return new Response(null,{status:400})
        const result=await handle(envelope.method,envelope.payload,request.signal)
        return Response.json({type:'server-response',rpcId:envelope.rpcId,result})
      },
    }),'better-float: authenticated companion route')
  }),'better-float: optional connection')
}
