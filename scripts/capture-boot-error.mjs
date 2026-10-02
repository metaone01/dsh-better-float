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
const events = []
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.id !== undefined && pending.has(message.id)) {
    pending.get(message.id)(message)
    pending.delete(message.id)
  } else if (message.method === 'Runtime.consoleAPICalled') {
    events.push({ kind: 'console', type: message.params.type, args: message.params.args?.map((a) => a.value ?? a.description ?? a.type) })
  } else if (message.method === 'Runtime.exceptionThrown') {
    events.push({ kind: 'exception', details: message.params.exceptionDetails })
  } else if (message.method === 'Log.entryAdded') {
    events.push({ kind: 'log', entry: message.params.entry })
  }
})
const send = (method, params = {}) => new Promise((resolve) => {
  const id = nextId++
  pending.set(id, resolve)
  socket.send(JSON.stringify({ id, method, params }))
})
await send('Runtime.enable')
await send('Log.enable')
await send('Page.enable')
const hook = `(() => {
  const state = { errors: [], rejections: [], console: [] }
  Object.defineProperty(window, '__BF_BOOT_CAPTURE__', { value: state, configurable: true })
  window.addEventListener('error', (event) => state.errors.push({ message: event.message, filename: event.filename, line: event.lineno, stack: event.error?.stack }))
  window.addEventListener('unhandledrejection', (event) => state.rejections.push({ reason: String(event.reason), stack: event.reason?.stack }))
  const original = console.error
  console.error = (...args) => { state.console.push(args.map((arg) => typeof arg === 'string' ? arg : (arg?.stack ?? String(arg)))); original.apply(console, args) }
})()`
const add = await send('Page.addScriptToEvaluateOnNewDocument', { source: hook })
if (add.error) throw new Error(JSON.stringify(add.error))
await send('Page.reload', { ignoreCache: true })
await new Promise((resolve) => setTimeout(resolve, 7000))
const result = await send('Runtime.evaluate', { expression: `(() => ({ capture: window.__BF_BOOT_CAPTURE__ ?? null, body: document.body?.innerText?.slice(0, 500) ?? '' }))()`, returnByValue: true })
console.log(JSON.stringify({ events, page: result.result?.result?.value ?? null }, null, 2))
socket.close()
