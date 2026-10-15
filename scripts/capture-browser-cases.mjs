import { extract } from '../src/capture/index.ts'
import { installStructuralStandIn, createPlaceholder } from '../src/capture/stand-in.ts'
import { moveNode } from '../src/capture/tier0-live.ts'

export async function run() {
  let checks = 0
  const assert = (value, message) => {
    if (!value) throw new Error(message)
    checks++
  }
  const tick = () => new Promise(resolve => setTimeout(resolve, 0))
  const fixture = () => {
    document.body.replaceChildren()
    const parent = document.createElement('section')
    const first = document.createElement('div')
    const target = document.createElement('div')
    const last = document.createElement('div')
    parent.append(first, target, last)
    const container = document.createElement('article')
    document.body.append(parent, container)
    return { parent, target, first, last, container }
  }
  const originalMethods = Object.getOwnPropertyNames(Node.prototype)
  assert(typeof Element.prototype.moveBefore === 'function', 'Chromium must support atomic moves for this regression')

  {
    const f = fixture()
    const input = document.createElement('input')
    input.value = 'live unsaved value'
    const button = document.createElement('button')
    const scroll = document.createElement('div')
    scroll.style.cssText = 'overflow:auto;width:80px;height:40px'
    const content = document.createElement('div')
    content.style.cssText = 'width:300px;height:500px'
    scroll.append(content)
    f.target.append(input, button, scroll)
    let clicks = 0
    button.addEventListener('click', () => clicks++)
    const fiber = { state: 'unchanged reference' }
    f.target.__reactFiber$regression = fiber
    input.focus()
    input.setSelectionRange(2, 7)
    scroll.scrollTop = 70
    scroll.scrollLeft = 25
    const extraction = extract({ element: f.target, container: f.container, destination: 'float' })
    assert(extraction.tier === 'live' && extraction.strategy === 'in-place', 'default extraction is the in-place live tier')
    assert(f.container.contains(f.target), 'the original DOM object is extracted')
    assert(document.activeElement === input, 'atomic extraction preserves focused input')
    assert(input.value === 'live unsaved value' && input.selectionStart === 2 && input.selectionEnd === 7, 'input value and selection survive extraction')
    assert(scroll.scrollTop === 70 && scroll.scrollLeft === 25, 'scroll offsets survive extraction')
    button.click()
    assert(clicks === 1, 'native click handler survives extraction')
    assert(f.target.__reactFiber$regression === fiber, 'the existing Fiber reference is not copied or replaced')
    extraction.restore()
    assert(f.parent.children[1] === f.target && f.parent.children[2] === f.last, 'restore uses the exact original sibling slot')
    assert(document.activeElement === input && input.selectionStart === 2 && input.selectionEnd === 7, 'atomic restore preserves focus and selection')
    assert(scroll.scrollTop === 70 && scroll.scrollLeft === 25, 'restore preserves scroll offsets')
    assert(!Object.hasOwn(f.parent, 'removeChild'), 'last restore removes the parent mutation guard')
    extraction.restore()
    assert(f.parent.children[1] === f.target && !f.parent.querySelector('dsh-float-anchor'), 'restore is idempotent and removes the anchor')
  }

  {
    const f = fixture()
    const iframe = document.createElement('iframe')
    iframe.srcdoc = '<p>stateful frame</p>'
    const loaded = new Promise(resolve => iframe.addEventListener('load', resolve, { once: true }))
    f.target.append(iframe)
    await loaded
    const childWindow = iframe.contentWindow
    childWindow.sentinel = 'kept'
    const extraction = extract({ element: f.target, container: f.container, destination: 'float' })
    await tick()
    assert(iframe.contentWindow === childWindow && childWindow.sentinel === 'kept', 'iframe browsing context survives extraction')
    extraction.restore()
    await tick()
    assert(iframe.contentWindow === childWindow && childWindow.sentinel === 'kept', 'iframe browsing context survives restoration')
  }

  {
    const f = fixture()
    const secondContainer = document.createElement('article')
    document.body.append(secondContainer)
    const first = extract({ element: f.target, container: f.container, destination: 'float' })
    const second = extract({ element: f.last, container: secondContainer, destination: 'float' })
    const added = document.createElement('span')
    f.parent.insertBefore(added, f.target)
    assert(added.nextSibling.tagName === 'DSH-FLOAT-ANCHOR', 'insertBefore rewrites its reference-node argument')
    first.restore()
    assert(added.nextSibling === f.target, 'the first panel returns to its own updated slot')
    assert(Object.hasOwn(f.parent, 'removeChild'), 'closing the first panel retains the second guard')
    assert(f.parent.removeChild(f.last) === f.last, 'guarded DOM methods return the logical original node')
    second.restore()
    assert(f.last.parentNode !== f.parent, 'an unmounted second panel is not resurrected')
    assert(!f.parent.querySelector('dsh-float-anchor') && !Object.hasOwn(f.parent, 'removeChild'), 'multiple-panel teardown removes all anchors and patches')
  }

  {
    const f = fixture()
    let removed = 0
    const extraction = extract({ element: f.target, container: f.container, destination: 'float', onHostRemoved: () => { removed++; extraction.restore() } })
    f.parent.removeChild(f.target)
    extraction.restore()
    assert(f.target.parentNode !== f.parent, 'synchronous late restore does not resurrect an unmounted child')
    await tick()
    assert(removed === 0, 'explicit teardown disconnects the queued host-removal callback')
  }

  {
    const f = fixture()
    let removed = 0
    const extraction = extract({ element: f.target, container: f.container, destination: 'float', onHostRemoved: () => { removed++; extraction.restore() } })
    const replacement = document.createElement('button')
    assert(f.parent.replaceChild(replacement, f.target) === f.target, 'replaceChild returns the logical old child')
    await tick()
    assert(removed === 1, 'host replacement triggers one reclaim callback')
    assert(replacement.parentNode === f.parent && f.target.parentNode !== f.parent, 'host replacement remains authoritative after restore')
  }

  for (const skeleton of [false, true]) {
    const f = fixture()
    if (skeleton) f.parent.style.transform = 'translateX(0)'
    let removed = 0
    const extraction = extract({ element: f.target, container: f.container, destination: 'float', onHostRemoved: () => { removed++; extraction.restore() } })
    assert(extraction.strategy === (skeleton ? 'skeleton' : 'in-place'), 'fixture selects the requested ancestry strategy')
    f.parent.remove()
    await tick()
    assert(removed === 1, `${extraction.strategy}: ancestor unmount triggers one reclaim callback`)
    assert(f.target.parentNode !== f.parent, `${extraction.strategy}: ancestor unmount is not undone by restore`)
  }

  {
    const f = fixture()
    const original = f.parent.removeChild
    const getter = () => original
    Object.defineProperty(f.parent, 'removeChild', { get: getter, configurable: true, enumerable: true })
    const extraction = extract({ element: f.target, container: f.container, destination: 'float' })
    extraction.restore()
    const descriptor = Object.getOwnPropertyDescriptor(f.parent, 'removeChild')
    assert(descriptor.get === getter && descriptor.enumerable === true, 'restore preserves the full preexisting property descriptor')
  }

  {
    const f = fixture()
    Object.defineProperty(f.parent, 'appendChild', { value: f.parent.appendChild, configurable: false })
    let failed = false
    try { installStructuralStandIn(f.parent, f.target, createPlaceholder()) } catch { failed = true }
    assert(failed, 'an unpatchable parent fails explicitly')
    assert(!Object.hasOwn(f.parent, 'removeChild') && !Object.hasOwn(f.parent, 'insertBefore'), 'partial guard installation is rolled back')
    assert(f.target.parentNode === f.parent && !f.parent.querySelector('dsh-float-anchor'), 'failed guard installation leaves the host unchanged')
  }

  {
    const f = fixture()
    const initialStyle = f.container.getAttribute('style')
    Object.defineProperty(f.container, 'moveBefore', { value: () => { throw new Error('injected atomic failure') } })
    Object.defineProperty(f.container, 'insertBefore', { value: () => { throw new Error('injected fallback failure') } })
    const originalRemoveAttribute = f.container.removeAttribute
    let removedStyle = false
    f.container.removeAttribute = function (attribute) { if (attribute === 'style') removedStyle = true; return originalRemoveAttribute.call(this, attribute) }
    let failed = false
    try { extract({ element: f.target, container: f.container, destination: 'float' }) } catch { failed = true }
    assert(failed, 'a failed move propagates its error')
    assert(f.target.parentNode === f.parent && f.parent.children[1] === f.target, 'failed extraction keeps the original child and sibling order')
    assert(!Object.hasOwn(f.parent, 'removeChild') && !f.parent.querySelector('dsh-float-anchor'), 'failed extraction removes the guard and anchor')
    assert(f.container.parentNode === document.body && f.container.getAttribute('style') === initialStyle, `failed extraction restores the frame location and style: parent=${f.container.parentNode?.tagName}, style=${f.container.getAttribute('style')}, expected=${initialStyle}, removed=${removedStyle}`)
  }

  {
    const f = fixture()
    const input = document.createElement('textarea')
    input.value = 'fallback editable value'
    f.target.append(input)
    input.focus()
    input.setSelectionRange(1, 4)
    Object.defineProperty(f.container, 'moveBefore', { value: undefined })
    const result = moveNode(f.target, f.container)
    assert(result.degraded, 'non-atomic fallback reports fidelity loss')
    assert(document.activeElement === input && input.selectionStart === 1 && input.selectionEnd === 4, 'same-document fallback repairs focus and selection')
    const beforeParent = f.target.parentNode
    let failed = false
    try { moveNode(f.target, f.parent, document.createElement('div')) } catch { failed = true }
    assert(failed && f.target.parentNode === beforeParent, 'invalid insertion does not detach or adopt the live node')
  }

  {
    const f = fixture()
    let removed = 0
    const extraction = extract({ element: f.target, container: f.container, destination: 'float', onHostRemoved: () => { removed++; extraction.restore() } })
    const anchor = f.parent.querySelector('dsh-float-anchor')
    const replacement = document.createElement('div')
    f.parent.replaceChildren(replacement)
    assert(anchor.parentNode === null, 'replaceChildren removes the reserved slot')
    extraction.restore()
    assert(f.target.parentNode !== f.parent, 'native replaceChildren cannot cause late restoration to resurrect old content')
    await tick()
    assert(removed === 0, 'cancelled observer does not fire after native replacement and teardown')
  }

  assert(Object.getOwnPropertyNames(Node.prototype).join() === originalMethods.join(), 'capture does not add or remove global Node methods')
  document.body.replaceChildren()
  return { checks }
}
