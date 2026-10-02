/**
 * The panel manager: the object the plugin entry point actually drives.
 *
 * Owns the set of open panels, starts pick sessions, and — the part that is
 * easy to get wrong — guarantees that every extraction is undone when its panel
 * closes. An extraction holds a structural stand-in on a live app element, so
 * leaking one means the app's DOM stays patched and the extracted content never
 * returns. Pairing them in one place is what makes that impossible to forget.
 */
import { extract, type Extraction } from '../capture/index.ts'
import { createPanel, wireDetach, type Panel } from '../float/index.ts'
import { initialPanelRect } from '../float/geometry.ts'
import { createOverview, type OverviewHandle } from './overview.ts'
import { startPick } from '../scout/index.ts'
import type { Rect } from '../shared/types.ts'

/** One open panel and the extraction backing it. */
interface OpenPanel {
  readonly panel: Panel
  readonly extraction: Extraction
  readonly title: string
}

/** What the manager reports back to the plugin. */
export interface PanelManagerEvents {
  /** Called when the number of open panels changes, so the UI can react. */
  readonly onChange?: (count: number) => void
  /** Called when the user asks to send a panel to its own window. */
  readonly onDetachRequest?: (panel: Panel, extraction: Extraction) => void
  /** Called when closing a panel failed for a reason worth surfacing. */
  readonly onError?: (message: string) => void
}

/**
 * Create the panel manager for one document.
 * @param owner - the document panels are created in.
 * @param events - optional callbacks.
 * @returns the manager.
 */
export function createPanelManager(owner: Document, events: PanelManagerEvents = {}) {
  const open = new Set<OpenPanel>()
  let session: { cancel: () => void } | null = null
  let overview: OverviewHandle | null = null

  /**
   * Open a panel for an extracted element.
   * @param element - the element to extract.
   * @param destination - where the panel lives.
   * @param rect - the source rect, used to size and place the panel.
   */
  const openPanel = (element: Element, destination: 'float' | 'popout', rect: Rect): void => {
    const placeholderContainer = owner.createElement('div')
    placeholderContainer.style.setProperty('display', 'contents')

    const target = initialPanelRect(rect, {
      width: owner.defaultView?.innerWidth ?? window.innerWidth,
      height: owner.defaultView?.innerHeight ?? window.innerHeight,
    })

    let extraction: Extraction | null = null
    let panel: Panel | null = null

    const warnings = describeWarnings(element)
    panel = createPanel(owner, {
      title: labelFor(element),
      rect: target,
      warnings,
      onClose: () => {
        // Order matters: the DOM is put back before the bookkeeping is dropped,
        // so a failure to restore is still observable.
        try {
          extraction?.restore()
        } catch (error) {
          events.onError?.(`Could not restore the page: ${String(error)}`)
        }
        if (extraction !== null) {
          const entry = [...open].find((candidate) => candidate.extraction === extraction)
          if (entry !== undefined) open.delete(entry)
        }
        placeholderContainer.remove()
        events.onChange?.(open.size)
      },
    })

    try {
      extraction = extract({
        element,
        container: panel.body,
        destination,
        frame: panel.root,
        onHostRemoved: () => panel?.close(),
      })
      open.add({ panel, extraction, title: labelFor(element) })
      // The source rect is the minimum content size. Measuring after the move
      // also catches intrinsic overflow and layout changes caused by the new
      // panel width, while the panel method adds chrome height separately.
      panel.fitToContent(element, { width: rect.width, height: rect.height })
      wireDetach(panel, () => events.onDetachRequest?.(panel as Panel, extraction as Extraction))
      events.onChange?.(open.size)
    } catch (error) {
      // The panel is already mounted, so it must be removed rather than left
      // showing an empty body with a live close button.
      panel.close()
      events.onError?.(`Could not extract that element: ${String(error)}`)
    }
  }

  return {
    /**
     * Enter pick mode. The shortcut handler calls this.
     * @param detachEnabled - whether the drag-out gesture should be offered.
     */
    pick(detachEnabled: boolean): void {
      // A second press while picking means the user wants out, not a nested
      // session.
      if (session !== null) {
        session.cancel()
        return
      }
      session = startPick(owner, {
        detachEnabled,
        blockedRoots: [...open].map((entry) => entry.panel.root),
        onDone: (outcome) => {
          session = null
          if (outcome.type !== 'extract') return
          openPanel(outcome.element, 'float', outcome.rect)
        },
      })
    },

    /** Toggle the floating-window overview and recall panels from it. */
    toggleOverview(): void {
      if (overview !== null) {
        const wasVisible = overview.root.isConnected
        overview.close()
        overview = null
        if (wasVisible) return
      }
      const entries = [...open]
      let handle: OverviewHandle | null = null
      handle = createOverview(owner, entries, (panel, point) => {
        handle?.close()
        if (overview === handle) overview = null
        const current = panel.rect()
        panel.raise()
        panel.setRect({ ...current, x: point.x, y: point.y })
      })
      overview = handle
    },

    /** Whether a pick session is currently running. */
    isPicking: (): boolean => session !== null,

    /** Close every panel, restoring the page. */
    closeAll(): void {
      for (const entry of [...open]) entry.panel.close()
    },

    /** The number of open panels. */
    count: (): number => open.size,

    /** The open panels, for a popout handoff or diagnostics. */
    entries: (): readonly OpenPanel[] => [...open],

    /** Stop any running pick session. */
    dispose(): void {
      session?.cancel()
      session = null
      overview?.close()
      overview = null
    },
  }
}

/** The manager type, so the plugin can hold one. */
export type PanelManager = ReturnType<typeof createPanelManager>

/**
 * A short human label for an extracted element.
 * @param element - the extracted element.
 * @returns a label suitable for a panel title bar.
 */
function labelFor(element: Element): string {
  const tag = element.tagName.toLowerCase()
  const id = element.id === '' ? '' : `#${element.id}`
  const firstClass = typeof element.className === 'string'
    ? element.className.trim().split(/\s+/u)[0]
    : undefined
  return `${tag}${id}${firstClass === undefined ? '' : `.${firstClass}`}`
}

/**
 * Turn a capture prognosis into strings a panel can show.
 * @param element - the extracted element.
 * @returns warning lines, most important first.
 */
function describeWarnings(element: Element): readonly string[] {
  const lines: string[] = []
  if (element.querySelector('canvas') !== null) lines.push('Canvas contents may be blank.')
  if (element.querySelector('iframe') !== null) lines.push('Contains an iframe, which reloads in a separate window.')
  if (element.querySelector('video, audio') !== null) lines.push('Media playback does not follow the panel.')
  return lines
}
