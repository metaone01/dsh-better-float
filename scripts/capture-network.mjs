const port = Number(process.argv[2] ?? 9222)
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
if (!page) throw new Error('no page target')
const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
let nextId = 1
const pending = new Map()
const events = []
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.id !== undefined && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); return }
  if (!message.method?.startsWith('Network.')) return
  const p = message.params
  if (message.method === 'Network.requestWillBeSent' && /dsh-better-float|client\.js/u.test(p.request?.url ?? '')) events.push({ kind: 'request', id: p.requestId, url: p.request.url })
  if (message.method === 'Network.responseReceived' && /dsh-better-float|client\.js/u.test(p.response?.url ?? '')) events.push({ kind: 'response', id: p.requestId, status: p.response.status, url: p.response.url, mime: p.response.mimeType })
  if (message.method === 'Network.loadingFailed') events.push({ kind: 'failed', id: p.requestId, error: p.errorText, canceled: p.canceled, blocked: p.blockedReason })
})
const send = (method, params = {}) => new Promise((resolve) => { const id = nextId++; pending.set(id, resolve); socket.send(JSON.stringify({ id, method, params })) })
await send('Network.enable')
await send('Page.enable')
await send('Page.reload', { ignoreCache: true })
await new Promise((resolve) => setTimeout(resolve, 10000))
const result = await send('Runtime.evaluate', { expression: `(() => ({ boot: window.__DSH_BOOT__, loader: (() => { const x = window.__ModuleLoader__; return x ? { keys: Object.getOwnPropertyNames(x), pending: String(x.pendingQueue), pendingType: typeof x.pendingQueue } : null })(), body: document.body?.innerText?.slice(0, 300) }))()`, returnByValue: true })
console.log(JSON.stringify({ events, page: result.result?.result?.value ?? null }, null, 2))
socket.close()
