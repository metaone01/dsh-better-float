/** display:contents has no box; measure its visible children without moving them. */
export function visualBounds(source:Element):DOMRect {
  const own=source.getBoundingClientRect()
  if(own.width>0 && own.height>0)return own
  const view=source.ownerDocument.defaultView!
  let count=0,left=Infinity,top=Infinity,right=-Infinity,bottom=-Infinity
  const include=(rect:DOMRect):void=>{
    if(rect.width>0 && rect.height>0){left=Math.min(left,rect.left);top=Math.min(top,rect.top);right=Math.max(right,rect.right);bottom=Math.max(bottom,rect.bottom)}
  }
  const visit=(element:Element):void=>{
    if(++count>512)throw new Error('Visual bounds exceed traversal limit')
    const style=view.getComputedStyle(element)
    if(style.display==='none' || style.visibility!=='visible' || style.opacity==='0' || element.hasAttribute('hidden'))return
    const rect=element.getBoundingClientRect()
    if(rect.width>0 && rect.height>0)include(rect)
    else for(const child of element.childNodes){
      if(child.nodeType===1)visit(child as Element)
      else if(child.nodeType===3 && child.textContent?.trim()){
        const range=source.ownerDocument.createRange();range.selectNodeContents(child);include(range.getBoundingClientRect())
      }
    }
  }
  visit(source)
  if(![left,top,right,bottom].every(Number.isFinite))throw new Error('No visible layout box')
  return new view.DOMRect(left,top,right-left,bottom-top)
}
