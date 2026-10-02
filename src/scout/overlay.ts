/**
 * The picker overlay.
 *
 * One fixed-position element per document, mounted only while picking. It
 * carries the highlight box, the label, the drag ghost, and the dimming mask.
 * The root captures pointer input so clicks and wheel events cannot reach the
 * page. Hit-testing temporarily disables that root while sampling the page
 * below it.
 *
 * The highlight is drawn with an inset box-shadow on an outline-style ring
 * rather than by touching the target's own `outline`. Writing to the target's
 * style would pollute the very subtree that is about to be captured, and the
 * pollution would be inherited by every descendant.
 */
import type { Rect } from '../shared/types.ts'

/** Class prefix so host styles cannot collide with ours. */
const PREFIX = 'dsh-bf'

const STYLE_TEXT = `
.${PREFIX}-root {
  position: fixed;
  inset: 0;
  width: 100vw;
  height: 100vh;
  z-index: 2147483600;
  pointer-events: auto !important;
  isolation: isolate;
  cursor: crosshair;
}
.${PREFIX}-dim {
  position: fixed !important;
  display: block !important;
  z-index: 0 !important;
  pointer-events: none !important;
  background: rgba(8, 12, 20, 0.52) !important;
}
.${PREFIX}-box {
  position: absolute;
  z-index: 1;
  pointer-events: none;
  border-radius: 3px;
  box-shadow:
    0 0 0 1px rgba(120, 170, 255, 0.95),
    0 0 0 9999px rgba(8, 12, 20, 0.34);
  transition: none;
}
.${PREFIX}-label {
  position: absolute;
  z-index: 2;
  pointer-events: none;
  max-width: 60ch;
  padding: 3px 7px;
  border-radius: 4px;
  font: 500 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
  color: #eaf1ff;
  background: rgba(24, 34, 56, 0.96);
  border: 1px solid rgba(120, 170, 255, 0.55);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.${PREFIX}-hint {
  position: absolute;
  z-index: 2;
  left: 50%;
  bottom: 28px;
  transform: translateX(-50%);
  pointer-events: none;
  padding: 7px 13px;
  border-radius: 999px;
  font: 500 12px/1.4 system-ui, sans-serif;
  color: #eaf1ff;
  background: rgba(24, 34, 56, 0.96);
  border: 1px solid rgba(120, 170, 255, 0.4);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);
}
.${PREFIX}-edge {
  position: absolute;
  z-index: 2;
  pointer-events: none;
  background: rgba(120, 200, 255, 0.22);
  box-shadow: inset 0 0 0 2px rgba(120, 200, 255, 0.85);
}
.${PREFIX}-ghost {
  position: absolute;
  z-index: 2;
  pointer-events: none;
  border-radius: 4px;
  border: 1px dashed rgba(150, 200, 255, 0.9);
  background: rgba(120, 170, 255, 0.12);
}
`

/** Elements the overlay owns, cached for cheap updates. */
export interface OverlayHandles {
  readonly root: HTMLDivElement
  readonly dimTop: HTMLDivElement
  readonly dimLeft: HTMLDivElement
  readonly dimRight: HTMLDivElement
  readonly dimBottom: HTMLDivElement
  readonly box: HTMLDivElement
  readonly label: HTMLDivElement
  readonly hint: HTMLDivElement
  readonly edge: HTMLDivElement
  readonly ghost: HTMLDivElement
  /** The overlay root, for use as an exclusion root in hit testing. */
  readonly exclusions: readonly Element[]
  destroy(): void
}

/**
 * Create the picker overlay in a document.
 *
 * The overlay is appended to `documentElement` rather than `body`, so a host
 * that transforms or clips `<body>` cannot displace it, and it uses `inset: 0`
 * with `contain: strict` so it never contributes to layout.
 * @param owner - the document to mount into.
 * @returns handles for driving and tearing down the overlay.
 */
export function createOverlay(owner: Document): OverlayHandles {
  const style = owner.createElement('style')
  style.id = `${PREFIX}-style`
  style.textContent = STYLE_TEXT
  owner.head.appendChild(style)

  const root = owner.createElement('div')
  root.className = `${PREFIX}-root`
  root.setAttribute('aria-hidden', 'true')
  root.style.position = 'fixed'
  root.style.inset = '0'
  root.style.width = '100vw'
  root.style.height = '100vh'
  root.style.zIndex = '2147483600'
  root.style.pointerEvents = 'auto'
  root.style.isolation = 'isolate'

  const dimTop = owner.createElement('div')
  const dimLeft = owner.createElement('div')
  const dimRight = owner.createElement('div')
  const dimBottom = owner.createElement('div')
  for (const dim of [dimTop, dimLeft, dimRight, dimBottom]) {
    dim.className = `${PREFIX}-dim`
    dim.style.position = 'fixed'
    dim.style.display = 'block'
    dim.style.zIndex = '0'
    dim.style.pointerEvents = 'none'
    dim.style.backgroundColor = 'rgba(8, 12, 20, 0.52)'
  }

  const box = owner.createElement('div')
  box.className = `${PREFIX}-box`
  box.style.display = 'none'

  const label = owner.createElement('div')
  label.className = `${PREFIX}-label`
  label.style.display = 'none'

  const hint = owner.createElement('div')
  hint.className = `${PREFIX}-hint`

  const edge = owner.createElement('div')
  edge.className = `${PREFIX}-edge`
  edge.style.display = 'none'

  const ghost = owner.createElement('div')
  ghost.className = `${PREFIX}-ghost`
  ghost.style.display = 'none'

  root.append(dimTop, dimLeft, dimRight, dimBottom, box, label, edge, ghost, hint)
  owner.documentElement.appendChild(root)

  setDim({ dimTop, dimLeft, dimRight, dimBottom }, null)

  return {
    root,
    dimTop,
    dimLeft,
    dimRight,
    dimBottom,
    box,
    label,
    hint,
    edge,
    ghost,
    exclusions: [root],
    destroy(): void {
      root.remove()
      style.remove()
    },
  }
}

/**
 * Position the highlight box around a rect.
 * @param handles - the overlay handles.
 * @param rect - the target rect in viewport coordinates.
 */
export function highlight(handles: OverlayHandles, rect: Rect): void {
  const box = handles.box
  box.style.display = 'block'
  box.style.left = `${rect.x}px`
  box.style.top = `${rect.y}px`
  box.style.width = `${rect.width}px`
  box.style.height = `${rect.height}px`
  setDim(handles, rect)
}

/**
 * Hide the highlight and its label.
 * @param handles - the overlay handles.
 */
export function clearHighlight(handles: OverlayHandles): void {
  handles.box.style.display = 'none'
  handles.label.style.display = 'none'
  setDim(handles, null)
}

function setDim(
  handles: Pick<OverlayHandles, 'dimTop' | 'dimLeft' | 'dimRight' | 'dimBottom'>,
  rect: Rect | null,
): void {
  const view = handles.dimTop.ownerDocument.defaultView ?? window
  const viewportWidth = view.innerWidth
  const viewportHeight = view.innerHeight
  // A zero-sized layout box (for example an empty or `display: contents` div
  // with no visible descendants) has no meaningful hole.  Do not interpret it
  // as a request to dim the entire viewport.
  if (rect !== null && (rect.width <= 0 || rect.height <= 0)) {
    for (const dim of [handles.dimTop, handles.dimLeft, handles.dimRight, handles.dimBottom]) {
      dim.style.display = 'none'
    }
    return
  }
  const top = rect === null ? viewportHeight : Math.max(0, Math.min(viewportHeight, rect.y))
  const bottom = rect === null ? 0 : Math.max(0, Math.min(viewportHeight, rect.y + rect.height))
  const left = rect === null ? 0 : Math.max(0, Math.min(viewportWidth, rect.x))
  const right = rect === null ? 0 : Math.max(0, Math.min(viewportWidth, rect.x + rect.width))

  handles.dimTop.style.left = '0px'
  handles.dimTop.style.top = '0px'
  handles.dimTop.style.position = 'fixed'
  handles.dimTop.style.display = 'block'
  handles.dimTop.style.width = `${viewportWidth}px`
  handles.dimTop.style.height = `${top}px`

  handles.dimBottom.style.left = '0px'
  handles.dimBottom.style.top = `${bottom}px`
  handles.dimBottom.style.position = 'fixed'
  handles.dimBottom.style.display = 'block'
  handles.dimBottom.style.width = `${viewportWidth}px`
  handles.dimBottom.style.height = `${Math.max(0, viewportHeight - bottom)}px`

  handles.dimLeft.style.left = '0px'
  handles.dimLeft.style.top = `${top}px`
  handles.dimLeft.style.position = 'fixed'
  handles.dimLeft.style.display = 'block'
  handles.dimLeft.style.width = `${left}px`
  handles.dimLeft.style.height = `${Math.max(0, bottom - top)}px`

  handles.dimRight.style.left = `${right}px`
  handles.dimRight.style.top = `${top}px`
  handles.dimRight.style.position = 'fixed'
  handles.dimRight.style.display = 'block'
  handles.dimRight.style.width = `${Math.max(0, viewportWidth - right)}px`
  handles.dimRight.style.height = `${Math.max(0, bottom - top)}px`
}

/**
 * Describe the highlighted element beside it.
 *
 * Placed above the box when there is room, below when there is not, and clamped
 * to the viewport so a selection at the edge still shows its label.
 * @param handles - the overlay handles.
 * @param rect - the target rect.
 * @param text - the label text.
 * @param sub - an optional second line, such as a downgrade warning.
 */
export function describe(
  handles: OverlayHandles,
  rect: Rect,
  text: string,
  sub?: string,
): void {
  const label = handles.label
  label.textContent = sub === undefined ? text : `${text}  ·  ${sub}`
  label.style.display = 'block'
  // Measure after writing, so the clamp uses the real width.
  const width = label.offsetWidth
  const above = rect.y > 28
  const top = above ? rect.y - label.offsetHeight - 6 : rect.y + rect.height + 6
  const left = Math.max(6, Math.min(rect.x, window.innerWidth - width - 6))
  label.style.top = `${top}px`
  label.style.left = `${left}px`
}

/**
 * Show the hint bar at the bottom of the screen.
 * @param handles - the overlay handles.
 * @param text - the hint to display.
 */
export function setHint(handles: OverlayHandles, text: string): void {
  handles.hint.textContent = text
}

/**
 * Arm an edge for the drag-out-to-detach gesture.
 *
 * Arm-on-proximity rather than true off-window tracking, because the engine
 * stops delivering `pointermove` once the cursor leaves the window, so the
 * release can never be observed out there. The band gives the user something
 * they can see and aim at, and the release happens where it can be seen.
 * @param handles - the overlay handles.
 * @param edge - the edge to arm, or null to disarm.
 * @param viewport - the current viewport size.
 */
export function armEdge(
  handles: OverlayHandles,
  edge: 'left' | 'right' | 'top' | 'bottom' | null,
  viewport: { readonly width: number; readonly height: number },
): void {
  const element = handles.edge
  if (edge === null) {
    element.style.display = 'none'
    return
  }
  const thickness = 4
  element.style.display = 'block'
  if (edge === 'left' || edge === 'right') {
    element.style.left = `${edge === 'left' ? 0 : viewport.width - thickness}px`
    element.style.top = '0px'
    element.style.width = `${thickness}px`
    element.style.height = `${viewport.height}px`
  } else {
    element.style.left = '0px'
    element.style.top = `${edge === 'top' ? 0 : viewport.height - thickness}px`
    element.style.width = `${viewport.width}px`
    element.style.height = `${thickness}px`
  }
}

/**
 * Draw the drag ghost while a panel is being torn out.
 * @param handles - the overlay handles.
 * @param rect - the ghost rect in viewport coordinates.
 */
export function showGhost(handles: OverlayHandles, rect: Rect): void {
  const ghost = handles.ghost
  ghost.style.display = 'block'
  ghost.style.left = `${rect.x}px`
  ghost.style.top = `${rect.y}px`
  ghost.style.width = `${rect.width}px`
  ghost.style.height = `${rect.height}px`
}

/**
 * Hide the drag ghost.
 * @param handles - the overlay handles.
 */
export function hideGhost(handles: OverlayHandles): void {
  handles.ghost.style.display = 'none'
}

/**
 * Compose the label text for an element.
 * @param element - the highlighted element.
 * @param depth - how many ancestors above the initially hit element, for context.
 * @returns a short description such as `div.chat-message > p`.
 */
export function describeElement(element: Element, depth: number): string {
  const tag = element.tagName.toLowerCase()
  const classes = typeof element.className === 'string'
    ? element.className.trim().split(/\s+/u).filter(Boolean).slice(0, 3)
    : []
  const id = element.id === '' ? '' : `#${element.id}`
  const suffix = depth > 0 ? `  ↑${depth}` : ''
  return classes.length === 0 ? `${tag}${id}${suffix}` : `${tag}${id}.${classes.join('.')}${suffix}`
}
