/** IPC manages native windows; BroadcastChannel carries validated descriptions only. */
export interface PopoutAttributes {
  readonly alwaysOnTop?: boolean
  readonly clickThrough?: boolean
  readonly frameless?: boolean
  readonly transparent?: boolean
  readonly resizable?: boolean
}

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
  readonly bounds: PopoutRecord['bounds']
  readonly attributes?: PopoutAttributes
  readonly snapshot?: string
}

export type FloatMessage =
  | { readonly type: 'popout-opened'; readonly record: PopoutRecord }
  | { readonly type: 'popout-closed'; readonly id: string }
  | { readonly type: 'popout-updated'; readonly record: PopoutRecord }
  | { readonly type: 'claim'; readonly id: string; readonly from: string }
  | { readonly type: 'release'; readonly id: string; readonly from: string }

export const FLOAT_PROTOCOL_VERSION = 1
const CHANNEL = 'dsh-better-float:v1'
const ATTRIBUTE_KEYS = ['alwaysOnTop', 'clickThrough', 'frameless', 'transparent', 'resizable'] as const

interface DesktopBridge {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
}

export function desktopBridge(): DesktopBridge | null {
  const candidate = (globalThis as { dshDesktop?: unknown }).dshDesktop
  if (candidate === undefined || candidate === null) return null
  if (typeof (candidate as DesktopBridge).invoke !== 'function') return null
  return candidate as DesktopBridge
}

/** The installed host patch still uses raw IPC arguments, not protocol envelopes. */
export const CHANNELS = {
  open: 'dsh-desktop:better-float-open',
  close: 'dsh-desktop:better-float-close',
  update: 'dsh-desktop:better-float-update',
  list: 'dsh-desktop:better-float-list',
  changed: 'dsh-desktop:better-float-changed',
  capturePage: 'dsh-desktop:better-float-capture-page',
  toggleClickThrough: 'dsh-desktop:better-float-toggle-click-through',
} as const

export type TransportErrorCode =
  | 'missing-bridge' | 'backend-unverified' | 'backend-error' | 'timeout'
  | 'invalid-request' | 'invalid-response' | 'disposed' | 'content-unavailable'

export interface TransportFailure {
  readonly code: TransportErrorCode
  readonly reason: string
  readonly requestId?: string
}

export interface TransportCapabilities {
  readonly bridgePresent: boolean
  readonly windowManagement: 'missing' | 'unverified' | 'reachable' | 'unavailable'
  /** No popup renderer/semantic adapter has been implemented in this plugin yet. */
  readonly contentPresentation: false
  readonly reason: TransportFailure
}

export interface Transport {
  open(request: OpenPopoutRequest): Promise<PopoutRecord | null>
  close(id: string): Promise<boolean>
  update(id: string, patch: Partial<PopoutRecord>): Promise<boolean>
  list(): Promise<readonly PopoutRecord[]>
  capturePage(id: string, rect: PopoutRecord['bounds']): Promise<string | null>
  publish(message: FloatMessage): void
  subscribe(listener: (message: FloatMessage) => void): () => void
  /** Compatibility flag: a validated backend reply, never just bridge presence. */
  readonly available: boolean
  readonly capabilities: TransportCapabilities
  readonly lastFailure: TransportFailure | null
  /** Read-only list probe; does not create a window or move a panel. */
  probe(): Promise<TransportCapabilities>
  dispose(): void
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function id(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
}

function bounds(value: unknown): value is PopoutRecord['bounds'] {
  return object(value) && ['x', 'y', 'width', 'height'].every((key) =>
    typeof value[key] === 'number' && Number.isFinite(value[key]))
    && (value.width as number) > 0 && (value.height as number) > 0
}

function attributes(value: unknown, complete = false): value is Required<PopoutAttributes> {
  return object(value) && Object.keys(value).every((key) =>
    ATTRIBUTE_KEYS.includes(key as typeof ATTRIBUTE_KEYS[number]) && typeof value[key] === 'boolean')
    && (!complete || ATTRIBUTE_KEYS.every((key) => typeof value[key] === 'boolean'))
}

function record(value: unknown): value is PopoutRecord {
  return object(value) && id(value.id) && typeof value.title === 'string' && value.title.length <= 4096
    && bounds(value.bounds) && attributes(value.attributes, true) && typeof value.alive === 'boolean'
}

function message(value: unknown): value is FloatMessage {
  if (!object(value)) return false
  switch (value.type) {
    case 'popout-opened':
    case 'popout-updated': return record(value.record)
    case 'popout-closed': return id(value.id)
    case 'claim':
    case 'release': return id(value.id) && id(value.from)
    default: return false
  }
}

function openRequest(value: OpenPopoutRequest): boolean {
  return object(value) && id(value.id) && typeof value.title === 'string' && value.title.length <= 4096
    && bounds(value.bounds) && (value.attributes === undefined || attributes(value.attributes))
    && (value.snapshot === undefined || (typeof value.snapshot === 'string' && value.snapshot.length <= 1_000_000))
}

function updatePatch(value: Partial<PopoutRecord>): boolean {
  return object(value) && Object.keys(value).every((key) => key === 'bounds' || key === 'attributes')
    && (value.bounds === undefined || bounds(value.bounds))
    && (value.attributes === undefined || attributes(value.attributes))
}

function failure(code: TransportErrorCode, requestId?: string): TransportFailure {
  const reasons: Record<TransportErrorCode, string> = {
    'missing-bridge': 'The current host has no independent-window IPC bridge.',
    'backend-unverified': 'The bridge exists, but the window backend has not been verified.',
    'backend-error': 'The window backend rejected the request or is unavailable.',
    timeout: 'The window backend did not respond within the time limit.',
    'invalid-request': 'The window request does not match the supported contract.',
    'invalid-response': 'The window backend returned an invalid response.',
    disposed: 'The window transport has been disposed.',
    'content-unavailable': 'A window backend is reachable, but popup content rendering is not implemented.',
  }
  return { code, reason: reasons[code], ...(requestId === undefined ? {} : { requestId }) }
}

/** No call can wait forever. A timeout does not cancel an already-running IPC operation. */
export function createTransport(options: { readonly timeoutMs?: number } = {}): Transport {
  const bridge = desktopBridge()
  const requestedTimeout = options.timeoutMs ?? 1500
  const timeoutMs = Number.isFinite(requestedTimeout) ? Math.min(30_000, Math.max(10, requestedTimeout)) : 1500
  let channel: BroadcastChannel | null = null
  try {
    if (typeof BroadcastChannel === 'function') channel = new BroadcastChannel(CHANNEL)
  } catch { /* Storage policy can disable the channel without disabling L0. */ }
  const listeners = new Set<(message: FloatMessage) => void>()
  const pending = new Set<() => void>()
  const revisions = new Map<string, number>()
  const sender = `renderer-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`
  let revision = 0
  let sequence = 0
  let disposed = false
  let backend: TransportCapabilities['windowManagement'] = bridge === null ? 'missing' : 'unverified'
  let lastFailure: TransportFailure | null = bridge === null ? failure('missing-bridge') : null

  function capabilities(): TransportCapabilities {
    return {
      bridgePresent: bridge !== null,
      windowManagement: backend,
      contentPresentation: false,
      reason: disposed ? failure('disposed') : backend === 'reachable' ? failure('content-unavailable')
        : lastFailure ?? failure('backend-unverified'),
    }
  }

  function reject(code: TransportErrorCode): void { lastFailure = failure(code) }

  async function invoke<T>(name: string, args: unknown[], valid: (value: unknown) => value is T): Promise<T | null> {
    if (disposed) { reject('disposed'); return null }
    if (bridge === null) { reject('missing-bridge'); return null }
    const requestId = `${sender}:${++sequence}`
    return new Promise((resolve) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout>
      const finish = (result: T | null, code?: TransportErrorCode): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        pending.delete(cancel)
        if (code !== undefined) {
          lastFailure = failure(code, requestId)
          if (code !== 'disposed') backend = 'unavailable'
        } else {
          lastFailure = null
          backend = 'reachable'
        }
        resolve(result)
      }
      const cancel = (): void => finish(null, 'disposed')
      pending.add(cancel)
      timer = setTimeout(() => finish(null, 'timeout'), timeoutMs)
      Promise.resolve().then(() => settled ? undefined : bridge.invoke(name, ...args)).then((value) => {
        if (valid(value)) finish(value)
        else finish(null, 'invalid-response')
      }, () => finish(null, 'backend-error'))
    })
  }

  const onMessage = (event: MessageEvent): void => {
    if (disposed) return
    const envelope: unknown = event.data
    if (!object(envelope) || envelope.version !== FLOAT_PROTOCOL_VERSION || !id(envelope.sender)
      || !id(envelope.requestId) || envelope.sender === sender
      || typeof envelope.revision !== 'number' || !Number.isSafeInteger(envelope.revision)
      || envelope.revision < 1 || !message(envelope.message)) return
    if ((revisions.get(envelope.sender) ?? 0) >= envelope.revision) return
    // Bounded deduplication, not authentication: same-origin scripts can still impersonate a sender.
    if (revisions.size >= 256 && !revisions.has(envelope.sender)) revisions.delete(revisions.keys().next().value!)
    revisions.set(envelope.sender, envelope.revision)
    for (const listener of listeners) {
      try { listener(envelope.message) } catch { /* One observer must not break lifecycle delivery. */ }
    }
  }
  channel?.addEventListener('message', onMessage)

  const transport: Transport = {
    get available() { return !disposed && backend === 'reachable' },
    get capabilities() { return capabilities() },
    get lastFailure() { return lastFailure },
    async probe() { await transport.list(); return capabilities() },
    async open(request) {
      if (!openRequest(request)) { reject('invalid-request'); return null }
      const result = await invoke(CHANNELS.open, [request], (value): value is PopoutRecord | null => value === null || record(value))
      if (result !== null && (result.id !== request.id || !result.alive)) {
        backend = 'unavailable'
        reject('invalid-response')
        return null
      }
      return result
    },
    async close(value) {
      if (!id(value)) { reject('invalid-request'); return false }
      return await invoke(CHANNELS.close, [value], (result): result is boolean => typeof result === 'boolean') ?? false
    },
    async update(value, patch) {
      if (!id(value) || !updatePatch(patch)) { reject('invalid-request'); return false }
      return await invoke(CHANNELS.update, [value, patch], (result): result is boolean => typeof result === 'boolean') ?? false
    },
    async list() {
      return await invoke(CHANNELS.list, [], (value): value is PopoutRecord[] => Array.isArray(value)
        && value.length <= 1024 && value.every(record)) ?? []
    },
    async capturePage(value, rect) {
      if (!id(value) || !bounds(rect)) { reject('invalid-request'); return null }
      return await invoke(CHANNELS.capturePage, [value, rect], (result): result is string | null => result === null
        || (typeof result === 'string' && result.length <= 24_000_000 && /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(result)))
    },
    publish(value) {
      if (disposed || !message(value)) return
      try { channel?.postMessage({ version: FLOAT_PROTOCOL_VERSION, sender, requestId: `${sender}:${++sequence}`, revision: ++revision, message: value }) }
      catch { /* Closed/denied channels must not break the original panel. */ }
    },
    subscribe(listener) {
      if (!disposed) listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    dispose() {
      if (disposed) return
      disposed = true
      for (const cancel of pending) cancel()
      listeners.clear()
      revisions.clear()
      channel?.removeEventListener('message', onMessage)
      channel?.close()
      channel = null
    },
  }
  return transport
}

export type DetachResult = { readonly ok: true; readonly record: PopoutRecord }
  | ({ readonly ok: false } & TransportFailure)

/** Never remove the real panel merely because a shell can create an empty window. */
export async function requestDetach(transport: Transport, request: OpenPopoutRequest): Promise<DetachResult> {
  if (!openRequest(request)) return { ok: false, ...failure('invalid-request') }
  const capability = await transport.probe()
  if (!capability.contentPresentation) return { ok: false, ...capability.reason }
  const result = await transport.open(request)
  if (result === null) return { ok: false, ...(transport.lastFailure ?? failure('backend-error')) }
  transport.publish({ type: 'popout-opened', record: result })
  return { ok: true, record: result }
}

export function rendererId(): string {
  const params = new URLSearchParams(globalThis.location?.search ?? '')
  const popout = params.get('dsh-popout')
  if (popout !== null && popout !== '') return popout
  const key = 'dsh-better-float:renderer-id'
  try {
    const existing = sessionStorage.getItem(key)
    if (existing !== null) return existing
  } catch { /* The ID also works when sessionStorage is denied. */ }
  const generated = `primary-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2, 10)}`
  try { sessionStorage.setItem(key, generated) } catch { /* No persistent storage is required. */ }
  return generated
}
