/**
 * The floating panel surface.
 *
 * Managed imperatively rather than as React state, because a panel holds a
 * *live DOM node* that came out of the app. Putting that node under React's
 * control would mean React adopts it as a child it did not create, and its next
 * commit would reconcile against it and delete it. The panel is a container
 * React never looks inside, which is what lets the extracted element keep
 * whatever framework backing it already had.
 *
 * The interaction model — drag by the header, resize from the corner, raise on
 * pointerdown, close — is factored into `pointer.ts` and `geometry.ts` so this
 * file only composes them.
 */
import { clampToViewport, MIN_PANEL_SIZE, resizeFrom, translate, type Size } from './geometry.ts'
import { beginDrag } from './pointer.ts'
import type { Rect } from '../shared/types.ts'

/** Panel chrome, injected once per document. */
const STYLE_TEXT = `
.dsh-bf-panel {
  position: fixed;
  z-index: 900;
  display: flex;
  pointer-events: auto !important;
  flex-direction: column;
  min-width: 160px;
  min-height: 80px;
  border-radius: 8px;
  --dsh-bf-panel-bg: #ffffff;
  --dsh-bf-panel-fg: #20242b;
  --dsh-bf-panel-border: #d1d5db;
  --dsh-bf-bar-bg: #f4f5f7;
  --dsh-bf-btn-hover-bg: #e5e7eb;
  --dsh-bf-accent: #9ca3af;
  background: var(--dsh-bf-panel-bg);
  border: 1px solid var(--dsh-bf-panel-border);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.26);
  overflow: hidden;
  color-scheme: light dark;
  color: var(--dsh-bf-panel-fg);
  font: 500 12px/1.4 system-ui, sans-serif;
}
.dsh-bf-panel[data-active="true"] {
  box-shadow: 0 16px 52px rgba(0, 0, 0, 0.34);
  border-color: var(--dsh-bf-accent);
}
.dsh-bf-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 6px 5px 10px;
  cursor: grab;
  user-select: none;
  background: var(--dsh-bf-bar-bg);
  border-bottom: 1px solid var(--dsh-bf-panel-border);
}
.dsh-bf-bar:active { cursor: grabbing; }
.dsh-bf-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.82;
}
.dsh-bf-btn {
  flex: none;
  width: 20px;
  height: 20px;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 5px;
  cursor: pointer;
  background: transparent;
  color: inherit;
  opacity: 0.62;
  font: inherit;
  line-height: 1;
}
.dsh-bf-btn:hover {
  opacity: 1;
  background: var(--dsh-bf-btn-hover-bg);
}
.dsh-bf-body { flex: 1; min-height: 0; position: relative; }
.dsh-bf-grip {
  position: absolute;
  right: 0;
  bottom: 0;
  width: 16px;
  height: 16px;
  cursor: nwse-resize;
  background: linear-gradient(135deg, transparent 46%, rgba(0, 0, 0, 0.28) 46%, rgba(0, 0, 0, 0.28) 56%, transparent 56%);
}
.dsh-bf-warn {
  padding: 5px 9px;
  font-size: 11px;
  opacity: 0.85;
  background: var(--dsh-bf-warn-bg, rgba(255, 196, 0, 0.14));
  border-top: 1px solid var(--dsh-bf-panel-border);
}

/* DSH can keep the OS preference light while its own theme is dark. */
@media (prefers-color-scheme: dark) {
  .dsh-bf-panel {
    --dsh-bf-panel-bg: #1f232b;
    --dsh-bf-panel-fg: #e6edf3;
    --dsh-bf-panel-border: #414957;
    --dsh-bf-bar-bg: #292f3a;
    --dsh-bf-btn-hover-bg: #3a4351;
    --dsh-bf-accent: #667085;
  }
}

html[data-theme='dark'] .dsh-bf-panel,
html[data-color-scheme='dark'] .dsh-bf-panel,
html[data-mode='dark'] .dsh-bf-panel,
html.dark .dsh-bf-panel,
.dark .dsh-bf-panel {
  --dsh-bf-panel-bg: #1f232b;
  --dsh-bf-panel-fg: #e6edf3;
  --dsh-bf-panel-border: #414957;
  --dsh-bf-bar-bg: #292f3a;
  --dsh-bf-btn-hover-bg: #3a4351;
  --dsh-bf-accent: #667085;
}
`

/** One floating panel. */
export interface Panel {
  /** The panel's root element. */
  readonly root: HTMLElement
  /** The element extracted content is attached to. */
  readonly body: HTMLElement
  /** Raise this panel above the others. */
  readonly raise: () => void
  /** Move and resize to an exact rect. */
  readonly setRect: (rect: Rect) => void
  /** The panel's current rect. */
  readonly rect: () => Rect
  /** Resize the panel so the extracted content has its natural measured size. */
  readonly fitToContent: (content: Element, minimum?: { readonly width: number; readonly height: number }) => void
  /** Close the panel, running the caller's cleanup. */
  readonly close: () => void
}

export interface PanelOptions {
  readonly title: string
  readonly rect: Rect
  /** Warnings to show under the content. */
  readonly warnings?: readonly string[]
  /** Called after the panel has been removed, to undo the extraction. */
  readonly onClose: () => void
}

/** Monotonic z-order counter, shared across panels in one document. */
// Host menus, tooltips and modal surfaces use the 1000+ range. Keep float
// panels below that range so a host popup can always appear above a panel.
let zCounter = 900

/**
 * Ensure the panel stylesheet exists in a document.
 * @param owner - the document to prepare.
 */
export function ensurePanelStyles(owner: Document): void {
  if (owner.getElementById('dsh-bf-panel-style') !== null) return
  const style = owner.createElement('style')
  style.id = 'dsh-bf-panel-style'
  style.textContent = STYLE_TEXT
  owner.head.appendChild(style)
}

/**
 * Create a floating panel.
 * @param owner - the document to mount into.
 * @param options - title, initial rect, warnings and close behaviour.
 * @returns the panel handle.
 */
export function createPanel(owner: Document, options: PanelOptions): Panel {
  ensurePanelStyles(owner)

  const root = owner.createElement('div')
  root.className = 'dsh-bf-panel'
  root.setAttribute('role', 'dialog')
  root.setAttribute('aria-label', options.title)
  root.dataset.active = 'false'

  const bar = owner.createElement('div')
  bar.className = 'dsh-bf-bar'

  const title = owner.createElement('span')
  title.className = 'dsh-bf-title'
  title.textContent = options.title

  const detachButton = owner.createElement('button')
  detachButton.className = 'dsh-bf-btn'
  detachButton.type = 'button'
  detachButton.title = 'Open in a separate window'
  detachButton.setAttribute('aria-label', detachButton.title)
  detachButton.textContent = '⤢'

  const closeButton = owner.createElement('button')
  closeButton.className = 'dsh-bf-btn'
  closeButton.type = 'button'
  closeButton.title = 'Close'
  closeButton.setAttribute('aria-label', closeButton.title)
  closeButton.textContent = '✕'

  bar.append(title, detachButton, closeButton)

  const body = owner.createElement('div')
  body.className = 'dsh-bf-body'

  const grip = owner.createElement('div')
  grip.className = 'dsh-bf-grip'
  body.appendChild(grip)

  root.append(bar, body)

  if (options.warnings !== undefined && options.warnings.length > 0) {
    const warn = owner.createElement('div')
    warn.className = 'dsh-bf-warn'
    warn.textContent = options.warnings[0] ?? ''
    warn.title = options.warnings.join('\n')
    root.appendChild(warn)
  }

  let rect = clampToViewport(options.rect, viewportSize())
  applyRect(root, rect)
  owner.documentElement.appendChild(root)

  const raise = (): void => {
    zCounter = zCounter >= 999 ? 900 : zCounter + 1
    root.style.zIndex = String(zCounter)
    root.dataset.active = 'true'
  }
  raise()

  // Any pointer landing inside the panel makes it the one being worked on.
  root.addEventListener('pointerdown', raise, true)

  let dragOrigin: Rect | null = null
  const stopDrag = beginDrag(bar, {
    onStart: () => {
      dragOrigin = rect
    },
    onMove: (delta) => {
      rect = clampToViewport(translate(dragOrigin ?? rect, delta), viewportSize())
      applyRect(root, rect)
    },
    onEnd: () => {
      dragOrigin = null
    },
  })

  let stopResize = (): void => {}
  let resizeOrigin: Rect | null = null
  stopResize = beginDrag(grip, {
    onStart: () => {
      resizeOrigin = rect
    },
    onMove: (delta) => {
      rect = clampToViewport(
        resizeFrom(resizeOrigin ?? rect, delta, MIN_PANEL_SIZE, viewportSize()),
        viewportSize(),
      )
      applyRect(root, rect)
    },
    onEnd: () => {
      resizeOrigin = null
    },
  })

  const close = (): void => {
    stopDrag()
    stopResize()
    root.remove()
    options.onClose()
  }
  closeButton.addEventListener('click', close)

  const fitToContent = (
    content: Element,
    minimum: { readonly width: number; readonly height: number } = { width: 0, height: 0 },
  ): void => {
    // Measure after the live node has been moved into the panel. scrollWidth /
    // scrollHeight retain the content's overflow size, while the client rect
    // covers ordinary transformed/layout boxes.
    const measured = content.getBoundingClientRect()
    const box = content instanceof HTMLElement ? content : null
    const contentWidth = Math.max(minimum.width, measured.width, box?.scrollWidth ?? 0)
    const contentHeight = Math.max(minimum.height, measured.height, box?.scrollHeight ?? 0)
    const barHeight = bar.getBoundingClientRect().height
    const warningHeight = root.querySelector<HTMLElement>('.dsh-bf-warn')?.getBoundingClientRect().height ?? 0
    rect = clampToViewport({
      x: rect.x,
      y: rect.y,
      width: contentWidth,
      height: contentHeight + barHeight + warningHeight,
    }, viewportSize())
    applyRect(root, rect)
  }

  return {
    root,
    body,
    raise,
    setRect: (next) => {
      rect = clampToViewport(next, viewportSize())
      applyRect(root, rect)
    },
    rect: () => rect,
    fitToContent,
    close,
  }
}

/**
 * Write a rect onto a panel element.
 * @param root - the panel root.
 * @param rect - the rect to apply.
 */
function applyRect(root: HTMLElement, rect: Rect): void {
  const style = root.style
  style.left = `${rect.x}px`
  style.top = `${rect.y}px`
  style.width = `${rect.width}px`
  style.height = `${rect.height}px`
}

/**
 * The current viewport size.
 * @returns width and height in CSS pixels.
 */
function viewportSize(): Size {
  return { width: window.innerWidth, height: window.innerHeight }
}

/**
 * Attach a detach handler to a panel's detach button.
 *
 * Kept out of `createPanel` so the panel does not need to know whether a
 * popout backend exists — on a plain web deployment there is none, and the
 * button is simply removed.
 * @param panel - the panel.
 * @param handler - what to do when the user asks for a separate window.
 */
export function wireDetach(panel: Panel, handler: () => void): void {
  const button = panel.root.querySelector<HTMLButtonElement>('.dsh-bf-btn[title="Open in a separate window"]')
  if (button === null) return
  button.addEventListener('click', handler)
}
