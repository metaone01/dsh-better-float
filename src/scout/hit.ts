/**
 * Which element is under the pointer, and how far out the user has stepped.
 *
 * The picker owns the pointer while active. Hit-testing temporarily disables
 * its overlay root and samples the underlying document with `elementsFromPoint`.
 */
import type { Rect } from '../shared/types.ts'

/**
 * Hit-test a viewport point, ignoring everything inside `excludeRoots`.
 *
 * Pass the picker's own UI as `excludeRoots` so the highlight box and hint bar
 * can never be picked. `elementsFromPoint` returns the whole stack, so the
 * first entry outside our own chrome is the real candidate.
 * @param x - viewport x coordinate.
 * @param y - viewport y coordinate.
 * @param excludeRoots - subtrees to skip, such as the picker overlay.
 * @returns the topmost non-picker element, or null over nothing.
 */
export function hitTest(
  x: number,
  y: number,
  excludeRoots: readonly Element[],
  owner: Document = document,
): Element | null {
  const disabled = excludeRoots.filter((root): root is HTMLElement => root instanceof HTMLElement)
  const previous = disabled.map((root) => root.style.display)
  for (const root of disabled) root.style.display = 'none'
  let stack: Element[]
  try {
    stack = owner.elementsFromPoint(x, y)
  } finally {
    disabled.forEach((root, index) => { root.style.display = previous[index] ?? '' })
  }
  let first: Element | null = null
  for (const element of stack) {
    if (excludeRoots.some((root) => root === element || root.contains(element))) continue
    first = element
    break
  }
  if (first === null) return null

  // Some component libraries put `pointer-events: none` on icons, labels, or
  // wrappers inside a control. Chromium then reports the outer layout node as
  // the hit, even though the user is clearly pointing at a button or input.
  // Prefer the nearest semantic control under that point while retaining the
  // raw hit for ordinary non-interactive content.
  const control = controlAtPoint(first, x, y)
  return control ?? first
}

/**
 * Read the element currently hovered before the picker mounts its own root.
 *
 * A keyboard shortcut does not carry pointer coordinates.  Sampling `(0, 0)`
 * in that moment commonly selects `html` or `body`, so the first highlight
 * covers the whole viewport until the pointer moves.  The `:hover` chain is
 * the only reliable coordinate-free snapshot available to the renderer.
 */
export function hoveredElement(
  owner: Document,
  excludeRoots: readonly Element[] = [],
): Element | null {
  let hovered: NodeListOf<Element>
  try {
    hovered = owner.querySelectorAll(':hover')
  } catch {
    return null
  }
  for (let index = hovered.length - 1; index >= 0; index -= 1) {
    const candidate = hovered[index]
    if (candidate === undefined) continue
    if (candidate === owner.documentElement || candidate === owner.body) continue
    if (excludeRoots.some((root) => root === candidate || root.contains(candidate))) continue
    return candidate
  }
  return null
}

/** Whether a viewport point lies inside an excluded floating surface. */
export function pointInRoot(
  x: number,
  y: number,
  roots: readonly Element[],
): boolean {
  return roots.some((root) => {
    const rect = root.getBoundingClientRect()
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
  })
}

const CONTROL_SELECTOR = [
  'button',
  'a[href]',
  'input',
  'textarea',
  'select',
  'summary',
  '[contenteditable="true"]',
  '[role="button"]',
  '[role="checkbox"]',
  '[role="link"]',
  '[role="tab"]',
  '[role="switch"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

function controlAtPoint(root: Element, x: number, y: number): Element | null {
  const closest = root.closest(CONTROL_SELECTOR)
  if (closest !== null) return closest

  let best: { element: Element; depth: number; area: number } | null = null
  for (const candidate of root.querySelectorAll(CONTROL_SELECTOR)) {
    const rect = candidate.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0
      || x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) continue
    const style = getComputedStyle(candidate)
    if (style.display === 'none' || style.visibility === 'hidden') continue

    let depth = 0
    for (let node = candidate.parentElement; node !== null && node !== root; node = node.parentElement) depth += 1
    const area = rect.width * rect.height
    if (best === null || depth > best.depth || depth === best.depth && area < best.area) {
      best = { element: candidate, depth, area }
    }
  }
  return best?.element ?? null
}

/**
 * Step from an element to its parent, refusing to walk past the document body.
 *
 * Stepping out of `<body>` would select the whole page, which is never what the
 * user meant, so the walk stops at the element's own documentElement children.
 * @param element - the current selection.
 * @returns the parent element, or null when there is nowhere useful to go.
 */
export function stepOut(element: Element): Element | null {
  const parent = element.parentElement
  if (parent === null) return null
  const owner = element.ownerDocument
  if (parent === owner.documentElement) return null
  // `body` is the page canvas, not a useful extraction target.  Returning it
  // here makes the next highlight equal the viewport and removes the hole in
  // the dimming mask, which looks like a picker failure.
  if (parent === owner.body) return null
  return parent
}

/**
 * Step from an element to its first element child, the inverse of `stepOut`.
 *
 * Used by the down-arrow key: entering a container to pick the specific child
 * the user actually wants. Descends toward the last pointer position so
 * repeated presses converge on what is under the cursor.
 * @param element - the current selection.
 * @param point - the pointer position used to choose a descendant branch.
 * @returns the child to select, or null when the element has none.
 */
export function stepIn(
  element: Element,
  point?: { readonly x: number; readonly y: number },
  excludeRoots: readonly Element[] = [],
  owner: Document = document,
): Element | null {
  if (point !== undefined) {
    // `elementsFromPoint` accounts for stacking and transforms, so ArrowDown
    // follows the control actually under the cursor instead of firstElementChild.
    const disabled = excludeRoots.filter((root): root is HTMLElement => root instanceof HTMLElement)
    const previous = disabled.map((root) => root.style.display)
    for (const root of disabled) root.style.display = 'none'
    try {
      for (const candidate of owner.elementsFromPoint(point.x, point.y)) {
        if (candidate !== element && element.contains(candidate)) return candidate
      }
    } finally {
      disabled.forEach((root, index) => { root.style.display = previous[index] ?? '' })
    }
  }
  return element.firstElementChild
}

/**
 * Measure an element in viewport coordinates.
 *
 * Uses `getBoundingClientRect`, which is what the on-screen highlight needs;
 * scroll offsets are already folded in because the rect is viewport-relative.
 * @param element - the element to measure.
 * @returns the element's viewport rect.
 */
export function rectOf(element: Element): Rect {
  const rect = element.getBoundingClientRect()
  if (rect.width > 0 && rect.height > 0) {
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  }

  // `display: contents` elements have no principal box, so Chromium reports
  // a zero rect even though their descendants occupy visible space.  Union
  // the descendant client rects to give the picker a real hole to draw.
  let left = Number.POSITIVE_INFINITY
  let top = Number.POSITIVE_INFINITY
  let right = Number.NEGATIVE_INFINITY
  let bottom = Number.NEGATIVE_INFINITY
  for (const descendant of element.querySelectorAll('*')) {
    for (const candidate of descendant.getClientRects()) {
      if (candidate.width <= 0 || candidate.height <= 0) continue
      left = Math.min(left, candidate.left)
      top = Math.min(top, candidate.top)
      right = Math.max(right, candidate.right)
      bottom = Math.max(bottom, candidate.bottom)
    }
  }
  if (left !== Number.POSITIVE_INFINITY) {
    return { x: left, y: top, width: right - left, height: bottom - top }
  }
  return { x: rect.x, y: rect.y, width: Math.max(0, rect.width), height: Math.max(0, rect.height) }
}

/**
 * Whether two rects differ enough to be worth repainting the highlight.
 * @param a - previous rect.
 * @param b - next rect.
 * @param epsilon - tolerance in CSS pixels.
 * @returns whether the highlight needs to move.
 */
export function rectChanged(a: Rect | null, b: Rect, epsilon = 0.5): boolean {
  if (a === null) return true
  return (
    Math.abs(a.x - b.x) > epsilon ||
    Math.abs(a.y - b.y) > epsilon ||
    Math.abs(a.width - b.width) > epsilon ||
    Math.abs(a.height - b.height) > epsilon
  )
}

/**
 * Decide whether a pointer movement should be treated as a drag rather than a
 * click, so a stray pixel does not tear an element out of the page.
 * @param start - where the press began.
 * @param current - where the pointer is now.
 * @param threshold - distance in CSS pixels before a drag counts.
 * @returns whether the gesture has become a drag.
 */
export function passedDragThreshold(
  start: { readonly x: number; readonly y: number },
  current: { readonly x: number; readonly y: number },
  threshold = 4,
): boolean {
  return Math.hypot(current.x - start.x, current.y - start.y) >= threshold
}

/**
 * Which window edge the pointer is near, for the drag-out-to-detach gesture.
 *
 * Chromium stops delivering `pointermove` once the cursor leaves the window, so
 * true off-window tracking is not available. An edge band is the reliable
 * substitute: the user arms the detach by moving into it, and the release
 * happens while the cursor is still inside the window and therefore observable.
 * @param point - the pointer position in viewport coordinates.
 * @param viewport - the current viewport size.
 * @param band - width of the arming band in CSS pixels.
 * @returns the armed edge, or null when the pointer is in the interior.
 */
export function edgeBand(
  point: { readonly x: number; readonly y: number },
  viewport: { readonly width: number; readonly height: number },
  band = 24,
): 'left' | 'right' | 'top' | 'bottom' | null {
  if (point.x <= band) return 'left'
  if (point.x >= viewport.width - band) return 'right'
  if (point.y <= band) return 'top'
  if (point.y >= viewport.height - band) return 'bottom'
  return null
}
