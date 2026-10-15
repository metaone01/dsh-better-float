import {captureControls,openSemanticControls} from '../src/detach/semantic-adapter.ts'
import {validSnapshot} from '../src/shared/control-adapter.ts'
import {isWorkspaceSource} from '../src/detach/workspace-adapter.ts'

let source,adapter,events=[],selected=0,expanded=true,query='',seq=0
export function fixture() {
  source?.remove();events=[];selected=0;expanded=true;query='';seq=0
  source=document.createElement('section')
  source.innerHTML='<button type="button" aria-expanded="false" aria-keyshortcuts="Control+K">Search</button><input type="text" maxlength="500" style="display:none" value="HIDDEN_PRIVATE_QUERY"><div data-slot="sidebar.workspaces.directoryFlow"></div><div role="tree" aria-label="Sessions"></div>'
  document.body.append(source)
  const button=source.querySelector('button'),input=source.querySelector('input'),tree=source.querySelector('[role=tree]')
  const rows=()=>{
    tree.replaceChildren()
    if(!query){
      const workspace=document.createElement('div');workspace.role='treeitem';workspace.dataset.rowKey='workspace:fixture';workspace.setAttribute('aria-expanded',String(expanded));workspace.textContent='Fixture workspace'
      workspace.onclick=e=>{events.push({kind:'expand',trusted:e.isTrusted});expanded=!expanded;workspace.setAttribute('aria-expanded',String(expanded));rows()};tree.append(workspace)
    }
    if(expanded || query)for(let i=0;i<5;i++) {
      if(query && !`Session ${i}`.includes(query))continue
      const row=document.createElement('div');row.role='treeitem';if(!query)row.dataset.rowKey=`session:s${i}`;row.setAttribute('aria-selected',String(selected===i));row.textContent=`Session ${i}`
      row.onclick=e=>{events.push({kind:'select',id:i,trusted:e.isTrusted});selected=i;for(const node of tree.querySelectorAll('[aria-selected]'))node.setAttribute('aria-selected',String(node.textContent===`Session ${i}`))};tree.append(row)
    }
  }
  button.onclick=e=>{events.push({kind:'open-search',trusted:e.isTrusted});button.setAttribute('aria-expanded','true');input.style.display='block'}
  input.addEventListener('input',e=>{events.push({kind:'input',trusted:e.isTrusted});query=input.value;rows()})
  rows();adapter=captureControls(source)
  return read(0)
}
export const read=revision=>adapter.read(revision)
export const apply=action=>adapter.apply(action)
export const eventLog=()=>events
export const sourceState=()=>({expanded,selected,query,connected:source.isConnected})
export async function boundaryChecks() {
  let checks=0
  const ok=(condition,label)=>{checks++;if(!condition)throw Error(label)}
  const reject=async(run,label)=>{let failed=false;try{await run()}catch{failed=true}ok(failed,label)}
  const act=async(key,kind='click',value)=>{const c=read(0).controls.find(c=>c.key===key);await apply({seq:++seq,key,kind,binding:c.binding,...value!==undefined?{value}:{}})}
  try {
    let snapshot=fixture();ok(validSnapshot(snapshot),'workspace snapshot validates');ok(snapshot.controls.length===6,'six-control bound with paging')
    ok(snapshot.adapter==='workspace-v1','recognized workspace only');ok(!JSON.stringify(snapshot).includes('HIDDEN_PRIVATE_QUERY'),'hidden query never exported')
    const original=read(0).controls.find(c=>c.key==='c3')
    await act('c2');ok(read(0).controls.some(c=>c.text==='○ Session 4'),'second page includes remaining rows');ok(events.length===0,'paging sends no source business event')
    await reject(()=>apply({seq:++seq,key:'c3',kind:'click',binding:original.binding}),'old page action rejected')
    const row=read(0).controls.find(c=>c.key==='c3');source.querySelector('[data-row-key="session:s2"]').replaceWith(source.querySelector('[data-row-key="session:s2"]').cloneNode(true))
    await reject(()=>apply({seq:++seq,key:row.key,kind:'click',binding:row.binding}),'replaced node with same id rejected')
    fixture();await act('c3');ok(sourceState().expanded===false,'workspace collapses');ok(read(0).controls.length===4,'removed rows disappear without disconnect')
    await act('c3');ok(sourceState().expanded===true,'workspace expands');await act('c5');ok(sourceState().selected===1,'session selection dispatched')
    await act('c0','input','Session 3');ok(sourceState().query==='Session 3','hidden search opens then native setter updates');ok(read(0).controls[3].text==='○ Session 3','search-result row without data id represented')
    await act('c3');ok(sourceState().selected===3,'search result selection works')
    ok(events.every(event=>event.trusted===false),'source events are synthetic, not trusted')
    await reject(()=>act('c0','input','x'.repeat(501)),'search limit enforced before source mutation')
    await reject(()=>act('c0','input','a\0b'),'NUL rejected')
    source.querySelector('input').readOnly=true;await reject(()=>act('c0','input','other'),'readOnly rejects')
    fixture();const password=document.createElement('input');password.type='password';password.hidden=true;source.append(password)
    await reject(()=>read(0),'hidden sensitive content rejects entire workspace')
    fixture();source.querySelector('[role=treeitem]').dataset.rowKey='delete:any';await reject(()=>read(0),'unknown row identity rejected')
    fixture();const oldTreeRow=read(0).controls[3];source.querySelector('[role=tree]').replaceWith(source.querySelector('[role=tree]').cloneNode(true));ok(validSnapshot(read(0)),'tree replacement remains a valid workspace');await reject(()=>apply({seq:++seq,key:'c3',kind:'click',binding:oldTreeRow.binding}),'old tree action cannot target replacement')
    source.querySelector('[role=tree]').replaceChildren();ok(read(0).controls.length===3,'empty search tree remains connected')
    fixture();source.querySelector('input').replaceWith(source.querySelector('input').cloneNode(true));await reject(()=>read(0),'replaced search owner requires reopen')
    fixture();source.querySelector('[data-slot]').remove();ok(!isWorkspaceSource(source),'unknown tree does not opt in')
    ok(sourceState().connected,'source never moved or hidden by adapter')
    fixture();let issued=false,acknowledged=0;const statuses=[]
    const bridge={openControls:async(id)=>({ok:true,value:{windows:[{id}]}}),syncControls:async(id,snapshot,ack)=>{
      acknowledged=ack
      if(issued)return{ok:true,value:{windows:[{id}],actions:[]}}
      issued=true
      return{ok:true,value:{windows:[{id}],actions:[{seq:1,key:'c3',kind:'click',binding:'expired_binding'},{seq:2,key:'c5',kind:'click',binding:snapshot.controls.find(control=>control.key==='c5').binding}]}}
    },close:async()=>({ok:true,value:{windows:[]}}),dispose(){}}
    const handle=await openSemanticControls(source,status=>statuses.push(status),{bridge})
    try{await new Promise(resolve=>setTimeout(resolve,300));ok(sourceState().selected===1,'valid queued action after stale action executes');ok(acknowledged===2,'stale action retired and post-action state acknowledged');ok(!statuses.includes('disconnected'),'stale action does not disconnect')}
    finally{handle.close()}
    return {checks}
  }finally{source?.remove()}
}
