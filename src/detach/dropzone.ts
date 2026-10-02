/**
 * The drag-out-to-detach gesture.
 *
 * ## The constraint that shapes this
 *
 * The plan's spike S0 asks whether `pointermove` keeps arriving once the cursor
 * leaves the window. It cannot, in the general case: the browser only reports
 * coordinates it can attribute to its own surface, so a gesture that exits the
 * window simply stops delivering. Any design that requires following the cursor
 * across the boundary is therefore built on sand.
 *
 * What this module does instead is *arm* the detach while the pointer is still
 * inside, in a band along each edge. The user sees the band light up and the
 * hint change to "release to open in a separate window", and the release lands
 * at a coordinate the renderer can actually observe. The exact screen position
 * of the new window is then computed from the release point plus the window's
 * screen offset, which the desktop shell resolves.
 *
 * ## The fallback, if S0 succeeds
 *
 * If a platform turns out to deliver out-of-window coordinates, `finalPoint`
 * already prefers them when present, so the same code gets exact placement for
 * free. There is no second path to maintain.
 */
import { edgeBand } from '../scout/hit.ts'
import type { Point, Rect } from '../shared/types.ts'

/** Which edge, when the pointer is in one. */
export type Edge = 'left' | 'right' | 'top' | 'bottom'

export interface DropzoneOptions {
  /** Called while the pointer is inside a band, and again with null on exit. */
  readonly onArmed: (edge: Edge | null) => void
  /** Called when the gesture completes inside a band. */
  readonly onDrop: (edge: Edge) => void
  /** Width of the arming band in CSS pixels. */
  readonly band?: number
  /** Whether the gesture is available at all. */
  readonly enabled?: boolean
}

/**
 * Track a detach gesture for the duration of a drag.
 *
 * Only listens while a drag is in progress, so it contributes nothing to the
 * app's steady-state pointer cost.
 * @param target - the document to observe.
 * @param options - callbacks and tuning.
 * @returns handles for feeding pointer positions and ending the gesture.
 */
export function createDropzone(target: Document, options: DropzoneOptions) {
  const band = options.band ?? 24
  const enabled = options.enabled ?? true
  let armed: Edge | null = null
  let active = false

  const viewport = (): { width: number; height: number } => ({
    width: target.defaultView?.innerWidth ?? window.innerWidth,
    height: target.defaultView?.innerHeight ?? window.innerHeight,
  })

  return {
    /** Begin listening for the gesture. */
    begin(): void {
      active = true
    },

    /**
     * Offer a pointer position to the gesture.
     *
     * Takes the raw coordinates and, when a trailing sentinel value is present,
     * prefers it — that is where an out-of-window coordinate would arrive if the
     * platform provides one.
     * @param inside - the last position observed inside the window.
     * @param finalPoint - a position observed outside the window, if any.
     * @returns the edge now armed, or null.
     */
    offer(inside: Point, finalPoint?: Point | null): Edge | null {
      if (!active || !enabled) return null
      const point = finalPoint ?? inside
      const next = edgeBand(point, viewport(), band)
      if (next !== armed) {
        armed = next
        options.onArmed(next)
      }
      return next
    },

    /** Whether an edge is currently armed. */
    armed: (): Edge | null => armed,

    /**
     * Complete the gesture.
     * @returns whether a detach was requested.
     */
    release(): boolean {
      const edge = armed
      active = false
      armed = null
      options.onArmed(null)
      if (edge === null || !enabled) return false
      options.onDrop(edge)
      return true
    },

    /** Abandon the gesture without detaching. */
    cancel(): void {
      active = false
      if (armed !== null) {
        armed = null
        options.onArmed(null)
      }
    },
  }
}

/**
 * Work out where a detached window should open.
 *
 * The renderer knows the release point only in viewport coordinates; the shell
 * needs screen coordinates. The window's own screen offset supplies the missing
 * term, so the new window lands under the cursor rather than at the screen
 * origin — which is what makes the gesture feel like the panel followed the
 * hand.
 * @param release - the release point in viewport coordinates.
 * @param rect - the dragged panel's rect, in viewport coordinates.
 * @param windowOrigin - the current window's top-left in screen coordinates.
 * @param edge - which edge was released against, used to bias the placement out.
 * @returns bounds in screen coordinates.
 */
export function detachBounds(
  release: Point,
  rect: Rect,
  windowOrigin: Point,
  edge: Edge,
): { x: number; y: number; width: number; height: number } {
  const width = Math.max(220, Math.round(rect.width))
  const height = Math.max(140, Math.round(rect.height))
  // Place the window's centre on the release point, then push it slightly past
  // the edge that was used, so it reads as having been thrown outwards.
  const offset = 40
  const bias = {
    left: { dx: -offset, dy: 0 },
    right: { dx: offset, dy: 0 },
    top: { dx: 0, dy: -offset },
    bottom: { dx: 0, dy: offset },
  }[edge]
  return {
    x: Math.round(windowOrigin.x + release.x - width / 2 + bias.dx),
    y: Math.round(windowOrigin.y + release.y - height / 2 + bias.dy),
    width,
    height,
  }
}

/**
 * The current window's screen position.
 *
 * `screenX`/`screenY` are the only viewport-to-screen mapping a renderer has,
 * and they are available without any shell involvement, so the placement maths
 * above works even before a detach backend is confirmed.
 * @returns the window origin in screen coordinates.
 */
export function windowOrigin(): Point {
  return { x: globalThis.screenX ?? 0, y: globalThis.screenY ?? 0 }
}
