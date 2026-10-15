import {captureControls} from '../src/detach/semantic-adapter.ts'
import {validSnapshot} from '../src/shared/control-adapter.ts'
let root,adapter,clicks=0,displayClicks=0
export function fixture(){
  const style=document.createElement('style')
  style.textContent='body{margin:24px;background:rgb(32,36,44);color:rgb(225,230,240);font:16px/24px Arial}section{width:340px;height:320px}.row{display:flex;align-items:center;gap:12px}.row span{margin-right:30px}button{width:24px;height:24px;padding:0;border:0;background:transparent;color:rgb(225,230,240)}svg{width:24px;height:24px}.folder{display:flex;align-items:center;gap:8px;margin-top:20px}.session{margin-top:18px;background:rgb(55,60,70);padding:8px}';document.head.append(style)
  root=document.createElement('section');root.id='workspace-scene'
  root.innerHTML='<div class="row"><span>工作区</span><button type="button" aria-label="搜索"><svg viewBox="0 0 24 24"><circle cx="10" cy="10" r="6" fill="none" stroke="currentColor"/><path d="M15 15L22 22" stroke="currentColor"/></svg></button><button type="button" aria-label="设置"><svg viewBox="0 0 24 24"><path d="M2 22L22 2" stroke="currentColor"/></svg></button><button type="button" aria-label="新建"><svg viewBox="0 0 24 24"><path d="M12 2L12 22M2 12L22 12" stroke="currentColor"/></svg></button></div><div class="folder"><svg viewBox="0 0 24 24"><path d="M2 6L10 6L12 9L22 9L22 21L2 21Z" fill="none" stroke="currentColor"/></svg><span>默认工作区</span></div><div class="session" role="button" tabindex="0">新会话</div>'
  root.querySelector('button').addEventListener('click',()=>clicks++)
  root.querySelector('[role=button]').addEventListener('click',()=>displayClicks++)
  document.body.append(root);adapter=captureControls(root);return true
}
export function read(revision){return adapter.read(revision)}
export function apply(action){adapter.apply(action)}
export function counts(){return {clicks,displayClicks}}
export function mutate(){root.querySelector('.folder span').textContent='更新后的工作区';root.querySelector('button').setAttribute('aria-label','搜索已更新');document.body.style.backgroundColor='rgb(45,50,60)'}
export function captureSpan(){return captureControls(root.querySelector('.folder span')).read(0)}
export function boundaries(){
  let checks=0
  const assert=(condition,label)=>{checks++;if(!condition)throw Error(label)}
  const holder=document.createElement('section');holder.style.height='auto';document.body.append(holder)
  const rejects=(html,label)=>{holder.innerHTML=html;let failed=false;try{captureControls(holder)}catch{failed=true}assert(failed,label)}
  try{
    holder.innerHTML='<span>Hello &lt;script&gt; world</span>'
    const snapshot=captureControls(holder.firstChild).read(0)
    assert(snapshot.controls.length===0 && validSnapshot(snapshot),'span alone is valid display-only snapshot')
    assert(snapshot.scene.items[0].text==='Hello <script> world','text is data, not HTML')
    rejects('<button type="button"></button>','empty button rejected')
    rejects('<img src="data:image/png;base64,">','unrepresented image rejected')
    rejects('<canvas width="20" height="20"></canvas>','canvas rejected')
    rejects('<input type="password" value="SECRET">','sensitive input excluded')
    rejects('<button type="button"><svg><foreignObject><span>unsafe</span></foreignObject></svg></button>','unsafe unlabelled SVG rejected')
    holder.innerHTML='<button type="button" aria-label="搜索"><svg><use href="https://invalid/x"/></svg></button>'
    const fallback=captureControls(holder).read(0)
    assert(fallback.controls[0].text==='搜索' && !fallback.controls[0].icon && fallback.appearance.mode==='fallback','unsafe labelled SVG gets visible text and readable fallback layout')
    holder.innerHTML='<span>可见</span><span hidden>PRIVATE</span>'
    assert(!JSON.stringify(captureControls(holder).read(0)).includes('PRIVATE'),'hidden text not exported')
    holder.innerHTML='<button type="button">可见<span hidden>PRIVATE</span></button>'
    assert(!JSON.stringify(captureControls(holder).read(0)).includes('PRIVATE'),'hidden button text not exported')
    holder.innerHTML='<span>可见</span><input type="text" style="display:none" value="PRIVATE">'
    assert(!JSON.stringify(captureControls(holder).read(0)).includes('PRIVATE'),'hidden ordinary control excluded')
    rejects('<span>可见</span><input type="password" hidden value="SECRET">','hidden sensitive input rejects selection')
    holder.innerHTML='<span>decorative</span><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M1 1L2 2" style="transform:rotate(90deg)"/></svg>'
    assert(captureControls(holder).read(0).scene.items.some(item=>item.text==='◇'),'unsupported decorative SVG gets visible placeholder')
    holder.innerHTML='<svg viewBox="0 0 24 24"><path d="M1 1L2 2" opacity="0.16"/></svg>'
    assert(captureControls(holder).read(0).scene.items[0].icon.shapes[0].attrs.opacity==='0.16','bounded shape opacity preserved')
    rejects('<span>'+'x'.repeat(513)+'</span>','display text limits reject instead of truncate')
    rejects(Array.from({length:25},()=>'<div>item</div>').join(''),'scene item count bounded')
    holder.innerHTML='<span>plain</span>'
    const sheet=document.createElement('style');sheet.textContent='#generated::before{content:"missing"}';document.head.append(sheet);holder.id='generated'
    let failed=false;try{captureControls(holder)}catch{failed=true}assert(failed,'generated content cannot silently disappear');sheet.remove();holder.removeAttribute('id')
    holder.innerHTML='<span>plain</span>'
    const node=holder.firstChild;const shadow=document.createElement('div');shadow.attachShadow({mode:'open'}).innerHTML='<span>shadow</span>';holder.append(shadow)
    failed=false;try{captureControls(holder)}catch{failed=true}assert(failed,'shadow DOM excluded')
    const scene=snapshot.scene
    assert(!validSnapshot({...snapshot,scene:{...scene,items:[{...scene.items[0],text:'',icon:{viewBox:'0 0 24 24',shapes:[{tag:'script',attrs:{}}]}}]}}),'SVG script rejected by schema')
    for(const attrs of [{d:'M1 1',onload:'evil'},{d:'M1 1',fill:'url(https://invalid)'},{d:'M1 1',style:'color:red'}]){
      assert(!validSnapshot({...snapshot,scene:{...scene,items:[{...scene.items[0],icon:{viewBox:'0 0 24 24',shapes:[{tag:'path',attrs}]}}]}}),'unsafe vector attribute rejected')
    }
    assert(!validSnapshot({...snapshot,scene:{...scene,items:[{...scene.items[0],placement:{...scene.items[0].placement,x:-1}}]}}),'negative scene position rejected')
    assert(!validSnapshot({...snapshot,scene:{...scene,styles:[{color:'red;position:fixed'}]}}),'CSS scene injection rejected')
    assert(!validSnapshot({...snapshot,scene:{...scene,items:[scene.items[0],scene.items[0]]}}),'duplicate scene key rejected')
    assert(!validSnapshot({...snapshot,controls:[],scene:undefined}),'empty snapshot remains rejected')
    return {checks}
  }finally{holder.remove()}
}
