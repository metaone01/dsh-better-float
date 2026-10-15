import { build } from 'esbuild'

const port = Number(process.argv[2] ?? 9222)
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Expected a local CDP port')
let socket
const pending = new Map()
let nextId = 0
try {
  let response
  try {
    response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) })
  } catch {
    throw new Error(`Live DSH acceptance unavailable: no CDP endpoint on loopback ${port}. Do not restart the normal host automatically.`)
  }
  if (!response.ok) throw new Error(`CDP returned HTTP ${response.status}`)
  const targets = await response.json()
  const page = targets.find(target => target.type === 'page' && target.url?.startsWith('dsh-app://app/') && target.webSocketDebuggerUrl)
  if (!page) throw new Error('No actual dsh-app://app/ page target; refusing to test an arbitrary page')
  const debuggerUrl = new URL(page.webSocketDebuggerUrl)
  if (debuggerUrl.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(debuggerUrl.hostname)) {
    throw new Error('CDP target is not a loopback WebSocket')
  }
  socket = new WebSocket(debuggerUrl)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP connection timed out')), 3000)
    socket.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP connection failed')) }, { once: true })
  })
  socket.addEventListener('message', event => {
    const response = JSON.parse(event.data)
    const request = pending.get(response.id)
    if (!request) return
    clearTimeout(request.timer)
    pending.delete(response.id)
    if (response.error) request.reject(new Error(response.error.message))
    else request.resolve(response.result)
  })
  socket.addEventListener('close', () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer)
      request.reject(new Error('CDP disconnected'))
    }
    pending.clear()
  })
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)) }, 10000)
    pending.set(id, { resolve, reject, timer })
    socket.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    return result.result.value
  }
  const preflight = await evaluate(`({ origin: location.origin, bridgePresent: typeof globalThis.dshDesktop?.invoke === 'function',
    moduleLoaderReady: !!window.__ModuleLoader__, bootReady: !!window.__DSH_BOOT__,
    existingSurfaces: !!document.querySelector('.dsh-bf-root, .dsh-bf-panel, .dsh-bf-overview') })`)
  if (!preflight.moduleLoaderReady || !preflight.bootReady) throw new Error('DSH application has not booted; refusing to count error/recovery page as host acceptance')
  if (preflight.existingSurfaces) throw new Error('Existing picker/panels detected; refusing to interfere with user UI')
  const { outputFiles } = await build({ entryPoints: ['scripts/detach-browser-cases.mjs'], bundle: true,
    write: false, format: 'iife', globalName: 'DetachChecks' })
  // Lexical wrapper keeps the test bundle out of the host's module registry.
  const result = await evaluate(`(async () => { ${outputFiles[0].text}\nreturn await DetachChecks.run({ allowBridgeMock: false }); })()`)
  console.log(JSON.stringify({ ...preflight, result,
    scope: 'local source fixture inside real DSH Renderer, not installed-bundle activation or trusted-pointer acceptance' }, null, 2))
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
} finally {
  for (const request of pending.values()) clearTimeout(request.timer)
  pending.clear()
  socket?.close()
}
