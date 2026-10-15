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
import { englishMessages, type MessageKey, type Messages } from '../shared/i18n.ts'

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
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 6px 5px 10px;
  cursor: grab;
  touch-action: none;
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
.dsh-bf-body { flex: 1; min-height: 0; position: relative; overflow: auto; }
.dsh-bf-grip {
  position: absolute;
  right: 0;
  bottom: 0;
  width: 16px;
  height: 16px;
  cursor: nwse-resize;
  touch-action: none;
  background: linear-gradient(135deg, transparent 46%, rgba(0, 0, 0, 0.28) 46%, rgba(0, 0, 0, 0.28) 56%, transparent 56%);
}
.dsh-bf-warn {
  flex-shrink: 0;
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
  /** Explain a detach failure without disturbing the live content. */
  readonly showStatus: (key: MessageKey) => void
  readonly setWarningKeys: (keys: readonly MessageKey[]) => void
  /** Run session cleanup before the source is restored or disconnected. */
  readonly onClose: (listener: () => void) => () => void
  /** Close the panel, running the caller's cleanup. */
  readonly close: () => void
}

export interface PanelOptions {
  readonly title: string
  readonly rect: Rect
  /** Warnings to show under the content. */
  readonly warnings?: readonly string[]
  readonly warningKeys?: readonly MessageKey[]
  readonly messages?: Messages
  /** Restore the live content while the panel is still connected. */
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
  const viewportSize = (): Size => ({ width: owner.defaultView?.innerWidth ?? window.innerWidth,
    height: owner.defaultView?.innerHeight ?? window.innerHeight })
  const messages = options.messages ?? englishMessages

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
  detachButton.dataset.action = 'detach'
  detachButton.textContent = '⤢'

  const closeButton = owner.createElement('button')
  closeButton.className = 'dsh-bf-btn'
  closeButton.type = 'button'
  closeButton.textContent = '✕'

  bar.append(title, detachButton, closeButton)

  const body = owner.createElement('div')
  body.className = 'dsh-bf-body'

  const grip = owner.createElement('div')
  grip.className = 'dsh-bf-grip'
  body.appendChild(grip)

  root.append(bar, body)

  const warn = owner.createElement('div')
  warn.className = 'dsh-bf-warn'
  root.appendChild(warn)
  let warningKeys = options.warningKeys ?? []
  let statusKey: MessageKey | null = null
  const status = owner.createElement('div')
  status.className = 'dsh-bf-warn'
  status.dataset.role = 'status'
  status.setAttribute('role', 'status')
  status.hidden = true
  root.appendChild(status)
  const renderMessages = (): void => {
    detachButton.title = messages.t('detach')
    detachButton.setAttribute('aria-label', detachButton.title)
    closeButton.title = messages.t('close')
    closeButton.setAttribute('aria-label', closeButton.title)
    if (statusKey !== null) status.textContent = messages.t(statusKey)
    const warnings = [...(options.warnings ?? []), ...warningKeys.map((key) => messages.t(key))]
    warn.hidden = warnings.length === 0
    warn.textContent = warnings.join(' ')
    warn.title = warnings.join('\n')
  }
  renderMessages()
  const stopMessages = messages.subscribe(renderMessages)

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
    onEnd: ({ cancelled }) => {
      if (cancelled && dragOrigin !== null) {
        rect = dragOrigin
        applyRect(root, rect)
      }
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
    onEnd: ({ cancelled }) => {
      if (cancelled && resizeOrigin !== null) {
        rect = resizeOrigin
        applyRect(root, rect)
      }
      resizeOrigin = null
    },
  })

  let closed = false
  const closeListeners = new Set<() => void>()
  const close = (): void => {
    if (closed) return
    closed = true
    stopMessages()
    stopDrag()
    stopResize()
    for (const listener of closeListeners) {
      try { listener() } catch { /* One session must not prevent source recovery. */ }
    }
    closeListeners.clear()
    try {
      options.onClose()
    } finally {
      root.remove()
    }
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
    showStatus: (key) => {
      if (closed) return
      const previousHeight = status.hidden ? 0 : status.getBoundingClientRect().height
      statusKey = key
      status.hidden = false
      renderMessages()
      const addedHeight = status.getBoundingClientRect().height - previousHeight
      if (addedHeight > 0) {
        rect = clampToViewport({ ...rect, height: rect.height + addedHeight }, viewportSize())
        applyRect(root, rect)
      }
    },
    setWarningKeys: (keys) => {
      if (closed) return
      warningKeys = keys
      renderMessages()
    },
    onClose: (listener) => {
      if (closed) listener()
      else closeListeners.add(listener)
      return () => { closeListeners.delete(listener) }
    },
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
 * Attach a detach handler to a panel's detach button.
 *
 * Kept out of `createPanel` so the panel does not need to know whether a
 * popout backend exists. The handler can explain a downgrade in the panel.
 * @param panel - the panel.
 * @param handler - what to do when the user asks for a separate window.
 */
export function wireDetach(panel: Panel, handler: () => void): void {
  const button = panel.root.querySelector<HTMLButtonElement>('[data-action="detach"]')
  if (button === null) return
  button.addEventListener('click', handler)
}
