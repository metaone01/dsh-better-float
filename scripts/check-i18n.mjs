import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { build } from 'esbuild'
import { createLocaleFixture } from './i18n-fixture.mjs'

const { outputFiles } = await build({
  entryPoints: ['src/shared/i18n.ts'], bundle: true, write: false, format: 'cjs',
})
const shared = { exports: {} }
vm.runInNewContext(outputFiles[0].text, { module: shared, exports: shared.exports })
const { en, zh, LOCALE_NAMESPACE, messagesFor, englishMessages } = shared.exports
assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort())
for (const key of Object.keys(en)) {
  assert.ok(en[key].length > 0 && zh[key].length > 0)
  const parameters = (text) => [...text.matchAll(/\{([^}]+)\}/gu)].map((match) => match[1]).sort()
  assert.deepEqual(parameters(en[key]), parameters(zh[key]), `${key}: interpolation parameters must match`)
}
assert.equal(englishMessages.t('place', { title: '<项目>' }), 'Place <项目>')
assert.equal(englishMessages.t('close'), 'Close')

const locale = createLocaleFixture()
const disposeDictionary = locale.register(LOCALE_NAMESPACE, { en, zh })
const messages = messagesFor(locale)
assert.equal(messages.t('close'), 'Close')
locale.setLanguage('zh')
assert.equal(messages.t('close'), '关闭')
assert.equal(messages.t('restoreError', { error: '原始错误' }), '无法还原页面：原始错误')
locale.setLanguage('fr')
assert.equal(messages.t('close'), 'Close')
disposeDictionary()

let client
const sandbox = {
  window: { __ModuleLoader__: { load: ({ factory }) => {
    client = factory((name) => {
      assert.equal(name, 'react')
      return { createElement: () => null }
    })
  } } },
}
vm.runInNewContext(await readFile('lib/client.js', 'utf8'), sandbox)
assert.ok(Array.from(client.inject).includes('locale'))
const effects = []
const commands = new Map()
client.apply({
  locale,
  effect(run) { const stop = run(); effects.push(stop); return stop },
  slots: { inject: (_name, register) => register(), register: () => () => {} },
  shortcuts: { register(command) {
    commands.set(command.id, command)
    return () => commands.delete(command.id)
  } },
})
assert.equal(commands.size, 2)
for (const language of ['en', 'zh', 'en']) {
  locale.setLanguage(language)
  const dictionary = language === 'zh' ? zh : en
  assert.equal(commands.get('betterFloat.scout').label(), dictionary.pickCommand)
  assert.equal(commands.get('betterFloat.overview').label(), dictionary.overviewCommand)
  assert.equal(commands.get('betterFloat.scout').resolve().status, 'pass')
}
for (const stop of effects.reverse()) stop?.()
assert.equal(commands.size, 0)
assert.equal(locale.dictionaries.size, 0)
assert.equal(locale.listeners.size, 0)
console.log(`i18n: ${Object.keys(en).length} bilingual keys, matching interpolation, fallback, live command labels and disposal passed`)
