import {resolve} from 'node:path'

/** Test-only, fixed-id offline journal seed. Never installed into a normal profile. */
export function apply(ctx,config={}) {
  if(typeof config.isolatedHome!=='string' || !config.isolatedHome.endsWith('.dsh-debug-userdata-e0e1-20261003\\harness')
    || resolve(process.env.DSH_HOME??'.')!==resolve(config.isolatedHome))return
  ctx.effect(()=>ctx.inject(['connection','sessions','sessionTitle','sessionPersistence'],child=>{
    child.effect(()=>child.connection.fetch.register({path:'/api/better-float-acceptance/seed-workspace',methods:['POST'],requestBody:'buffered',fetch:async()=>{
      const ids=[]
      for(let index=0;index<3;index++) {
        const id=`session-bf-workspace-20261011-ws-${index}`,session=child.sessions.get(id)
        if(!session)throw new Error('Acceptance session must be created through the official Client API first')
        if(child.sessionTitle.get(session)?.title!==`BF Acceptance ${index}`) {
          session.append('turn/start',{turn:1})
          session.append('turn/end',{turn:1,reason:{kind:'completed'}})
          child.sessionTitle.rename(session,`BF Acceptance ${index}`)
        }
        await child.sessions.flush(session)
        const handle=await child.sessionPersistence.open(id,'read')
        try {
          const {events}=await handle.read()
          if(!events.some(event=>event.type==='turn/start' && event.data.turn===1)
            || !events.some(event=>event.type==='session/title' && event.data.source.kind==='user'))throw new Error('Offline acceptance storage readback failed')
        }finally{await handle.close()}
        ids.push(id)
      }
      return Response.json({ids,offlineJournalSeed:true,modelSubmitted:false,storageReadbackValidated:true})
    }}),'better-float acceptance: offline workspace journal')
  }),'better-float acceptance: isolated seed route')
}
