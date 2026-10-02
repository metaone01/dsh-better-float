/**
 * Talking to the desktop shell about windows.
 *
 * Two channels, deliberately kept separate:
 *
 * - **IPC** for anything only the main process can answer — creating a window,
 *   knowing whether it still exists, capturing a native screenshot.
 * - **`BroadcastChannel`** for panel state shared between renderers. It is
 *   same-origin by construction, which is exactly the property the popout
 *   document URL is designed to preserve, and it keeps working when the
 *   desktop backend is absent — a panel dragged between two browser tabs
 *   coordinates over the same channel.
 *
 * Nothing here sends DOM. A live node cannot cross a process boundary, and
 * serialising one would turn the receiving window into an execution surface.
 * What crosses is a description; the receiving window decides how to rebuild it.
 */
/** Window attributes a panel may request, mirroring the main-process contract. */
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

/** Messages exchanged between renderers over `BroadcastChannel`. */
export type FloatMessage =
  | { readonly type: 'popout-opened'; readonly record: PopoutRecord }
  | { readonly type: 'popout-closed'; readonly id: string }
  | { readonly type: 'popout-updated'; readonly record: PopoutRecord }
  /** Sent by a popout to claim ownership of a panel, so the source can drop it. */
  | { readonly type: 'claim'; readonly id: string; readonly from: string }
  | { readonly type: 'release'; readonly id: string; readonly from: string }

/** The channel name; the version suffix lets the protocol change safely later. */
const CHANNEL = 'dsh-better-float:v1'

/** The shell bridge, when the plugin is running inside the desktop app. */
interface DesktopBridge {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
}

/**
 * Find the desktop bridge if one is present.
 *
 * Feature-detected rather than assumed, because the same client half also runs
 * in a plain browser where no bridge exists and the detach feature is simply
 * unavailable.
 * @returns the bridge, or null.
 */
export function desktopBridge(): DesktopBridge | null {
  const candidate = (globalThis as { dshDesktop?: unknown }).dshDesktop
  if (candidate === undefined || candidate === null) return null
  if (typeof (candidate as DesktopBridge).invoke !== 'function') return null
  return candidate as DesktopBridge
}

/** Channel names, mirroring `BETTER_FLOAT_IPC` on the main-process side. */
export const CHANNELS = {
  open: 'dsh-desktop:better-float-open',
  close: 'dsh-desktop:better-float-close',
  update: 'dsh-desktop:better-float-update',
  list: 'dsh-desktop:better-float-list',
  changed: 'dsh-desktop:better-float-changed',
  capturePage: 'dsh-desktop:better-float-capture-page',
  toggleClickThrough: 'dsh-desktop:better-float-toggle-click-through',
} as const

export interface Transport {
  /** Create a popout window. */
  open(request: {
    readonly id: string
    readonly title: string
    readonly bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
    readonly attributes?: PopoutAttributes
    readonly snapshot?: string
  }): Promise<PopoutRecord | null>
  /** Close a popout window. */
  close(id: string): Promise<boolean>
  /** Change a popout's attributes or bounds. */
  update(id: string, patch: Partial<PopoutRecord>): Promise<boolean>
  /** Every live popout. */
  list(): Promise<readonly PopoutRecord[]>
  /** A native screenshot, which captures what a DOM serialisation cannot. */
  capturePage(id: string, rect: { x: number; y: number; width: number; height: number }): Promise<string | null>
  /** Post a message to other renderers. */
  publish(message: FloatMessage): void
  /** Subscribe to messages from other renderers. */
  subscribe(listener: (message: FloatMessage) => void): () => void
  /** Whether a desktop backend exists. */
  readonly available: boolean
  dispose(): void
}

/**
 * Build the transport for the current environment.
 *
 * On the desktop it wraps IPC and adds `BroadcastChannel`; in a browser it has
 * only `BroadcastChannel`, and the window-management calls report failure
 * rather than throwing, so callers can degrade to keeping the panel in place.
 * @returns the transport.
 */
export function createTransport(): Transport {
  const bridge = desktopBridge()
  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(CHANNEL) : null
  const listeners = new Set<(message: FloatMessage) => void>()

  const onMessage = (event: MessageEvent): void => {
    const message = event.data as FloatMessage | undefined
    if (message === undefined) return
    for (const listener of listeners) listener(message)
  }
  channel?.addEventListener('message', onMessage)

  return {
    available: bridge !== null,

    async open(request) {
      if (bridge === null) return null
      const result = await bridge.invoke(CHANNELS.open, request)
      return (result as PopoutRecord | null) ?? null
    },

    async close(id) {
      if (bridge === null) return false
      return Boolean(await bridge.invoke(CHANNELS.close, id))
    },

    async update(id, patch) {
      if (bridge === null) return false
      return Boolean(await bridge.invoke(CHANNELS.update, id, patch))
    },

    async list() {
      if (bridge === null) return []
      return (await bridge.invoke(CHANNELS.list)) as readonly PopoutRecord[]
    },

    async capturePage(id, rect) {
      if (bridge === null) return null
      const result = await bridge.invoke(CHANNELS.capturePage, id, rect)
      return typeof result === 'string' ? result : null
    },

    publish(message) {
      channel?.postMessage(message)
    },

    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    dispose() {
      listeners.clear()
      channel?.removeEventListener('message', onMessage)
      channel?.close()
    },
  }
}

/**
 * Ask for a window to be created for a panel, and report why not if it cannot.
 * @param transport - the transport to use.
 * @param request - the window to create.
 * @returns the created record, or a reason it could not be created.
 */
export async function requestDetach(
  transport: Transport,
  request: {
    readonly id: string
    readonly title: string
    readonly bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
    readonly attributes?: PopoutAttributes
  },
): Promise<{ readonly ok: true; readonly record: PopoutRecord } | { readonly ok: false; readonly reason: string }> {
  if (!transport.available) {
    return {
      ok: false,
      reason: 'Separate windows need the desktop app. In a browser, the panel stays in this window.',
    }
  }
  try {
    const record = await transport.open(request)
    if (record === null) return { ok: false, reason: 'The desktop shell did not create a window.' }
    transport.publish({ type: 'popout-opened', record })
    return { ok: true, record }
  } catch (error) {
    return { ok: false, reason: `Could not open a separate window: ${String(error)}` }
  }
}

/**
 * The id this renderer uses to identify itself in messages.
 *
 * A popout knows itself from its URL; the primary window has no such marker, so
 * one is generated. It only needs to be unique among open renderers, not
 * globally meaningful.
 * @returns this renderer's id.
 */
export function rendererId(): string {
  const params = new URLSearchParams(globalThis.location?.search ?? '')
  const popout = params.get('dsh-popout')
  if (popout !== null && popout !== '') return popout
  const key = 'dsh-better-float:renderer-id'
  const existing = sessionStorage.getItem(key)
  if (existing !== null) return existing
  const generated = `primary-${Math.random().toString(36).slice(2, 10)}`
  sessionStorage.setItem(key, generated)
  return generated
}
