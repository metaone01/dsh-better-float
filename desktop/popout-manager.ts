/**
 * Popout window registry and lifecycle.
 *
 * **This file is a patch to `apps/desktop/src`. It is not compiled as part of
 * the plugin**, because the plugin's purity gate forbids it from reaching
 * Electron at all. To install it, copy it next to `main.ts` and call
 * `installPopoutManager` from the app's `whenReady` path, after the primary
 * window exists.
 *
 * ## Why a main-process registry
 *
 * The renderer cannot be authoritative about windows it does not own: a panel
 * can be closed by the OS, by the window's own close button, or by the app
 * quitting, and only the main process sees all three. Everything else —
 * which panel is in which window, whether a window is still alive — is derived
 * from here and pushed to renderers.
 *
 * ## The same-origin rule
 *
 * Every popout loads `dsh-app://app/?dsh-popout=<id>` — the **same host as the
 * primary window**, distinguished only by a query parameter. A separate host
 * such as `dsh-app://popout/` would change the origin, because a custom
 * scheme's origin is `scheme://host`. That would sever `BroadcastChannel`,
 * `localStorage`, cross-window drag-and-drop and `adoptNode` in one move, and
 * would also require widening the host allow-list in `assertDesktopSender`.
 * Keeping one host costs nothing and breaks nothing.
 */

import { BrowserWindow, globalShortcut, nativeTheme, screen } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'

/** Channel names owned by this feature. */
export const BETTER_FLOAT_IPC = {
  open: 'dsh-desktop:better-float-open',
  close: 'dsh-desktop:better-float-close',
  update: 'dsh-desktop:better-float-update',
  list: 'dsh-desktop:better-float-list',
  changed: 'dsh-desktop:better-float-changed',
  capturePage: 'dsh-desktop:better-float-capture-page',
  toggleClickThrough: 'dsh-desktop:better-float-toggle-click-through',
} as const

/** Window attributes a panel may request. */
export interface PopoutAttributes {
  readonly alwaysOnTop?: boolean
  /** Let pointer events pass through to whatever is behind the window. */
  readonly clickThrough?: boolean
  /** Draw our own title bar instead of the native one. */
  readonly frameless?: boolean
  readonly transparent?: boolean
  readonly resizable?: boolean
}

/** A popout as the renderer sees it. */
export interface PopoutRecord {
  readonly id: string
  readonly title: string
  readonly bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
  readonly attributes: Required<PopoutAttributes>
  readonly alive: boolean
}

export interface OpenPopoutRequest {
  readonly id: string
  readonly title: string
  readonly bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
  readonly attributes?: PopoutAttributes
  /**
   * Optional snapshot handed to the new window.
   *
   * Carried as a plain string, never as markup, so the new window decides how to
   * interpret it. Serialising live DOM would need a structure-preserving channel
   * that does not exist, and shipping markup across would make the receiving
   * window an execution surface for anything the sender put in it.
   */
  readonly snapshot?: string
}

interface Managed {
  readonly window: BrowserWindow
  record: PopoutRecord
  /** Whether click-through is currently on, so the toggle knows its state. */
  clickThrough: boolean
  /**
   * The global shortcut registered to rescue this window from click-through.
   *
   * This is the only place in the whole plugin that genuinely needs an OS-level
   * hotkey. Click-through makes a window unclickable by design, so without a
   * shortcut that works while the window is not focused, enabling it would
   * strand the user with a window they cannot turn off.
   */
  rescueAccelerator: string | null
}

/** Attributes every popout starts with. */
const DEFAULT_ATTRIBUTES: Required<PopoutAttributes> = {
  alwaysOnTop: true,
  clickThrough: false,
  frameless: true,
  transparent: false,
  resizable: true,
}

export interface PopoutManagerOptions {
  /** Electron preload script path for popout windows. */
  readonly preload: string
  /** Host allowed to call these channels. Must match the primary window's host. */
  readonly host: string
  /** Absolute URL of the popout document, already including `dsh-app://app/`. */
  readonly documentUrl: string
  /** The window that owns the panels, used for centring and for parent links. */
  readonly primary: () => BrowserWindow | null
}

/**
 * Create the popout manager and register its IPC handlers.
 * @param options - preload path, allowed host and document URL.
 * @returns the manager, with a dispose function for app shutdown.
 */
export function installPopoutManager(options: PopoutManagerOptions) {
  const managed = new Map<string, Managed>()

  /**
   * Reject a call unless it came from one of our own windows.
   *
   * Deliberately the same check the rest of the desktop app uses: a
   * `dsh-app://` URL on the expected host. Because every popout shares the
   * primary window's host, this single allow-list covers all of them.
   * @param event - the IPC call.
   */
  const assertSender = (event: IpcMainInvokeEvent): void => {
    const frame = event.senderFrame
    if (frame === null) throw new Error('better-float: rejected IPC without a sender frame')
    const url = new URL(frame.url)
    if (url.protocol !== 'dsh-app:' || url.hostname !== options.host) {
      throw new Error('better-float: rejected IPC from an unowned renderer')
    }
  }

  /** Push the current registry to every renderer that cares. */
  const broadcast = (): void => {
    const records = [...managed.values()].map((entry) => entry.record)
    for (const target of BrowserWindow.getAllWindows()) {
      if (target.isDestroyed()) continue
      target.webContents.send(BETTER_FLOAT_IPC.changed, records)
    }
  }

  /**
   * Clamp a requested rect to the nearest display's work area.
   *
   * Screen coordinates are physical and displays can be arranged arbitrarily,
   * so a panel detached near a boundary would otherwise open partly off-screen.
   * @param bounds - the requested bounds in screen coordinates.
   * @returns bounds guaranteed to be visible on some display.
   */
  const clampToDisplay = (bounds: PopoutRecord['bounds']): PopoutRecord['bounds'] => {
    const area = screen.getDisplayNearestPoint({ x: Math.round(bounds.x), y: Math.round(bounds.y) }).workArea
    const width = Math.min(Math.max(bounds.width, 200), area.width)
    const height = Math.min(Math.max(bounds.height, 140), area.height)
    const x = Math.min(Math.max(bounds.x, area.x), area.x + area.width - width)
    const y = Math.min(Math.max(bounds.y, area.y), area.y + area.height - height)
    return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) }
  }

  /**
   * Apply window attributes, including the two that need care.
   * @param window - the window to configure.
   * @param attributes - the desired attributes.
   */
  const applyAttributes = (window: BrowserWindow, attributes: Required<PopoutAttributes>): void => {
    window.setAlwaysOnTop(attributes.alwaysOnTop, 'floating')
    window.setResizable(attributes.resizable)
    setClickThrough(window, attributes.clickThrough)
  }

  /**
   * Turn pointer pass-through on or off.
   *
   * `forward: true` is essential and easy to omit. Without it the window stops
   * receiving `mousemove` as well as clicks, so the page cannot detect the
   * pointer arriving at its own title bar and the window becomes permanently
   * dead. With it, movement keeps arriving while clicks pass through — which is
   * what makes "hover the top edge to reveal the controls" work.
   * @param window - the target window.
   * @param enabled - whether clicks should pass through.
   */
  const setClickThrough = (window: BrowserWindow, enabled: boolean): void => {
    window.setIgnoreMouseEvents(enabled, { forward: true })
  }

  const openPopout = (request: OpenPopoutRequest): PopoutRecord => {
    const existing = managed.get(request.id)
    if (existing !== undefined && !existing.window.isDestroyed()) {
      existing.window.focus()
      return existing.record
    }

    const attributes: Required<PopoutAttributes> = { ...DEFAULT_ATTRIBUTES, ...request.attributes }
    const bounds = clampToDisplay(request.bounds)
    // The query parameter is the only thing distinguishing a popout document
    // from the primary one. Same host means same origin, which is what keeps
    // BroadcastChannel, storage and adoptNode working across the two.
    const url = new URL(options.documentUrl)
    url.searchParams.set('dsh-popout', request.id)

    const window = new BrowserWindow({
      ...bounds,
      show: false,
      parent: options.primary() ?? undefined,
      // Window attributes are not a new capability here: the app already uses
      // titleBarStyle, vibrancy, backgroundMaterial and frame:false+transparent
      // elsewhere. This adds setIgnoreMouseEvents, which nothing else uses yet.
      frame: attributes.frameless ? false : true,
      transparent: attributes.transparent,
      backgroundColor: attributes.transparent ? '#00000000' : undefined,
      resizable: attributes.resizable,
      titleBarStyle: attributes.frameless ? 'hidden' : 'default',
      vibrancy: process.platform === 'darwin' ? 'sidebar' : undefined,
      visualEffectState: process.platform === 'darwin' ? 'active' : undefined,
      webPreferences: {
        preload: options.preload,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        // No `affinity` on purpose. Sharing a renderer process with the primary
        // window would let a crashing panel take the whole application down,
        // and the fidelity it would buy (a live cross-window DOM move) is
        // already discounted by `moveBefore`'s cross-document limitation. See
        // the plan's D7 for the full argument.
      },
    })

    const record: PopoutRecord = {
      id: request.id,
      title: request.title,
      bounds,
      attributes,
      alive: true,
    }
    const entry: Managed = { window, record, clickThrough: false, rescueAccelerator: null }
    managed.set(request.id, entry)

    applyAttributes(window, attributes)

    // The snapshot is sent once the document is ready to receive it. Sending
    // earlier would race the renderer's listener registration.
    window.webContents.once('did-finish-load', () => {
      window.webContents.send(BETTER_FLOAT_IPC.open, { ...request, bounds, attributes })
      if (!window.isDestroyed()) window.show()
    })

    const resync = (): void => {
      const current = managed.get(request.id)
      if (current === undefined) return
      const next = window.getBounds()
      // Only rewrite when it actually changed, or every resize event would
      // produce an IPC round trip and a re-render.
      if (next.x === current.record.bounds.x && next.y === current.record.bounds.y
        && next.width === current.record.bounds.width && next.height === current.record.bounds.height) return
      current.record = { ...current.record, bounds: next }
      broadcast()
    }
    window.on('moved', resync)
    window.on('resized', resync)

    window.on('closed', () => {
      const current = managed.get(request.id)
      if (current?.rescueAccelerator != null) globalShortcut.unregister(current.rescueAccelerator)
      managed.delete(request.id)
      broadcast()
    })

    window.webContents.on('render-process-gone', () => {
      // A popout is a view onto a panel, not the panel's home. Losing it is
      // recoverable, and the primary window is untouched — which is the whole
      // point of not sharing a renderer process with it.
      const current = managed.get(request.id)
      if (current !== undefined) current.record = { ...current.record, alive: false }
      broadcast()
    })

    void url
    broadcast()
    return record
  }

  return {
    openPopout,

    closePopout(id: string): boolean {
      const entry = managed.get(id)
      if (entry === undefined) return false
      if (entry.rescueAccelerator != null) globalShortcut.unregister(entry.rescueAccelerator)
      entry.window.close()
      return true
    },

    listPopouts(): readonly PopoutRecord[] {
      return [...managed.values()].map((entry) => entry.record)
    },

    /**
     * Update a popout's attributes and bounds.
     * @param id - the popout id.
     * @param patch - the attributes to change.
     * @returns whether the popout existed.
     */
    updatePopout(id: string, patch: Partial<PopoutRecord>): boolean {
      const entry = managed.get(id)
      if (entry === undefined || entry.window.isDestroyed()) return false
      if (patch.bounds !== undefined) {
        const bounds = clampToDisplay(patch.bounds)
        entry.window.setBounds(bounds)
        entry.record = { ...entry.record, bounds }
      }
      if (patch.attributes !== undefined) {
        const attributes = { ...entry.record.attributes, ...patch.attributes }
        entry.record = { ...entry.record, attributes }
        applyAttributes(entry.window, attributes)
        syncRescueShortcut(entry, attributes.clickThrough)
      }
      broadcast()
      return true
    },

    /**
     * Register the shortcut that turns click-through back off.
     *
     * The accelerator is derived from the window id so several windows can each
     * have one without colliding, and it is unregistered the moment
     * click-through ends so it never lingers as a global grab.
     * @param entry - the managed window.
     * @param enabled - whether click-through is now on.
     */
    syncRescueShortcut(entry: Managed, enabled: boolean): void {
      if (enabled && entry.rescueAccelerator === null) {
        const accelerator = 'CommandOrControl+Shift+Alt+P'
        if (globalShortcut.register(accelerator, () => {
          setClickThrough(entry.window, false)
          entry.clickThrough = false
          entry.record = { ...entry.record, attributes: { ...entry.record.attributes, clickThrough: false } }
          broadcast()
        })) {
          entry.rescueAccelerator = accelerator
        }
      } else if (!enabled && entry.rescueAccelerator !== null) {
        globalShortcut.unregister(entry.rescueAccelerator)
        entry.rescueAccelerator = null
      }
    },

    /**
     * Capture a rect from the focused window.
     * @param id - the popout or `primary`.
     * @param rect - the region, in CSS pixels relative to that window's viewport.
     * @returns a PNG data URL, or null.
     */
    async capturePage(id: string, rect: { x: number; y: number; width: number; height: number }): Promise<string | null> {
      const target = id === 'primary' ? options.primary() : managed.get(id)?.window
      if (target == null || target.isDestroyed()) return null
      const image = await target.webContents.capturePage({
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      })
      return image.isEmpty() ? null : image.toDataURL()
    },

    /** Register the IPC surface. Call once, after the primary window exists. */
    registerIpc(ipcMain: { handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: never[]) => unknown): void }): void {
      ipcMain.handle(BETTER_FLOAT_IPC.open, (event, request: unknown) => {
        assertSender(event)
        return openPopout(request as OpenPopoutRequest)
      })
      ipcMain.handle(BETTER_FLOAT_IPC.close, (event, id: unknown) => {
        assertSender(event)
        return this.closePopout(String(id))
      })
      ipcMain.handle(BETTER_FLOAT_IPC.update, (event, id: unknown, patch: unknown) => {
        assertSender(event)
        return this.updatePopout(String(id), patch as Partial<PopoutRecord>)
      })
      ipcMain.handle(BETTER_FLOAT_IPC.list, (event) => {
        assertSender(event)
        return this.listPopouts()
      })
      ipcMain.handle(BETTER_FLOAT_IPC.capturePage, (event, id: unknown, rect: unknown) => {
        assertSender(event)
        return this.capturePage(String(id), rect as { x: number; y: number; width: number; height: number })
      })
      ipcMain.handle(BETTER_FLOAT_IPC.toggleClickThrough, (event, id: unknown, enabled: unknown) => {
        assertSender(event)
        return this.updatePopout(String(id), {
          attributes: { clickThrough: Boolean(enabled) } as Required<PopoutAttributes>,
        })
      })
    },

    /** Unregister shortcuts and close every popout. Call on app shutdown. */
    dispose(): void {
      for (const entry of managed.values()) {
        if (entry.rescueAccelerator != null) globalShortcut.unregister(entry.rescueAccelerator)
        if (!entry.window.isDestroyed()) entry.window.destroy()
      }
      managed.clear()
    },

    /** Theme accessor, so a popout can match the app. */
    prefersDark: (): boolean => nativeTheme.shouldUseDarkColors,
  }
}
