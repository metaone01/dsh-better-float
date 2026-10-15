import type { Panel } from '../float/index.ts'
import type { Messages } from '../shared/i18n.ts'
import { browserIdentity } from '../shared/identity.ts'

/** Per-session consent; no input values are rendered in the confirmation itself. */
export function confirmCompanion(panel: Panel, messages: Messages, count: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted || !panel.root.isConnected) return Promise.resolve(false)
  const owner = panel.root.ownerDocument
  const previousFocus = owner.activeElement
  const section = owner.createElement('section')
  section.className = 'dsh-bf-warn'
  section.dataset.role = 'companion-confirm'
  section.style.maxHeight = '50%'
  section.style.overflow = 'auto'
  section.setAttribute('role', 'group')
  const title = owner.createElement('strong')
  title.id = `bf-consent-${browserIdentity()}`
  section.setAttribute('aria-labelledby', title.id)
  const body = owner.createElement('p')
  const privacy = owner.createElement('p')
  const actions = owner.createElement('div')
  actions.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap'
  const cancel = owner.createElement('button')
  cancel.type = 'button'; cancel.dataset.action = 'companion-cancel'
  const allow = owner.createElement('button')
  allow.type = 'button'; allow.dataset.action = 'companion-allow'
  for (const button of [cancel, allow]) button.style.cssText = 'font:inherit;padding:6px 10px;cursor:pointer'
  actions.append(cancel, allow); section.append(title, body, privacy, actions)
  const render = (): void => {
    title.textContent = messages.t('companionConfirmTitle')
    body.textContent = messages.t('companionConfirmBody', { count })
    privacy.textContent = messages.t('companionConfirmPrivacy')
    cancel.textContent = messages.t('companionCancel'); allow.textContent = messages.t('companionAllow')
  }
  render()
  const stopMessages = messages.subscribe(render)
  panel.root.append(section)
  // Leave some content visible without letting confirmation overflow the panel.
  const rect = panel.rect()
  const view = owner.defaultView!
  const height = Math.min(rect.height + Math.min(section.scrollHeight, 250), Math.max(110, view.innerHeight - 4))
  // Reachability clamping permits off-screen panel bodies; approval must stay in the viewport.
  panel.setRect({ ...rect, height,
    x: Math.max(0, Math.min(rect.x, view.innerWidth - rect.width - 4)),
    y: Math.max(0, Math.min(rect.y, view.innerHeight - height - 4)) })
  const expanded = panel.rect()
  cancel.focus({ preventScroll: true })
  return new Promise(resolve => {
    let finished = false
    const finish = (approved: boolean): void => {
      if (finished) return
      finished = true
      stopMessages(); signal.removeEventListener('abort', onAbort)
      section.remove()
      const current = panel.rect()
      if (current.height === expanded.height) {
        const unchanged = current.x === expanded.x && current.y === expanded.y && current.width === expanded.width
        panel.setRect(unchanged ? rect : { ...current, height: rect.height })
      }
      if (previousFocus instanceof owner.defaultView!.HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true })
      resolve(approved)
    }
    const onAbort = (): void => finish(false)
    signal.addEventListener('abort', onAbort, { once: true })
    cancel.addEventListener('click', () => finish(false))
    allow.addEventListener('click', () => finish(true))
    section.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(false) }
    })
    if (signal.aborted) finish(false)
  })
}
