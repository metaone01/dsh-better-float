/** Values only: never selectors, HTML, resource URLs, or arbitrary CSS rules. */
export const CONTROL_STYLE_PROPERTIES = [
  'color','background-color','font-family','font-size','font-weight','font-style','line-height',
  'letter-spacing','text-align','text-transform','text-decoration-line',
  'border-top-width','border-right-width','border-bottom-width','border-left-width',
  'border-top-style','border-right-style','border-bottom-style','border-left-style',
  'border-top-color','border-right-color','border-bottom-color','border-left-color',
  'border-top-left-radius','border-top-right-radius','border-bottom-right-radius','border-bottom-left-radius',
  'padding-top','padding-right','padding-bottom','padding-left','box-shadow','box-sizing','width','height','color-scheme','opacity',
] as const
export type ControlStyleProperty = typeof CONTROL_STYLE_PROPERTIES[number]
export type ControlStyle = Readonly<Partial<Record<ControlStyleProperty,string>>>
export const INTERACTION_STYLE_PROPERTIES = ['color','background-color','border-top-color','border-right-color','border-bottom-color','border-left-color','box-shadow','opacity','outline-color','outline-style','outline-width','outline-offset'] as const
export const INTERACTION_STATES = ['idle','hover','focus','hover-focus','focus-visible','hover-focus-visible'] as const
export type InteractionState = typeof INTERACTION_STATES[number]
export type InteractionStyle = Readonly<Partial<Record<typeof INTERACTION_STYLE_PROPERTIES[number],string>>>
export type ControlInteractions = Readonly<Record<string,Readonly<Record<InteractionState,InteractionStyle>>>>
export interface ControlPlacement {readonly x:number;readonly y:number;readonly width:number;readonly height:number}
export const THEME_STYLE_PROPERTIES = ['color','background-color','color-scheme'] as const
export type ThemeStyle = Readonly<Partial<Record<typeof THEME_STYLE_PROPERTIES[number],string>>>
export const MAX_APPEARANCE_BYTES = 6000
export type ControlAppearance =
  | {readonly mode:'captured';readonly theme:ThemeStyle;readonly styles:readonly ControlStyle[];readonly assignments:Readonly<Record<string,number>>;readonly frame?:ControlPlacement;readonly placements?:Readonly<Record<string,ControlPlacement>>;readonly interactions?:ControlInteractions}
  | {readonly mode:'fallback';readonly reason:'budget'|'unavailable'|'geometry'}

export function validStyleValue(value:unknown):value is string {
  if(typeof value!=='string' || value.length===0 || value.length>160
    || !/^[\p{L}\p{M}\p{N}\p{Zs}#.,()%+\-/'"]+$/u.test(value))return false
  // Only non-resource color functions are allowed, even within shadows.
  for(const match of value.matchAll(/([a-z-]+)\s*\(/gi)) {
    if(!['rgb','rgba','hsl','hsla','hwb','lab','lch','oklab','oklch','color'].includes(match[1]!.toLowerCase()))return false
  }
  for(const match of value.matchAll(/(-?\d+(?:\.\d+)?)px/gi))if(Math.abs(Number(match[1]))>4096)return false
  return true
}
function validStyle(value:unknown,properties:readonly string[]):boolean {
  return !!value && typeof value==='object' && !Array.isArray(value)
    && Object.entries(value).every(([key,item])=>properties.includes(key) && validStyleValue(item))
}
export function validPlacement(value:unknown):value is ControlPlacement {
  if(!value || typeof value!=='object' || Array.isArray(value))return false
  const item=value as Record<string,unknown>
  return Object.keys(item).every(key=>['x','y','width','height'].includes(key))
    && ['x','y','width','height'].every(key=>typeof item[key]==='number' && Number.isFinite(item[key]) && item[key]>=0 && item[key]<=8192)
}
export function appearanceBytes(value:ControlAppearance):number {return new TextEncoder().encode(JSON.stringify(value)).byteLength}
export function validAppearance(value:unknown,keys:readonly string[]):value is ControlAppearance {
  if(!value || typeof value!=='object' || Array.isArray(value))return false
  const item=value as ControlAppearance
  if(item.mode==='fallback')return Object.keys(item).every(key=>['mode','reason'].includes(key)) && ['budget','unavailable','geometry'].includes(item.reason)
  if(item.mode!=='captured' || !Object.keys(item).every(key=>['mode','theme','styles','assignments','frame','placements','interactions'].includes(key))
    || !validStyle(item.theme,THEME_STYLE_PROPERTIES) || !Array.isArray(item.styles) || item.styles.length<1 || item.styles.length>6
    || !item.styles.every(style=>validStyle(style,CONTROL_STYLE_PROPERTIES))
    || !item.assignments || typeof item.assignments!=='object' || Array.isArray(item.assignments)
    || (item.placements!==undefined && (!item.placements || typeof item.placements!=='object' || Array.isArray(item.placements))))return false
  if(item.interactions!==undefined) {
    if(!item.interactions || typeof item.interactions!=='object' || Array.isArray(item.interactions))return false
    for(const [key,states] of Object.entries(item.interactions)) {
      if(!keys.includes(key) || !states || typeof states!=='object' || Array.isArray(states)
        || Object.keys(states).length!==INTERACTION_STATES.length
        || !INTERACTION_STATES.every(state=>validStyle(states[state],INTERACTION_STYLE_PROPERTIES)))return false
    }
  }
  const assignments=Object.entries(item.assignments)
  const placementEntries=item.placements===undefined?[]:Object.entries(item.placements)
  return assignments.length===keys.length && assignments.every(([key,index])=>keys.includes(key) && Number.isInteger(index) && index>=0 && index<item.styles.length)
    && (item.frame===undefined || validPlacement(item.frame))
    && placementEntries.length===(item.placements===undefined?0:keys.length)
    && placementEntries.every(([key,placement])=>keys.includes(key) && validPlacement(placement))
    && appearanceBytes(item)<=MAX_APPEARANCE_BYTES
}

/** Already validated values cannot escape declarations; selectors are fixed. */
export function appearanceCss(appearance:ControlAppearance|undefined):string {
  if(!appearance || appearance.mode!=='captured')return ''
  const declarations=(style:ControlStyle)=>Object.entries(style).map(([key,value])=>`${key}:${value}!important`).join(';')
  const stateSelectors:Record<InteractionState,string>={idle:':not(:hover):not(:focus)',hover:':hover:not(:focus)',focus:':not(:hover):focus:not(:focus-visible)',
    'hover-focus':':hover:focus:not(:focus-visible)','focus-visible':':not(:hover):focus:focus-visible','hover-focus-visible':':hover:focus:focus-visible'}
  const frame=appearance.frame
  const frameCss=frame?`#controls{position:relative!important;display:block!important;width:${frame.width}px!important;height:${frame.height}px!important;margin:0!important;}`:''
  return `body{${declarations(appearance.theme)}}`+frameCss+Object.entries(appearance.assignments)
    .map(([key,index])=>{
      const placement=appearance.placements?.[key]
      const layout=placement?`position:absolute!important;left:${placement.x}px!important;top:${placement.y}px!important;`:''
      return `#controls>[data-control="${key}"]{${layout}${declarations(appearance.styles[index]!)}}`
    }).join('')+Object.entries(appearance.interactions??{}).map(([key,states])=>INTERACTION_STATES.map(state=>
      `#controls>[data-control="${key}"]${stateSelectors[state]}{${declarations(states[state] as ControlStyle)}}`).join('')).join('')
}
