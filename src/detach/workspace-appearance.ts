import {captureAppearance} from './control-appearance.ts'
import {captureIcon} from './control-scene.ts'
import {validAppearance,validPlacement,validStyleValue,type ControlAppearance,type ControlStyle,type ControlPlacement} from '../shared/control-appearance.ts'
import {SCENE_STYLE_PROPERTIES,validScene,type ControlScene,type SceneItem,type SceneStyle} from '../shared/control-scene.ts'
import type {ControlSnapshot,SemanticControl} from '../shared/control-adapter.ts'
import {visualBounds} from './visual-bounds.ts'

type Visible=(element:Element,root:Element)=>boolean
const round=(value:number)=>Math.round(value*1000)/1000

/** Read-only decoration. Business labels/bindings survive every appearance fallback. */
export function captureWorkspaceAppearance(source:Element,tree:Element,rows:readonly Element[],pageRows:readonly Element[],
  controls:readonly SemanticControl[],visible:Visible):Pick<ControlSnapshot,'appearance'|'scene'|'workspaceVisual'> {
  const fallback=(reason:'budget'|'unavailable'|'geometry'):Pick<ControlSnapshot,'appearance'>=>({appearance:{mode:'fallback',reason}})
  let retained:ControlAppearance|undefined
  try {
    if(!pageRows.length)return fallback('unavailable')
    const base=captureAppearance(source,pageRows)
    if(base.mode!=='captured' || !base.frame || !base.placements)return fallback(base.mode==='fallback'?base.reason:'unavailable')
    const view=source.ownerDocument.defaultView!,origin=visualBounds(source)
    const shift=pageRows[0]!.getBoundingClientRect().top-rows[0]!.getBoundingClientRect().top
    const frame={...base.frame,height:round(base.frame.height+88)}
    const styles:ControlStyle[]=[],assignments:Record<string,number>={},placements:Record<string,ControlPlacement>={}
    const interactions:Record<string,NonNullable<Extract<ControlAppearance,{mode:'captured'}>['interactions']>[string]>={}
    pageRows.forEach((_row,index)=>{
      const from=`c${index}`,key=`c${index+3}`
      placements[key]={...base.placements![from]!,y:round(base.placements![from]!.y-shift)}
      // Text is painted by the scene; retain only the row's hit-area decoration.
      const original=base.styles[base.assignments[from]!]!,style:Partial<Record<keyof ControlStyle,string>>={
        width:`${placements[key]!.width}px`,height:`${placements[key]!.height}px`,'box-sizing':'border-box'}
      for(const property of ['color','background-color','opacity','border-top-left-radius','border-top-right-radius','border-bottom-left-radius','border-bottom-right-radius'] as const){
        if(original[property])style[property]=original[property]
      }
      for(const side of ['top','right','bottom','left'] as const){
        if(Number.parseFloat(original[`border-${side}-width`]??'0')>0){
          for(const part of ['width','style','color'] as const){const property=`border-${side}-${part}` as const;if(original[property])style[property]=original[property]}
        }
      }
      if(original['box-shadow'] && original['box-shadow']!=='none')style['box-shadow']=original['box-shadow']
      let styleIndex=styles.findIndex(candidate=>JSON.stringify(candidate)===JSON.stringify(style))
      if(styleIndex<0){styleIndex=styles.length;styles.push(style)}
      assignments[key]=styleIndex
      if(base.interactions?.[from])interactions[key]=base.interactions[from]!
    })
    const font=base.styles[0]!,footer:ControlStyle={color:base.theme.color??font.color??'inherit','background-color':base.theme['background-color']??'transparent',
      'font-size':'12px','line-height':'20px','box-sizing':'border-box',
      'font-family':'inherit'}
    const addFooter=(key:string,placement:ControlPlacement)=>{
      const style={...footer,width:`${placement.width}px`,height:`${placement.height}px`}
      let index=styles.findIndex(candidate=>JSON.stringify(candidate)===JSON.stringify(style))
      if(index<0){index=styles.length;styles.push(style)}
      assignments[key]=index;placements[key]=placement
    }
    if(frame.width<32)return fallback('geometry')
    const width=round(frame.width-16),half=round((width-8)/2)
    addFooter('c0',{x:8,y:round(origin.height+8),width,height:28})
    addFooter('c1',{x:8,y:round(origin.height+44),width:half,height:28})
    addFooter('c2',{x:round(16+half),y:round(origin.height+44),width:half,height:28})
    const appearance:ControlAppearance={mode:'captured',theme:base.theme,styles,assignments,placements,frame,
      ...Object.keys(interactions).length?{interactions}:{}}
    if(!validAppearance(appearance,controls.map(control=>control.key)))return fallback('geometry')
    retained=appearance
    const items:SceneItem[]=[],sceneStyles:SceneStyle[]=[]
    let visited=0,omittedIcons=0
    const add=(element:Element,text:string,rect:DOMRect,offset:number,icon?:SceneItem['icon'])=>{
      if(items.length>=24 || text.length>512)throw new Error('Workspace decoration budget')
      const placement={x:round(rect.left-origin.left),y:round(rect.top-origin.top-offset),width:round(rect.width),height:round(rect.height)}
      if(!validPlacement(placement) || placement.y+placement.height>origin.height+1)throw new Error('Workspace decoration geometry')
      const computed=view.getComputedStyle(element),style:Record<string,string>={}
      if(!icon)for(const property of SCENE_STYLE_PROPERTIES){
        const value=computed.getPropertyValue(property).trim()
        if(['white-space','text-align'].includes(property)
          || property==='background-color' && ['transparent','rgba(0, 0, 0, 0)'].includes(value)
          || ['font-style','letter-spacing'].includes(property) && value==='normal'
          || property==='text-decoration-line' && value==='none')continue
        if(validStyleValue(value))style[property]=value
      }
      if(!icon && computed.lineHeight==='normal')style['line-height']=`${placement.height}px`
      const signature=JSON.stringify(style)
      let index=sceneStyles.findIndex(candidate=>JSON.stringify(candidate)===signature)
      if(index<0){index=sceneStyles.length;sceneStyles.push(style)}
      items.push({key:`v${items.length}`,text,placement,style:index,...icon?{icon}:{}})
    }
    const capture=(root:Element,offset:number,header=false)=>{
      const walker=source.ownerDocument.createTreeWalker(root,view.NodeFilter.SHOW_TEXT)
      let node:Node|null
      while((node=walker.nextNode())){
        if(++visited>256)throw new Error('Workspace decoration traversal budget')
        const parent=node.parentElement,text=node.textContent??''
        if(!text.trim() || !parent || parent.closest('button,input,svg,[aria-hidden="true"]') || !visible(parent,root)
          || header && tree.contains(parent))continue
        const leaf=parent.childNodes.length===1
        const range=source.ownerDocument.createRange();range.selectNodeContents(node)
        const rect=leaf?parent.getBoundingClientRect():range.getBoundingClientRect()
        range.detach();add(parent,text,rect,offset)
      }
      if(!header)for(const svg of root.querySelectorAll('svg')){
        if(svg.closest('button') || !visible(svg,root))continue
        const icon=captureIcon(svg)
        if(icon)add(svg,'',svg.getBoundingClientRect(),offset,icon)
        else omittedIcons++
      }
    }
    capture(source,0,true)
    for(const row of pageRows)capture(row,shift)
    const scene:ControlScene={items,styles:sceneStyles,displayOnly:false}
    if(!validScene(scene))return {appearance}
    const make=()=>({appearance,scene,workspaceVisual:{sourceHeight:round(origin.height),omittedIcons}})
    const bytes=()=>new TextEncoder().encode(JSON.stringify({revision:0,title:'Better Float · Workspaces (limited)',adapter:'workspace-v1',controls,...make()})).byteLength
    // Leave room for the authenticated RPC envelope; only decorative icons may be omitted.
    for(let index=items.length-1;bytes()>6500 && index>=0;index--)if(items[index]!.icon){items.splice(index,1);omittedIcons++}
    items.forEach((item,index)=>{items[index]={...item,key:`v${index}`}})
    return bytes()<=6500 && validScene(scene)?make():{appearance}
  } catch {return retained?{appearance:retained}:fallback('unavailable')}
}
