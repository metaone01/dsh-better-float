import {captureControls,openSemanticControls} from '../src/detach/semantic-adapter.ts'
import {validSnapshot} from '../src/shared/control-adapter.ts'

let source,adapter,events=[],selected=0,expanded=true,query=''
const icon='<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M1 4H7L9 6H15V14H1Z" fill="currentColor" opacity="0.16"/><path d="M1 4H7L9 6H15V14H1Z" fill="none" stroke="currentColor"/></svg>'
export function fixture(){
  source?.remove();events=[];selected=0;expanded=true;query=''
  if(!document.querySelector('#workspace-appearance-style')){
    const style=document.createElement('style');style.id='workspace-appearance-style'
    style.textContent=`body{margin:24px;font:14px/20px "Segoe UI",sans-serif;background:rgb(249,250,251);color:rgb(15,17,21)}
    #workspace-visual-source{width:268px;height:350px}#workspace-visual-source header{height:36px;display:flex;align-items:center;padding-left:4px}
    #workspace-visual-source header>button,#workspace-visual-source>input{display:none}
    #workspace-visual-source [role=tree]{padding-top:6px}#workspace-visual-source [role=treeitem]{position:relative;border-radius:12px;box-sizing:border-box;width:256px;height:32px;margin-bottom:2px;padding:0 8px;display:flex;align-items:center;cursor:pointer}
    #workspace-visual-source [data-row-key^="workspace:"]{height:34px}#workspace-visual-source [aria-selected=true]{background:rgba(38,49,72,.06)}
    #workspace-visual-source svg{flex:none;color:rgb(65,118,230);display:block}#workspace-visual-source .title{margin-left:6px;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    #workspace-visual-source [data-row-key^="session:"] .title{margin-left:20px}#workspace-visual-source .time{font:10px/16px "Segoe UI",sans-serif;color:rgb(129,133,140);margin-left:6px}
    #workspace-visual-source .secret{display:none}`
    document.head.append(style)
  }
  source=document.createElement('section');source.id='workspace-visual-source'
  source.innerHTML='<header><span>Workspaces</span><button type="button" aria-expanded="false" aria-keyshortcuts="Control+K">Search</button><div data-slot="sidebar.workspaces.directoryFlow"></div><span class="secret">HIDDEN_PRIVATE_DECORATION</span></header><input type="text" maxlength="500" value="HIDDEN_PRIVATE_QUERY"><div role="tree" aria-label="Sessions"></div>'
  document.body.append(source)
  const button=source.querySelector('button'),input=source.querySelector('input'),tree=source.querySelector('[role=tree]')
  const rows=()=>{
    tree.replaceChildren()
    if(!query){const row=document.createElement('div');row.role='treeitem';row.dataset.rowKey='workspace:default';row.setAttribute('aria-expanded',String(expanded));row.innerHTML=icon+'<span class="title">Default workspace</span>';row.onclick=e=>{events.push({kind:'expand',trusted:e.isTrusted});expanded=!expanded;rows()};tree.append(row)}
    if(expanded || query)for(let index=0;index<5;index++){
      const title=`Session ${index}`;if(query && !title.includes(query))continue
      const row=document.createElement('div');row.role='treeitem';row.dataset.rowKey=`session:s${index}`;row.setAttribute('aria-selected',String(index===selected));row.innerHTML=`<span class="title">${title}</span><span class="time">10min</span><span class="secret">HIDDEN_PRIVATE_ROW</span>`
      row.onclick=e=>{events.push({kind:'select',trusted:e.isTrusted});selected=index;rows()};tree.append(row)
    }
  }
  button.onclick=()=>{input.style.display='block';button.setAttribute('aria-expanded','true');input.value=''}
  input.oninput=e=>{events.push({kind:'input',trusted:e.isTrusted});query=input.value;rows()}
  rows();adapter=captureControls(source);return read(0)
}
export const read=revision=>adapter.read(revision)
export const apply=action=>adapter.apply(action)
export const eventLog=()=>events
export const state=()=>({expanded,selected,query})
export const theme=dark=>{document.body.style.backgroundColor=dark?'rgb(22,28,38)':'rgb(249,250,251)';document.body.style.color=dark?'rgb(230,240,250)':'rgb(15,17,21)';document.body.style.colorScheme=dark?'dark':'light'}
export const rootRect=()=>{const r=source.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}}
export async function boundaries(){
  let checks=0
  const ok=(condition,label)=>{checks++;if(!condition)throw Error(label)}
  fixture();const snapshot=read(0)
  ok(snapshot.appearance.mode==='captured' && validSnapshot(snapshot),'captured snapshot is valid')
  ok(snapshot.scene.items.some(item=>item.icon) && snapshot.workspaceVisual.omittedIcons===0,'safe vector retained')
  ok(!JSON.stringify(snapshot).includes('HIDDEN_PRIVATE'),'hidden text and query excluded')
  ok(JSON.stringify(snapshot).length<6500,'complete decoration bounded')
  for(const metadata of [{sourceHeight:-1,omittedIcons:0},{sourceHeight:350,omittedIcons:Infinity},{sourceHeight:350,omittedIcons:0,css:'url(https://invalid)'},{sourceHeight:350,omittedIcons:0.1}])ok(!validSnapshot({...snapshot,workspaceVisual:metadata}),'invalid metadata rejected')
  ok(!validSnapshot({...snapshot,adapter:undefined}),'metadata requires workspace adapter')
  ok(!validSnapshot({...snapshot,scene:{...snapshot.scene,styles:[{'background-color':'url(https://invalid)'}]}}),'resource CSS rejected')
  source.querySelector('svg').append(document.createElementNS('http://www.w3.org/2000/svg','use'))
  const unsafe=read(0);ok(unsafe.appearance.mode==='captured' && unsafe.workspaceVisual.omittedIcons===1 && !unsafe.scene.items.some(item=>item.icon),'unsafe vector omitted explicitly')
  fixture();for(let index=0;index<25;index++){const span=document.createElement('span');span.textContent='Decoration';source.querySelector('header').append(span)}
  const oversized=read(0);ok(oversized.appearance.mode==='captured' && !oversized.scene && oversized.controls.length===6,'decoration budget preserves row geometry and business data')
  fixture();const attempts=[],statuses=[];let done
  const completed=new Promise(resolve=>done=resolve)
  const bridge={openControls:async(id,next)=>{attempts.push(next);return attempts.length===1?{ok:false,error:{code:'companion/frame-too-large'}}:{ok:true,value:{windows:[{id}]}}},syncControls:async(id,next)=>{
    attempts.push(next)
    if(attempts.length===3)theme(true)
    // A new theme re-enables decoration; reject a later delta with no appearance.
    if(attempts.length===5)return{ok:false,error:{code:'companion/frame-too-large'}}
    if(attempts.length>=7)done()
    return{ok:true,value:{windows:[{id}],actions:[]}}
  },close:async()=>({ok:true,value:{windows:[]}}),dispose(){}}
  const handle=await openSemanticControls(source,status=>statuses.push(status),{bridge})
  try{
    await Promise.race([completed,new Promise((_,reject)=>setTimeout(()=>reject(Error('budget retry timeout')),2000))])
    for(const index of [1,5])ok(attempts[index].appearance.mode==='fallback' && !attempts[index].scene && !attempts[index].workspaceVisual && attempts[index].controls.length===6,'oversized decoration removed, bindings retained')
    ok([2,6].every(index=>attempts[index].appearance===undefined && !attempts[index].scene),'unchanged rejected decoration is not retried every poll')
    ok(attempts[3].appearance.mode==='captured','changed theme retries full captured appearance')
    ok(attempts[4].appearance===undefined && !!attempts[4].scene,'appearance delta with scene exercised')
    ok(!statuses.includes('disconnected') && eventLog().length===0,'budget retries neither disconnect nor execute business actions')
  }finally{handle.close();theme(false)}
  return{checks}
}
