/**
 * Bringing the tiers together: from a picked element to a live panel.
 *
 * Each tier is useful on its own, but the decision of *which* one to use is
 * where the quality of this feature actually lives. Doing it once, in one
 * place, means the choice is testable and the user-visible consequences are
 * computed up front rather than discovered after the page has changed.
 *
 * ## The order, and why
 *
 * 1. **Live move, in place.** Highest fidelity and often no work at all,
 *    because the in-place escape keeps the real ancestor chain. Try this first,
 *    always.
 * 2. **Live move, skeleton.** The escape was blocked, so rebuild the missing
 *    ancestors. Still a live move, so the node keeps its identity and React
 *    keeps updating it.
 * 3. **Clone.** Only for a popout, where a live move across documents would
 *    degrade anyway, or when the caller explicitly wants a snapshot.
 * 4. **Bitmap.** For subtrees where nothing else can work.
 *
 * The prognosis computed during capture decides how far down that list the
 * caller needs to go, and its reasons are handed back so the UI can explain
 * what the user is about to lose.
 */
import { buildSkeleton, mirrorAncestorState, restoreSiblingIndex } from './css-skeleton.ts'
import { findInsertionPoint, placeInPlace, type StyleReader } from './css-inplace.ts'
import { createPlaceholder, installStructuralStandIn, watchStandIn } from './stand-in.ts'
import { capture, moveNode, supportsMoveBefore } from './tier0-live.ts'
import { cloneElement, freezeRect, mirrorStyleSheets } from './tier2-clone.ts'
import { attachReflection, REFLECTED_EVENTS } from './events-reflect.ts'
import type { CaptureTarget, CssStrategy, Downgrade, Rect, SizingMode, Tier } from '../shared/types.ts'

/** A panel that has been extracted and can be put back. */
export interface Extraction {
  /** The node now living in the panel. */
  readonly node: Element
  /** Which tier produced it. */
  readonly tier: Tier
  /** Which CSS strategy kept it looking right. */
  readonly strategy: CssStrategy
  /** How the size was decided. */
  readonly sizing: SizingMode
  /** Anything the user should be told about. */
  readonly warnings: readonly Downgrade[]
  /**
   * Put the page back the way it was. Must be called before the panel closes,
   * and is idempotent.
   */
  readonly restore: () => void
}

export interface ExtractOptions {
  /** The element to extract. */
  readonly element: Element
  /** The container the panel will render into. */
  readonly container: HTMLElement
  /**
   * Where the panel is going. A popout cannot use the state-preserving move, so
   * this decides whether a clone is used instead of a live node.
   */
  readonly destination: 'float' | 'popout'
  /** Force a tier, bypassing the automatic choice. Used by the tier picker UI. */
  readonly forceTier?: Tier
  /** Style reader injection point, for tests. */
  readonly readStyle?: StyleReader
  /** Called when the host removes the structural stand-in while the panel is open. */
  readonly onHostRemoved?: () => void
  /** Optional panel frame that should move with the content in the in-place path. */
  readonly frame?: HTMLElement
}

/**
 * Extract an element into a container.
 * @param options - the element, the destination container, and any overrides.
 * @returns the extraction, including how to undo it.
 */
export function extract(options: ExtractOptions): Extraction {
  const { element, container, destination } = options
  const target: CaptureTarget = capture(element)

  if (options.forceTier === 'bitmap') {
    return { node: element, tier: 'bitmap', strategy: 'skeleton', sizing: 'frozen', warnings: target.prognosis.downgrades, restore: () => {} }
  }

  if (destination === 'popout' || options.forceTier === 'clone') {
    return extractClone(target, container, options)
  }

  return extractLive(target, container, options)
}

/**
 * Extract by moving the real node.
 * @param target - the captured element and its analysis.
 * @param container - the panel container.
 * @param options - the original options, for the style reader.
 * @returns the extraction.
 */
function extractLive(target: CaptureTarget, container: HTMLElement, options: ExtractOptions): Extraction {
  const { element } = target
  const readStyle = options.readStyle
  const plan = readStyle === undefined ? findInsertionPoint(element) : findInsertionPoint(element, readStyle)

  const warnings: Downgrade[] = [...target.prognosis.downgrades]
  if (!supportsMoveBefore()) {
    warnings.push({
      reason: 'fixed-containing-block',
      detail: 'This engine lacks moveBefore, so animation, focus and iframe state will reset.',
    })
  }

  // The stand-in must be installed before the element leaves, so React never
  // observes a parent whose child has vanished.
  const parent = element.parentElement
  const placeholder = parent === null ? null : createPlaceholder()
  const detachGuard = parent !== null && placeholder !== null
    ? installStructuralStandIn(parent, element, placeholder)
    : () => {}
  const stopWatching = parent !== null && placeholder !== null
    ? watchStandIn(parent, placeholder, () => options.onHostRemoved?.())
    : () => {}

  let strategy: CssStrategy = 'in-place'
  let releaseMirrors: () => void = () => {}
  let stopReflection: () => void = () => {}

  if (plan.escapes) {
    // Ideal case: keep the element in its own parent and move the container
    // there too, so the real ancestor chain still applies to it.
    placeInPlace(container, plan.host, target.rect, options.frame)
    moveNode(element, container)
  } else {
    strategy = 'skeleton'
    const originalParent = parent
    // Build the replacement ancestry while the live node is still attached;
    // moving it directly into the deepest shell then needs only one move.
    const attach = buildSkeleton(container, target.ancestry)
    const moved = moveNode(element, attach)
    if (moved.degraded) {
      warnings.push({
        reason: 'fixed-containing-block',
        detail: 'The live node crossed documents, so focus, animation and iframe state were reset.',
      })
    }
    if (originalParent !== null) {
      const shells = Array.from(container.querySelectorAll<HTMLElement>('[data-dsh-float-shell]'))
      releaseMirrors = mirrorAncestorState([...ancestorChain(element, originalParent)], shells)
    }
    // The skeleton lives outside the app's React root. Reflect only events that
    // land in this panel so handlers in the rest of the document are untouched.
    stopReflection = attachReflection(container.ownerDocument, REFLECTED_EVENTS, container)
  }

  return {
    node: container,
    tier: 'live',
    strategy,
    sizing: 'fluid',
    warnings,
    restore: (): void => {
      releaseMirrors()
      stopReflection()
      stopWatching()
      // The guard must come off before the element returns, or React's own
      // operations stay hijacked and the placeholder lingers.
      detachGuard()
      // A normal close restores the exact placeholder slot. If the host already
      // removed that slot, retain the node in the old parent as a recoverable
      // fallback rather than leaving the live subtree detached forever.
      if (parent !== null && element.parentNode !== parent) parent.appendChild(element)
    },
  }
}

/**
 * Extract by copying.
 * @param target - the captured element and its analysis.
 * @param container - the panel container.
 * @param options - the original options.
 * @returns the extraction.
 */
function extractClone(target: CaptureTarget, container: HTMLElement, options: ExtractOptions): Extraction {
  const document = container.ownerDocument
  const result = cloneElement(target.element, document)
  const warnings: Downgrade[] = [...target.prognosis.downgrades]
  if (result.losses.some((loss) => loss.reason === 'canvas-bitmap')) {
    warnings.push({ reason: 'live-media', detail: 'A canvas in this element will be blank.' })
  }

  container.appendChild(result.root)
  if (options.forceTier === 'clone') freezeRect(result.root as HTMLElement, target.rect)

  return {
    node: container,
    tier: 'clone',
    strategy: 'skeleton',
    sizing: options.forceTier === 'clone' ? 'frozen' : 'fluid',
    warnings,
    restore: (): void => {
      result.root.remove()
    },
  }
}

/**
 * Walk the live ancestors from an element up to (but excluding) a stop point.
 * @param element - the element to start from.
 * @param stopAt - the ancestor to stop at.
 * @returns the ancestors, outermost first.
 */
function ancestorChain(element: Element, stopAt: Element): readonly Element[] {
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
 * Prepare a popout document so a cloned panel looks right inside it.
 * @param source - the document the element came from.
 * @param target - the popout document.
 * @param baseHref - absolute URL for repairing relative stylesheet hrefs.
 */
export function preparePopoutDocument(source: Document, target: Document, baseHref: string): void {
  mirrorStyleSheets(source, target, baseHref)
}

/**
 * Whether the extraction cost is low enough to be instant.
 * @param element - the element to estimate.
 * @returns whether the subtree is small enough for an immediate live move.
 */
export function isCheapToMove(element: Element): boolean {
  // A live move copies nothing, so the only real cost is the stand-in
  // bookkeeping. Anything under a few thousand nodes is instantaneous.
  return element.querySelectorAll('*').length < 3000
}

export { restoreSiblingIndex }
