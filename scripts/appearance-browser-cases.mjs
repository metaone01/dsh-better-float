import {captureControls,openSemanticControls} from '../src/detach/semantic-adapter.ts'
import {CONTROL_STYLE_PROPERTIES,validAppearance,validStyleValue} from '../src/shared/control-appearance.ts'
import {captureInteractions} from '../src/detach/control-interactions.ts'
import {captureAppearance} from '../src/detach/control-appearance.ts'
let adapter,root,handle
let sourceEvents=0
export function fixture(){
  const sheet=document.createElement('style')
  sheet.textContent=`body{margin:24px;background:rgb(245,247,251);color:rgb(24,36,52);color-scheme:light}
    body.dark{background:rgb(22,28,38);color:rgb(220,230,242);color-scheme:dark}
    section{padding:0}
    .original{display:block;box-sizing:content-box;width:180px;height:26px;margin:16px 0;
      font:500 18px/26px Arial,sans-serif;letter-spacing:0.5px;text-align:left;text-transform:none;
      color:rgb(28,48,70);background:rgb(225,240,250);border:2px solid rgb(60,100,145);
      border-radius:10px;padding:10px 14px;box-shadow:none}
    .dark .original{color:rgb(230,240,250);background:rgb(48,62,80);border-color:rgb(120,160,195)}
    .original:disabled{color:rgb(100,110,120);opacity:0.65}`
  document.head.append(sheet)
  root=document.createElement('section');root.id='appearance-source'
  const button=document.createElement('button');button.className='original';button.type='button';button.textContent='Count 0'
  const input=document.createElement('input');input.className='original';input.value='draft';input.placeholder='Text'
  let clicks=0
  button.addEventListener('click',()=>button.textContent=`Count ${++clicks}`)
  root.append(button,input);document.body.append(root);adapter=captureControls(root)
  return true
}
export function read(revision){return adapter.read(revision)}
export function apply(action){adapter.apply(action)}
export function mutate(mode){
  if(mode==='dark')document.body.classList.add('dark')
  else if(mode==='light')document.body.classList.remove('dark')
  else if(mode==='disabled')root.querySelector('button').disabled=true
  else if(mode==='enabled')root.querySelector('button').disabled=false
}
export function styles(index){
  const node=root.children[index],style=getComputedStyle(node),result={}
  for(const property of CONTROL_STYLE_PROPERTIES)if(validStyleValue(style.getPropertyValue(property).trim()))result[property]=style.getPropertyValue(property).trim()
  const rect=node.getBoundingClientRect()
  return{style:result,rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height}}
}
export function enableInteractions(){
  mutate('enabled');mutate('light')
  const sheet=document.createElement('style')
  sheet.textContent=`.original{--hover-tint:rgb(10,120,220);outline:0px solid rgb(0,0,0);outline-offset:0px;color:rgb(28,48,70)!important}
    .original:hover{background-color:var(--hover-tint);color:rgb(200,0,0)}
    .original:focus{border-color:rgb(200,50,80)}
    .original:focus-visible{outline:2px solid rgb(130,40,200);outline-offset:3px}
    .original:hover:focus-visible{background-color:rgb(90,30,150)}`
  document.head.append(sheet)
  for(const event of ['click','input','pointerenter','mouseenter','focus','blur'])root.addEventListener(event,()=>sourceEvents++,true)
  return true
}
export function events(){return sourceEvents}
export function runInteractionBoundaries(){
  let checks=0
  const assert=(condition,label)=>{checks++;if(!condition)throw Error(label)}
  const node=document.createElement('button');node.className='boundary';node.type='button'
  const holder=document.createElement('section');holder.append(node);document.body.append(holder)
  const sheet=document.createElement('style');document.head.append(sheet)
  try{
    sheet.textContent='.boundary{color:rgb(1,2,3);background-color:rgb(4,5,6)}.boundary:hover{color:rgb(7,8,9);background-color:rgb(10,11,12)}.boundary[data-x]{color:rgb(20,21,22)}'
    node.dataset.x='yes'
    let states=captureInteractions([node])?.c0
    assert(states && states.hover.color===undefined && states.hover['background-color']==='rgb(10, 11, 12)','unsupported matching selector blocks only affected property')
    sheet.textContent='.boundary{color:rgb(1,2,3)}.boundary:hover{color:var(--missing)}'
    assert(captureInteractions([node])===undefined,'unresolved variables are skipped')
    sheet.textContent='.boundary{--tint:red;color:black}.boundary:hover{--tint:blue;color:var(--tint)}'
    assert(captureInteractions([node])===undefined,'state-dependent custom properties are not copied as static values')
    sheet.textContent='.boundary{color:black}.boundary:hover{color:red}.boundary{all:initial}'
    assert(captureInteractions([node])===undefined,'all shorthand blocks unresolved cascade')
    sheet.textContent='@media (min-width:99999px){.boundary:hover{color:red}}'
    assert(captureInteractions([node])===undefined,'inactive media excluded')
    sheet.textContent='.boundary:hover{color:red}';node.disabled=true
    assert(captureInteractions([node])===undefined,'disabled controls do not receive hover rules');node.disabled=false
    sheet.textContent='@layer test{.boundary:hover{color:red}}'
    assert(captureInteractions([node])===undefined,'cascade layers explicitly unsupported')
    sheet.textContent='.boundary{margin-left:-100px}'
    assert(captureAppearance(holder,[node]).mode==='fallback','negative placement fails closed')
    sheet.textContent='.boundary{width:9000px}'
    assert(captureAppearance(holder,[node]).mode==='fallback','oversized geometry fails closed')
    sheet.textContent=Array.from({length:2001},()=>'.boundary:hover{color:red}').join('')
    assert(captureInteractions([node])===undefined,'CSSOM scan bounded')
    sheet.textContent='.boundary:hover{color:red}'
    Object.defineProperty(sheet.sheet,'cssRules',{get(){throw new DOMException('Unreadable','SecurityError')},configurable:true})
    assert(captureInteractions([node])===undefined,'unreadable stylesheet fails closed')
  }finally{sheet.remove();holder.remove()}
  return {checks}
}
export async function runDeltaChecks(){
  let checks=0
  const assert=(condition,label)=>{checks++;if(!condition)throw Error(label)}
  mutate('light')
  const requests=[],statuses=[]
  let id
  const ok=()=>({ok:true,value:{version:1,testOnly:true,windows:[{id,lease:'fixture'}],actions:[]}})
  const bridge={
    async openControls(windowId,snapshot){id=windowId;requests.push({op:'open',snapshot});return ok()},
    async syncControls(windowId,snapshot,ack){requests.push({op:'sync',snapshot,ack});return ok()},
    async close(){return ok()},dispose(){},
  }
  handle=await openSemanticControls(root,status=>statuses.push(status),{bridge})
  const wait=async predicate=>{for(let i=0;i<30;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,40))}throw Error(`Delta test timeout requests=${JSON.stringify(requests)} statuses=${JSON.stringify(statuses)}`)}
  try{
    await wait(()=>requests.length>=3)
    assert(requests[0].snapshot.appearance.mode==='captured','initial request carries styles')
    assert(requests.slice(1).every(request=>request.snapshot.appearance===undefined),'unchanged styles are omitted')
    const oldLength=requests.length
    mutate('dark')
    await wait(()=>requests.slice(oldLength).some(request=>request.snapshot.appearance?.theme?.['background-color']==='rgb(22, 28, 38)'))
    assert(true,'ancestor theme change is resampled')
    assert(validAppearance(requests.at(-1).snapshot.appearance,['c0','c1']),'delta is bounded and valid')
    mutate('disabled')
    await wait(()=>requests.at(-1).snapshot.controls[0].disabled===true && requests.at(-1).snapshot.appearance?.mode==='captured')
    assert(requests.at(-1).snapshot.appearance.styles[requests.at(-1).snapshot.appearance.assignments.c0].opacity==='0.65','disabled visual state is resampled')
    assert(statuses.includes('connected'),'styling does not disrupt lifecycle status')
  }finally{handle.close();handle=undefined;mutate('enabled');mutate('light')}
  const fallbackRequests=[]
  const fallbackBridge={...bridge,async openControls(windowId,snapshot){id=windowId;fallbackRequests.push(snapshot)
    return snapshot.appearance?.mode==='captured'?{ok:false,error:{code:'companion/frame-too-large',message:'local frame rejection',details:{}}}:ok()},
    async syncControls(windowId,snapshot){fallbackRequests.push(snapshot);return ok()}}
  handle=await openSemanticControls(root,()=>{},{bridge:fallbackBridge})
  try{
    assert(fallbackRequests[0].appearance.mode==='captured' && fallbackRequests[1].appearance.mode==='fallback','oversized appearance retries as explicit fallback')
    assert(fallbackRequests[1].controls[1].value===fallbackRequests[0].controls[1].value,'fallback never truncates business values')
    await wait(()=>fallbackRequests.length>=3)
    assert(fallbackRequests[2].appearance===undefined,'unchanged over-budget styles do not retry every poll')
  }finally{handle.close();handle=undefined}
  return{checks}
}
