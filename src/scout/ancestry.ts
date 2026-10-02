/**
 * Reading order for the ancestor walk and the fixed-containing-block check.
 *
 * Both are pure functions over `getComputedStyle` output so they can be tested
 * against a stub without a browser, and reused identically by the picker
 * (stepping out to the parent) and the CSS planner (deciding how deep the
 * float container may be inserted).
 */

/**
 * Properties whose non-default value makes an element a containing block for
 * `position: fixed` descendants. A non-`none` value is the escape blocker: the
 * float container can no longer use `position: fixed` to jump to screen
 * coordinates while it sits below such an ancestor.
 */
export const FIXED_CONTAINING_BLOCK_PROPERTIES = [
  'transform',
  'filter',
  'backdropFilter',
  'perspective',
  'contain',
  'willChange',
] as const

/** Values that mean "this property is not doing anything". */
const INERT_VALUES = new Set(['none', 'normal', 'auto', '', 'visible'])

/**
 * Decide whether one computed style blocks `position: fixed` escaping.
 * @param value - the computed value of one containing-block property.
 * @returns whether the value establishes a containing block.
 */
export function valueBlocksFixed(value: string): boolean {
  const normalized = value.trim().toLowerCase()
  if (INERT_VALUES.has(normalized)) return false
  // `contain: paint` / `contain: layout` / `contain: strict` / `contain: content`
  // all establish containment. Only `contain: none` is inert, already handled.
  return true
}

/** The minimal style surface the planner needs, so tests can stub it. */
export interface StyleProbe {
  /** Computed value for one CSS property name, or '' when absent. */
  value(property: string): string
}

/**
 * Decide whether an element blocks a fixed-position descendant from escaping.
 * @param probe - computed-style accessor for the element.
 * @returns whether the element is a containing block for fixed positioning.
 */
export function blocksFixed(probe: StyleProbe): boolean {
  return FIXED_CONTAINING_BLOCK_PROPERTIES.some(
    (property) => valueBlocksFixed(probe.value(property)),
  )
}

/**
 * Whether placing the panel below this ancestor can make it unreachable.
 *
 * The skeleton path keeps the frame at the document root when fixed positioning
 * cannot escape. Pointer hit testing is handled independently by the panel's
 * explicit `pointer-events:auto`, because moving the live content into a
 * skeleton just to work around inherited pointer styling loses its cascade.
 */
export function blocksFloatInteraction(probe: StyleProbe): boolean {
  // `pointer-events` is inherited, but an explicitly interactive descendant
  // can opt back in. The panel does that in its own stylesheet, so moving the
  // content into a skeleton for this case would lose more styling than it
  // fixes. Keep this helper focused on boundaries fixed positioning cannot
  // escape.
  if (blocksFixed(probe)) return true
  return false
}

/**
 * Decide whether `contain` specifically establishes containment.
 * Split out because `contain: none` is inert while every other keyword is not,
 * and the generic check above would treat the whole value as opaque.
 * @param value - the computed `contain` value.
 * @returns whether containment is active.
 */
export function containIsActive(value: string): boolean {
  const normalized = value.trim().toLowerCase()
  return normalized !== '' && normalized !== 'none'
}

/**
 * Does this computed style establish a container-query container?
 *
 * `container-type` is ignored on elements that generate no layout box, which is
 * why a `display: contents` skeleton cannot stand in for a real container. The
 * caller uses this to decide whether that ancestor needs a real box.
 * @param probe - computed-style accessor for the element.
 * @returns whether the element is a query container.
 */
export function isQueryContainer(probe: StyleProbe): boolean {
  const type = probe.value('containerType').trim().toLowerCase()
  return type !== '' && type !== 'normal'
}

/** Whether an element generates a layout box at all. */
export function generatesBox(probe: StyleProbe): boolean {
  const display = probe.value('display').trim().toLowerCase()
  return display !== 'contents' && display !== 'none'
}
