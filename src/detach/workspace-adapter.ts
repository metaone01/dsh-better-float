import type {ControlAction,ControlSnapshot,SemanticControl} from '../shared/control-adapter.ts'
import {browserIdentity} from '../shared/identity.ts'
import {captureWorkspaceAppearance} from './workspace-appearance.ts'

const FLOW='[data-slot="sidebar.workspaces.directoryFlow"]'
const PAGE_SIZE=3
const MAX_ROWS=120
export class StaleWorkspaceActionError extends Error {
  constructor(){super('Stale or unavailable workspace action')}
}

/** Only the observed workspace shell contract opts into row actions. Unknown trees stay display-only. */
export function isWorkspaceSource(source:Element):boolean {
  return source.querySelectorAll(FLOW).length===1 && source.querySelectorAll('[role="tree"]').length===1
    && source.querySelectorAll('button[aria-expanded][aria-keyshortcuts]').length===1
    && source.querySelectorAll('input[maxlength="500"]').length===1
}

function visible(element:Element,root:Element):boolean {
  const view=element.ownerDocument.defaultView!
  for(let node:Element|null=element;node;node=node.parentElement) {
    const style=view.getComputedStyle(node)
    if(node.hasAttribute('hidden') || style.display==='none' || style.visibility!=='visible' || style.opacity==='0')return false
    if(node===root)break
  }
  const rect=element.getBoundingClientRect()
  return rect.width>0 && rect.height>0
}

function title(row:Element):string {
  const view=row.ownerDocument.defaultView!,walker=row.ownerDocument.createTreeWalker(row,view.NodeFilter.SHOW_TEXT)
  let node:Node|null
  while((node=walker.nextNode())) {
    const parent=node.parentElement,text=node.textContent?.trim()
    if(text && parent && !parent.closest('button,svg,[aria-hidden="true"]') && visible(parent,row)) {
      if(text.length>96)throw new Error('Workspace row title exceeds budget')
      return text
    }
  }
  throw new Error('Workspace row has no visible title')
}

interface Binding {token:string;signature:string;node:Element;control:SemanticControl;run:(action:ControlAction)=>void|Promise<void>}

/** A bounded projection, not a copied tree. Search values never read from a hidden source field. */
export function captureWorkspaceControls(source:Element) {
  const view=source.ownerDocument.defaultView
  if(!view || !source.isConnected || !isWorkspaceSource(source))throw new Error('Unsupported workspace shell')
  const flow=source.querySelector(FLOW)!
  const search=source.querySelector<HTMLInputElement>('input[maxlength="500"]')!
  const toggle=source.querySelector<HTMLButtonElement>('button[aria-expanded][aria-keyshortcuts]')!
  let page=0
  const bindings=new Map<string,Binding>()
  const read=(revision:number):ControlSnapshot=>{
    if(!source.isConnected || !isWorkspaceSource(source) || source.querySelector(FLOW)!==flow
      || source.querySelector('input[maxlength="500"]')!==search || source.querySelector('button[aria-expanded][aria-keyshortcuts]')!==toggle)throw new Error('Workspace shell changed; reopen adapter')
    // React replaces the tree for search results; old row bindings still expire by node identity.
    const tree=source.querySelector('[role="tree"]')!
    if(source.querySelector('iframe,canvas,video,audio,img,object,embed,textarea,select,[contenteditable]:not([contenteditable="false"])')
      || [...source.querySelectorAll('input')].some(input=>input!==search)
      || !['text','search'].includes(search.type) || /password|one-time-code|cc-|username/i.test(search.autocomplete))throw new Error('Workspace contains unsupported or sensitive content')
    const rows=[...tree.querySelectorAll('[role="treeitem"]')].filter(row=>visible(row,source))
    if(rows.length>MAX_ROWS)throw new Error('Workspace exceeds row budget')
    for(const row of rows) {
      const id=row.getAttribute('data-row-key')
      if(id!==null && !/^(workspace|session):[a-zA-Z0-9_-]{1,100}$/.test(id))throw new Error('Unknown workspace row identity')
      if(id===null && !row.hasAttribute('aria-selected'))throw new Error('Unknown workspace search row')
      if(row.querySelector('[role="treeitem"]') || row.shadowRoot)throw new Error('Unknown nested workspace row')
    }
    const pages=Math.max(1,Math.ceil(rows.length/PAGE_SIZE))
    page=Math.min(page,pages-1)
    const current=new Set<string>(),controls:SemanticControl[]=[]
    const bind=(key:string,node:Element,signature:string,control:SemanticControl,run:Binding['run'])=>{
      let binding=bindings.get(key)
      if(!binding || binding.node!==node || binding.signature!==signature)binding={token:browserIdentity(),node,signature,control,run}
      binding.control=control;binding.run=run;bindings.set(key,binding);current.add(key)
      controls.push({...control,binding:binding.token})
    }
    const shown=visible(search,source),value=shown?search.value:''
    if(value.length>500)throw new Error('Workspace search exceeds budget')
    bind('c0',search,'search',{key:'c0',kind:'input',value,placeholder:'搜索会话（原 Desktop 同步）',disabled:search.disabled || toggle.disabled,readOnly:search.readOnly},async action=>{
      if(action.kind!=='input' || action.value===undefined || action.value.length>500 || action.value.includes('\0'))throw new Error('Unsupported workspace query')
      if(!visible(search,source)) {
        toggle.click()
        for(let attempt=0;attempt<20 && !visible(search,source);attempt++)await new Promise(resolve=>setTimeout(resolve,25))
      }
      read(0)
      if(!visible(search,source) || search.disabled || search.readOnly)throw new Error('Workspace search unavailable')
      const setter=Object.getOwnPropertyDescriptor(view.HTMLInputElement.prototype,'value')?.set
      if(!setter)throw new Error('Native input setter unavailable')
      setter.call(search,action.value)
      search.dispatchEvent(new view.Event('input',{bubbles:true}));search.dispatchEvent(new view.Event('change',{bubbles:true}))
      page=0
    })
    const rowSignature=rows.map(row=>row.getAttribute('data-row-key')??title(row)).join('|')
    bind('c1',tree,`previous:${page}:${rowSignature}`,{key:'c1',kind:'button',text:`上一页 · ${page+1}/${pages}`,disabled:page===0},()=>{page--})
    bind('c2',tree,`next:${page}:${rowSignature}`,{key:'c2',kind:'button',text:`下一页 · ${page+1}/${pages}`,disabled:page===pages-1},()=>{page++})
    rows.slice(page*PAGE_SIZE,(page+1)*PAGE_SIZE).forEach((row,index)=>{
      const key=`c${index+3}`,id=row.getAttribute('data-row-key'),expanded=row.getAttribute('aria-expanded'),selected=row.getAttribute('aria-selected')
      const workspace=id?.startsWith('workspace:')===true
      if(workspace && expanded!=='true' && expanded!=='false')throw new Error('Workspace expansion state unavailable')
      if(!workspace && selected!=='true' && selected!=='false')throw new Error('Session selection state unavailable')
      const text=`${workspace?(expanded==='true'?'▾ ':'▸ '):(selected==='true'?'● ':'○ ')}${title(row)}`
      // Archived result rows have a separate unarchive flow; never forward their click.
      const disabled=row.getAttribute('aria-disabled')==='true' || row.hasAttribute('aria-description')
      bind(key,row,`${id??'search-result'}:${expanded}:${selected}:${text}:${disabled}`,{key,kind:'button',text,disabled},action=>{
        if(action.kind!=='click' || !source.contains(row) || !visible(row,source))throw new Error('Workspace row unavailable')
        const target=row as HTMLElement
        target.click()
      })
    })
    for(const key of bindings.keys())if(!current.has(key))bindings.delete(key)
    return {revision,title:'Better Float · Workspaces (limited)',adapter:'workspace-v1',controls,
      ...captureWorkspaceAppearance(source,tree,rows,rows.slice(page*PAGE_SIZE,(page+1)*PAGE_SIZE),controls,visible)}
  }
  const apply=async(action:ControlAction):Promise<void>=>{
    read(0)
    const binding=bindings.get(action.key)
    if(!binding || action.binding!==binding.token || binding.control.disabled
      || (action.kind==='input'?binding.control.kind!=='input' || binding.control.readOnly:binding.control.kind!=='button'))throw new StaleWorkspaceActionError()
    await binding.run(action)
  }
  read(0)
  return {read,apply}
}
