/**
 * Fetch the plugin's bundle exactly as the page requests it.
 *
 * The page reports `dsh-better-float` in its own application batch with
 * `url: plugins/??dsh-better-float/client.js&rev=444f3f99edd5` and
 * `rev: 444f3f99edd5`, while every official plugin is grouped into the shared
 * multi-entry batch. Two things follow from that, and both are testable:
 *
 *   1. The plugin's bytes may not even be reachable at the URL the page was told
 *      to load — in which case nothing about the bundle's content matters.
 *   2. The `rev` in the manifest must match the bytes on disk; the module system
 *      only serves a bundle whose captured rev agrees with that artifact.
 *
 * This fetches the manifest's exact URL *from inside the page* (so the
 * `dsh-app://` scheme resolves), reports the status and size, and for a
 * successful response reports whether the served copy is the one on disk.
 *
 * Run with `node scripts/fetch-bundle-in-page.mjs [port]`.
 */
import { writeFileSync } from 'node:fs'

const OUT = 'G:/Code/fork/dsh-better-float/served-bundle.txt'
const PORT = Number(process.argv[2] ?? 9222)

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl !== undefined)
if (page === undefined) { console.log('no page target'); process.exit(1) }

const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', () => reject(new Error('ws error')), { once: true })
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

const probe = `(async () => {
  const boot = window.__DSH_BOOT__;
  const row = (boot.entries || []).find((e) => e.id === "dsh-better-float");
  const batch = (boot.batches || []).find((b) => (b.entries || []).includes("dsh-better-float"));
  const out = {
    row,
    batchUrl: batch?.url ?? null,
    batchPhase: batch?.phase ?? null,
    batchSize: (batch?.entries ?? []).length,
  };

  const attempts = [];
  // Try the manifest URL, its absolute form, and the single-package form.
  const urls = [];
  if (batch?.url) urls.push(batch.url);
  if (row?.url) urls.push(row.url);
  if (row?.url) urls.push(row.url.replace("plugins/??", "/plugins/??"));
  for (const u of urls) {
    try {
      const res = await fetch(u);
      const body = await res.text();
      const requires = [];
      const re = /require\\(([^)]*)\\)/g;
      let m;
      while ((m = re.exec(body)) !== null) requires.push(m[0] + " @" + m.index);
      attempts.push({
        url: u, status: res.status, length: body.length,
        contentType: res.headers.get("content-type"),
        requires, hasShim: body.includes("__require"),
        hasDynamic: body.includes("Dynamic require"),
        registers: body.includes("__ModuleLoader__.load"),
        head: body.slice(0, 400),
        tail: body.slice(-300),
      });
    } catch (error) {
      attempts.push({ url: u, error: String(error) });
    }
  }
  out.attempts = attempts;
  return out;
})()`

const result = await send('Runtime.evaluate', {
  expression: probe, returnByValue: true, awaitPromise: true,
})

const lines = ['=== the plugin bundle, as the page can reach it ===']
lines.push(JSON.stringify(result.result?.result?.value ?? result, null, 2).slice(0, 12000))

socket.close()
writeFileSync(OUT, lines.join('\n'), 'utf8')
console.log(lines.join('\n').slice(0, 6000))
