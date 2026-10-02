const port = Number(process.argv[2] ?? 9222)
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
if (!page) throw new Error('no page target')
const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
let nextId = 1
const pending = new Map()
socket.addEventListener('message', (event) => { const m = JSON.parse(event.data); if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } })
const send = (method, params = {}) => new Promise((resolve) => { const id = nextId++; pending.set(id, resolve); socket.send(JSON.stringify({ id, method, params })) })
await send('Runtime.enable')
await send('Page.enable')
const source = `(() => {
  const state = { events: [], errors: [] }
  Object.defineProperty(window, '__BF_HOOK__', { value: state, configurable: true })
  const record = (event) => state.events.push({ at: Date.now(), ...event })
  const install = () => {
    const loader = window.__ModuleLoader__
    if (!loader || loader.__bfWrapped) return
    const originalLoad = loader.load
    const wrappedLoad = function (registration) {
      if (registration?.id !== 'dsh-better-float') return originalLoad.call(this, registration)
      record({ kind: 'registration', keys: Object.keys(registration) })
      const originalFactory = registration.factory
      registration.factory = (require) => {
        record({ kind: 'factory-start' })
        let exports
        try {
          exports = originalFactory(require)
          record({ kind: 'factory-done', exportKeys: Object.keys(exports ?? {}), inject: exports?.inject })
          if (typeof exports?.apply === 'function') {
            const originalApply = exports.apply
            exports.apply = (ctx) => {
              record({ kind: 'apply-start', ctxKeys: Object.keys(ctx ?? {}), services: ['slots', 'shortcuts'].map((key) => ({ key, present: ctx?.[key] !== undefined })) })
              try {
                const result = originalApply(ctx)
                record({ kind: 'apply-done', resultType: typeof result })
                return result
              } catch (error) {
                const detail = { kind: 'apply-error', message: String(error), stack: error?.stack }
                state.errors.push(detail)
                record(detail)
                throw error
              }
            }
          }
          return exports
        } catch (error) {
          const detail = { kind: 'factory-error', message: String(error), stack: error?.stack }
          state.errors.push(detail)
          record(detail)
          throw error
        }
      }
      return originalLoad.call(this, registration)
    }
    Object.defineProperty(wrappedLoad, 'name', { value: originalLoad.name })
    loader.load = wrappedLoad
    Object.defineProperty(loader, '__bfWrapped', { value: true, configurable: true })
    record({ kind: 'hook-installed' })
  }
  install()
  const timer = setInterval(() => { install(); if (window.__BF_HOOK__?.events.some((event) => event.kind === 'factory-done')) clearInterval(timer) }, 0)
})()`
const added = await send('Page.addScriptToEvaluateOnNewDocument', { source })
if (added.error) throw new Error(JSON.stringify(added.error))
await send('Page.reload', { ignoreCache: true })
await new Promise((resolve) => setTimeout(resolve, 8000))
const result = await send('Runtime.evaluate', { expression: `(() => ({ hook: window.__BF_HOOK__ ?? null, body: document.body?.innerText?.slice(0, 500) ?? '' }))()`, returnByValue: true })
console.log(JSON.stringify(result.result?.result?.value ?? result, null, 2))
socket.close()
