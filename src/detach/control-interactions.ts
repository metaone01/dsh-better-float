import {INTERACTION_STATES,INTERACTION_STYLE_PROPERTIES,validStyleValue,
  type ControlInteractions,type InteractionState,type InteractionStyle} from '../shared/control-appearance.ts'

interface Candidate {style:CSSStyleDeclaration;required:readonly string[];rank:readonly number[]}
const dynamic=/:(hover|focus-visible|focus)\b/g
const compound=/^(?:\*|[a-zA-Z][\w-]*)?(?:[.#][\w-]+|:(?:hover|focus-visible|focus|disabled|enabled))*$/
const compare=(left:readonly number[],right:readonly number[])=>{
  for(let index=0;index<left.length;index++)if(left[index]!==right[index])return left[index]!-right[index]!
  return 0
}

/** Conservative CSSOM subset: no source events, clones, style writes, or URLs. */
export function captureInteractions(elements:readonly Element[]):ControlInteractions|undefined {
  const document=elements[0]?.ownerDocument,view=document?.defaultView
  if(!document || !view)return undefined
  const rules:CSSStyleRule[]=[]
  let visited=0
  const walk=(list:CSSRuleList):void=>{
    for(const rule of list) {
      if(++visited>2000)throw new Error('CSSOM rule budget')
      if(rule.type===1) {
        // Nested rules need a different cascade/specificity model.
        if((rule as CSSStyleRule).cssRules?.length)throw new Error('Nested CSS unsupported')
        const styleRule=rule as CSSStyleRule
        if(styleRule.selectorText.length>1024)throw new Error('CSSOM selector budget')
        rules.push(styleRule)
      } else if(rule.type===4) {
        const media=rule as CSSMediaRule
        if(view.matchMedia(media.conditionText).matches)walk(media.cssRules)
      } else if(rule.type===12) {
        const supports=rule as CSSSupportsRule
        if(CSS.supports(supports.conditionText))walk(supports.cssRules)
      } else if(rule.type===3 || 'cssRules' in rule)throw new Error('Unresolved CSS cascade')
    }
  }
  try {
    for(const sheet of new Set([...document.styleSheets,...document.adoptedStyleSheets])) {
      if(sheet.disabled || (sheet.media.mediaText && !view.matchMedia(sheet.media.mediaText).matches))continue
      walk(sheet.cssRules)
    }
  } catch {return undefined}
  const result:Record<string,Record<InteractionState,InteractionStyle>>={}
  elements.forEach((element,index)=>{
    if(element.matches(':disabled'))return
    const computed=view.getComputedStyle(element)
    if(computed.animationName!=='none')return
    const candidates:Candidate[]=[],blocked=new Set<string>(),blockedVariables=new Set<string>()
    const block=(style:CSSStyleDeclaration)=>{
      for(const property of INTERACTION_STYLE_PROPERTIES)if(style.getPropertyValue(property) || style.getPropertyValue('all'))blocked.add(property)
      for(const property of style)if(property.startsWith('--'))blockedVariables.add(property)
    }
    rules.forEach((rule,order)=>{
      for(const selector of rule.selectorText.split(',')) {
        const parts=selector.trim().split(/\s+/),last=parts.at(-1)!
        const supported=parts.every((part,i)=>compound.test(part) && (i===parts.length-1 || !part.includes(':')))
        const plain=selector.replace(dynamic,'')
        let matches=false
        try{matches=element.matches(plain)}catch{block(rule.style);continue}
        if(!matches)continue
        if(!supported){block(rule.style);continue}
        if(rule.style.getPropertyValue('all')){block(rule.style);continue}
        const required=[...last.matchAll(dynamic)].map(match=>match[1]!)
        const rank=[0,(selector.match(/#/g)??[]).length,(selector.match(/[.:]/g)??[]).length,
          parts.filter(part=>/^[a-zA-Z]/.test(part)).length,order]
        candidates.push({style:rule.style,required,rank})
      }
    })
    const inline=(element as HTMLElement).style
    if(inline)candidates.push({style:inline,required:[],rank:[1,0,0,0,rules.length]})
    const states=Object.fromEntries(INTERACTION_STATES.map(state=>[state,{}])) as Record<InteractionState,Record<string,string>>
    const active=element.matches(':hover,:focus')
    for(const property of INTERACTION_STYLE_PROPERTIES) {
      if(blocked.has(property) || !candidates.some(candidate=>candidate.required.length && candidate.style.getPropertyValue(property)))continue
      let invalid=false
      for(const state of INTERACTION_STATES) {
        const flags=new Set<string>()
        if(state.includes('hover'))flags.add('hover')
        if(state.includes('focus'))flags.add('focus')
        if(state.includes('focus-visible'))flags.add('focus-visible')
        let winner:Candidate|undefined,rank:readonly number[]=[]
        for(const candidate of candidates) {
          if(!candidate.required.every(flag=>flags.has(flag)) || !candidate.style.getPropertyValue(property))continue
          const next=[candidate.style.getPropertyPriority(property)==='important'?1:0,...candidate.rank]
          if(!winner || compare(next,rank)>0){winner=candidate;rank=next}
        }
        // Without a static winner, an already active source cannot provide its idle value.
        if(!winner && active){invalid=true;break}
        let value=(winner?.style.getPropertyValue(property)??computed.getPropertyValue(property)).trim()
        const variable=/^var\((--[\w-]+)\)$/.exec(value)
        if(variable) {
          if(blockedVariables.has(variable[1]!) || candidates.some(candidate=>candidate.required.length && candidate.style.getPropertyValue(variable[1]!))){invalid=true;break}
          value=computed.getPropertyValue(variable[1]!).trim()
        }
        if(!validStyleValue(value) || /\b(?:inherit|initial|unset|revert|currentcolor)\b/i.test(value)
          || /(?:%|\b\d*\.?\d+(?:em|rem|vh|vw|cqw|cqh)\b)/i.test(value)){invalid=true;break}
        states[state][property]=value
      }
      if(invalid)for(const state of INTERACTION_STATES)delete states[state][property]
    }
    if(Object.keys(states.idle).length)result[`c${index}`]=states
  })
  return Object.keys(result).length?result:undefined
}
