import type {ControlIcon,ControlScene} from '../src/shared/control-scene.ts'

export function renderIcon(icon:ControlIcon):SVGSVGElement {
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg')
  svg.setAttribute('viewBox',icon.viewBox);svg.setAttribute('aria-hidden','true');svg.setAttribute('focusable','false')
  for(const shape of icon.shapes){
    const node=document.createElementNS('http://www.w3.org/2000/svg',shape.tag)
    for(const [key,value] of Object.entries(shape.attrs))node.setAttribute(key,value)
    svg.append(node)
  }
  return svg
}

export function sceneCss(scene:ControlScene|undefined,positioned:boolean):string {
  if(!scene)return ''
  const container=positioned?'#scene{position:absolute;inset:0;pointer-events:none}':'#scene{position:static;display:flex;flex-direction:column;gap:6px;pointer-events:none}'
  const iconFallback=positioned?'':'#scene svg [stroke]:not([stroke="none"]){stroke:currentColor!important}#scene svg [fill]:not([fill="none"]){fill:currentColor!important}'
  return container+iconFallback+scene.items.map(item=>{
    const style=scene.styles[item.style]!,rect=item.placement
    const values=Object.entries(style).filter(([key])=>positioned || !['color','background-color'].includes(key)).map(([key,value])=>`${key}:${value}!important`).join(';')
    const layout=positioned?`position:absolute;left:${rect.x}px;top:${rect.y}px;width:${rect.width}px;min-height:${rect.height}px;`
      :`position:relative;${item.icon?`width:${Math.min(96,rect.width)}px;height:${Math.min(96,rect.height)}px;`:''}`
    return `#scene>[data-scene="${item.key}"]{${layout}${values};margin:0;padding:0;border:0;box-sizing:border-box;overflow-wrap:anywhere;}`
  }).join('')
}
