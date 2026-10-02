/**
 * Tier 0: the live move.
 *
 * Moving the node rather than copying it is what makes this whole approach
 * worth doing. `moveBefore` (Chromium 133+, so present in Electron 44) performs
 * an atomic move that preserves the node's identity *and* its runtime state —
 * CSS animation progress, `:focus`, open popovers, an open `<dialog>`, a
 * running `<video>`, and crucially an `<iframe>` without a reload. React's
 * fiber keeps pointing at the same object, so the framework keeps updating it
 * and the updates simply render in the new location.
 *
 * `appendChild` after `removeChild` loses most of that, because it detaches and
 * reattaches. `moveBefore` does not detach.
 *
 * ## The cross-document wall
 *
 * `moveBefore` throws `HierarchyRequestError` across documents. There is no way
 * around it: a standalone window is a different document, so the popout path
 * necessarily falls back to `adoptNode`, which preserves the node object and
 * its React identity but resets iframes, focus and animations. That gap is a
 * real quality difference between "floating in the app" and "a separate
 * window", and the caller should tell the user which one they got.
 */
import type { AncestorSnapshot, CaptureTarget, Prognosis, Downgrade } from '../shared/types.ts'
import { findInsertionPoint, liveStyleReader, snapshotAncestor } from './css-inplace.ts'

/**
 * Whether the running engine can move a node without detaching it.
 *
 * Feature-detected rather than version-sniffed: the method either exists on the
 * prototype or it does not, and that is the only thing that matters.
 * @returns whether `moveBefore` is available.
 */
export function supportsMoveBefore(): boolean {
  return typeof Element.prototype.moveBefore === 'function'
}

export interface MoveResult {
  /** How the node actually travelled. */
  readonly method: 'moveBefore' | 'adopt-insert'
  /** True when fidelity was lost and the user should be warned. */
  readonly degraded: boolean
}

/**
 * Move a node under a new parent, preferring the state-preserving path.
 *
 * Tries `moveBefore` first and falls back to `adoptNode` + insert, which is
 * what a cross-document move requires. The fallback is not an error path — it
 * is the correct primitive for a popout — so it is reported rather than thrown.
 * @param node - the element to move.
 * @param parent - the new parent.
 * @param before - insert before this child, or null to append.
 * @returns how the move was performed.
 */
export function moveNode(node: Element, parent: Element, before: Element | null = null): MoveResult {
  if (supportsMoveBefore()) {
    try {
      parent.moveBefore(node, before)
      return { method: 'moveBefore', degraded: false }
    } catch {
      // Cross-document, or a node type `moveBefore` refuses. Fall through.
    }
  }
  // `adoptNode` transfers the node into the target document while keeping the
  // same object identity — which is what React's fiber reference needs. Using
  // `importNode` here instead would clone, silently breaking the live link.
  const document = parent.ownerDocument
  const adopted = document.adoptNode(node)
  parent.insertBefore(adopted, before)
  return { method: 'adopt-insert', degraded: true }
}

/**
 * Capture everything needed to extract an element, and judge what is safe.
 *
 * Doing the analysis up front means the user gets a warning *before* the page
 * is mutated, rather than watching an iframe reload after the fact.
 * @param element - the element the user picked.
 * @returns the capture target, including the prognosis.
 */
export function capture(element: Element): CaptureTarget {
  const rect = element.getBoundingClientRect()
  const plan = findInsertionPoint(element)
  const ancestry = plan.missing.length > 0
    ? ancestorsOf(element, plan.host).map((node) => snapshotAncestor(node, liveStyleReader))
    : []
  return {
    element,
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    ancestry,
    prognosis: prognose(element, plan.escapes),
  }
}

/**
 * Walk the live ancestors from just below `stopAt` down to the element's
 * parent, in top-down order.
 * @param element - the element being extracted.
 * @param stopAt - the ancestor to stop above.
 * @returns the intermediate ancestors, outermost first.
 */
function ancestorsOf(element: Element, stopAt: Element): readonly Element[] {
  const chain: Element[] = []
  let node = element.parentElement
  while (node !== null && node !== stopAt) {
    chain.push(node)
    node = node.parentElement
  }
  chain.reverse()
  return chain
}

/**
 * How large a subtree the plugin is willing to move before warning.
 *
 * A live move is cheap regardless of size, because nothing is copied. This
 * bound exists for the clone path, where the cost is real.
 */
export const NODE_BUDGET = 2000

/**
 * Decide what could go wrong if this element is extracted.
 * @param element - the element the user picked.
 * @param escapes - whether the in-place escape is available.
 * @returns the verdict, with each reason to downgrade.
 */
export function prognose(element: Element, escapes: boolean): Prognosis {
  const downgrades: Downgrade[] = []

  if (!escapes) {
    downgrades.push({
      reason: 'fixed-containing-block',
      detail: 'An ancestor establishes a containing block, so the panel needs a rebuilt ancestor chain.',
    })
  }

  if (crossesShadowBoundary(element)) {
    downgrades.push({
      reason: 'shadow-boundary',
      detail: 'The element sits below a shadow root, which a rebuilt chain cannot reproduce.',
    })
  }

  if (element.querySelector('iframe') !== null) {
    downgrades.push({
      reason: 'contains-iframe',
      detail: 'Contains an iframe, which will reload if the panel is moved to a separate window.',
    })
  }

  if (element.querySelector('video[src], audio[src], video source, audio source') !== null) {
    downgrades.push({
      reason: 'live-media',
      detail: 'Contains playing media, whose playback position resets in a separate window.',
    })
  }

  if (looksVirtualized(element)) {
    downgrades.push({
      reason: 'virtualized-row',
      detail: 'Looks like a virtualised list row, which relies on measurement and recycling.',
    })
  }

  return { canMove: downgrades.length === 0, downgrades }
}

/**
 * Whether the ancestry crosses a shadow root.
 * @param element - the element to inspect.
 * @returns whether a shadow boundary sits above the element.
 */
function crossesShadowBoundary(element: Element): boolean {
  let root: Node | null = element.getRootNode()
  while (root instanceof ShadowRoot) {
    root = root.host.getRootNode()
    return true
  }
  return false
}

/**
 * Heuristic for a virtualised list row.
 *
 * A transformed element inside a scroll container whose siblings share the same
 * class and differ only in `transform` is the signature of a windowing
 * library. Such a row cannot be relocated meaningfully, because its position is
 * recomputed from scroll offset on every frame.
 * @param element - the element to inspect.
 * @returns whether it looks virtualised.
 */
function looksVirtualized(element: Element): boolean {
  const parent = element.parentElement
  if (parent === null) return false
  const siblings = parent.children
  if (siblings.length < 3) return false
  const own = getComputedStyle(element)
  if (own.transform === 'none' && own.position !== 'absolute') return false
  const scrollParent = parent.closest('[style*="overflow"]')
  if (scrollParent === null) return false
  let shared = 0
  for (const sibling of siblings) {
    if (sibling !== element && sibling.tagName === element.tagName
      && sibling.className === element.className) shared += 1
  }
  return shared >= 2
}
