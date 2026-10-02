/**
 * Turn a pointer gesture into deltas.
 *
 * Uses pointer capture so a fast drag that outruns the element still delivers
 * every move, and so the gesture survives the pointer passing over an iframe or
 * another element. Note that capture is *reinforcement*, not the mechanism: the
 * coordinate space is the element's own, and the caller does the actual
 * positioning.
 *
 * One consequence worth recording, because it shapes the whole drag-out feature:
 * capture guarantees delivery *while the pointer is inside the window*. It does
 * not make the engine report coordinates outside the window, so a gesture that
 * leaves the window simply stops. Callers must therefore decide what to do at
 * the boundary rather than plan on following the cursor out.
 */
import type { Delta } from './geometry.ts'

export interface DragOptions {
  /** Called when a primary-button drag starts. */
  readonly onStart?: () => void
  /** Called on every move, with the total movement since the gesture started. */
  readonly onMove: (delta: Delta) => void
  /** Called once when the gesture ends, with how it ended. */
  readonly onEnd?: (ended: { readonly delta: Delta; readonly cancelled: boolean }) => void
  /** Skip moves whose movement is below this distance, to avoid jitter. */
  readonly deadZone?: number
}

/**
 * Track a drag gesture on a handle element.
 *
 * The delta is always measured from the press position, not accumulated frame
 * by frame. Accumulating would let rounding drift, so a long drag would end up
 * offset from where the pointer actually is.
 * @param handle - the element the gesture starts on.
 * @param options - callbacks and thresholds.
 * @returns a function that detaches the listeners.
 */
export function beginDrag(handle: HTMLElement, options: DragOptions): () => void {
  const deadZone = options.deadZone ?? 0
  let origin: { x: number; y: number } | null = null
  let activeId: number | null = null
  let last: Delta = { dx: 0, dy: 0 }

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return
    // The title bar contains buttons; a drag starting on one of them is a
    // click, not a move.
    if (event.target instanceof HTMLButtonElement) return
    origin = { x: event.clientX, y: event.clientY }
    activeId = event.pointerId
    last = { dx: 0, dy: 0 }
    options.onStart?.()
    handle.setPointerCapture(event.pointerId)
    event.preventDefault()
  }

  const onPointerMove = (event: PointerEvent): void => {
    if (origin === null || event.pointerId !== activeId) return
    const delta: Delta = { dx: event.clientX - origin.x, dy: event.clientY - origin.y }
    if (Math.hypot(delta.dx, delta.dy) < deadZone) return
    last = delta
    options.onMove(delta)
  }

  const finish = (cancelled: boolean): void => {
    if (origin === null) return
    const id = activeId
    origin = null
    activeId = null
    if (id !== null && handle.hasPointerCapture(id)) handle.releasePointerCapture(id)
    options.onEnd?.({ delta: last, cancelled })
  }

  const onPointerUp = (event: PointerEvent): void => {
    if (event.pointerId !== activeId) return
    finish(false)
  }

  const onPointerCancel = (event: PointerEvent): void => {
    if (event.pointerId !== activeId) return
    finish(true)
  }

  handle.addEventListener('pointerdown', onPointerDown)
  handle.addEventListener('pointermove', onPointerMove)
  handle.addEventListener('pointerup', onPointerUp)
  handle.addEventListener('pointercancel', onPointerCancel)

  return () => {
    handle.removeEventListener('pointerdown', onPointerDown)
    handle.removeEventListener('pointermove', onPointerMove)
    handle.removeEventListener('pointerup', onPointerUp)
    handle.removeEventListener('pointercancel', onPointerCancel)
  }
}

/**
 * Track a press that may become either a click or a drag.
 *
 * Needed wherever the same gesture has two outcomes — picking an element versus
 * tearing it out — so the caller can wait for the threshold before committing
 * to the destructive one.
 * @param handle - the element the gesture starts on.
 * @param threshold - movement in CSS pixels before the gesture is a drag.
 * @returns an object exposing the current mode and a detach function.
 */
export function beginPress(
  handle: HTMLElement,
  threshold: number,
): { mode: () => 'idle' | 'pressed' | 'dragging'; stop: () => void } {
  let mode: 'idle' | 'pressed' | 'dragging' = 'idle'
  let origin: { x: number; y: number } | null = null

  const onDown = (event: PointerEvent): void => {
    if (event.button !== 0) return
    origin = { x: event.clientX, y: event.clientY }
    mode = 'pressed'
    handle.setPointerCapture(event.pointerId)
  }

  const onMove = (event: PointerEvent): void => {
    if (origin === null) return
    if (Math.hypot(event.clientX - origin.x, event.clientY - origin.y) >= threshold) {
      mode = 'dragging'
    }
  }

  const reset = (): void => {
    origin = null
    mode = 'idle'
  }

  handle.addEventListener('pointerdown', onDown)
  handle.addEventListener('pointermove', onMove)
  handle.addEventListener('pointerup', reset)
  handle.addEventListener('pointercancel', reset)

  return {
    mode: () => mode,
    stop: () => {
      handle.removeEventListener('pointerdown', onDown)
      handle.removeEventListener('pointermove', onMove)
      handle.removeEventListener('pointerup', reset)
      handle.removeEventListener('pointercancel', reset)
    },
  }
}

/**
 * Coalesce per-frame callbacks.
 *
 * Continuous gestures produce far more events than the display can show, and
 * writing layout on each one forces a synchronous reflow per event. Collapsing
 * to one write per frame is the difference between smooth and janky.
 * @param run - the work to perform at most once per frame.
 * @returns a schedule function and a cancel function.
 */
export function perFrame(run: () => void): { schedule: () => void; cancel: () => void } {
  let handle: number | null = null
  return {
    schedule: () => {
      if (handle !== null) return
      handle = requestAnimationFrame(() => {
        handle = null
        run()
      })
    },
    cancel: () => {
      if (handle === null) return
      cancelAnimationFrame(handle)
      handle = null
    },
  }
}
