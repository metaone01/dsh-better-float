import { createTransport, requestDetach, type Transport } from './transport.ts'
import { createCompanionBridge, type CompanionBridge } from './companion.ts'
import { captureControls, openSemanticControls, CompanionSelectionSizeError } from './semantic-adapter.ts'
import { confirmCompanion } from './consent.ts'
import { englishMessages, type Messages } from '../shared/i18n.ts'
import type { Panel } from '../float/index.ts'
import {selectionFailure} from './selection-failure.ts'

interface Session {
  readonly abort: AbortController
  readonly stopClose: () => void
  handle?: { close(): void }
  active: boolean
}
export interface DetachOptions {
  readonly messages?: Messages
  readonly companion?: () => CompanionBridge
}

/** One approved companion session per live panel; missing backends never move it. */
export function createDetachController(transport: Transport = createTransport(), options: DetachOptions = {}) {
  const pending = new Map<Panel, Promise<void>>()
  const sessions = new Map<Panel, Session>()
  const messages = options.messages ?? englishMessages
  const bridgeFor = options.companion ?? createCompanionBridge
  let disposed = false

  function release(panel: Panel): void {
    const session = sessions.get(panel)
    if (!session) return
    sessions.delete(panel)
    session.active = false
    session.abort.abort()
    session.handle?.close()
    session.stopClose()
  }

  async function connect(panel: Panel, source: Element, session: Session): Promise<void> {
    let count: number
    let preflight: ReturnType<typeof captureControls>
    try { preflight = captureControls(source); count = preflight.read(0).controls.length }
    catch(error) { panel.showStatus(selectionFailure(error)); return }
    panel.showStatus('detachChecking')
    const probe = bridgeFor()
    let availability
    const stopProbe = (): void => probe.dispose()
    session.abort.signal.addEventListener('abort', stopProbe, { once: true })
    try { availability = await probe.ping() }
    finally { session.abort.signal.removeEventListener('abort', stopProbe); probe.dispose() }
    if (disposed || session.abort.signal.aborted) return
    if (!availability.ok) {
      panel.showStatus(availability.error.code === 'companion/not-configured' ? 'companionNotConfigured' : 'companionUnavailable')
      return
    }
    panel.showStatus('companionReview')
    const allowed = await confirmCompanion(panel, messages, count, session.abort.signal)
    if (disposed || session.abort.signal.aborted) return
    if (!allowed) { panel.showStatus('companionCancelled'); return }
    // Selection may have changed while the user reviewed the prompt.
    try { preflight.read(0) }
    catch(error) { panel.showStatus(selectionFailure(error)); return }
    panel.showStatus('companionConnecting')
    const handle = await openSemanticControls(source, status => {
      if (disposed || session.abort.signal.aborted) return
      panel.root.dataset.companionState = status
      panel.showStatus(status === 'connected' ? 'companionConnected'
        : status === 'closed' ? 'companionClosed' : status === 'frame-too-large' ? 'companionTooLarge' : 'companionDisconnected')
      if (status !== 'connected') session.active = false
    }, { signal: session.abort.signal, bridge: bridgeFor() })
    if (disposed || session.abort.signal.aborted) { handle.close(); return }
    session.handle = handle
    session.active = true
  }

  return {
    request(panel: Panel, source?: Element): Promise<void> {
      if (disposed || !panel.root.isConnected) return Promise.resolve()
      const existing = pending.get(panel)
      if (existing) return existing
      if (sessions.get(panel)?.active) { panel.showStatus('companionConnected'); return Promise.resolve() }
      release(panel)
      const abort = new AbortController()
      const session: Session = { abort, active: false, stopClose: panel.onClose(() => release(panel)) }
      sessions.set(panel, session)
      const task = (async () => {
        if (source) { await connect(panel, source, session); return }
        // Retain the host-patch capability path for callers without a source.
        panel.showStatus(transport.capabilities.bridgePresent ? 'detachChecking' : 'detachUnavailable')
        const result = await requestDetach(transport, {
          id: `panel-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`,
          title: panel.root.getAttribute('aria-label') ?? '', bounds: panel.rect(),
        })
        if (disposed || abort.signal.aborted || result.ok || result.code === 'disposed') return
        panel.showStatus(result.code === 'content-unavailable' ? 'detachNotReady'
          : result.code === 'missing-bridge' ? 'detachUnavailable' : 'detachBackendError')
      })().catch(error => {
        if (!disposed && !abort.signal.aborted) panel.showStatus(error instanceof CompanionSelectionSizeError ? 'companionTooLarge'
          : source ? 'companionUnavailable' : 'detachBackendError')
      }).finally(() => {
        pending.delete(panel)
        if (!session.active && sessions.get(panel) === session) release(panel)
      })
      pending.set(panel, task)
      return task
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      for (const panel of [...sessions.keys()]) release(panel)
      transport.dispose()
    },
  }
}
export type DetachController = ReturnType<typeof createDetachController>
