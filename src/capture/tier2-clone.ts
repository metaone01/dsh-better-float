/**
 * Tier 2: the clone.
 *
 * Only reached when a live move is impossible — the panel is going to a
 * different renderer process, or the caller explicitly asked for a snapshot.
 * The clone is a detached copy plus a rebuilt style environment, and it is
 * strictly worse than a live move on every axis that matters: no canvas
 * bitmap, no WebGL context, no video position, no form values, no scroll, no
 * focus, no animation progress, and no React backing, so its handlers have to
 * be reflected.
 *
 * ## The one rule that matters
 *
 * Never round-trip through an HTML string. `innerHTML` parses and *executes* —
 * an `<img onerror>` in the copied markup runs its handler, which turns a
 * copier into a code-execution primitive. `cloneNode` copies nodes without
 * parsing, and `importNode`/`adoptNode` move them between documents without
 * re-serialising. Both are safe; `innerHTML` is not.
 *
 * ## What has to be repaired by hand
 *
 * `cloneNode` faithfully copies markup but not the runtime state that markup
 * describes: input values live in the property, not the attribute; scroll
 * offsets are not attributes at all; canvas pixels are a bitmap, not DOM.
 * Those are enumerated in `repairClone` rather than left to surprise the user.
 */
import type { Rect } from '../shared/types.ts'
import { NODE_BUDGET } from './tier0-live.ts'

export interface CloneResult {
  /** The detached copy, ready to insert. */
  readonly root: Element
  /** What the copy could not carry over, for the caller to surface. */
  readonly losses: readonly CloneLoss[]
  /** Whether the size budget was exceeded and the copy is partial. */
  readonly truncated: boolean
}

export type CloneLossReason =
  | 'canvas-bitmap'
  | 'input-value'
  | 'scroll-position'
  | 'no-focus'
  | 'media-position'
  | 'node-budget'

export interface CloneLoss {
  readonly reason: CloneLossReason
  readonly detail: string
}

/**
 * Deep-copy an element into a target document.
 *
 * `cloneNode(true)` rather than `innerHTML`: it never parses markup, so nothing
 * in the source can execute as a side effect of being copied. The copy is then
 * adopted into the destination document, which is what makes it insertable
 * there without a second serialisation step.
 * @param element - the source element.
 * @param target - the document the copy will live in.
 * @returns the detached copy and what was lost.
 */
export function cloneElement(element: Element, target: Document): CloneResult {
  const copy = element.cloneNode(true) as Element
  const count = countNodes(copy)
  const truncated = count > NODE_BUDGET
  const losses = collectLosses(element, truncated)
  const adopted = target.adoptNode(copy)
  repairClone(element, adopted)
  return { root: adopted, losses, truncated }
}

/**
 * Count the nodes in a subtree, cheaply, stopping once the budget is passed.
 * @param root - the subtree root.
 * @returns the node count, capped just past the budget.
 */
function countNodes(root: Element): number {
  let count = 1
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT)
  while (walker.nextNode() !== null) {
    count += 1
    if (count > NODE_BUDGET) return count
  }
  return count
}

/**
 * Enumerate what this particular subtree cannot carry across a clone.
 * @param source - the original subtree.
 * @param truncated - whether the size budget was exceeded.
 * @returns the losses to report.
 */
function collectLosses(source: Element, truncated: boolean): readonly CloneLoss[] {
  const losses: CloneLoss[] = []
  if (source.querySelector('canvas') !== null) {
    losses.push({
      reason: 'canvas-bitmap',
      detail: 'Canvas contents are not part of the DOM and will appear blank.',
    })
  }
  if (source.querySelector('input, textarea, select') !== null) {
    losses.push({
      reason: 'input-value',
      detail: 'Form values live on the element, not in the markup, and are restored by copy.',
    })
  }
  if (hasScrollableContent(source)) {
    losses.push({
      reason: 'scroll-position',
      detail: 'Scroll offsets are not copied.',
    })
  }
  if (source.querySelector('video, audio') !== null) {
    losses.push({
      reason: 'media-position',
      detail: 'Media playback position and state reset.',
    })
  }
  if (truncated) {
    losses.push({
      reason: 'node-budget',
      detail: `The subtree exceeds ${NODE_BUDGET} elements and was copied in full anyway; expect a slow draw.`,
    })
  }
  return losses
}

/**
 * Whether any element in the subtree is currently scrolled.
 * @param root - the subtree root.
 * @returns whether scroll offsets would be lost.
 */
function hasScrollableContent(root: Element): boolean {
  if (root.scrollTop > 0 || root.scrollLeft > 0) return true
  for (const element of root.querySelectorAll('*')) {
    if (element.scrollTop > 0 || element.scrollLeft > 0) return true
  }
  return false
}

/**
 * Copy the runtime state that markup alone does not describe.
 *
 * Walks the original and the copy in lockstep. Both were produced from the same
 * tree in the same order, so a paired traversal is exact — no selector matching
 * and no ambiguity when siblings are identical.
 * @param source - the original subtree.
 * @param copy - the adopted copy.
 */
export function repairClone(source: Element, copy: Element): void {
  const sources = [source, ...Array.from(source.querySelectorAll('*'))]
  const copies = [copy, ...Array.from(copy.querySelectorAll('*'))]
  const count = Math.min(sources.length, copies.length)
  for (let index = 0; index < count; index += 1) {
    const from = sources[index]
    const to = copies[index]
    if (from === undefined || to === undefined) continue
    if (from instanceof HTMLInputElement && to instanceof HTMLInputElement) {
      // `value` is a property, not an attribute, so the clone starts empty or
      // stale. Checked state has the same problem via the `checked` property.
      to.value = from.value
      to.checked = from.checked
    } else if (from instanceof HTMLTextAreaElement && to instanceof HTMLTextAreaElement) {
      to.value = from.value
    } else if (from instanceof HTMLSelectElement && to instanceof HTMLSelectElement) {
      to.value = from.value
    } else if (from instanceof HTMLCanvasElement && to instanceof HTMLCanvasElement) {
      copyCanvas(from, to)
    }
    if (from.scrollTop !== 0 || from.scrollLeft !== 0) {
      to.scrollTop = from.scrollTop
      to.scrollLeft = from.scrollLeft
    }
  }
}

/**
 * Copy a canvas bitmap when the copy cannot be replayed.
 *
 * A 2D canvas can be duplicated pixel-for-pixel. A WebGL canvas cannot: its
 * drawing buffer is gone once the frame is presented unless the context was
 * created with `preserveDrawingBuffer`, and reading it back would need the
 * original context. In that case the copy stays blank, which is why the caller
 * is told about it up front.
 * @param from - the source canvas.
 * @param to - the copy canvas.
 */
function copyCanvas(from: HTMLCanvasElement, to: HTMLCanvasElement): void {
  to.width = from.width
  to.height = from.height
  const context = to.getContext('2d')
  if (context === null) return
  try {
    context.drawImage(from, 0, 0)
  } catch {
    // A tainted or WebGL canvas cannot be read. Leaving it blank is the only
    // option, and `collectLosses` has already reported it.
  }
}

/**
 * Copy the document's stylesheets into a target document.
 *
 * Needed because a popout is a different document with its own style resolution.
 * `<link>` and `<style>` nodes are cloned as nodes rather than read as text, so
 * nothing is parsed twice. Constructed stylesheets are copied by reference
 * through `adoptedStyleSheets`, which same-origin documents can share.
 * @param source - the document to copy from.
 * @param target - the document to copy into.
 * @param baseHref - absolute URL used to repair relative `href`s.
 */
export function mirrorStyleSheets(source: Document, target: Document, baseHref: string): void {
  const already = target.querySelectorAll('[data-dsh-float-sheet]')
  for (const node of already) node.remove()

  const base = target.createElement('base')
  base.href = baseHref
  base.setAttribute('data-dsh-float-sheet', '')

  const fragment = target.createDocumentFragment()
  fragment.appendChild(base)

  for (const sheet of Array.from(source.styleSheets)) {
    if (sheet.href !== null) {
      const link = target.createElement('link')
      link.rel = 'stylesheet'
      link.href = new URL(sheet.href, baseHref).href
      link.setAttribute('data-dsh-float-sheet', '')
      fragment.appendChild(link)
      continue
    }
    const owner = sheet.ownerNode
    if (owner instanceof HTMLStyleElement) {
      const style = target.createElement('style')
      style.textContent = owner.textContent ?? ''
      style.setAttribute('data-dsh-float-sheet', '')
      fragment.appendChild(style)
    }
  }

  target.head.appendChild(fragment)

  // Constructed sheets have no owner node, and same-origin documents may share
  // the same CSSStyleSheet object directly instead of re-creating the rules.
  const constructed = Array.from(source.adoptedStyleSheets ?? [])
  if (constructed.length > 0) {
    target.adoptedStyleSheets = [...target.adoptedStyleSheets, ...constructed]
  }

  const sourceRoot = source.documentElement
  target.documentElement.className = sourceRoot.className
  for (const attribute of sourceRoot.attributes) {
    if (attribute.name.startsWith('data-')) {
      target.documentElement.setAttribute(attribute.name, attribute.value)
    }
  }
}

/**
 * Apply a frozen size to a cloned subtree.
 * @param root - the clone root.
 * @param rect - the rect measured at capture time.
 */
export function freezeRect(root: HTMLElement, rect: Rect): void {
  const style = root.style
  style.setProperty('width', `${rect.width}px`)
  style.setProperty('height', `${rect.height}px`)
  style.setProperty('overflow', 'hidden')
}
