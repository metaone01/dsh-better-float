import { createCompanionBridge, type CompanionBridge } from './companion.ts'
import type { ControlSnapshot, SemanticControl, ControlAction } from '../shared/control-adapter.ts'
import { browserIdentity } from '../shared/identity.ts'
import { captureAppearance } from './control-appearance.ts'
import {captureIcon,captureScene} from './control-scene.ts'
import {captureWorkspaceControls,isWorkspaceSource,StaleWorkspaceActionError} from './workspace-adapter.ts'
import {captureComposerControls,composerElement,StaleComposerActionError} from './composer-adapter.ts'

export class CompanionSelectionSizeError extends Error {
  constructor() { super('Selection exceeds the UTF-8 frame limit') }
}
function visibleControls(source:Element):Element[] {
  const view=source.ownerDocument.defaultView!
  return [...(source.matches('button,input,textarea')?[source]:[]),...source.querySelectorAll('button,input,textarea')].filter(element=>{
    if(element.tagName==='INPUT') {
      const input=element as HTMLInputElement
      if(!['text','search','url','tel'].includes(input.type) || /password|one-time-code|cc-|username/i.test(input.autocomplete))throw new Error('Sensitive/unsupported input is excluded')
    }
    let ancestor:Element|null=element
    while(ancestor) {
      const computed=view.getComputedStyle(ancestor)
      if(computed.display==='none' || computed.visibility!=='visible' || computed.opacity==='0' || ancestor.hasAttribute('hidden'))return false
      if(ancestor===source)break
      ancestor=ancestor.parentElement
    }
    const rect=element.getBoundingClientRect()
    return rect.width>0 && rect.height>0
  })
}

/** Bounded display scene plus native controls; never migrate Fiber or source DOM. */
export function captureControls(source:Element) {
  if(isWorkspaceSource(source))return captureWorkspaceControls(source)
  if(composerElement(source))return captureComposerControls(source)
  const view=source.ownerDocument.defaultView
  if(!view || !source.isConnected)throw new Error('Source must be connected')
  const elements=visibleControls(source)
  if(elements.length>6)throw new Error('Adapter supports at most six standard controls')
  for(const element of elements) {
    if(element.tagName==='INPUT' && !['text','search','url','tel'].includes((element as HTMLInputElement).type))throw new Error('Only non-sensitive text inputs are supported')
    if(element.getRootNode()!==source.ownerDocument)throw new Error('Shadow DOM requires a dedicated adapter')
  }
  if(source.matches('select,[contenteditable="true"],[contenteditable=""]')
    || source.querySelector('select,[contenteditable="true"],[contenteditable=""]'))throw new Error('Unsupported editable control')
  const read=(revision:number):ControlSnapshot => {
    const current=visibleControls(source)
    if(current.length!==elements.length || current.some((element,index)=>element!==elements[index]))throw new Error('Control set changed; reopen adapter')
    if(!source.isConnected || elements.some(element=>!element.isConnected || (element!==source && !source.contains(element))))throw new Error('Source control was removed or replaced')
    const controls:SemanticControl[]=elements.map((element,index)=>{
      const key=`c${index}`
      const computed=view.getComputedStyle(element),rect=element.getBoundingClientRect()
      if(computed.display==='none' || computed.visibility!=='visible' || computed.opacity==='0' || !rect.width || !rect.height)throw new Error('Hidden control is not exportable')
      if(element.tagName==='BUTTON') {
        const button=element as HTMLButtonElement
        if(button.form && (button.type==='submit' || button.type==='reset'))throw new Error('Form submit/reset buttons require a dedicated adapter')
        const svgs=[...button.querySelectorAll('svg')]
        const icon=svgs.length===1?captureIcon(svgs[0]!):undefined
        const textWalker=source.ownerDocument.createTreeWalker(button,view.NodeFilter.SHOW_TEXT)
        let textNode:Node|null,text=''
        while((textNode=textWalker.nextNode())) {
          if(textNode.parentElement?.closest('svg,script,style'))continue
          let parent=textNode.parentElement,visible=true
          while(parent && parent!==button) {
            const style=view.getComputedStyle(parent)
            if(style.display==='none' || style.visibility!=='visible' || style.opacity==='0' || parent.hasAttribute('hidden')){visible=false;break}
            parent=parent.parentElement
          }
          if(visible)text+=textNode.textContent??''
        }
        text=text.trim()
        const label=(button.getAttribute('aria-label')??button.getAttribute('title')??'').trim()
        if(text.length>120 || label.length>120 || button.querySelector('img,canvas,iframe,input,select,textarea') || svgs.length>1
          || (svgs.length && !icon && !text && !label) || (!text && !icon && !label))throw new Error('Button has no representable content')
        return {key,kind:'button',text:text || (!icon?label:''),disabled:button.disabled || button.matches(':disabled'),...icon?{icon}:{},...label?{label}:{}}
      }
      const input=element as HTMLInputElement|HTMLTextAreaElement
      if(element.tagName==='INPUT' && !['text','search','url','tel'].includes(input.type))throw new Error('Input became unsupported or sensitive')
      if(/password|one-time-code|cc-|username/i.test(input.autocomplete))throw new Error('Sensitive autocomplete field is excluded')
      if(input.value.length>512)throw new Error('Input exceeds adapter limit')
      return {key,kind:'input',value:input.value,placeholder:input.placeholder.slice(0,120),disabled:input.disabled || input.matches(':disabled'),readOnly:input.readOnly,...element.tagName==='TEXTAREA'?{multiline:true}:{}}
    })
    const scene=captureScene(source,elements)
    if(!controls.length && !scene)throw new Error('Selection has no visible supported content')
    const labelledFallback=controls.some(control=>control.kind==='button' && !control.icon && !!control.label && elements[Number(control.key.slice(1))]!.querySelector('svg'))
    return {revision,title:'Better Float · Experimental controls',controls,appearance:labelledFallback?{mode:'fallback',reason:'unavailable'}:captureAppearance(source,elements),...scene?{scene}:{}}
  }
  const apply=(action:ControlAction):void=>{
    read(0)
    const index=Number(action.key.slice(1))
    const element=elements[index]
    if(!element || element.matches(':disabled') || element.hasAttribute('disabled'))throw new Error('Control unavailable')
    if(action.kind==='click' && element.tagName==='BUTTON') (element as HTMLButtonElement).click()
    else if(action.kind==='input' && ['INPUT','TEXTAREA'].includes(element.tagName)) {
      const input=element as HTMLInputElement|HTMLTextAreaElement
      if(input.readOnly || action.value===undefined)throw new Error('Input unavailable')
      const setter=Object.getOwnPropertyDescriptor(element.tagName==='TEXTAREA'?view.HTMLTextAreaElement.prototype:view.HTMLInputElement.prototype,'value')?.set
      if(!setter)throw new Error('Native input setter unavailable')
      setter.call(input,action.value)
      input.dispatchEvent(new view.Event('input',{bubbles:true}))
      input.dispatchEvent(new view.Event('change',{bubbles:true}))
    } else throw new Error('Unsupported action')
  }
  read(0)
  return {read,apply}
}

/** Explicit experimental API; failure never hides or removes the source. */
export async function openSemanticControls(source:Element, onStatus:(status:'connected'|'closed'|'disconnected'|'frame-too-large')=>void=()=>{},
  options:{readonly signal?:AbortSignal;readonly bridge?:CompanionBridge}={}) {
  const adapter=captureControls(source)
  const bridge=options.bridge??createCompanionBridge()
  const id=`controls-${browserIdentity()}`
  let disposed=false,revision=0,ack=0
  let lastAppearance:string|undefined
  let rejectedWorkspaceDecoration:string|undefined
  const sendSnapshot=async(snapshot:ControlSnapshot,opening=false)=>{
    const signature=JSON.stringify(snapshot.appearance)
    const {appearance,...content}=snapshot
    const {scene,workspaceVisual,...business}=content
    const decoration=snapshot.adapter==='workspace-v1'?JSON.stringify({appearance,scene,workspaceVisual,controls:snapshot.controls}):undefined
    let outgoing:ControlSnapshot=signature===lastAppearance?content:snapshot
    if(decoration!==undefined && decoration===rejectedWorkspaceDecoration)outgoing=lastAppearance===JSON.stringify({mode:'fallback',reason:'budget'})?business:{...business,appearance:{mode:'fallback',reason:'budget'}}
    const send=()=>opening?bridge.openControls(id,outgoing):bridge.syncControls(id,outgoing,ack)
    let result=await send()
    // This error is a local pre-send rejection: retry cannot replay an open or action.
    if(!result.ok && result.error.code==='companion/frame-too-large'
      && (outgoing.appearance?.mode==='captured' || snapshot.adapter==='workspace-v1' && !!snapshot.scene)) {
      // Workspace decoration is optional; never truncate labels, values or bindings.
      outgoing={...snapshot.adapter==='workspace-v1'?business:content,appearance:{mode:'fallback',reason:'budget'}}
      result=await send()
      if(result.ok && decoration!==undefined)rejectedWorkspaceDecoration=decoration
    }
    if(result.ok){
      if(snapshot.adapter!=='workspace-v1')lastAppearance=signature
      else if(outgoing.appearance)lastAppearance=JSON.stringify(outgoing.appearance)
      if(outgoing.appearance?.mode==='captured')rejectedWorkspaceDecoration=undefined
    }
    return result
  }
  const report=(status:'connected'|'closed'|'disconnected'|'frame-too-large'):void=>{try{onStatus(status)}catch{/* Consumer notifications must not leak a window. */}}
  let timer:ReturnType<typeof setTimeout>|null=null
  const close=():void=>{
    if(disposed)return
    disposed=true
    options.signal?.removeEventListener('abort',close)
    if(timer!==null)clearTimeout(timer)
    void bridge.close(id).finally(()=>bridge.dispose())
    report('closed')
  }
  options.signal?.addEventListener('abort',close,{once:true})
  if(options.signal?.aborted){close();throw new Error('Session cancelled')}
  let initial
  try {initial=await sendSnapshot(adapter.read(revision),true)}
  catch(error){close();throw error}
  if(!initial.ok || disposed){
    close()
    if(!initial.ok && initial.error.code==='companion/frame-too-large') throw new CompanionSelectionSizeError()
    throw new Error('Companion unavailable or control window rejected')
  }
  report('connected')
  const tick=async():Promise<void>=>{
    if(disposed)return
    try {
      const result=await sendSnapshot(adapter.read(++revision))
      if(disposed)return
      if(!result.ok){
        if(result.error.code==='companion/frame-too-large')throw new CompanionSelectionSizeError()
        throw new Error('Companion disconnected')
      }
      if(!result.value.windows.some(window=>window.id===id)){close();return}
      for(const action of result.value.actions??[]) {
        if(action.seq<=ack)continue
        if(action.seq!==ack+1)throw new Error('Action sequence gap')
        // Record before dispatch: an exception must not replay a business action.
        ack=action.seq
        try {await adapter.apply(action)}
        catch(error){if(!(error instanceof StaleWorkspaceActionError) && !(error instanceof StaleComposerActionError))throw error}
      }
      if(result.value.actions?.length) {
        // Publish the post-action binding/state without waiting for a background-throttled timer.
        // New actions in this reply remain queued until a later tick acknowledges them.
        const refreshed=await sendSnapshot(adapter.read(++revision))
        if(disposed)return
        if(!refreshed.ok) {
          if(refreshed.error.code==='companion/frame-too-large')throw new CompanionSelectionSizeError()
          throw new Error('Companion disconnected')
        }
        if(!refreshed.value.windows.some(window=>window.id===id)){close();return}
      }
      timer=setTimeout(()=>{void tick()},200)
    } catch (error) {
      if(disposed)return
      close()
      report(error instanceof CompanionSelectionSizeError ? 'frame-too-large' : 'disconnected')
    }
  }
  timer=setTimeout(()=>{void tick()},0)
  return {close,id}
}
