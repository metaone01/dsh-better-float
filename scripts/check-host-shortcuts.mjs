import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const host = resolve(process.argv[2] ?? '../deepseek-harness')
const source = `
export { ShortcutRegistry } from ${JSON.stringify(`${host}/packages/client/shortcuts/src/client/registry.ts`)};
export { installWorkspaceShortcuts, createWorkspaceShortcutControls } from ${JSON.stringify(`${host}/packages/client/ui-workspace/src/client/shortcuts.ts`)};
export { apply } from ${JSON.stringify(resolve('src/client/index.ts'))};
`
const result = await build({ stdin: { contents: source, resolveDir: process.cwd() },
  bundle: true, platform: 'node', format: 'cjs', write: false,
  logLevel: 'error', plugins: [{ name: 'host-services', setup(builder) {
    builder.onResolve({ filter: /^@deepseek-ai\// }, (args) => ({ path: args.path, external: true }))
  } }] })
const module = { exports: {} }
const require = createRequire(import.meta.url)
// Only the store service is substituted; reservation/conflict validation and
// workspace command registration execute the actual host implementation.
const hostRequire = (id) => {
  if (id === '@deepseek-ai/dsh-client-store') return { createSnapshotStore: (initial) => {
    let value = initial
    return { getSnapshot: () => value, set: (next) => { value = next }, subscribe: () => () => {} }
  } }
  if (id === '@deepseek-ai/dsh-util-values') return { assertNever: (value) => { throw new Error(`Unexpected value: ${value}`) } }
  if (id === '@deepseek-ai/dsh-util-crypto') return { randomUUID: () => 'test-id' }
  return require(id)
}
new Function('require', 'module', 'exports', result.outputFiles[0].text)(hostRequire, module, module.exports)
const { ShortcutRegistry, installWorkspaceShortcuts, createWorkspaceShortcutControls, apply } = module.exports

for (const runtime of ['desktop', 'web']) {
  for (const platform of ['windows', 'macos', 'linux']) {
    for (const pluginFirst of [true, false]) {
      const registry = new ShortcutRegistry(runtime, platform)
      const disposers = []
      const ctx = {
        effect: (run) => { const dispose = run(); if (typeof dispose === 'function') disposers.push(dispose) },
        shortcuts: registry,
        slots: { inject: () => () => {}, entries: () => [] },
        locale: { bind: () => (key) => key },
      }
      const workspace = () => installWorkspaceShortcuts(ctx, {}, createWorkspaceShortcutControls(), () => {})
      if (pluginFirst) { apply(ctx); workspace() } else { workspace(); apply(ctx) }
      const overview = registry.definitions().find((row) => row.id === 'betterFloat.overview')
      assert.ok(overview)
      const oldDefaults = Object.fromEntries(Object.keys(overview.defaults).map((profile) =>
        [profile, { code: 'KeyF', modifiers: ['primary', 'shift'] }]))
      assert.throws(() => registry.register({ id: 'test.oldOverview', label: () => 'Old overview',
        defaults: oldDefaults, regions: ['page'], modals: [], resolve: () => ({ status: 'pass' }) }),
      /Conflicting shortcut defaults: .*session\.fork/)
      if (runtime === 'desktop' || platform !== 'linux') {
        assert.deepEqual(overview.defaults[`${runtime}:${platform}`], { code: 'KeyS', modifiers: ['primary', 'alt', 'shift'] })
      }
      for (const dispose of disposers.reverse()) dispose()
    }
  }
}
console.log('Host shortcut registry: all 12 profile/registration-order cases passed')
