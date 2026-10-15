import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'

const port = Number(process.argv[2] ?? 9222)
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) })).json()
const page = targets.find(target => target.type === 'page' && target.url?.startsWith('dsh-app://app/'))
assert.ok(page, 'actual DSH page must exist')
const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('CDP connection timeout')), 3000)
  socket.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
})
let sequence = 0
const pending = new Map()
socket.addEventListener('message', ({ data }) => {
  const reply = JSON.parse(data)
  const task = pending.get(reply.id)
  if (!task) return
  pending.delete(reply.id)
  clearTimeout(task.timer)
  if (reply.error) task.reject(new Error(reply.error.message))
  else task.resolve(reply.result)
})
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timeout`)) }, 10000)
  pending.set(id, { resolve, reject, timer })
  socket.send(JSON.stringify({ id, method, params }))
})
const evaluate = async expression => {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  return result.result.value
}
const frames = () => evaluate('new Promise(resolve => { const timer=setTimeout(resolve,100); requestAnimationFrame(() => requestAnimationFrame(() => {clearTimeout(timer);resolve()})) })')
const point = selector => evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
  return { x: Math.round(r.x + Math.min(30,r.width/2)), y: Math.round(r.y+r.height/2) } })()`)
const click = async coordinates => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...coordinates })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...coordinates, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...coordinates, button: 'left', clickCount: 1 })
  await frames()
}
const shortcut = async (key, code, modifiers) => {
  const windowsVirtualKeyCode = code === 'KeyS' ? 83 : code === 'KeyA' ? 65 : code === 'ArrowUp' ? 38 : 27
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers, windowsVirtualKeyCode })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers, windowsVirtualKeyCode })
  await frames()
}
const pull = async () => {
  if (process.argv.includes('--command')) {
    await evaluate('window.__BF_ACCEPTANCE__.invoke()')
    await frames()
  } else if (process.argv[3]) {
    const pid = Number(process.argv[3])
    assert.ok(Number.isInteger(pid) && pid > 0)
    execFileSync('powershell.exe', ['-NoProfile', '-Command',
      `$proc=Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if($proc.CommandLine -notmatch 'dsh-debug-userdata-e0e1-20261003'){throw 'Refusing non-isolated process'}; $shell=New-Object -ComObject WScript.Shell; if(-not $shell.AppActivate(${pid})){throw 'Cannot focus isolated DSH'}; $shell.SendKeys('^+s')`],
      { windowsHide: true, timeout: 10000 })
    await frames()
  } else {
    await shortcut('S', 'KeyS', 10)
  }
  assert.equal(await evaluate('!!document.querySelector(".dsh-bf-root")'), true, 'actual installed command opens picker')
  const coordinates = await point('[data-counter]')
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...coordinates })
  await shortcut('ArrowUp', 'ArrowUp', 0)
  assert.ok(await evaluate('document.querySelector(".dsh-bf-label").textContent.includes("section")'), 'picker selects React component subtree')
  await click(coordinates)
  assert.equal(await evaluate('document.querySelectorAll(".dsh-bf-panel").length'), 1, 'installed plugin extracts one panel')
}
let checks = 0
const check = async (expression, expected, label) => {
  assert.deepEqual(await evaluate(expression), expected, label)
  checks++
}
const errors = []
socket.addEventListener('message', ({ data }) => {
  const event = JSON.parse(data)
  if (event.method === 'Runtime.exceptionThrown') errors.push(event.params.exceptionDetails.text)
})
try {
  await send('Page.bringToFront')
  await send('Runtime.enable')
  const preflight = await evaluate('({fixture:!!window.__BF_ACCEPTANCE__,layer:!!document.querySelector("[data-better-float=layer]"),origin:location.origin})')
  assert.ok(preflight.fixture && preflight.layer, 'requires fully booted isolated acceptance profile')
  const row = await evaluate('window.__DSH_BOOT__.entries.find(row => row.id === "@metaone01/dsh-better-float")')
  assert.ok(row, 'installed plugin row exists')
  const served = await evaluate(`(async () => { const response = await fetch(${JSON.stringify(row.url)}); if(!response.ok)throw Error('bundle fetch failed'); return await response.text() })()`)
  const disk = await readFile('lib/client.js', 'utf8')
  const normalized = served.replace(/^>\s*\n/, '')
  assert.ok(normalized.startsWith(disk.trimEnd()), 'served installed bundle contains exact current built artifact')
  const tail = normalized.slice(disk.trimEnd().length).trim()
  assert.ok(tail === '' || /^;?\s*\/\/# sourceMappingURL=\?\?@metaone01\/dsh-better-float\/client\.js\.map&rev=[a-f0-9]+$/.test(tail), `unexpected bundle suffix: ${tail.slice(0,150)}`)
  checks++
  await check('typeof globalThis.dshDesktop?.invoke', 'undefined', 'real host still lacks generic window bridge')
  await evaluate('window.__BF_ACCEPTANCE__.setCount(0)')
  await click(await point('[data-counter]'))
  await check('document.querySelector("[data-counter]").textContent', 'Count 1', 'baseline trusted React click')
  await evaluate('window.__BF_ACCEPTANCE__.events.length=0; window.__BF_ACCEPTANCE__.source=document.querySelector("[data-acceptance-target]"); window.__BF_ACCEPTANCE__.frame=document.querySelector("[data-state-frame]").contentWindow; window.__BF_ACCEPTANCE__.frame.sentinel="preserved"; document.querySelector("[data-scroll]").scrollTop=75; window.__BF_ACCEPTANCE__.scroll=document.querySelector("[data-scroll]").scrollTop')
  await pull()
  checks++
  await check('document.querySelector(".dsh-bf-panel [data-acceptance-target]") === window.__BF_ACCEPTANCE__.source', true, 'original React DOM identity preserved')
  await click(await point('.dsh-bf-panel [data-counter]'))
  await check('document.querySelector("[data-counter]").textContent', 'Count 2', 'real React hook state updates in live panel')
  await check('window.__BF_ACCEPTANCE__.events', ['button:true', 'ancestor'], 'React handler and ancestor each fire exactly once')
  await click(await point('[data-state-input]'))
  await shortcut('a', 'KeyA', 2)
  await send('Input.insertText', { text: 'edited in panel' })
  await frames()
  await check('document.querySelector("[data-state-input]").value', 'edited in panel', 'real controlled input onChange works')
  await evaluate('window.__BF_ACCEPTANCE__.update()')
  await check('document.querySelector("[data-state-input]").value', 'external update', 'external hook update reaches moved node')
  await check('document.querySelector("[data-context]").textContent', 'context stays live', 'React Context remains available')
  await check('document.querySelector("[data-state-frame]").contentWindow === window.__BF_ACCEPTANCE__.frame && window.__BF_ACCEPTANCE__.frame.sentinel === "preserved"', true, 'iframe execution context preserved')
  await check('document.querySelector("[data-scroll]").scrollTop === window.__BF_ACCEPTANCE__.scroll', true, 'actual DPI-rounded scroll offset retained')
  await click(await point('[data-action="detach"]'))
  for(let attempt=0;attempt<30;attempt++){
    if(await evaluate('!!document.querySelector("[data-role=companion-confirm]") || !document.querySelector("[data-role=status]").textContent.includes("Checking")'))break
    await new Promise(resolve=>setTimeout(resolve,100))
  }
  if(await evaluate('!!document.querySelector("[data-role=companion-confirm]")'))await click(await point('[data-action="companion-cancel"]'))
  await check('document.querySelector("[data-role=status]").textContent.length > 0', true, 'actual detach cancellation or unavailable feedback is visible')
  await check('document.querySelectorAll(".dsh-bf-panel").length', 1, 'detach failure retains source')
  await check('(() => { const root=document.querySelector(".dsh-bf-panel"); const body=root.querySelector(".dsh-bf-body"); const warn=root.querySelector(".dsh-bf-warn"); return body.getBoundingClientRect().bottom <= warn.getBoundingClientRect().top + 1 && getComputedStyle(body).overflowY === "auto" })()', true, 'status and warning do not overlap scrollable content')
  await mkdir('docs/screenshots', { recursive: true })
  const screenshot = await send('Page.captureScreenshot', { format:'png' })
  await writeFile('docs/screenshots/e0e1-dsh-detach.png', Buffer.from(screenshot.data,'base64'))
  await click(await point('.dsh-bf-panel .dsh-bf-btn:last-child'))
  await check('document.querySelector("[data-acceptance-target]").parentElement.id', 'dsh-bf-acceptance-fixture', 'close restores original React root slot')
  await check('document.querySelector("[data-state-frame]").contentWindow === window.__BF_ACCEPTANCE__.frame && window.__BF_ACCEPTANCE__.frame.sentinel === "preserved"', true, 'iframe preserved on restore')
  await click(await point('[data-counter]'))
  await check('document.querySelector("[data-counter]").textContent', 'Count 3', 'React continues updating after restore')
  await pull()
  await evaluate('window.__BF_ACCEPTANCE__.unmount()')
  await frames()
  await check('document.querySelectorAll(".dsh-bf-panel, dsh-float-anchor").length', 0, 'real React unmount reclaims panel without resurrecting node')
  await check('document.querySelector("[data-acceptance-target]")', null, 'unmounted component stays removed')
  assert.deepEqual(errors, [], 'no uncaught browser runtime exceptions')
  console.log(JSON.stringify({ checks, origin:preflight.origin, bundleSha256:createHash('sha256').update(disk).digest('hex'),
    screenshot:'docs/screenshots/e0e1-dsh-detach.png', commandEntry:process.argv.includes('--command') ? 'host registry diagnostic entry; native shortcut NOT verified' : 'native shortcut',
    scope:'actual installed plugin, trusted CDP mouse input, host React hooks/Context/unmount; no native popout backend' },null,2))
} finally {
  try { await shortcut('Escape','Escape',0) } catch {}
  for (const task of pending.values()) clearTimeout(task.timer)
  pending.clear()
  socket.close()
}
