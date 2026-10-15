/** Plugin-only contract checks; they do not establish Desktop host support. */
import assert from 'node:assert/strict'
import { build } from 'esbuild'

const result = await build({ entryPoints: ['src/detach/transport.ts'], bundle: true, write: false, format: 'esm', platform: 'node' })
const { createTransport, requestDetach, CHANNELS, FLOAT_PROTOCOL_VERSION } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
const originalBridge = Object.getOwnPropertyDescriptor(globalThis, 'dshDesktop')
const originalChannel = Object.getOwnPropertyDescriptor(globalThis, 'BroadcastChannel')
const transports = []
let checks = 0

class MockChannel extends EventTarget {
  static instances = []
  sent = []
  closed = false
  constructor(name) { super(); this.name = name; MockChannel.instances.push(this) }
  postMessage(value) { assert.equal(this.closed, false); this.sent.push(value) }
  close() { this.closed = true }
  receive(value) { this.dispatchEvent(new MessageEvent('message', { data: value })) }
}

function setup(invoke) {
  if (invoke === undefined) delete globalThis.dshDesktop
  else globalThis.dshDesktop = { invoke }
  const transport = createTransport({ timeoutMs: 20 })
  transports.push(transport)
  return transport
}

const request = { id: 'panel-1', title: 'Example', bounds: { x: -20, y: 10, width: 200, height: 100 } }
const record = { ...request, attributes: { alwaysOnTop: true, clickThrough: false, frameless: true, transparent: false, resizable: true }, alive: true }
const envelope = (message, revision = 1) => ({ version: FLOAT_PROTOCOL_VERSION, sender: 'other-renderer', requestId: `other:${revision}`, revision, message })

async function check(name, fn) { await fn(); ++checks; console.log(`PASS ${name}`) }

try {
  Object.defineProperty(globalThis, 'BroadcastChannel', { configurable: true, writable: true, value: MockChannel })
  await check('missing bridge never claims an independent window', async () => {
    const transport = setup()
    assert.equal(transport.available, false)
    assert.equal(transport.capabilities.bridgePresent, false)
    assert.equal((await requestDetach(transport, request)).code, 'missing-bridge')
    assert.equal(await transport.open(request), null)
  })
  await check('bridge presence is not window or content capability', async () => {
    const calls = []
    const transport = setup(async (channel) => { calls.push(channel); return [] })
    assert.equal(transport.available, false)
    assert.equal(transport.capabilities.windowManagement, 'unverified')
    const detached = await requestDetach(transport, request)
    assert.equal(detached.ok, false)
    assert.equal(detached.code, 'content-unavailable')
    assert.equal(transport.available, true)
    assert.equal(transport.capabilities.contentPresentation, false)
    assert.deepEqual(calls, [CHANNELS.list])
    assert.equal(MockChannel.instances.at(-1).sent.length, 0)
  })
  await check('backend failures stay bounded and recover after a valid re-probe', async () => {
    let missing = true
    const transport = setup(async () => { if (missing) throw new Error('No handler registered'); return [] })
    assert.equal((await transport.probe()).reason.code, 'backend-error')
    assert.equal(transport.available, false)
    missing = false
    assert.equal((await transport.probe()).windowManagement, 'reachable')
    assert.equal(transport.lastFailure, null)
  })
  await check('hung IPC times out with a request id', async () => {
    const transport = setup(() => new Promise(() => {}))
    assert.equal((await transport.probe()).reason.code, 'timeout')
    assert.equal(typeof transport.lastFailure.requestId, 'string')
    assert.equal(transport.available, false)
  })
  await check('malformed IPC list records are rejected', async () => {
    for (const value of [undefined, {}, [null], [{ ...record, bounds: { ...request.bounds, width: Infinity } }], [{ ...record, attributes: {} }]]) {
      const transport = setup(async () => value)
      assert.deepEqual(await transport.list(), [])
      assert.equal(transport.lastFailure.code, 'invalid-response')
    }
  })
  await check('truthy IPC responses are not boolean success', async () => {
    const transport = setup(async () => 'true')
    assert.equal(await transport.close('panel-1'), false)
    assert.equal(await transport.update('panel-1', { bounds: request.bounds }), false)
    assert.equal(transport.lastFailure.code, 'invalid-response')
  })
  await check('open replies must identify a live requested window', async () => {
    for (const value of [{ ...record, id: 'someone-else' }, { ...record, alive: false }]) {
      const transport = setup(async () => value)
      assert.equal(await transport.open(request), null)
      assert.equal(transport.lastFailure.code, 'invalid-response')
      assert.equal(transport.available, false)
    }
    const transport = setup(async () => record)
    assert.deepEqual(await transport.open(request), record)
  })
  await check('invalid requests never reach IPC', async () => {
    let calls = 0
    const transport = setup(async () => { ++calls; return true })
    assert.equal(await transport.open({ ...request, bounds: { ...request.bounds, width: 0 } }), null)
    assert.equal(await transport.close(''), false)
    assert.equal(await transport.update('panel-1', { id: 'rename' }), false)
    assert.equal(await transport.capturePage('panel-1', { ...request.bounds, x: NaN }), null)
    assert.equal(calls, 0)
    assert.equal(transport.lastFailure.code, 'invalid-request')
  })
  await check('capture accepts only bounded PNG data URLs', async () => {
    const transport = setup(async () => 'javascript:alert(1)')
    assert.equal(await transport.capturePage('primary', request.bounds), null)
    assert.equal(transport.lastFailure.code, 'invalid-response')
    const valid = setup(async () => 'data:image/png;base64,YQ==')
    assert.equal(await valid.capturePage('primary', request.bounds), 'data:image/png;base64,YQ==')
  })
  await check('BroadcastChannel requires a valid versioned message envelope', async () => {
    const transport = setup()
    const channel = MockChannel.instances.at(-1)
    const received = []
    transport.subscribe((message) => received.push(message))
    for (const value of [null, { type: 'popout-closed', id: 'panel-1' }, envelope({ type: 'unknown' }), { ...envelope({ type: 'claim', id: 'panel-1', from: 'source' }), version: 99 }, envelope({ type: 'popout-updated', record: { ...record, alive: 'yes' } })]) channel.receive(value)
    assert.equal(received.length, 0)
    const message = { type: 'popout-closed', id: 'panel-1' }
    channel.receive(envelope(message))
    channel.receive(envelope(message))
    channel.receive(envelope(message, 0))
    assert.deepEqual(received, [message])
    channel.receive(envelope({ type: 'release', id: 'panel-1', from: 'source' }, 2))
    assert.equal(received.length, 2)
  })
  await check('publish validates messages and includes revision/request identity', async () => {
    const transport = setup()
    const channel = MockChannel.instances.at(-1)
    transport.publish({ type: 'unknown' })
    transport.publish({ type: 'claim', id: 'panel-1', from: 'source' })
    transport.publish({ type: 'release', id: 'panel-1', from: 'source' })
    assert.equal(channel.sent.length, 2)
    assert.equal(channel.sent[0].version, FLOAT_PROTOCOL_VERSION)
    assert.equal(channel.sent[1].revision, channel.sent[0].revision + 1)
    assert.notEqual(channel.sent[0].requestId, channel.sent[1].requestId)
  })
  await check('listener failure and unsubscribe do not break other observers', async () => {
    const transport = setup()
    const channel = MockChannel.instances.at(-1)
    let count = 0
    transport.subscribe(() => { throw new Error('listener failure') })
    const unsubscribe = transport.subscribe(() => ++count)
    channel.receive(envelope({ type: 'popout-closed', id: 'panel-1' }))
    unsubscribe()
    channel.receive(envelope({ type: 'popout-closed', id: 'panel-1' }, 2))
    assert.equal(count, 1)
  })
  await check('dispose settles inflight work and blocks new operations', async () => {
    let calls = 0
    const transport = setup(() => { ++calls; return new Promise(() => {}) })
    const pending = transport.list()
    await Promise.resolve()
    const channel = MockChannel.instances.at(-1)
    let received = 0
    transport.subscribe(() => ++received)
    transport.dispose()
    transport.dispose()
    assert.deepEqual(await pending, [])
    assert.equal(transport.lastFailure.code, 'disposed')
    assert.equal(transport.available, false)
    assert.equal(channel.closed, true)
    assert.equal(await transport.open(request), null)
    assert.equal(await transport.close('panel-1'), false)
    assert.equal(await transport.update('panel-1', { bounds: request.bounds }), false)
    assert.equal(await transport.capturePage('primary', request.bounds), null)
    assert.equal((await requestDetach(transport, request)).code, 'disposed')
    transport.publish({ type: 'popout-closed', id: 'panel-1' })
    transport.subscribe(() => ++received)
    channel.receive(envelope({ type: 'popout-closed', id: 'panel-1' }))
    assert.equal(received, 0)
    assert.equal(channel.sent.length, 0)
    assert.equal(calls, 1)
  })
  await check('immediate dispose prevents queued IPC invocation', async () => {
    let calls = 0
    const transport = setup(async () => { ++calls; return [] })
    const pending = transport.list()
    transport.dispose()
    assert.deepEqual(await pending, [])
    assert.equal(calls, 0)
  })
  await check('channel constructor rejection preserves L0 fallback', async () => {
    Object.defineProperty(globalThis, 'BroadcastChannel', { configurable: true, writable: true, value: class { constructor() { throw new Error('denied') } } })
    const transport = setup()
    assert.equal((await requestDetach(transport, request)).code, 'missing-bridge')
    transport.publish({ type: 'popout-closed', id: 'panel-1' })
  })
  console.log(`${checks} transport checks passed (not host acceptance).`)
} finally {
  for (const transport of transports) transport.dispose()
  if (originalBridge) Object.defineProperty(globalThis, 'dshDesktop', originalBridge)
  else delete globalThis.dshDesktop
  if (originalChannel) Object.defineProperty(globalThis, 'BroadcastChannel', originalChannel)
  else delete globalThis.BroadcastChannel
}
