import type { Messages } from '../shared/i18n.ts'

export type HintState = 'idle' | 'drag' | 'detach'
type InputIcon = 'click' | 'drag' | 'wheel'

function inputIcon(owner: Document, kind: InputIcon): SVGSVGElement {
  const svg = owner.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', '18')
  svg.setAttribute('height', '18')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.6')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  svg.dataset.inputIcon = kind
  const path = (data: string, accent = false): void => {
    const element = owner.createElementNS('http://www.w3.org/2000/svg', 'path')
    element.setAttribute('d', data)
    if (accent) element.setAttribute('stroke', 'var(--dsh-bf-input-accent)')
    svg.appendChild(element)
  }
  if (kind === 'drag') {
    path('M12 3v18M3 12h18M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3')
  } else {
    path('M11 3a5 5 0 0 0-5 5v8a5 5 0 0 0 10 0V8a5 5 0 0 0-5-5Z')
    if (kind === 'click') {
      path('M6 10h10M11 3v7')
      const pressed = owner.createElementNS('http://www.w3.org/2000/svg', 'path')
      pressed.setAttribute('d', 'M10 4a4 4 0 0 0-3 4v1h3Z')
      pressed.setAttribute('fill', 'var(--dsh-bf-input-accent)')
      pressed.setAttribute('stroke', 'none')
      svg.appendChild(pressed)
    } else {
      path('M11 6v4', true)
      path('M20 7v10M18 9l2-2 2 2M18 15l2 2 2-2', true)
    }
  }
  return svg
}

export function renderPickHint(hint: HTMLElement, state: HintState, messages: Messages): void {
  const owner = hint.ownerDocument
  const labels: string[] = []
  const iconKey = (kind: InputIcon): HTMLElement => {
    const label = messages.t(kind === 'click' ? 'inputClick' : kind === 'drag' ? 'inputDrag' : 'inputWheel')
    const key = owner.createElement('span')
    key.className = 'dsh-bf-key dsh-bf-key-icon'
    key.title = label
    key.setAttribute('aria-label', label)
    key.appendChild(inputIcon(owner, kind))
    return key
  }
  const keycap = (text: string): HTMLElement => {
    const key = owner.createElement('kbd')
    key.className = 'dsh-bf-key'
    key.textContent = text
    return key
  }
  const group = (inputs: readonly HTMLElement[], text: string, description: string): HTMLElement => {
    const item = owner.createElement('span')
    item.className = 'dsh-bf-hint-group'
    const controls = owner.createElement('span')
    controls.className = 'dsh-bf-hint-controls'
    controls.setAttribute('aria-hidden', 'true')
    controls.append(...inputs)
    const label = owner.createElement('span')
    label.className = 'dsh-bf-hint-action'
    label.textContent = text
    item.append(controls, label)
    labels.push(`${description}: ${text}`)
    return item
  }
  const groups = state === 'idle' ? [
    group([iconKey('click')], messages.t('pickClick'), messages.t('inputClick')),
    group([iconKey('drag')], messages.t('pickPull'), messages.t('inputDrag')),
    group([keycap('↑'), keycap('↓'), iconKey('wheel')], messages.t('pickAdjust'), `↑ / ↓ / ${messages.t('inputWheel')}`),
  ] : [
    group([iconKey(state === 'detach' ? 'click' : 'drag')], messages.t(state === 'detach' ? 'pickDetach' : 'pickDrag'), messages.t('inputDrag')),
  ]
  groups.push(group([keycap('Esc')], messages.t('pickCancel'), 'Esc'))
  hint.dataset.hintState = state
  hint.setAttribute('aria-label', labels.join(' · '))
  hint.replaceChildren(...groups)
}
