import { en, zh, LOCALE_NAMESPACE, messagesFor } from '../src/shared/i18n.ts'
import { createPanel } from '../src/float/index.ts'
import { createOverview } from '../src/float/overview.ts'
import { startPick } from '../src/scout/index.ts'
import { apply } from '../src/client/index.ts'
import { createLocaleFixture } from './i18n-fixture.mjs'

export async function run() {
  let checks = 0
  const equal = (actual, expected, label) => {
    if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
    checks++
  }
  const locale = createLocaleFixture()
  const removeDictionary = locale.register(LOCALE_NAMESPACE, { en, zh })
  const messages = messagesFor(locale)
  const panel = createPanel(document, {
    title: '用户标题 <Project>', rect: { x: 60, y: 60, width: 360, height: 240 }, messages,
    warningKeys: ['canvasWarning', 'iframeWarning', 'mediaWarning'], onClose() {},
  })
  const content = document.createElement('p')
  content.textContent = '用户原文 Content'
  panel.body.append(content)
  for (const language of ['en', 'zh', 'en']) {
    locale.setLanguage(language)
    const dictionary = language === 'zh' ? zh : en
    const buttons = panel.root.querySelectorAll('button')
    equal(buttons[0].title, dictionary.detach, 'detach tooltip')
    equal(buttons[0].getAttribute('aria-label'), dictionary.detach, 'detach accessibility label')
    equal(buttons[1].title, dictionary.close, 'close tooltip')
    equal(buttons[1].getAttribute('aria-label'), dictionary.close, 'close accessibility label')
    equal(panel.root.querySelector('.dsh-bf-warn').textContent,
      [dictionary.canvasWarning, dictionary.iframeWarning, dictionary.mediaWarning].join(' '), 'all warnings are visible')
    equal(panel.root.querySelector('.dsh-bf-warn').title,
      [dictionary.canvasWarning, dictionary.iframeWarning, dictionary.mediaWarning].join('\n'), 'all warnings')
    equal(panel.root.querySelector('.dsh-bf-title').textContent, '用户标题 <Project>', 'preserve element title')
    equal(content.textContent, '用户原文 Content', 'preserve user content')
  equal(panel.root.isConnected, true, 'keep the same panel')
  }
  const brokenPreview = { ...panel, root: Object.assign(document.createElement('div'), {
    cloneNode() { throw new Error('Unavailable preview fixture') },
  }) }
  const failedOverview = createOverview(document, [{ panel: brokenPreview, title: 'Preview failure' }], () => {}, messages)
  locale.setLanguage('zh')
  await Promise.resolve()
  equal(failedOverview.root.querySelector('.dsh-bf-overview-preview').textContent, zh.previewUnavailable, 'late preview failure uses current language')
  locale.setLanguage('en')
  equal(failedOverview.root.querySelector('.dsh-bf-overview-preview').textContent, en.previewUnavailable, 'preview failure switches live')
  failedOverview.close()
  let overview = createOverview(document, [], () => {}, messages)
  for (const language of ['en', 'zh']) {
    locale.setLanguage(language)
    const dictionary = language === 'zh' ? zh : en
    equal(overview.root.querySelector('h2').textContent, dictionary.overviewTitle, 'overview title')
    equal(overview.root.getAttribute('aria-label'), dictionary.overviewTitle, 'overview accessibility label')
    equal(overview.root.querySelector('p').textContent, dictionary.overviewEmpty, 'overview empty state')
    equal(overview.root.scrollWidth <= innerWidth, true, 'overview fits viewport')
  }
  overview.close()
  let recalled = null
  overview = createOverview(document, [{ panel, title: '用户标题 <Project>' }], (_panel, point) => { recalled = point }, messages)
  equal(overview.root.querySelector('button').getAttribute('aria-label'), '召回 用户标题 <Project>', 'recall label')
  overview.root.querySelector('button').click()
  equal(recalled, null, 'selection does not recall immediately')
  equal(overview.root.dataset.placing, 'true', 'placement remains active')
  equal(overview.root.getAttribute('aria-label'), '放置 用户标题 <Project>', 'placement Chinese label')
  locale.setLanguage('en')
  equal(overview.root.getAttribute('aria-label'), 'Place 用户标题 <Project>', 'placement label switches live')
  equal(overview.root.dataset.placing, 'true', 'switching language preserves selection')
  overview.root.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 440, clientY: 280 }))
  overview.root.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, clientX: 440, clientY: 280 }))
  equal(recalled?.x, 440, 'recall x coordinate')
  equal(recalled?.y, 280, 'recall y coordinate')
  equal(overview.root.isConnected, false, 'placement closes overview')
  overview = createOverview(document, [], () => {}, messages)
  overview.root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  equal(overview.root.isConnected, false, 'Escape closes overview')
  panel.close()
  equal(locale.listeners.size, 0, 'closed surfaces release subscriptions')

  const target = document.createElement('div')
  target.id = 'i18n-target'
  target.style.cssText = 'position:fixed;left:50px;top:50px;width:200px;height:120px;background:#ddd'
  target.textContent = '不翻译的页面内容'
  document.body.append(target)
  const pointer = (type, clientX, clientY) => document.dispatchEvent(new PointerEvent(type,
    { bubbles: true, pointerId: 1, button: 0, clientX, clientY }))
  let outcome = null
  const pick = startPick(document, { messages, detachEnabled: true, onDone: (result) => { outcome = result } })
  const hint = document.querySelector('.dsh-bf-hint')
  const idleText = (dictionary) => dictionary.pickClick + dictionary.pickPull + '↑↓' + dictionary.pickAdjust + 'Esc' + dictionary.pickCancel
  equal(hint.textContent, idleText(en), 'picker English idle')
  equal(hint.textContent.includes('/'), false, 'keycaps have no visible slash separators')
  equal(hint.querySelectorAll('kbd').length, 3, 'arrow and Escape keycaps')
  equal(hint.querySelectorAll('svg').length, 3, 'click, drag and wheel icons')
  equal(hint.querySelector('[data-input-icon="wheel"]').parentElement.title, en.inputWheel, 'wheel icon tooltip')
  equal(hint.getAttribute('aria-label').includes('↑ / ↓ / Mouse wheel'), true, 'wheel has a text alternative')
  equal(Number.parseFloat(getComputedStyle(hint.querySelector('kbd')).borderRadius) > 0, true, 'rounded keycaps')
  const withinViewport = () => {
    const rect = hint.getBoundingClientRect()
    return rect.left >= 0 && rect.right <= innerWidth && hint.scrollWidth <= hint.clientWidth
  }
  equal(withinViewport(), true, 'English hint fits viewport')
  locale.setLanguage('zh')
  equal(hint.textContent, idleText(zh), 'picker Chinese idle')
  equal(hint.querySelector('[data-input-icon="wheel"]').parentElement.title, zh.inputWheel, 'Chinese wheel tooltip')
  equal(withinViewport(), true, 'Chinese hint fits viewport')
  const initialScheme = document.documentElement.style.colorScheme
  const firstGroup = hint.firstElementChild
  const hintSize = hint.getBoundingClientRect()
  const label = document.querySelector('.dsh-bf-label')
  const key = hint.querySelector('kbd')
  const clickAccent = hint.querySelector('[data-input-icon="click"] path[fill]')
  const wheelAccent = hint.querySelector('[data-input-icon="wheel"] path:nth-child(2)')
  for (const scheme of ['light', 'dark', 'light']) {
    // ThemePresenter publishes the resolved app scheme on html, independently of the OS.
    document.documentElement.style.colorScheme = scheme
    const dark = scheme === 'dark'
    const background = dark ? 'rgba(24, 34, 56, 0.96)' : 'rgba(255, 255, 255, 0.98)'
    const foreground = dark ? 'rgb(234, 241, 255)' : 'rgb(38, 51, 71)'
    equal(getComputedStyle(hint).backgroundColor, background, `${scheme} hint background`)
    equal(getComputedStyle(hint).color, foreground, `${scheme} hint text`)
    equal(getComputedStyle(label).backgroundColor, background, `${scheme} element label background`)
    equal(getComputedStyle(label).color, foreground, `${scheme} element label text`)
    equal(getComputedStyle(key).backgroundColor, dark ? 'rgba(167, 199, 255, 0.1)' : 'rgb(241, 245, 251)', `${scheme} key background`)
    equal(getComputedStyle(key).color, dark ? 'rgb(240, 245, 255)' : 'rgb(51, 65, 85)', `${scheme} key text`)
    equal(getComputedStyle(clickAccent).fill, dark ? 'rgb(167, 199, 255)' : 'rgb(37, 99, 235)', `${scheme} mouse press accent`)
    equal(getComputedStyle(wheelAccent).stroke, dark ? 'rgb(167, 199, 255)' : 'rgb(37, 99, 235)', `${scheme} mouse wheel accent`)
    equal(hint.firstElementChild, firstGroup, `${scheme} change keeps hint nodes`)
    equal(hint.getBoundingClientRect().width, hintSize.width, `${scheme} change preserves width`)
    equal(hint.getBoundingClientRect().height, hintSize.height, `${scheme} change preserves height`)
    equal(withinViewport(), true, `${scheme} hint fits viewport`)
  }
  document.documentElement.style.colorScheme = initialScheme
  pointer('pointermove', 80, 80)
  equal(pick.current(), target, 'picker selects source element')
  const child = document.createElement('div')
  child.style.cssText = 'width:100%;height:100%'
  child.textContent = '子级元素'
  target.append(child)
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }))
  equal(pick.current(), child, 'down arrow selects child')
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }))
  equal(pick.current(), target, 'up arrow selects parent')
  document.dispatchEvent(new WheelEvent('wheel', { deltaY: 10, cancelable: true }))
  equal(pick.current(), child, 'wheel down selects child')
  document.dispatchEvent(new WheelEvent('wheel', { deltaY: -10, cancelable: true }))
  equal(pick.current(), target, 'wheel up selects parent')
  child.remove()
  pointer('pointerdown', 80, 80)
  pointer('pointermove', 100, 100)
  equal(hint.querySelector('.dsh-bf-hint-action').textContent, zh.pickDrag, 'picker drag hint')
  equal(hint.querySelectorAll('.dsh-bf-hint-group').length, 2, 'drag retains Escape hint')
  const dragKey = hint.querySelector('.dsh-bf-key')
  pointer('pointermove', 110, 110)
  equal(hint.querySelector('.dsh-bf-key'), dragKey, 'same-state pointer move does not rebuild hint')
  locale.setLanguage('en')
  equal(hint.querySelector('.dsh-bf-hint-action').textContent, en.pickDrag, 'active drag switches language')
  pointer('pointermove', 1, 100)
  equal(hint.querySelector('.dsh-bf-hint-action').textContent, en.pickDetach, 'detach hint')
  locale.setLanguage('zh')
  equal(hint.querySelector('.dsh-bf-hint-action').textContent, zh.pickDetach, 'active detach switches language')
  pick.cancel()
  equal(outcome?.type, 'cancelled', 'picker cancels normally')
  equal(locale.listeners.size, 0, 'picker releases subscription')
  removeDictionary()

  const effects = []
  const commands = new Map()
  apply({ locale, effect(runEffect) { const stop = runEffect(); effects.push(stop); return stop },
    slots: { inject: (_name, register) => register(), register: () => () => {} },
    shortcuts: { register(command) { commands.set(command.id, command); return () => commands.delete(command.id) } },
  })
  commands.get('betterFloat.scout').resolve().run()
  pointer('pointermove', 80, 80)
  pointer('pointerdown', 80, 80)
  pointer('pointerup', 80, 80)
  equal(document.querySelectorAll('.dsh-bf-panel').length, 1, 'client entry extracts a real element')
  equal(target.closest('.dsh-bf-panel') !== null, true, 'source moves into panel')
  locale.setLanguage('en')
  equal(document.querySelector('.dsh-bf-btn').title, en.detach, 'client panel receives host language')
  commands.get('betterFloat.overview').resolve().run()
  locale.setLanguage('zh')
  equal(document.querySelector('.dsh-bf-overview-title').textContent, zh.overviewTitle, 'client overview switches language')
  equal(commands.get('betterFloat.overview').label(), zh.overviewCommand, 'client shortcut switches language')
  for (const stop of effects.reverse()) stop?.()
  equal(document.querySelector('.dsh-bf-panel, .dsh-bf-overview, .dsh-bf-root'), null, 'unload removes plugin surfaces')
  equal(target.parentElement, document.body, 'unload restores original content')
  equal(locale.listeners.size, 0, 'unload releases listeners')
  equal(locale.dictionaries.size, 0, 'unload releases dictionary')
  equal(commands.size, 0, 'unload unregisters commands')
  target.remove()
  locale.register(LOCALE_NAMESPACE, { en, zh })
  createPanel(document, { title: '中文标题 · English content', rect: { x: 20, y: 70, width: Math.min(360, innerWidth - 40), height: 250 },
    messages, warningKeys: ['canvasWarning'], onClose() {},
  }).body.append(Object.assign(document.createElement('p'), { textContent: '页面内容保持原文。' }))
  return { checks, width: innerWidth, height: innerHeight }
}

let previewSession = null
export function showHint(language, scheme = 'light') {
  document.documentElement.style.colorScheme = scheme
  previewSession?.cancel()
  const locale = createLocaleFixture(language)
  locale.register(LOCALE_NAMESPACE, { en, zh })
  previewSession = startPick(document, { messages: messagesFor(locale), detachEnabled: false, onDone() {} })
  const rect = document.querySelector('.dsh-bf-hint').getBoundingClientRect()
  return { x: Math.max(0, Math.floor(rect.left) - 16), y: Math.max(0, Math.floor(rect.top) - 16),
    width: Math.min(innerWidth, Math.ceil(rect.width) + 32), height: Math.min(innerHeight - Math.floor(rect.top) + 16, Math.ceil(rect.height) + 32) }
}
