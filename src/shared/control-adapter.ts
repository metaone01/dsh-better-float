export interface ButtonControl { readonly key:string; readonly kind:'button'; readonly text:string; readonly disabled:boolean;readonly icon?:ControlIcon;readonly label?:string;readonly binding?:string }
export interface InputControl { readonly key:string; readonly kind:'input'; readonly value:string; readonly placeholder:string; readonly disabled:boolean; readonly readOnly:boolean;readonly binding?:string;readonly multiline?:boolean }
export type SemanticControl = ButtonControl | InputControl
export interface ControlSnapshot { readonly revision:number; readonly title:string; readonly controls:readonly SemanticControl[]; readonly appearance?:ControlAppearance;readonly scene?:ControlScene;readonly adapter?:'workspace-v1'|'composer-v1';readonly workspaceVisual?:{readonly sourceHeight:number;readonly omittedIcons:number} }
export interface ControlAction { readonly seq:number; readonly key:string; readonly kind:'click'|'input'; readonly value?:string;readonly binding?:string;readonly expectedValue?:string }
export interface ControlIntent { readonly key:string; readonly kind:'click'|'input'; readonly value?:string;readonly binding?:string;readonly expectedValue?:string }
const validBinding=(value:unknown):value is string=>typeof value==='string' && /^[a-zA-Z0-9_-]{8,64}$/.test(value)
export function validSnapshot(value:unknown): value is ControlSnapshot {
  if(!value || typeof value!=='object')return false
  const snapshot=value as ControlSnapshot
  if(!Object.keys(snapshot).every(key=>['revision','title','controls','appearance','scene','adapter','workspaceVisual'].includes(key)))return false
  return Number.isSafeInteger(snapshot.revision) && snapshot.revision>=0 && typeof snapshot.title==='string' && snapshot.title.length<=120
    && Array.isArray(snapshot.controls) && (snapshot.controls.length>0 || snapshot.scene!==undefined) && snapshot.controls.length<=6
    && new Set(snapshot.controls.map(control=>control?.key)).size===snapshot.controls.length
    && snapshot.controls.every(control=>control && /^c[0-5]$/.test(control.key) && typeof control.disabled==='boolean'
      && Object.keys(control).every(key=>(control.kind==='button'?['key','kind','text','disabled','icon','label','binding']:['key','kind','value','placeholder','disabled','readOnly','binding','multiline']).includes(key))
      && (control.binding===undefined || validBinding(control.binding))
      && (control.kind==='button' ? typeof control.text==='string' && control.text.length<=120
          && (control.icon===undefined || validIcon(control.icon)) && (control.label===undefined || typeof control.label==='string' && control.label.length<=120)
        : control.kind==='input' && typeof control.value==='string' && control.value.length<=512
          && typeof control.placeholder==='string' && control.placeholder.length<=120 && typeof control.readOnly==='boolean'
          && (control.multiline===undefined || typeof control.multiline==='boolean')))
    && (snapshot.adapter===undefined || ['workspace-v1','composer-v1'].includes(snapshot.adapter) && snapshot.controls.every(control=>validBinding(control.binding)))
    && (snapshot.adapter!=='composer-v1' || snapshot.controls.length===1 && snapshot.controls[0]?.kind==='input' && snapshot.controls[0].multiline===true)
    && (snapshot.workspaceVisual===undefined || snapshot.adapter==='workspace-v1' && !!snapshot.workspaceVisual && typeof snapshot.workspaceVisual==='object' && !Array.isArray(snapshot.workspaceVisual)
      && Object.keys(snapshot.workspaceVisual).every(key=>['sourceHeight','omittedIcons'].includes(key))
      && Number.isFinite(snapshot.workspaceVisual.sourceHeight) && snapshot.workspaceVisual.sourceHeight>0 && snapshot.workspaceVisual.sourceHeight<=8192
      && Number.isSafeInteger(snapshot.workspaceVisual.omittedIcons) && snapshot.workspaceVisual.omittedIcons>=0 && snapshot.workspaceVisual.omittedIcons<=256)
    && (snapshot.scene===undefined || validScene(snapshot.scene))
    && (snapshot.appearance===undefined || validAppearance(snapshot.appearance,snapshot.controls.map(control=>control.key)))
}
export function validIntent(value:unknown):value is ControlIntent {
  if(!value || typeof value!=='object')return false
  const action=value as ControlIntent
  return Object.keys(action).every(key=>['key','kind','value','seq','binding','expectedValue'].includes(key)) && (action.binding===undefined || validBinding(action.binding))
    && (action.expectedValue===undefined || action.kind==='input' && typeof action.expectedValue==='string' && action.expectedValue.length<=512)
    && /^c[0-5]$/.test(action.key) && (action.kind==='click' ? action.value===undefined
    : action.kind==='input' && typeof action.value==='string' && action.value.length<=512)
}
export function validAction(value:unknown):value is ControlAction {
  return validIntent(value) && Number.isSafeInteger((value as ControlAction).seq) && (value as ControlAction).seq>0
}
import {validAppearance,type ControlAppearance} from './control-appearance.ts'
import {validIcon,validScene,type ControlIcon,type ControlScene} from './control-scene.ts'
