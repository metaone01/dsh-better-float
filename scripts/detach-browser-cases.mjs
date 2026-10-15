import { createPanel, wireDetach } from '../src/float/index.ts'
import { createPanelManager } from '../src/float/manager.ts'
import { createDetachController } from '../src/detach/controller.ts'
import { createTransport, CHANNELS } from '../src/detach/transport.ts'
import { beginDrag } from '../src/float/pointer.ts'
import { startPick } from '../src/scout/index.ts'
import { createDropzone } from '../src/detach/dropzone.ts'
import { LOCALE_NAMESPACE, en, zh, messagesFor } from '../src/shared/i18n.ts'
import { createLocaleFixture } from './i18n-fixture.mjs'

export async function run({ allowBridgeMock = true } = {}) {
  let checks = 0
  const cleanups = []
  const equal = (actual, expected, label) => {
    checks++
    if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}`)
  }
  const locale = createLocaleFixture('zh')
  cleanups.push(locale.register(LOCALE_NAMESPACE, { en, zh }))
  const messages = messagesFor(locale)
  const fixture = document.createElement('section')
  fixture.dataset.detachFixture = ''
  fixture.style.cssText = 'position:fixed;top:30px;left:30px;width:240px;height:160px;z-index:2147483646;background:white'
  const target = document.createElement('input')
  target.value = 'original state'
  target.style.cssText = 'display:block;width:180px;height:50px'
  fixture.append(target)
  document.documentElement.append(fixture)
  cleanups.push(() => fixture.remove())
  let stops = 0
  const panel = createPanel(document, { title: 'Detach regression', messages,
    rect: { x: 300, y: 100, width: 240, height: 150 },
    onClose() { stops++; equal(panel.root.isConnected, true, 'close restores before disconnecting source') },
  })
  cleanups.push(() => panel.close())
  const controller = createDetachController(createTransport({ timeoutMs: 20 }))
  cleanups.push(() => controller.dispose())
  let requested
  wireDetach(panel, () => { requested = controller.request(panel) })
  const detach = panel.root.querySelector('[data-action="detach"]')
  const status = panel.root.querySelector('[data-role="status"]')
  const pointer = (node, type, x, y, id = 1) => node.dispatchEvent(new PointerEvent(type, {
    bubbles: true, cancelable: true, button: 0, pointerId: id, clientX: x, clientY: y,
  }))
  try {
    equal(detach.title, zh.detach, 'Chinese detach button')
    detach.click()
    await requested
    equal(status.hidden, false, 'detach result is visible')
    equal(panel.root.isConnected, true, 'failed detach retains panel')
    if (!globalThis.dshDesktop?.invoke) equal(status.textContent, zh.detachUnavailable, 'missing host feedback')
    const statusKey = ['detachUnavailable', 'detachNotReady', 'detachBackendError'].find(key => zh[key] === status.textContent)
    equal(typeof statusKey, 'string', 'detach reports a known result')
    locale.setLanguage('en')
    equal(detach.title, en.detach, 'English detach button')
    equal(status.textContent, en[statusKey], 'status follows language')
    detach.click()
    await requested
    equal(status.hidden, false, 'English detach click stays wired')

    if (allowBridgeMock) {
      const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'dshDesktop')
      let invoked = []
      Object.defineProperty(globalThis, 'dshDesktop', { configurable: true, value: {
        invoke: async (channel) => { invoked.push(channel); return [] },
      } })
      const bridgeController = createDetachController(createTransport({ timeoutMs: 20 }))
      try {
        const first = bridgeController.request(panel)
        equal(bridgeController.request(panel), first, 'double request is coalesced')
        await first
        equal(status.textContent, en.detachNotReady, 'backend exists without content renderer')
        equal(invoked.join(','), CHANNELS.list, 'read-only probe does not open empty window')
      } finally {
        bridgeController.dispose()
        if (descriptor) Object.defineProperty(globalThis, 'dshDesktop', descriptor)
        else delete globalThis.dshDesktop
      }
    }

    const bar = panel.root.querySelector('.dsh-bf-bar')
    let captured = null
    bar.setPointerCapture = id => { captured = id }
    bar.hasPointerCapture = id => captured === id
    bar.releasePointerCapture = () => { captured = null }
    const origin = panel.rect()
    pointer(bar, 'pointerdown', 310, 110)
    pointer(bar, 'pointermove', 330, 130)
    equal(panel.rect().x, origin.x + 20, 'header drag moves panel')
    pointer(bar, 'pointermove', 500, 300, 9)
    equal(panel.rect().x, origin.x + 20, 'other pointer cannot move panel')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    equal(panel.rect().x, origin.x, 'Escape restores drag origin')
    equal(captured, null, 'cancel releases pointer capture')
    pointer(bar, 'pointerdown', 310, 110)
    pointer(bar, 'pointermove', 330, 130)
    pointer(bar, 'lostpointercapture', 330, 130)
    equal(panel.rect().x, origin.x, 'lost capture cancels drag')
    pointer(bar, 'pointerdown', 310, 110)
    pointer(bar, 'pointermove', 330, 130)
    window.dispatchEvent(new Event('blur'))
    equal(panel.rect().x, origin.x, 'window blur cancels drag')
    pointer(bar, 'pointerdown', 310, 110)
    pointer(bar, 'pointerup', 335, 135)
    equal(panel.rect().x, origin.x + 25, 'release uses final pointer position')

    const button = document.createElement('button')
    const icon = document.createElement('span')
    button.append(icon)
    bar.append(button)
    let starts = 0
    const stopNested = beginDrag(bar, { onStart: () => starts++, onMove() {} })
    pointer(icon, 'pointerdown', 310, 110)
    equal(starts, 0, 'nested button icon does not start drag')
    stopNested()
    button.remove()

    let dropped = 0
    const zone = createDropzone(document, { onArmed() {}, onDrop() { dropped++ } })
    zone.begin()
    equal(zone.offer({ x: 1, y: 100 }), 'left', 'edge prearms')
    zone.cancel()
    equal(zone.release(), false, 'cancelled edge cannot detach')
    equal(dropped, 0, 'cancelled edge leaves window alone')
    zone.begin()
    zone.offer({ x: 1, y: 100 })
    equal(zone.release(), true, 'edge release requests detach')
    equal(zone.release(), false, 'release is one-shot')
    equal(dropped, 1, 'one drop action')
    const disabled = createDropzone(document, { enabled: false, onArmed() {}, onDrop() { dropped++ } })
    disabled.begin()
    equal(disabled.offer({ x: 1, y: 100 }), null, 'no edge detach without capability')
    equal(disabled.release(), false, 'disabled release does not detach')

    let outcome
    const pick = startPick(document, { detachEnabled: false, messages, onDone(value) { outcome = value } })
    cleanups.push(() => pick.cancel())
    pointer(document, 'pointermove', 80, 55)
    pointer(document, 'pointerdown', 80, 55)
    pointer(document, 'pointercancel', 80, 55, 9)
    equal(document.querySelector('.dsh-bf-root') !== null, true, 'foreign cancel does not terminate picker')
    pointer(document, 'pointercancel', 80, 55)
    equal(outcome.type, 'cancelled', 'pointercancel ends picker')
    equal(document.querySelector('.dsh-bf-root'), null, 'cancel releases picker surface')

    const manager = createPanelManager(document, { onDetachRequest: panel => { void controller.request(panel) } }, messages)
    cleanups.push(() => { manager.dispose(); manager.closeAll() })
    manager.pick(false)
    pointer(document, 'pointermove', 80, 55)
    pointer(document, 'pointerdown', 80, 55)
    pointer(document, 'pointerup', 80, 55)
    equal(manager.count(), 1, 'manager opens a live panel')
    equal(target.closest('.dsh-bf-panel') !== null, true, 'actual source node moves into panel')
    equal(target.value, 'original state', 'input value survives extraction')
    const managed = manager.entries()[0].panel
    await controller.request(managed)
    equal(target.isConnected, true, 'detach downgrade leaves source connected')
    managed.close()
    equal(target.parentElement, fixture, 'close restores exact source parent')
    equal(target.value, 'original state', 'input value survives restore')
    equal(manager.count(), 0, 'close releases manager entry')
    managed.close()
    equal(manager.count(), 0, 'second close is harmless')

    manager.pick(true)
    pointer(document, 'pointermove', 80, 55)
    pointer(document, 'pointerdown', 80, 55)
    pointer(document, 'pointermove', 1, 55)
    pointer(document, 'pointerup', 1, 55)
    const edgePanel = manager.entries()[0].panel
    await controller.request(edgePanel)
    equal(target.closest('.dsh-bf-panel'), edgePanel.root, 'edge detach keeps real node instead of cloning')
    equal(target.value, 'original state', 'edge detach retains editable state')
    fixture.removeChild(target)
    await new Promise(resolve => setTimeout(resolve, 0))
    equal(manager.count(), 0, 'host child removal automatically closes panel')
    equal(target.parentElement !== fixture, true, 'host removal cannot be undone by close')
    fixture.append(target)

    for (const [tag, key] of [['canvas', 'canvasWarning'], ['iframe', 'iframeWarning'], ['video', 'mediaWarning']]) {
      const media = document.createElement(tag)
      media.style.cssText = 'display:block;width:180px;height:50px'
      if (tag === 'iframe') media.src = 'about:blank'
      target.replaceWith(media)
      manager.pick(false)
      pointer(document, 'pointermove', 80, 55)
      pointer(document, 'pointerdown', 80, 55)
      pointer(document, 'pointerup', 80, 55)
      equal(manager.entries()[0]?.panel.root.querySelector('.dsh-bf-warn')?.textContent,
        messages.t(key), `${tag} root receives its warning`)
      manager.closeAll()
      media.replaceWith(target)
    }
    panel.close()
    panel.close()
    equal(stops, 1, 'panel cleanup runs exactly once')
    return { checks, origin: location.origin, bridgePresent: typeof globalThis.dshDesktop?.invoke === 'function',
      input: 'synthetic regression; not trusted-pointer or native-window acceptance' }
  } finally {
    for (const cleanup of cleanups.reverse()) cleanup()
    controller.dispose()
    panel.close()
  }
}

let trustedPanel
let trustedController
export function prepareTrusted() {
  let source = document.querySelector('[data-trusted-source]')
  if (source) throw new Error('Trusted fixture already exists')
  source = document.createElement('input')
  source.dataset.trustedSource = ''
  source.value = 'state stays live'
  document.body.append(source)
  trustedPanel = createPanel(document, { title: 'Trusted mouse regression',
    rect: { x: 100, y: 100, width: 280, height: 200 }, onClose() {} })
  trustedPanel.body.append(source)
  trustedController = createDetachController()
  wireDetach(trustedPanel, () => { void trustedController.request(trustedPanel) })
  const bar = trustedPanel.root.querySelector('.dsh-bf-bar').getBoundingClientRect()
  const detach = trustedPanel.root.querySelector('[data-action="detach"]').getBoundingClientRect()
  trustedPanel.root.addEventListener('pointerdown', event => { trustedPanel.root.dataset.trusted = String(event.isTrusted) }, true)
  return { x: Math.round(bar.x + 30), y: Math.round(bar.y + bar.height / 2),
    detach: { x: Math.round(detach.x + detach.width / 2), y: Math.round(detach.y + detach.height / 2) } }
}

export function trustedState() {
  return { rect: trustedPanel.rect(), trusted: trustedPanel.root.dataset.trusted,
    status: trustedPanel.root.querySelector('[data-role="status"]').textContent,
    input: trustedPanel.body.querySelector('input').value }
}

export function cleanupTrusted() {
  trustedController?.dispose()
  trustedPanel?.close()
  trustedController = null
  trustedPanel = null
}
