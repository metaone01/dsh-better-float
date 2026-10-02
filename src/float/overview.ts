import type { Panel } from './index.ts'
import { snapshotPreview } from './snapshot.ts'

const STYLE_ID = 'dsh-bf-overview-style'
const STYLE_TEXT = `
.dsh-bf-overview {
  position: fixed; inset: 0; z-index: 1200;
  display: grid; place-items: center; overflow: auto;
  padding: 40px; box-sizing: border-box; background: rgba(16, 17, 19, 0.78);
  color: #f3f4f6; font: 500 13px/1.4 system-ui, sans-serif;
  pointer-events: auto !important;
}
.dsh-bf-overview[data-placing="true"] { background: transparent; cursor: crosshair; }
.dsh-bf-overview[data-placing="true"] .dsh-bf-overview-panel { display: none; }
.dsh-bf-overview-panel { width: min(1200px, 100%); margin: auto; }
.dsh-bf-overview-title { margin: 0 0 24px; font-size: 18px; font-weight: 600; color: #f3f4f6; }
.dsh-bf-overview-grid {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(min(260px, 100%), 1fr)); gap: 24px;
}
.dsh-bf-overview-item {
  display: flex; flex-direction: column; gap: 10px; min-width: 0; width: 100%;
  padding: 8px; border: 1px solid transparent; border-radius: 6px;
  background: transparent; color: #f3f4f6; cursor: pointer; text-align: left; font: inherit;
}
.dsh-bf-overview-item:hover, .dsh-bf-overview-item:focus-visible {
  border-color: #a1a1aa; background: #232427; outline: none;
}
.dsh-bf-overview-preview {
  position: relative; display: grid; place-items: center;
  width: 100%; height: 220px; overflow: hidden; border-radius: 4px; background: #18191c;
  pointer-events: none;
}
.dsh-bf-overview-preview img {
  position: absolute; inset: 0; display: block;
  width: 100%; height: 100%; min-width: 0; min-height: 0;
  max-width: 100%; max-height: 100%; margin: 0; object-fit: contain;
}
.dsh-bf-overview-name { width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-bf-overview-empty { margin: 0; color: #a1a1aa; }
@media (max-width: 600px) {
  .dsh-bf-overview { padding: 20px; }
  .dsh-bf-overview-grid { gap: 16px; }
  .dsh-bf-overview-preview { height: 180px; }
}
`

export interface OverviewEntry { readonly panel: Panel; readonly title: string }
export interface OverviewHandle { readonly root: HTMLDivElement; close(): void }

export function createOverview(owner: Document, entries: readonly OverviewEntry[],
  onSelect: (panel: Panel, point: { readonly x: number; readonly y: number }) => void,
): OverviewHandle {
  let style = owner.getElementById(STYLE_ID) as HTMLStyleElement | null
  if (style === null) {
    style = owner.createElement('style')
    style.id = STYLE_ID
    owner.head.appendChild(style)
  }
  style.textContent = STYLE_TEXT
  const previousFocus = owner.activeElement
  const root = owner.createElement('div')
  root.className = 'dsh-bf-overview'
  root.dataset.overviewVersion = 'two-step-fit-2'
  root.tabIndex = -1
  root.setAttribute('role', 'dialog')
  root.setAttribute('aria-modal', 'true')
  root.setAttribute('aria-label', 'Floating windows')
  const panel = owner.createElement('div')
  panel.className = 'dsh-bf-overview-panel'
  const title = owner.createElement('h2')
  title.className = 'dsh-bf-overview-title'
  title.textContent = 'Floating windows'
  panel.appendChild(title)
  let closed = false
  let selected: Panel | null = null
  let placementPressed = false
  if (entries.length === 0) {
    const empty = owner.createElement('p')
    empty.className = 'dsh-bf-overview-empty'
    empty.textContent = 'No floating windows'
    panel.appendChild(empty)
  } else {
    const grid = owner.createElement('div')
    grid.className = 'dsh-bf-overview-grid'
    for (const entry of entries) {
      const item = owner.createElement('button')
      item.className = 'dsh-bf-overview-item'
      item.type = 'button'
      item.setAttribute('aria-label', `Recall ${entry.title}`)
      const preview = owner.createElement('span')
      preview.className = 'dsh-bf-overview-preview'
      preview.setAttribute('aria-hidden', 'true')
      const name = owner.createElement('span')
      name.className = 'dsh-bf-overview-name'
      name.textContent = entry.title
      name.title = entry.title
      item.append(preview, name)
      // Freeze before mounting the overview, without changing the live panel.
      void snapshotPreview(entry.panel.root, owner).then((image) => {
        if (closed) return
        if (image !== null) preview.appendChild(image)
        else preview.textContent = 'Preview unavailable'
      })
      item.addEventListener('click', (event) => {
        event.stopPropagation()
        selected = entry.panel
        placementPressed = false
        root.dataset.placing = 'true'
        root.setAttribute('aria-label', `Place ${entry.title}`)
        root.focus({ preventScroll: true })
      })
      grid.appendChild(item)
    }
    panel.appendChild(grid)
  }
  root.appendChild(panel)
  owner.documentElement.appendChild(root)
  root.focus()
  const close = (): void => {
    if (closed) return
    closed = true
    root.remove()
    if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true })
  }
  root.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    close()
  })
  // The placement surface consumes input so choosing a location cannot press
  // a control in the underlying app or start dragging another floating panel.
  root.addEventListener('pointerdown', (event) => {
    if (selected === null) return
    event.preventDefault()
    event.stopPropagation()
    placementPressed = event.button === 0 && event.target === root
  })
  root.addEventListener('click', (event) => {
    if (selected !== null) {
      event.preventDefault()
      event.stopPropagation()
      if (!placementPressed || event.button !== 0 || event.target !== root) return
      placementPressed = false
      const target = selected
      close()
      if (target.root.isConnected) onSelect(target, { x: event.clientX, y: event.clientY })
      return
    }
    if (event.target === root || event.target === panel) close()
  })
  return { root, close }
}
