import {browserIdentity} from '../shared/identity.ts'
import type {ControlAction,ControlSnapshot} from '../shared/control-adapter.ts'
import {captureAppearance} from './control-appearance.ts'
import {captureScene} from './control-scene.ts'
import {visualBounds} from './visual-bounds.ts'
import {validScene,type SceneItem} from '../shared/control-scene.ts'
import {validPlacement,validStyleValue} from '../shared/control-appearance.ts'

interface SerializedNode {type:string;version:number;text?:string;children?:SerializedNode[];format?:number|string;style?:string;mode?:string;detail?:number;indent?:number;textFormat?:number;textStyle?:string}
interface EditorState {toJSON():{root:SerializedNode}}
interface ResidentEditor {
  getRootElement():HTMLElement|null;getEditorState():EditorState;isEditable():boolean;isComposing():boolean;
  parseEditorState(value:{root:SerializedNode}):EditorState;setEditorState(state:EditorState,options:{tag:string}):void
}
export class StaleComposerActionError extends Error {}

export function composerElement(source:Element):HTMLElement|null {
  const selector='[data-composer-input][role="textbox"][aria-multiline="true"]'
  const candidates=[...(source.matches(selector)?[source]:[]),...source.querySelectorAll(selector)]
  return candidates.length===1?candidates[0] as HTMLElement:null
}

/** Borrow the resident editor, not React/Fiber. Only plain drafts may be replaced. */
export function captureComposerControls(source:Element) {
  const element=composerElement(source)!
  const editor=(element as HTMLElement & {__lexicalEditor?:ResidentEditor}).__lexicalEditor
  if(!editor || ['getRootElement','getEditorState','parseEditorState','setEditorState','isEditable','isComposing'].some(key=>typeof (editor as unknown as Record<string,unknown>)[key]!=='function'))throw new Error('Composer editor interface unavailable')
  const binding=browserIdentity()
  const inspect=()=>{
    if(!source.isConnected || composerElement(source)!==element || editor.getRootElement()!==element
      || (element as HTMLElement & {__lexicalEditor?:ResidentEditor}).__lexicalEditor!==editor)throw new Error('Composer editor was replaced')
    const view=element.ownerDocument.defaultView!,rect=element.getBoundingClientRect()
    if(!rect.width || !rect.height)throw new Error('Composer editor has no visible bounds')
    for(let ancestor:Element|null=element;ancestor;ancestor=ancestor.parentElement){
      const style=view.getComputedStyle(ancestor)
      if(ancestor.hasAttribute('hidden') || style.display==='none' || style.visibility!=='visible' || style.opacity==='0')throw new Error('Composer editor is hidden')
    }
    const root=editor.getEditorState().toJSON().root
    let count=0,plain=true
    const text=(node:SerializedNode,parent?:string):string=>{
      if(++count>256)throw new Error('Composer draft exceeds adapter limit')
      if(node.version!==1 || Object.keys(node).some(key=>!['type','version','text','children','format','style','mode','detail','indent','direction','textFormat','textStyle'].includes(key)))plain=false
      if(node.type==='root' && parent===undefined || node.type==='paragraph' && parent==='root') {
        if(node.format || node.style || node.indent || node.textFormat || node.textStyle)plain=false
        if(!Array.isArray(node.children)){plain=false;return ''}
        return node.children.map(child=>text(child,node.type)).join(node.type==='root'?'\n':'')
      }
      if(node.type==='text' && parent==='paragraph'){
        if(node.format || node.style || node.detail || node.mode && node.mode!=='normal')plain=false
        return node.text??''
      }
      if(node.type==='linebreak' && parent==='paragraph')return '\n'
      plain=false;return ''
    }
    let value=text(root)
    if(!plain)value=element.innerText
    if(value.length>512)throw new Error('Composer draft exceeds adapter limit')
    return {value,plain,root}
  }
  const read=(revision:number):ControlSnapshot=>{
    const current=inspect()
    const appearance=captureAppearance(source,[element])
    let scene:ControlSnapshot['scene']
    try {
      // Menus, submit controls and attachments are never rebound by this adapter.
      scene=captureScene(source,[element,...source.querySelectorAll('input,select,textarea,[data-composer-placeholder]')],{readonlyDecorations:true})
      if(scene)scene={...scene,displayOnly:true}
      const card=element.closest('[data-composer-card]')
      if(card && source.contains(card)){
        const rect=card.getBoundingClientRect(),origin=visualBounds(source),style=element.ownerDocument.defaultView!.getComputedStyle(card)
        const placement={x:rect.left-origin.left,y:rect.top-origin.top,width:rect.width,height:rect.height}
        const radius=Number.parseFloat(style.borderTopLeftRadius)||0
        const border=Number.parseFloat(style.borderTopWidth)||0
        if(validPlacement(placement) && rect.width<=4096 && rect.height<=4096 && validStyleValue(style.backgroundColor) && validStyleValue(style.borderTopColor)){
          const item:SceneItem={key:'v0',text:'',style:0,placement,icon:{viewBox:`0 0 ${rect.width} ${rect.height}`,shapes:[{tag:'rect',attrs:{x:String(border/2),y:String(border/2),width:String(Math.max(0,rect.width-border)),height:String(Math.max(0,rect.height-border)),rx:String(radius),fill:style.backgroundColor,stroke:style.borderTopColor,'stroke-width':String(border)}}]}}
          const next={styles:[{},...scene?.styles??[]],items:[item,...scene?.items.map((item,index)=>({...item,key:`v${index+1}`,style:item.style+1}))??[]],displayOnly:true}
          if(validScene(next))scene=next
        }
      }
    }catch{/* Decoration is optional; failure must not reject a supported editor. */}
    return {revision,title:'Better Float · Composer draft (limited)',adapter:'composer-v1',controls:[{key:'c0',kind:'input',multiline:true,
      binding,value:current.value,placeholder:(element.getAttribute('data-placeholder')??element.getAttribute('aria-label')??'').slice(0,120),
      disabled:element.getAttribute('aria-disabled')==='true',readOnly:!current.plain || !editor.isEditable()}],appearance,...scene?{scene}:{}}
  }
  const apply=(action:ControlAction):void=>{
    const current=inspect()
    const active=element.ownerDocument.activeElement
    if(action.key!=='c0' || action.kind!=='input' || action.binding!==binding || action.value===undefined || action.value.length>512
      || action.expectedValue!==current.value || !current.plain || !editor.isEditable() || element.getAttribute('aria-disabled')==='true'
      || editor.isComposing() || element.ownerDocument.hasFocus() && (active===element || !!active && element.contains(active)))throw new StaleComposerActionError('Draft changed or original editor is active')
    if(/[\uE100-\uE11D\uFFFC\r]/u.test(action.value))throw new StaleComposerActionError('Unsupported draft placeholder or newline')
    if(current.value===action.value)return
    const paragraph=(line:string):SerializedNode=>({type:'paragraph',version:1,format:'',children:line?[{type:'text',version:1,text:line,format:0,detail:0,style:'',mode:'normal'}]:[]})
    const next=editor.parseEditorState({root:{...current.root,children:action.value.split('\n').map(paragraph)}})
    // A null parsed selection plus this tag keeps focus/selection out of Desktop.
    editor.setEditorState(next,{tag:'skip-dom-selection'})
  }
  read(0)
  return {read,apply}
}
