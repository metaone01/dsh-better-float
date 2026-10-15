import {
  CONTROL_STYLE_PROPERTIES,THEME_STYLE_PROPERTIES,MAX_APPEARANCE_BYTES,appearanceBytes,validStyleValue,
  validPlacement,type ControlAppearance,type ControlStyle,type ControlStyleProperty,type ThemeStyle,type ControlPlacement,
} from '../shared/control-appearance.ts'
import {captureInteractions} from './control-interactions.ts'
import {visualBounds} from './visual-bounds.ts'

/** Sample in place; no source mutations, ancestor cloning, or resource loading. */
export function captureAppearance(source:Element,elements:readonly Element[]):ControlAppearance {
  try {
    const view=source.ownerDocument.defaultView!
    const styles:ControlStyle[]=[],assignments:Record<string,number>={},placements:Record<string,ControlPlacement>={}
    const sourceRect=visualBounds(source)
    if(!Number.isFinite(sourceRect.width) || !Number.isFinite(sourceRect.height) || sourceRect.width<0 || sourceRect.height<0)throw new Error('Source bounds unavailable')
    elements.forEach((element,index)=>{
      const computed=view.getComputedStyle(element)
      const style:Partial<Record<ControlStyleProperty,string>>={}
      for(const property of CONTROL_STYLE_PROPERTIES) {
        const value=computed.getPropertyValue(property).trim()
        if(validStyleValue(value))style[property]=value
      }
      const signature=JSON.stringify(style)
      let styleIndex=styles.findIndex(item=>JSON.stringify(item)===signature)
      if(styleIndex<0){styleIndex=styles.length;styles.push(style)}
      assignments[`c${index}`]=styleIndex
      const rect=element.getBoundingClientRect()
      const round=(value:number)=>Math.round(value*1000)/1000
      if(![rect.left,rect.top,rect.width,rect.height].every(Number.isFinite) || rect.width<0 || rect.height<0)throw new Error('Control bounds unavailable')
      const placement={x:round(rect.left-sourceRect.left),y:round(rect.top-sourceRect.top),width:round(rect.width),height:round(rect.height)}
      if(!validPlacement(placement))throw new Error('Unsupported control bounds')
      placements[`c${index}`]=placement
    })
    const own=view.getComputedStyle(source)
    const theme:Partial<Record<typeof THEME_STYLE_PROPERTIES[number],string>>={}
    for(const property of THEME_STYLE_PROPERTIES) {
      const value=own.getPropertyValue(property).trim()
      if(validStyleValue(value))theme[property]=value
    }
    // Transparent controls inherit their visible backdrop from ancestors.
    let ancestor:Element|null=source
    while(ancestor) {
      const value=view.getComputedStyle(ancestor).backgroundColor
      if(value!=='transparent' && !/^rgba\([^)]*,\s*0\s*\)$/.test(value)) {
        if(validStyleValue(value))theme['background-color']=value
        break
      }
      ancestor=ancestor.parentElement
    }
    const round=(value:number)=>Math.round(value*1000)/1000
    if(!styles.length)styles.push({})
    const frame={x:0,y:0,width:round(sourceRect.width),height:round(sourceRect.height)}
    if(!validPlacement(frame))throw new Error('Unsupported source bounds')
    const appearance:ControlAppearance={mode:'captured',theme:theme as ThemeStyle,styles,assignments,frame,placements}
    if(appearanceBytes(appearance)>MAX_APPEARANCE_BYTES)return {mode:'fallback',reason:'budget'}
    const interactions=captureInteractions(elements)
    const enhanced={...appearance,...interactions?{interactions}:{}}
    return appearanceBytes(enhanced)<=MAX_APPEARANCE_BYTES?enhanced:appearance
  } catch {return {mode:'fallback',reason:'unavailable'}}
}
