const port = Number(process.argv[2] ?? 9222)
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
if (!page) throw new Error('no page target')
const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})
let nextId = 1
const pending = new Map()
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
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
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.result?.exceptionDetails) return { error: result.result.exceptionDetails }
  return result.result?.result?.value
}
const report = await evaluate(`(() => {
  const own = (value) => { try { return Object.getOwnPropertyNames(value) } catch { return [] } }
  const desc = (value, key) => { try { const d = Object.getOwnPropertyDescriptor(value, key); return { type: typeof value[key], hasValue: 'value' in (d ?? {}), enumerable: d?.enumerable ?? false } } catch (e) { return { error: String(e) } } }
  const summarize = (value, depth = 0, seen = new Set()) => {
    if (value === null || value === undefined) return value
    if (typeof value !== 'object' && typeof value !== 'function') return value
    if (seen.has(value) || depth > 2) return '[object]'
    seen.add(value)
    const out = { type: typeof value, ctor: value?.constructor?.name ?? null, keys: own(value).slice(0, 100) }
    for (const key of out.keys) {
      if (/password|token|secret|cookie|storage/i.test(key)) continue
      try {
        const child = value[key]
        if (child === null || child === undefined || typeof child === 'string' || typeof child === 'number' || typeof child === 'boolean') out[key] = child
        else if (depth < 1 && /loader|entry|module|error|failure|state|plugin|fiber|context|root|system|registry|shortcut|slot|cordis|ms/i.test(key)) out[key] = summarize(child, depth + 1, seen)
      } catch (e) { out[key] = '[throws ' + String(e) + ']' }
    }
    return out
  }
  const globals = own(window).filter((key) => /loader|module|cordis|fiber|context|root|plugin|error|failure|ms|react/i.test(key))
  const loader = window.__ModuleLoader__
  return {
    globals,
    dshGlobals: own(window).filter((key) => /dsh/i.test(key)).map((key) => ({ key, type: typeof window[key], summary: typeof window[key] === 'object' && window[key] !== null ? summarize(window[key]) : String(window[key]) })),
    loader: loader ? summarize(loader) : null,
    loaderProto: loader ? own(Object.getPrototypeOf(loader)).map((key) => [key, desc(loader, key)]) : [],
    boot: window.__DSH_BOOT__,
    bodyText: document.body?.innerText?.slice(0, 3000) ?? ''
  }
})()`)
console.log(JSON.stringify(report, null, 2))
socket.close()
