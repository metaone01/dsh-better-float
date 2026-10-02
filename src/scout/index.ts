/**
 * Pick mode: the session between pressing the shortcut and releasing the drag.
 *
 * A single stateful object rather than scattered listeners, because the pieces
 * are genuinely coupled — the pointer position decides the hit target, the
 * arrow keys replace the hit target with an ancestor or descendant, and the
 * drag decides whether the result is a click or an extraction.
 *
 * ## Two decisions worth recording
 *
 * **The escape key cancels, and so does anything that looks like the user
 * changed their mind** (a right-click, a window blur, pressing the shortcut
 * again). A modal mode that traps input with no obvious way out is worse than
 * no mode at all.
 *
 * **A drag only counts after a threshold.** The same gesture starts both "pick
 * this element" and "tear this element out", so without a threshold a one-pixel
 * twitch during a click would rip a panel out of the page.
 */
import {
  edgeBand, hitTest, hoveredElement, passedDragThreshold, pointInRoot, rectChanged, rectOf, stepIn,
  stepOut,
} from './hit.ts'
import {
  armEdge, clearHighlight, createOverlay, describe, describeElement, hideGhost, highlight,
  setHint, showGhost, type OverlayHandles,
} from './overlay.ts'
import type { Point, Rect } from '../shared/types.ts'

/** Why a pick session ended. */
export type PickOutcome =
  | { readonly type: 'cancelled' }
  | { readonly type: 'extract'; readonly element: Element; readonly rect: Rect; readonly detach: boolean }

/** How the session ended, decided at release time. */
export interface PickSession {
  /** The element currently highlighted, or null when the pointer is over nothing. */
  readonly current: () => Element | null
  /** Tear the session down. Safe to call more than once. */
  readonly cancel: () => void
}

export interface PickOptions {
  /** Called when the user completes a gesture. */
  readonly onDone: (outcome: PickOutcome) => void
  /** Whether releasing on an armed edge should detach to a window. */
  readonly detachEnabled: boolean
  /** Distance in CSS pixels before a press becomes a drag. */
  readonly dragThreshold?: number
  /** Width of the edge band that arms detaching. */
  readonly edgeBand?: number
  /** Floating surfaces that must never become extraction targets. */
  readonly blockedRoots?: readonly Element[]
}

/** Label shown in the hint bar, before the user starts dragging. */
const HINT_IDLE = 'Click to keep the element · Drag to pull it out · ↑↓ to widen · Esc to cancel'
const HINT_DRAG = 'Release to pull the element out'
const HINT_DETACH = 'Release to open in a separate window'

/**
 * Start a pick session.
 *
 * Listeners are attached to `window` in the capture phase so the app cannot
 * swallow the picker's own keys, and on `document` for the pointer so hit
 * testing works over any element. Nothing is attached to the target subtree, so
 * the app's own handlers keep running normally underneath.
 * @param owner - the document to pick within.
 * @param options - callbacks and thresholds.
 * @returns handles for querying and cancelling the session.
 */
export function startPick(owner: Document, options: PickOptions): PickSession {
  const blockedRoots = options.blockedRoots ?? []
  // Capture this before mounting the pointer-owning overlay.  Once the root is
  // present, it becomes the hovered element and hides the page's prior hover
  // chain from CSS matching.
  const initialHover = hoveredElement(owner, blockedRoots)
  const overlay: OverlayHandles = createOverlay(owner)
  const view = owner.defaultView ?? window
  const threshold = options.dragThreshold ?? 4
  const band = options.edgeBand ?? 24

  let current: Element | null = null
  let currentRect: Rect | null = null
  /** The element last found directly under the pointer. */
  let pointerTarget: Element | null = null
  /** Positive values walk to ancestors; negative values walk to descendants. */
  let levelOffset = 0
  let pointer: Point = { x: 0, y: 0 }
  let pressedAt: Point | null = null
  let activePointerId: number | null = null
  let dragging = false
  let armedEdge: 'left' | 'right' | 'top' | 'bottom' | null = null
  let finished = false

  setHint(overlay, HINT_IDLE)

  /**
   * Adopt a new target and repaint if anything moved.
   * @param next - the element to highlight, or null for nothing.
   */
  const paint = (next: Element | null): void => {
    if (next === current && next !== null && currentRect !== null) {
      const nextRect = rectOf(next)
      if (!rectChanged(currentRect, nextRect)) return
      currentRect = nextRect
      highlight(overlay, nextRect)
      describe(overlay, nextRect, describeElement(next, Math.max(0, levelOffset)))
      return
    }
    current = next
    if (next === null) {
      currentRect = null
      clearHighlight(overlay)
      return
    }
    currentRect = rectOf(next)
    highlight(overlay, currentRect)
    describe(overlay, currentRect, describeElement(next, Math.max(0, levelOffset)))
  }

  const applyOffset = (base: Element | null): Element | null => {
    if (base === null) return null
    let next = base
    if (levelOffset > 0) {
      for (let index = 0; index < levelOffset; index += 1) {
        const parent = stepOut(next)
        if (parent === null) break
        next = parent
      }
    } else {
      for (let index = 0; index > levelOffset; index -= 1) {
        const child = stepIn(next, pointer, overlay.exclusions, owner)
        if (child === null) break
        next = child
      }
    }
    return next
  }

  const rawHit = (): Element | null => pointInRoot(pointer.x, pointer.y, blockedRoots)
    ? null
    : hitTest(pointer.x, pointer.y, overlay.exclusions, owner)

  /** Re-sample only after the pointer leaves the currently highlighted range. */
  const retarget = (force = false): void => {
    if (pointInRoot(pointer.x, pointer.y, blockedRoots)) {
      pointerTarget = null
      paint(null)
      return
    }
    if (!force && currentRect !== null
      && pointer.x >= currentRect.x && pointer.x <= currentRect.x + currentRect.width
      && pointer.y >= currentRect.y && pointer.y <= currentRect.y + currentRect.height) return
    pointerTarget = rawHit()
    paint(applyOffset(pointerTarget))
  }

  /**
   * Step the selection along the ancestor chain.
   * @param direction - -1 toward the root, 1 toward a child.
   */
  const step = (direction: -1 | 1): void => {
    const base = pointerTarget ?? current
    if (base === null) return
    const previousOffset = levelOffset
    levelOffset += direction === -1 ? 1 : -1
    const next = applyOffset(base)
    if (next === null) {
      levelOffset = previousOffset
      return
    }
    paint(next)
    // Keep the real pointer position so repeated down steps walk the same
    // branch under the cursor instead of jumping to an arbitrary div.
  }

  const onPointerMove = (event: PointerEvent): void => {
    pointer = { x: event.clientX, y: event.clientY }
    if (pressedAt !== null) {
      if (!dragging && passedDragThreshold(pressedAt, pointer, threshold)) {
        dragging = true
        if (currentRect !== null) showGhost(overlay, currentRect)
      }
      if (dragging && currentRect !== null) {
        // The ghost follows the pointer so the gesture reads as carrying the
        // element, even though the element itself has not moved yet.
        showGhost(overlay, {
          x: pointer.x - currentRect.width / 2,
          y: pointer.y - currentRect.height / 2,
          width: currentRect.width,
          height: currentRect.height,
        })
        armedEdge = edgeBand(pointer, { width: view.innerWidth, height: view.innerHeight }, band)
        armEdge(overlay, armedEdge, { width: view.innerWidth, height: view.innerHeight })
        setHint(overlay, options.detachEnabled && armedEdge !== null ? HINT_DETACH : HINT_DRAG)
      }
      return
    }
    retarget()
  }

  const onPointerOver = (event: PointerEvent): void => {
    if (pressedAt !== null) return
    pointer = { x: event.clientX, y: event.clientY }
    retarget()
  }

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) {
      // Any non-primary button means the user expected a context menu, not a
      // pick. Ending the session respects that.
      finish({ type: 'cancelled' })
      return
    }
    pressedAt = { x: event.clientX, y: event.clientY }
    activePointerId = event.pointerId
    pointer = pressedAt
    try {
      overlay.root.setPointerCapture(event.pointerId)
    } catch {
      // The document-level listener remains the fallback in embedded modes.
    }
    // Arrow/wheel stepping deliberately changes the selected ancestor while
    // the pointer stays inside its rectangle.  Re-hit-testing here would throw
    // that choice away and extract the element directly under the cursor
    // instead.  Pointer movement already retargets when it leaves the current
    // rectangle, so a click can keep the visible selection authoritative.
    if (current === null) retarget(true)
  }

  const onPointerUp = (event: PointerEvent): void => {
    if (pressedAt === null) return
    const released: Point = { x: event.clientX, y: event.clientY }
    const edge = edgeBand(released, { width: view.innerWidth, height: view.innerHeight }, band)
    const detach = dragging && options.detachEnabled && edge !== null
    if (current !== null) {
      finish({ type: 'extract', element: current, rect: rectOf(current), detach })
      return
    }
    finish({ type: 'cancelled' })
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      finish({ type: 'cancelled' })
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      event.stopPropagation()
      step(-1)
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      event.stopPropagation()
      step(1)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      if (current !== null) finish({ type: 'extract', element: current, rect: rectOf(current), detach: false })
    }
  }

  const onWheel = (event: WheelEvent): void => {
    event.preventDefault()
    step(event.deltaY < 0 ? -1 : 1)
  }

  const onBlur = (): void => {
    finish({ type: 'cancelled' })
  }

  const onContextMenu = (event: MouseEvent): void => {
    event.preventDefault()
    finish({ type: 'cancelled' })
  }

  /**
   * Tear down and report exactly once.
   * @param outcome - how the session ended.
   */
  function finish(outcome: PickOutcome): void {
    if (finished) return
    finished = true
    if (activePointerId !== null) {
      try {
        overlay.root.releasePointerCapture(activePointerId)
      } catch {
        // The pointer may already have been released by the host.
      }
    }
    owner.removeEventListener('pointermove', onPointerMove, true)
    owner.removeEventListener('pointerover', onPointerOver, true)
    owner.removeEventListener('pointerdown', onPointerDown, true)
    owner.removeEventListener('pointerup', onPointerUp, true)
    owner.removeEventListener('wheel', onWheel, { capture: true })
    owner.removeEventListener('contextmenu', onContextMenu, true)
    view.removeEventListener('keydown', onKeyDown, true)
    view.removeEventListener('blur', onBlur)
    overlay.destroy()
    options.onDone(outcome)
  }

  owner.addEventListener('pointermove', onPointerMove, true)
  owner.addEventListener('pointerover', onPointerOver, true)
  owner.addEventListener('pointerdown', onPointerDown, true)
  owner.addEventListener('pointerup', onPointerUp, true)
  owner.addEventListener('wheel', onWheel, { capture: true, passive: false })
  owner.addEventListener('contextmenu', onContextMenu, true)
  view.addEventListener('keydown', onKeyDown, true)
  view.addEventListener('blur', onBlur)

  // Seed from wherever the cursor already is, so the user does not have to
  // press the mouse or move it before seeing a highlight.  There is no pointer
  // coordinate on a keyboard event, hence the pre-mount `:hover` snapshot.
  if (initialHover !== null) {
    pointerTarget = initialHover
    paint(initialHover)
  } else {
    // The shortcut has no pointer coordinates.  Leave the mask without a
    // selection until the first real pointer event instead of guessing `(0, 0)`
    // and accidentally choosing the page canvas.
    paint(null)
  }

  return {
    current: () => current,
    cancel: () => finish({ type: 'cancelled' }),
  }
}

/**
 * Repaint the overlay when the layout moves under a stationary pointer.
 *
 * Scrolling and resizing change what is under the cursor without any pointer
 * event firing, so the highlight would otherwise point at stale coordinates.
 * @param handles - the overlay handles.
 * @param target - the element to keep highlighted.
 */
export function keepHighlightPinned(handles: OverlayHandles, target: Element): () => void {
  const follow = (): void => {
    const rect = rectOf(target)
    highlight(handles, rect)
    describe(handles, rect, describeElement(target, 0))
  }
  window.addEventListener('scroll', follow, { capture: true, passive: true })
  window.addEventListener('resize', follow, { passive: true })
  return () => {
    window.removeEventListener('scroll', follow, true)
    window.removeEventListener('resize', follow)
  }
}

/**
 * Whether the highlight actually needs repainting.
 *
 * Exposed for the controller loop, which polls on animation frames rather than
 * reacting to a scroll event, because a scroll can also be driven by the app
 * rather than by the user.
 * @param previous - the last painted rect.
 * @param next - the rect measured now.
 * @returns whether a repaint is warranted.
 */
export function needsRepaint(previous: Rect | null, next: Rect): boolean {
  return rectChanged(previous, next)
}
