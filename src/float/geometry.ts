/**
 * Panel geometry as pure functions.
 *
 * Kept free of the DOM so the clamping rules can be tested directly. Every
 * rule here exists because of a specific way a floating panel becomes unusable:
 * dragged past an edge, shrunk to nothing, or left off-screen after a window
 * resize.
 */
import type { Rect } from '../shared/types.ts'

export interface Size {
  readonly width: number
  readonly height: number
}

export interface Delta {
  readonly dx: number
  readonly dy: number
}

/** Smallest a panel may be resized to, in CSS pixels. */
export const MIN_PANEL_SIZE: Size = { width: 180, height: 110 }

/** How much of a panel must stay on screen, so it can always be grabbed again. */
export const MIN_VISIBLE = 60

/**
 * Keep a panel reachable.
 *
 * A panel is never fully pushed off an edge. At least `MIN_VISIBLE` pixels of
 * each axis stay inside the viewport, which is what guarantees the title bar
 * remains draggable no matter where the user flung it.
 * @param rect - the desired rect.
 * @param viewport - the current viewport size.
 * @returns a rect that is always grabbable.
 */
export function clampToViewport(rect: Rect, viewport: Size): Rect {
  const maxX = viewport.width - MIN_VISIBLE
  const maxY = viewport.height - MIN_VISIBLE
  const x = Math.min(Math.max(rect.x, MIN_VISIBLE - rect.width), maxX)
  const y = Math.min(Math.max(rect.y, 0), maxY)
  const width = Math.max(MIN_PANEL_SIZE.width, Math.min(rect.width, viewport.width))
  const height = Math.max(MIN_PANEL_SIZE.height, Math.min(rect.height, viewport.height))
  return { x, y, width, height }
}

/**
 * Move a rect by a pointer delta.
 * @param rect - the current rect.
 * @param delta - the movement since the gesture began.
 * @returns the translated rect.
 */
export function translate(rect: Rect, delta: Delta): Rect {
  return { x: rect.x + delta.dx, y: rect.y + delta.dy, width: rect.width, height: rect.height }
}

/**
 * Resize from the bottom-right corner.
 * @param rect - the current rect.
 * @param delta - the movement since the gesture began.
 * @param minimum - the smallest allowed size.
 * @param viewport - the current viewport size, to cap runaway growth.
 * @returns the resized rect.
 */
export function resizeFrom(rect: Rect, delta: Delta, minimum: Size, viewport: Size): Rect {
  const width = Math.max(minimum.width, Math.min(rect.width + delta.dx, viewport.width))
  const height = Math.max(minimum.height, Math.min(rect.height + delta.dy, viewport.height))
  return { x: rect.x, y: rect.y, width, height }
}

/**
 * Choose a sensible starting rect for a panel showing a captured element.
 *
 * Reuses the element's own size when it is reasonable, because a panel that
 * opens at the size the content had is far less jarring than one that opens at
 * an arbitrary default. Oversized and tiny elements are clamped, and the panel
 * is offset from the source so the user can see both and understand what
 * happened.
 * @param source - the captured element's rect.
 * @param viewport - the current viewport size.
 * @returns the panel's initial rect.
 */
export function initialPanelRect(source: Rect, viewport: Size): Rect {
  const width = Math.min(Math.max(source.width + 2, MIN_PANEL_SIZE.width), viewport.width * 0.9)
  const height = Math.min(Math.max(source.height + 34, MIN_PANEL_SIZE.height), viewport.height * 0.9)
  // Prefer the source's own position, nudged so the panel does not sit exactly
  // on top of the gap it left behind in the page.
  const x = source.x + 16
  const y = source.y + 16
  return clampToViewport({ x, y, width, height }, viewport)
}

/**
 * Whether a point is inside a rect.
 * @param point - the point to test.
 * @param rect - the rect to test against.
 * @returns whether the point is inside.
 */
export function containsPoint(point: { readonly x: number; readonly y: number }, rect: Rect): boolean {
  return point.x >= rect.x && point.x <= rect.x + rect.width
    && point.y >= rect.y && point.y <= rect.y + rect.height
}

/**
 * Shrink a rect to fit inside a container, preserving aspect ratio.
 * @param rect - the rect to fit.
 * @param container - the available size.
 * @returns the fitted size.
 */
export function fitInside(rect: Size, container: Size): Size {
  if (rect.width <= container.width && rect.height <= container.height) return rect
  const scale = Math.min(container.width / rect.width, container.height / rect.height)
  return { width: Math.floor(rect.width * scale), height: Math.floor(rect.height * scale) }
}
