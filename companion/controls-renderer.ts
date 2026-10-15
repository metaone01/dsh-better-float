import { validSnapshot, type ControlSnapshot, type ControlIntent } from '../src/shared/control-adapter.ts'
import {renderIcon} from './control-scene.ts'
interface ControlsApi {
  state():Promise<ControlSnapshot>;action(intent:ControlIntent):Promise<boolean>;
  subscribe(listener:(state:ControlSnapshot)=>void):()=>void
}
const api=(window as unknown as {floatControls:ControlsApi}).floatControls
const controls=document.getElementById('controls')!
const status=document.getElementById('status')!
const nodes=new Map<string,HTMLButtonElement|HTMLInputElement|HTMLTextAreaElement>()
const composing=new Set<string>()
const contentSignatures=new WeakMap<HTMLElement,string>()
const scene=document.createElement('div');scene.id='scene';controls.append(scene)
let sceneSignature:string|undefined
let revision=-1
let latest:ControlSnapshot|null=null
let draftBase:string|undefined
let draftDirty=false
let pendingDraft:{value:string;base:string;started:number}|undefined
let draftMessage=''
const draftActions=document.createElement('div');draftActions.id='draft-actions'
const draftSave=document.createElement('button');draftSave.type='button';draftSave.textContent='同步纯文本草稿'
const draftStatus=document.createElement('span');draftStatus.setAttribute('role','status')
draftActions.append(draftSave,draftStatus);controls.after(draftActions);draftActions.hidden=true
draftSave.addEventListener('click',async()=>{
  const node=nodes.get('c0'),control=latest?.controls[0]
  if(!(node instanceof HTMLTextAreaElement) || control?.kind!=='input' || control.readOnly || control.disabled || composing.has('c0') || draftBase===undefined || pendingDraft)return
  const attempt={value:node.value,base:draftBase,started:Date.now()};pendingDraft=attempt;draftSave.disabled=true
  draftMessage='正在请求同步；尚未确认写入原草稿。';draftStatus.textContent=draftMessage
  await send({kind:'input',key:'c0',value:attempt.value,expectedValue:attempt.base,binding:control.binding})
  setTimeout(()=>{
    if(pendingDraft!==attempt)return
    pendingDraft=undefined;draftMessage='未确认同步。原编辑器可能正在输入或草稿已变化；本窗口文字仍保留，可重新检查后同步。'
    if(latest)render(latest)
  },8000)
})
async function send(intent:ControlIntent) {
  try {if(!await api.action(intent))status.textContent='操作被拒绝，可能已断线或控件不可用。'}
  catch {status.textContent='连接不可用，原控件仍保留在 Desktop。'}
}
function render(state:ControlSnapshot):void {
  if(!validSnapshot(state) || state.revision<revision)return
  revision=state.revision
  latest=state
  document.title=state.title+' · Preview / 预览'
  document.body.dataset.presentation=state.scene && !state.controls.length?'display-only':state.scene?'mixed':'controls'
  document.body.dataset.adapter=state.adapter??'native'
  if(state.appearance) {
    document.body.dataset.appearance=state.appearance.mode
    document.body.dataset.hasLayout=state.appearance.mode==='captured' && state.appearance.frame && state.appearance.placements ? 'true' : 'false'
    document.body.dataset.interactions=state.appearance.mode==='captured' && state.appearance.interactions ? 'limited' : 'none'
    status.textContent=state.appearance.mode==='captured'
      ? '已复现有限计算样式和冻结布局；仅映射可解析的 hover/focus 规则，不包含完整 CSS 与图标。'
      : state.appearance.reason==='budget'
        ? '样式超过传输预算，已使用默认外观；按钮与输入操作仍可使用。'
        : state.appearance.reason==='geometry'
          ? '选区布局尺寸无效，已使用默认外观；操作数据仍保留。'
        : '原样式暂不可读取，已使用默认外观；按钮与输入操作仍可使用。'
  }
  if(state.scene || state.controls.some(control=>control.kind==='button' && control.icon)) {
    status.textContent=!state.controls.length?'仅展示：此窗口中的文字和图标不执行原控件操作。'
      : state.scene?.displayOnly?'部分展示：原生按钮与输入可操作；目录、文字及非原生交互区域仅展示。'
      : '文字与图标已同步；只有原生按钮与文本输入回传操作。'
    if(state.appearance?.mode==='fallback')status.textContent+=' 样式已降级为默认外观。'
  }
  const nextScene=JSON.stringify(state.scene)
  if(nextScene!==sceneSignature) {
    scene.replaceChildren()
    for(const item of state.scene?.items??[]) {
      const node=document.createElement('span');node.dataset.scene=item.key
      if(item.icon)node.append(renderIcon(item.icon))
      if(item.text)node.append(document.createTextNode(item.text))
      scene.append(node)
    }
    sceneSignature=nextScene
  }
  for(const control of state.controls) {
    let node=nodes.get(control.key)
    if(!node) {
      if(control.kind==='button') {
        const button=document.createElement('button');button.type='button'
        button.addEventListener('click',()=>{void send({kind:'click',key:control.key,...button.dataset.binding?{binding:button.dataset.binding}:{}})});node=button
      } else {
        const input=control.multiline?document.createElement('textarea'):document.createElement('input')
        if(input instanceof HTMLInputElement)input.type='text'
        input.maxLength=512
        const submit=()=>{
          if(state.adapter==='composer-v1'){
            draftDirty=input.value!==draftBase;draftMessage='';if(latest)render(latest);return
          }
          if(!composing.has(control.key))void send({kind:'input',key:control.key,value:input.value,...input.dataset.binding?{binding:input.dataset.binding}:{}})
        }
        input.addEventListener('input',submit)
        input.addEventListener('compositionstart',()=>{composing.add(control.key);if(state.adapter==='composer-v1' && latest)render(latest)})
        input.addEventListener('compositionend',()=>{composing.delete(control.key);submit()})
        input.addEventListener('blur',()=>{
          const current=latest?.controls.find(item=>item.key===control.key)
          if(current?.kind==='input' && latest?.adapter!=='composer-v1' && !composing.has(control.key))input.value=current.value
        })
        node=input
      }
      node.dataset.control=control.key
      nodes.set(control.key,node);controls.append(node)
    }
    node.disabled=control.disabled
    if(control.binding)node.dataset.binding=control.binding
    else delete node.dataset.binding
    if(control.kind==='button' && node instanceof HTMLButtonElement) {
      const sceneRow=state.adapter==='workspace-v1' && document.body.dataset.appearance==='captured' && !!state.workspaceVisual && Number(control.key.slice(1))>=3
      const signature=JSON.stringify({text:control.text,icon:control.icon,label:control.label,sceneRow})
      if(contentSignatures.get(node)!==signature) {
        node.replaceChildren()
        if(control.icon && !sceneRow)node.append(renderIcon(control.icon))
        if(control.text && !sceneRow)node.append(document.createTextNode(control.text))
        if(control.icon && !control.text && control.label) {
          const label=document.createElement('span');label.className='icon-label';label.textContent=control.label;node.append(label)
        }
        node.setAttribute('aria-label',control.label??control.text);node.title=control.label??control.text
        contentSignatures.set(node,signature)
      }
    }
    else if(control.kind==='input' && (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement)) {
      node.placeholder=control.placeholder;node.readOnly=control.readOnly
      if(state.adapter==='composer-v1') {
        if(pendingDraft && control.value===pendingDraft.value){
          draftBase=control.value;pendingDraft=undefined;draftDirty=node.value!==control.value;draftMessage='原草稿已确认同步。'
        }
        if(draftBase===undefined || !draftDirty && !pendingDraft && !composing.has(control.key)){
          draftBase=control.value;node.value=control.value
        }
        draftActions.hidden=false
        draftSave.disabled=control.readOnly || control.disabled || !!pendingDraft || composing.has(control.key) || !draftDirty
        draftStatus.textContent=control.readOnly?'含结构化内容或编辑器不可编辑：当前仅展示，不覆盖原草稿。'
          :draftMessage || (draftDirty && control.value!==draftBase?'原草稿已变化。本窗口文字已保留；请复制保留后重新连接，不会覆盖原稿。':'修改后点击同步；Enter 只换行，不发送消息。')
        if(draftDirty && control.value!==draftBase && !pendingDraft)draftSave.disabled=true
      }
      else if(!composing.has(control.key) && document.activeElement!==node && node.value!==control.value)node.value=control.value
    } else {status.textContent='控件类型变化，需要重新连接。';node.disabled=true}
  }
  for(const [key,node] of nodes)if(!state.controls.some(control=>control.key===key)){node.remove();nodes.delete(key)}
  if(state.adapter==='workspace-v1')status.textContent='工作区有限适配：支持分页、目录展开/折叠、会话选择与搜索；菜单、添加目录、拖放及新会话创建仍在原 Desktop。'
    +(document.body.dataset.appearance==='captured' && state.workspaceVisual?'已部分复现原行布局、主题和文字；辅助搜索/分页区另列，不复制完整 CSS 或未支持的菜单。'+(state.workspaceVisual.omittedIcons?` ${state.workspaceVisual.omittedIcons} 个图标无法安全复现或超出预算。`:'')
      :state.appearance?.mode==='fallback' && state.appearance.reason==='geometry'?'使用默认外观：选区布局尺寸无效。'
      :state.appearance?.mode==='fallback' && state.appearance.reason==='budget'?'使用默认外观：装饰超过传输预算。':'外观仅部分可用，原行文字布局未完整复现。')+'业务状态仍由原 Desktop 持有。'
  if(state.adapter==='composer-v1')status.textContent='聊天草稿有限适配：仅同步最多 512 字符的纯文本草稿；含引用或格式节点时只读。标题、按钮与卡片仅做有限静态展示，不含完整 CSS；模型、附件、菜单及发送仍在 Desktop。'
}
const unsubscribe=api.subscribe(render)
void api.state().then(render).catch(()=>{status.textContent='初始化失败，请关闭此窗口。'})
window.addEventListener('pagehide',unsubscribe,{once:true})
