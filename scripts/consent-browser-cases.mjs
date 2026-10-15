import {createPanel} from '../src/float/index.ts'
import {createDetachController} from '../src/detach/controller.ts'
import {confirmCompanion} from '../src/detach/consent.ts'
import {createLocaleFixture} from './i18n-fixture.mjs'
import {messagesFor,LOCALE_NAMESPACE,en,zh} from '../src/shared/i18n.ts'

export async function run(){
  let checks=0
  const equal=(actual,expected,label)=>{checks++;if(actual!==expected)throw Error(`${label}: expected ${expected}, got ${actual}`)}
  const tick=()=>new Promise(resolve=>setTimeout(resolve,0))
  const locale=createLocaleFixture('zh'),stopDictionary=locale.register(LOCALE_NAMESPACE,{en,zh})
  const messages=messagesFor(locale)
  const results={pings:0,opens:0,releases:0,alive:false,actions:[],value:'draft',disabled:false}
  let pendingPing=null
  let blocked=false
  let pendingOpen=null
  let oversizedOpen=false,oversizedSync=false
  const sizeFailure={ok:false,error:{code:'companion/frame-too-large',message:'Too large',details:{}}}
  const bridge=()=>({
    async ping(){results.pings++;if(pendingPing)await pendingPing;if(blocked)return{ok:false,error:{code:'companion/not-configured',message:'disabled',details:{}}};return {ok:true,value:{version:1,testOnly:true,windows:[]}}},
    async openControls(id,snapshot){results.opens++;if(oversizedOpen)return sizeFailure;results.alive=true;results.id=id;results.snapshot=snapshot;if(pendingOpen)await pendingOpen;return{ok:true,value:{version:1,testOnly:true,windows:results.alive?[{id,lease:'test'}]:[]}}},
    async syncControls(id,snapshot){results.snapshot=snapshot;if(oversizedSync)return sizeFailure;return{ok:true,value:{version:1,testOnly:true,windows:results.alive?[{id,lease:'test'}]:[],actions:[]}}},
    async close(){results.alive=false;return {ok:true,value:{version:1,testOnly:true,windows:[]}}},
    dispose(){results.releases++;results.alive=false},
  })
  const controller=createDetachController(undefined,{messages,companion:bridge})
  const panels=[]
  const make=()=>{
    const source=document.createElement('section'),button=document.createElement('button'),input=document.createElement('input')
    button.type='button';button.textContent='Count';input.value='private draft'
    source.append(button,input)
    const panel=createPanel(document,{title:'Consent checks',rect:{x:10,y:10,width:350,height:300},messages,onClose(){}})
    panel.body.append(source);panels.push(panel);return{panel,source,input}
  }
  const prompt=panel=>panel.root.querySelector('[data-role=companion-confirm]')
  const status=panel=>panel.root.querySelector('[data-role=status]').textContent
  const allow=panel=>panel.root.querySelector('[data-action=companion-allow]').click()
  try{
    const f=make()
    let task=controller.request(f.panel,f.source)
    equal(controller.request(f.panel,f.source),task,'double click coalesces confirmation')
    await tick()
    equal(!!prompt(f.panel),true,`reachable paired backend presents confirmation (${status(f.panel)}; secure=${isSecureContext}; uuid=${typeof crypto.randomUUID})`)
    equal(results.opens,0,'no state export or window before confirmation')
    equal(prompt(f.panel).textContent.includes('private draft'),false,'confirmation does not show input values')
    equal(prompt(f.panel).textContent.includes(zh.companionAllow),true,'Chinese consent')
    locale.setLanguage('en')
    equal(prompt(f.panel).textContent.includes(en.companionAllow),true,'consent follows language')
    f.panel.root.querySelector('[data-action=companion-cancel]').click()
    await task
    equal(results.opens,0,'cancel cannot create window')
    equal(status(f.panel),en.companionCancelled,'cancel status visible')
    equal(f.input.value,'private draft','source state untouched')
    task=controller.request(f.panel,f.source);await tick();allow(f.panel);await task
    equal(results.opens,1,'one approved window request')
    equal(status(f.panel),en.companionConnected,'connected status')
    await controller.request(f.panel,f.source)
    equal(results.opens,1,'already connected cannot create duplicate window')
    f.panel.close();await tick()
    equal(results.alive,false,'panel close ends companion lease')

    const escape=make();task=controller.request(escape.panel,escape.source);await tick()
    prompt(escape.panel).dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));await task
    equal(results.opens,1,'Escape cancels approval')

    const changed=make();task=controller.request(changed.panel,changed.source);await tick()
    changed.input.replaceWith(changed.input.cloneNode());allow(changed.panel);await task
    equal(results.opens,1,'changed controls cannot use stale approval')
    equal(status(changed.panel),en.companionSourceChanged,'changed source downgrade identifies replacement')

    const sensitive=make();sensitive.input.type='password';await controller.request(sensitive.panel,sensitive.source)
    equal(prompt(sensitive.panel),null,'sensitive input rejected without confirmation')
    equal(status(sensitive.panel),en.companionSensitive,'sensitive input feedback identifies exclusion')

    blocked=true
    const missing=make();await controller.request(missing.panel,missing.source)
    equal(status(missing.panel),en.companionNotConfigured,'missing Host pairing feedback')
    equal(prompt(missing.panel),null,'unpaired backend cannot request export consent')
    blocked=false

    const mid=make();task=controller.request(mid.panel,mid.source);await tick();mid.panel.close();await task
    equal(prompt(mid.panel),null,'close removes pending confirmation')
    equal(results.opens,1,'close during confirmation cannot export')

    let openResolve
    pendingOpen=new Promise(resolve=>openResolve=resolve)
    const opening=make();task=controller.request(opening.panel,opening.source);await tick();allow(opening.panel);await tick()
    opening.panel.close();openResolve();await task;await tick();pendingOpen=null
    equal(results.alive,false,'close during async open releases late window')

    oversizedOpen=true
    const large=make();task=controller.request(large.panel,large.source);await tick();allow(large.panel);await task
    equal(status(large.panel),en.companionTooLarge,'oversized open has specific feedback instead of unavailable')
    equal(large.input.value,'private draft','oversized open cannot truncate original data')
    equal(large.source.isConnected,true,'oversized open leaves source connected')
    oversizedOpen=false
    const grew=make();task=controller.request(grew.panel,grew.source);await tick();allow(grew.panel);await task
    oversizedSync=true;await tick();await tick();oversizedSync=false
    equal(status(grew.panel),en.companionTooLarge,'snapshot growth has specific feedback')
    equal(results.alive,false,'oversized sync closes only its own session')
    equal(grew.input.value,'private draft','oversized sync preserves original data')

    const tall=make();tall.panel.setRect({x:innerWidth-100,y:innerHeight-150,width:270,height:innerHeight-10})
    const original=tall.panel.rect(),cancelSignal=new AbortController()
    const tallConsent=confirmCompanion(tall.panel,messages,6,cancelSignal.signal)
    const confirmation=prompt(tall.panel),button=confirmation.querySelector('[data-action=companion-allow]')
    button.scrollIntoView({block:'nearest'})
    const buttonRect=button.getBoundingClientRect(),center={x:buttonRect.x+buttonRect.width/2,y:buttonRect.y+buttonRect.height/2}
    equal(center.x>0 && center.x<innerWidth && center.y>0 && center.y<innerHeight,true,'edge panel approval remains inside viewport')
    equal(document.elementFromPoint(center.x,center.y)===button,true,'approval is actually hit-testable after scrolling confirmation')
    cancelSignal.abort();await tallConsent
    equal(JSON.stringify(tall.panel.rect()),JSON.stringify(original),'untouched consent restores original panel size and position')
    const movingSignal=new AbortController(),movingConsent=confirmCompanion(tall.panel,messages,6,movingSignal.signal)
    tall.panel.setRect({...tall.panel.rect(),x:20,y:20});movingSignal.abort();await movingConsent
    equal(tall.panel.rect().x,20,'user movement during consent is preserved')
    tall.panel.close()

    const unload=make();task=controller.request(unload.panel,unload.source);await tick();controller.dispose();await task
    equal(prompt(unload.panel),null,'plugin unload releases consent and listeners')
    equal(locale.listeners.size,panels.filter(panel=>panel.root.isConnected).length,'only live panel locale listeners remain')
    return{checks}
  }finally{controller.dispose();for(const panel of panels)panel.close();stopDictionary()}
}
