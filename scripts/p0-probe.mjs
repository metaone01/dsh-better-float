/**
 * P0 host-capability probe.
 *
 * Read-only with respect to the normal DSH profile: the caller should launch
 * the app with a separate user-data directory and a loopback CDP port. The
 * probe opens one temporary child window, tests same-origin access and a
 * BroadcastChannel handshake, then closes it.
 */

const port = Number(process.argv[2] ?? 9222)
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl)
if (page === undefined) throw new Error(`no page target at 127.0.0.1:${port}`)

const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', () => reject(new Error('CDP websocket error')), { once: true })
})

let nextId = 1
const pending = new Map()
socket.addEventListener('message', (event) => {
  let message
  try { message = JSON.parse(event.data) } catch { return }
  if (message.id !== undefined && pending.has(message.id)) {
    pending.get(message.id)(message)
    pending.delete(message.id)
  }
})

const send = (method, params = {}) => new Promise((resolve) => {
  const id = nextId++
  pending.set(id, resolve)
  socket.send(JSON.stringify({ id, method, params }))
})

await send('Runtime.enable')

const evaluate = async (expression) => {
  const response = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })
  if (response.result?.exceptionDetails) {
    return {
      error: response.result.exceptionDetails.text ?? 'evaluation failed',
      description: response.result.exceptionDetails.exception?.description ?? null,
    }
  }
  return response.result?.result?.value
}

await evaluate(`(() => {
  const button = document.createElement('button')
  button.id = 'dsh-better-float-p0-click'
  button.textContent = 'p0'
  button.style.cssText = 'position:fixed;left:0;top:0;width:40px;height:30px;z-index:2147483647;opacity:.01'
  button.addEventListener('click', () => {
    const childUrl = new URL(location.href)
    childUrl.searchParams.set('dsh-p0-click', String(Date.now()))
    const child = window.open(childUrl.href, 'dsh-better-float-p0-click', 'popup,width=520,height=360')
    globalThis.__dshP0ClickResult = { returned: child !== null }
    globalThis.__dshP0ClickChild = child
  })
  document.documentElement.append(button)
  globalThis.__dshP0ClickResult = null
})()`)
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 8, y: 8, button: 'left', clickCount: 1 })
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 8, y: 8, button: 'left', clickCount: 1 })
await new Promise((resolve) => setTimeout(resolve, 300))
const userGestureWindowOpen = await evaluate(`(() => {
  const result = globalThis.__dshP0ClickResult
  const child = globalThis.__dshP0ClickChild
  if (child !== undefined && child !== null) child.close()
  document.getElementById('dsh-better-float-p0-click')?.remove()
  delete globalThis.__dshP0ClickChild
  delete globalThis.__dshP0ClickResult
  return result
})()`)

const report = await evaluate(`(async () => {
  try {
  const own = (value) => {
    try { return Object.getOwnPropertyNames(value) } catch { return [] }
  }
  const describe = (value) => ({
    type: typeof value,
    source: typeof value === 'function' ? String(value).slice(0, 1200) : null,
    length: typeof value === 'function' ? value.length : null,
    keys: value !== null && value !== undefined ? own(value) : [],
  })
  const platform = globalThis.dshPlatform
  const desktop = globalThis.dshDesktop
  const result = {
    page: {
      href: location.href,
      origin: location.origin,
      windowOpen: describe(window.open),
    },
    dshPlatform: platform === undefined ? null : {
      keys: own(platform),
      open: describe(platform.open),
      setBounds: describe(platform.setBounds),
      close: describe(platform.close),
    },
    dshDesktop: desktop === undefined ? null : {
      keys: own(desktop),
      browser: describe(desktop.browser),
      browserMethods: {
        acquire: describe(desktop.browser?.acquire),
        release: describe(desktop.browser?.release),
        onOpenRequested: describe(desktop.browser?.onOpenRequested),
      },
      keyboard: describe(desktop.keyboard),
      shortcuts: describe(desktop.shortcuts),
      updates: describe(desktop.updates),
      hasInvoke: typeof desktop.invoke === 'function',
    },
  }

  result.broadcastChannelApi = await new Promise((resolve) => {
    const name = 'dsh-better-float:p0-loopback:' + Math.random().toString(36).slice(2)
    const sender = new BroadcastChannel(name)
    const receiver = new BroadcastChannel(name)
    const timer = setTimeout(() => {
      sender.close()
      receiver.close()
      resolve(false)
    }, 1500)
    receiver.addEventListener('message', (event) => {
      clearTimeout(timer)
      sender.close()
      receiver.close()
      resolve(event.data?.payload === 'loopback')
    }, { once: true })
    sender.postMessage({ type: 'p0-loopback', payload: 'loopback' })
  })

  const childUrl = new URL(location.href)
  childUrl.searchParams.set('dsh-p0', String(Date.now()))
  const child = window.open(childUrl.href, 'dsh-better-float-p0', 'popup,width=520,height=360')
  result.windowOpen = { returned: child !== null }
  if (child === null) return result

  const deadline = Date.now() + 8000
  let sameOrigin = false
  let childHref = null
  let childOrigin = null
  let openerAccessible = false
  while (Date.now() < deadline) {
    try {
      childHref = child.location.href
      childOrigin = child.location.origin
      sameOrigin = childOrigin === location.origin
      openerAccessible = child.opener === window
      if (sameOrigin && child.document.readyState === 'complete') break
    } catch {
      // Navigation is still in progress or the child is cross-origin.
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  result.windowOpen.sameOrigin = sameOrigin
  result.windowOpen.childHref = childHref
  result.windowOpen.childOrigin = childOrigin
  result.windowOpen.openerAccessible = openerAccessible

  if (sameOrigin) {
    const channelName = 'dsh-better-float:p0:' + Math.random().toString(36).slice(2)
    const channel = new BroadcastChannel(channelName)
    const handshake = new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 2500)
      channel.addEventListener('message', (event) => {
        if (event.data?.type !== 'p0-hello') return
        clearTimeout(timer)
        resolve(event.data.payload === 'child-ready')
      }, { once: true })
    })
    try {
      child.eval('(() => { const channel = new BroadcastChannel('
        + JSON.stringify(channelName)
        + "); channel.postMessage({ type: 'p0-hello', payload: 'child-ready' });"
        + ' setTimeout(() => channel.close(), 1000); })()')
    } catch {
      // Same-origin access can still be denied by the window integration.
    }
    result.broadcastChannel = await handshake
    channel.close()
  } else {
    result.broadcastChannel = false
  }

  child.close()
  const closeDeadline = Date.now() + 2500
  while (Date.now() < closeDeadline && !child.closed) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  result.windowOpen.closedDetected = child.closed === true
  return result
  } catch (error) {
    return { probeError: String(error), stack: error?.stack ?? null }
  }
})()`)

if (report !== null && typeof report === 'object') report.userGestureWindowOpen = userGestureWindowOpen

console.log(JSON.stringify(report, null, 2))
socket.close()
