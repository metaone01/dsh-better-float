import {SCENE_STYLE_PROPERTIES,validIcon,validScene,type ControlScene,type ControlIcon,type SceneItem,type SceneStyle,type VectorShape} from '../shared/control-scene.ts'
import {validPlacement,validStyleValue} from '../shared/control-appearance.ts'
import {visualBounds} from './visual-bounds.ts'

export function captureIcon(svg:Element):ControlIcon|undefined {
  const view=svg.ownerDocument.defaultView!
  const shapes:VectorShape[]=[]
  const rootStyle=view.getComputedStyle(svg)
  if(rootStyle.opacity!=='1' || rootStyle.transform!=='none' || rootStyle.filter!=='none' || rootStyle.clipPath!=='none' || rootStyle.maskImage!=='none')return undefined
  if(svg.querySelectorAll('*').length>48)return undefined
  for(const node of svg.querySelectorAll('*')) {
    if(['title','desc'].includes(node.localName))continue
    if(node.localName==='g') {
      if(node.attributes.length)return undefined
      continue
    }
    if(!['path','circle','rect','line','polyline','polygon','ellipse'].includes(node.localName))return undefined
    const attrs:Record<string,string>={}
    for(const attribute of node.attributes) {
      if(attribute.name==='class')continue
      attrs[attribute.name]=attribute.value
    }
    const computed=view.getComputedStyle(node)
    for(const property of ['fill','stroke','stroke-width','stroke-linecap','stroke-linejoin','fill-rule','opacity'])attrs[property]=computed.getPropertyValue(property).trim()
    // Opacity/transform/resources require a dedicated vector adapter.
    if(computed.transform!=='none' || computed.clipPath!=='none' || computed.maskImage!=='none' || computed.filter!=='none')return undefined
    shapes.push({tag:node.localName as VectorShape['tag'],attrs})
  }
  const icon={viewBox:svg.getAttribute('viewBox')??'0 0 24 24',shapes}
  return validIcon(icon)?icon:undefined
}

/** Visible display nodes only. No HTML, event listeners, or hidden values leave the source. */
export function captureScene(source:Element,controls:readonly Element[],options:{readonly readonlyDecorations?:boolean}={}):ControlScene|undefined {
  const view=source.ownerDocument.defaultView!,origin=visualBounds(source)
  const items:SceneItem[]=[],styles:SceneStyle[]=[]
  let visited=0,displayOnly=false
  const add=(element:Element,text:string,rect:DOMRect,icon?:ControlIcon)=>{
    if(text.length>512 || items.length>=24){if(options.readonlyDecorations)return;throw new Error('Display scene exceeds item budget')}
    const placement={x:Math.round((rect.left-origin.left)*1000)/1000,y:Math.round((rect.top-origin.top)*1000)/1000,
      width:Math.round(rect.width*1000)/1000,height:Math.round(rect.height*1000)/1000}
    if(!validPlacement(placement)){if(options.readonlyDecorations)return;throw new Error('Display geometry unsupported')}
    const computed=view.getComputedStyle(element),style:Record<string,string>={}
    for(const property of SCENE_STYLE_PROPERTIES){const value=computed.getPropertyValue(property).trim();if(validStyleValue(value))style[property]=value}
    const signature=JSON.stringify(style)
    let index=styles.findIndex(style=>JSON.stringify(style)===signature)
    if(index<0){index=styles.length;styles.push(style)}
    items.push({key:`v${items.length}`,text,placement,style:index,...icon?{icon}:{}})
  }
  const visit=(element:Element,depth:number):void=>{
    if(++visited>512 || depth>48){if(options.readonlyDecorations)return;throw new Error('Display tree exceeds budget')}
    const computed=view.getComputedStyle(element)
    if(computed.display==='none' || computed.visibility!=='visible' || computed.opacity==='0' || element.hasAttribute('hidden'))return
    if(controls.includes(element))return
    if(element.shadowRoot || element.matches('iframe,canvas,video,audio,img,object,embed,textarea,select,input,script,style,[contenteditable]:not([contenteditable="false"])')){
      if(options.readonlyDecorations)return
      throw new Error('Selection contains unrepresented content')
    }
    if(element.matches('button') && !options.readonlyDecorations)throw new Error('Selection contains unrepresented content')
    if(/url\s*\(/i.test(computed.backgroundImage) && !options.readonlyDecorations)throw new Error('Background resource requires a dedicated adapter')
    if(element.matches('[role],a[href],[tabindex],[draggable=true]'))displayOnly=true
    if(element.localName==='svg') {
      const rect=element.getBoundingClientRect()
      if(!rect.width || !rect.height)return
      const icon=captureIcon(element),label=element.getAttribute('aria-label')??element.querySelector('title')?.textContent
        ??(element.getAttribute('aria-hidden')==='true'?'◇':'')
      if(!icon && options.readonlyDecorations)return
      if(!icon && !label.trim())throw new Error('Unlabelled unsupported graphic')
      add(element,icon?'':label,rect,icon);return
    }
    for(const pseudo of ['::before','::after']){
      const generated=view.getComputedStyle(element,pseudo).content
      if(generated && generated!=='none' && generated!=='normal' && generated!=='""' && !options.readonlyDecorations)throw new Error('Generated content requires a dedicated adapter')
    }
    for(const child of element.childNodes) {
      if(child.nodeType===1)visit(child as Element,depth+1)
      else if(child.nodeType===3 && child.textContent?.trim()){
        const range=source.ownerDocument.createRange();range.selectNodeContents(child)
        const rect=range.getBoundingClientRect()
        if(rect.width && rect.height)add(element,child.textContent,rect)
      }
    }
  }
  visit(source,0)
  if(!items.length)return undefined
  const scene={items,styles,displayOnly:displayOnly || controls.length===0 || !!options.readonlyDecorations}
  if(!validScene(scene)){if(options.readonlyDecorations)return undefined;throw new Error('Display scene exceeds byte budget')}
  return scene
}
