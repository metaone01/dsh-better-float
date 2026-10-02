import { rasterize } from '../capture/tier3-bitmap.ts'

/** Freeze styles on a detached tree so ancestor selectors still appear in the image. */
export async function snapshotPreview(source: HTMLElement, owner: Document): Promise<HTMLImageElement | null> {
  try {
    const rect = source.getBoundingClientRect()
    const copy = source.cloneNode(true) as HTMLElement
    const originals = [source, ...source.querySelectorAll('*')]
    const copies = [copy, ...copy.querySelectorAll('*')]
    for (let index = 0; index < originals.length; index++) {
      const original = originals[index]!
      const clone = copies[index]!
      const computed = owner.defaultView!.getComputedStyle(original)
      if (clone instanceof HTMLElement || clone instanceof SVGElement) {
        for (const property of computed) clone.style.setProperty(property, computed.getPropertyValue(property))
        clone.style.setProperty('animation', 'none')
        clone.style.setProperty('transition', 'none')
      }
      for (const attribute of [...clone.attributes]) {
        if (/^on/i.test(attribute.name)) clone.removeAttribute(attribute.name)
      }
      if (original instanceof HTMLInputElement && clone instanceof HTMLInputElement) {
        clone.setAttribute('value', original.type === 'password' ? '' : original.value)
        clone.toggleAttribute('checked', original.checked)
      }
      if (original instanceof HTMLTextAreaElement) clone.textContent = original.value
      if (original instanceof HTMLOptionElement) clone.toggleAttribute('selected', original.selected)
      if (original instanceof HTMLImageElement) clone.setAttribute('src', original.currentSrc || original.src)
      if (original instanceof HTMLCanvasElement) {
        try {
          const image = owner.createElement('img')
          image.src = original.toDataURL()
          image.setAttribute('style', clone.getAttribute('style') ?? '')
          clone.replaceWith(image)
        } catch { /* Cross-origin canvas pixels cannot be read. */ }
      }
    }
    copy.querySelectorAll('script, iframe, object, embed').forEach((element) => element.remove())
    copy.style.setProperty('position', 'relative', 'important')
    copy.style.setProperty('inset', 'auto', 'important')
    copy.style.setProperty('inset-inline', 'auto', 'important')
    copy.style.setProperty('inset-block', 'auto', 'important')
    copy.style.setProperty('left', '0', 'important')
    copy.style.setProperty('top', '0', 'important')
    copy.style.setProperty('margin', '0')
    copy.style.setProperty('transform', 'none')
    // Computed logical dimensions can otherwise override physical dimensions
    // and clip borders when the source uses content-box sizing.
    copy.style.setProperty('box-sizing', 'border-box', 'important')
    copy.style.setProperty('width', `${rect.width}px`, 'important')
    copy.style.setProperty('height', `${rect.height}px`, 'important')
    copy.style.setProperty('inline-size', `${rect.width}px`, 'important')
    copy.style.setProperty('block-size', `${rect.height}px`, 'important')
    const result = await rasterize(copy, { x: 0, y: 0, width: rect.width, height: rect.height })
    if (result === null) return null
    const image = owner.createElement('img')
    image.src = result.dataUrl
    image.alt = ''
    image.draggable = false
    return image
  } catch {
    return null
  }
}
