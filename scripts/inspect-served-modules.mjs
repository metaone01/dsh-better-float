const port = Number(process.argv[2] ?? 9222)
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
if (!page) throw new Error('no page target')
const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
let id = 1
const pending = new Map()
socket.addEventListener('message', (event) => { const m = JSON.parse(event.data); if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } })
const send = (method, params = {}) => new Promise((resolve) => { const callId = id++; pending.set(callId, resolve); socket.send(JSON.stringify({ id: callId, method, params })) })
const expression = `(async () => {
  const boot = window.__DSH_BOOT__
  const batch = boot?.batches?.find((entry) => entry.entries?.includes('dsh-better-float'))
  if (!batch) return { error: 'batch missing' }
  const source = await fetch(batch.url).then((r) => r.text())
  const moduleChunk = (id) => {
    const marker = 'id: "' + id + '"'
    const start = source.indexOf(marker)
    if (start < 0) return null
    const end = source.indexOf('\\n});', start)
    return source.slice(start, end < 0 ? start + 200000 : end)
  }
  const chunks = Object.fromEntries(['@deepseek-ai/dsh-client-shortcuts', '@deepseek-ai/dsh-client-ui-renderer', '@deepseek-ai/dsh-client-ui-layout', 'dsh-better-float'].map((id) => [id, moduleChunk(id)]))
  const needles = ['Unsupported Web shortcut', 'defaults', 'ShortcutRegistry.register', 'const inject = [', 'exports.inject', 'super(ctx, "shortcuts"', 'super(ctx, "slots"', 'new SlotRegistry']
  const snippets = []
  for (const needle of needles) {
    let from = 0
    const haystack = Object.entries(chunks).map(([id, chunk]) => ({ id, chunk })).filter(({ chunk }) => chunk !== null)
    for (const { id, chunk } of haystack) {
      from = 0
      let count = 0
      while (count < 8) {
        const at = chunk.indexOf(needle, from)
        if (at < 0) break
        snippets.push({ id, needle, at, text: chunk.slice(Math.max(0, at - 320), Math.min(chunk.length, at + 900)) })
        from = at + needle.length
        count++
      }
    }
  }
  return { batch: batch.url, bytes: source.length, chunks: Object.fromEntries(Object.entries(chunks).map(([id, chunk]) => [id, chunk?.length ?? null])), tails: Object.fromEntries(Object.entries(chunks).map(([id, chunk]) => [id, chunk?.slice(-1800) ?? null])), snippets, globalMatches: needles.map((needle) => ({ needle, at: source.indexOf(needle), text: source.indexOf(needle) < 0 ? null : source.slice(Math.max(0, source.indexOf(needle) - 600), source.indexOf(needle) + 1200) })) }
})()`
await send('Runtime.enable')
const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
console.log(JSON.stringify(result.result?.result?.value ?? result, null, 2))
socket.close()
