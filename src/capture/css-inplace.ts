/**
 * The in-place escape: the CSS strategy that copies nothing.
 *
 * ## The idea
 *
 * Everything the extracted element depends on for styling — inherited
 * properties, descendant and sibling selectors, `:has()`, container queries,
 * theme variables, state classes — is a function of its ancestor chain. So
 * instead of rebuilding those ancestors somewhere else, put the float container
 * **inside X's own parent** and move it to screen coordinates with
 * `position: fixed`.
 *
 * The ancestor chain is untouched, so every one of those mechanisms keeps
 * working natively. No computed snapshot, no inline overrides, no skeleton.
 * This is strictly the cheapest path and the one to try first.
 *
 * ## The one hard limit
 *
 * `position: fixed` resolves against the nearest ancestor that establishes a
 * containing block — any ancestor with a non-`none` `transform`, `filter`,
 * `backdrop-filter`, `perspective`, or active `contain`. If one sits between
 * the parent and the root, the container cannot jump to screen coordinates.
 * That is what `findInsertionPoint` reports, and why the skeleton path exists
 * as the fallback.
 *
 * ## The accepted trade-off
 *
 * The container is now a child of P, so it unmounts when P does. Callers pair
 * this with `watchStandIn` on the placeholder to notice and close cleanly.
 */
import {
  blocksFixed, blocksFloatInteraction, containIsActive, generatesBox, type StyleProbe,
} from '../scout/ancestry.ts'
import type { AncestorSnapshot } from '../shared/types.ts'

/** A computed-style reader the caller supplies, so this stays DOM-agnostic. */
export type StyleReader = (element: Element) => StyleProbe

/**
 * Read a live style probe for an element from the real document.
 * @param element - the element to inspect.
 * @returns a probe backed by `getComputedStyle`.
 */
export function liveStyleReader(element: Element): StyleProbe {
  const style = getComputedStyle(element)
  return { value: (property) => style.getPropertyValue(kebab(property)) }
}

/**
 * Convert a camelCase property name to the kebab-case `getComputedStyle` wants.
 * @param property - camelCase or already-kebab property name.
 * @returns the kebab-case form.
 */
export function kebab(property: string): string {
  return property.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)
}

export interface InsertionPlan {
  /** Where the float container is going. */
  readonly host: Element
  /**
   * Ancestors from just below `host` down to X's parent, in that order. These
   * are the ones a skeleton must rebuild when the host is not the real parent.
   * Empty when the escape is fully in place.
   */
  readonly missing: readonly AncestorSnapshot[]
  /** Whether `position: fixed` will actually reach screen coordinates. */
  readonly escapes: boolean
}

/**
 * Find the deepest ancestor the float container can live in and still escape.
 *
 * Walks up from X's parent collecting the ancestors that must be rebuilt, and
 * stops at the first one that would trap a fixed-position descendant. If the
 * walk reaches the root, the chain is fully escaped and `missing` is empty —
 * the ideal case, where the skeleton has zero work.
 * @param x - the element being extracted.
 * @param readStyle - computed-style accessor, injectable for tests.
 * @returns the insertion point and the ancestors that still need rebuilding.
 */
export function findInsertionPoint(x: Element, readStyle: StyleReader = liveStyleReader): InsertionPlan {
  const missing: AncestorSnapshot[] = []
  const parent = x.parentElement
  if (parent === null) {
    return { host: document.body, missing, escapes: false }
  }

  let node: Element | null = parent
  while (node !== null && node !== document.documentElement) {
    if (blocksFloatInteraction(readStyle(node))) {
      // This element traps fixed descendants, creates a lower stacking context,
      // or disables hit testing. Keep the live frame at document root and
      // rebuild everything between it and X's parent as skeleton work.
      return {
        host: node,
        missing: missing.reverse(),
        escapes: false,
      }
    }
    missing.push(snapshotAncestor(node, readStyle))
    node = node.parentElement
  }

  // Nothing blocked the escape: the container can sit directly in X's parent
  // with the real ancestor chain above it. Zero skeleton, zero style copying.
  return { host: parent, missing: [], escapes: true }
}

/**
 * Capture the minimum an ancestor needs for the skeleton to reproduce its
 * selector participation.
 *
 * `className` and `data-*` are copied because selectors match on them. `id` is
 * copied too — safe across documents, and required for `#app > .x` to match —
 * but the caller decides whether to keep it in the same document, where a
 * duplicate id would be a problem.
 * @param element - the real ancestor.
 * @param readStyle - computed-style accessor.
 * @returns a serialisable snapshot.
 */
export function snapshotAncestor(element: Element, readStyle: StyleReader): AncestorSnapshot {
  const data: Record<string, string> = {}
  for (const attribute of element.attributes) {
    if (attribute.name.startsWith('data-')) data[attribute.name] = attribute.value
  }
  const probe = readStyle(element)
  return {
    tagName: element.tagName.toLowerCase(),
    className: typeof element.className === 'string' ? element.className : '',
    id: element.id,
    dataAttributes: data,
    inlineStyle: element.getAttribute('style') ?? '',
    isContainer: isContainerQueryContainer(probe),
  }
}

/**
 * Whether an ancestor is a container-query container.
 *
 * ## Measured behaviour, not assumption
 *
 * Chromium **keeps the declared `container-type` in the computed style** even on
 * an element with `display: contents` — so reading the property back reports
 * `inline-size` while no `@container` rule ever resolves against that element.
 * The spike bench confirms this: an identical `@container` rule matches inside a
 * real box and does not match inside a contents shell.
 *
 * The practical consequence is a trap. Detecting the gap by comparing the
 * computed value against `normal` silently fails, because the value is never
 * `normal`. What can be trusted is the element's `display`: an element that
 * generates no box cannot be a query container, whatever it declares.
 *
 * So this returns true only for an element that both declares a container type
 * and generates a box. A `display: contents` shell is reported as not a
 * container, which is what routes it to the pinned-box repair.
 * @param probe - computed-style accessor for the element.
 * @returns whether the ancestor genuinely performs container queries.
 */
export function isContainerQueryContainer(probe: StyleProbe): boolean {
  const type = probe.value('containerType').trim().toLowerCase()
  if (type === '' || type === 'normal') return false
  return generatesBox(probe)
}

/**
 * Apply the in-place placement to a float container.
 *
 * Appends the container to the host and pins it to viewport coordinates. The
 * host is X's real parent in the escaped case, so every inherited property and
 * selector that reached X still reaches the container's subtree.
 * @param container - the float container element.
 * @param host - where `findInsertionPoint` said to put it.
 * @param rect - the target viewport rect.
 */
export function placeInPlace(
  container: HTMLElement,
  host: Element,
  rect: { x: number; y: number; width: number; height: number },
  frame: HTMLElement = container,
): void {
  // Move the panel frame, not just its content body. Keeping the title bar and
  // extracted node in one tree prevents the body from covering the chrome.
  host.appendChild(frame)
  const style = frame.style
  style.setProperty('position', 'fixed')
  style.setProperty('left', `${rect.x}px`)
  style.setProperty('top', `${rect.y}px`)
  style.setProperty('width', `${rect.width}px`)
  style.setProperty('height', `${rect.height}px`)
  style.setProperty('margin', '0')
  // The container must not be laid out as a flex/grid item of the host, or the
  // host's own layout would move it away from the coordinates we just pinned.
  style.setProperty('align-self', 'auto')
  style.setProperty('justify-self', 'auto')
  // Keep the frame's existing stacking order. The floating-panel owner assigns
  // a bounded z-index below the host's popup/modal layers; writing a near-
  // maximum value here would make those host surfaces render underneath it.
}

/**
 * Whether an element's own style would prevent it from being repositioned.
 * @param probe - computed-style accessor for the element.
 * @returns whether containment or a transform is active on the element itself.
 */
export function selfTraps(probe: StyleProbe): boolean {
  return blocksFixed(probe) || containIsActive(probe.value('contain'))
}
