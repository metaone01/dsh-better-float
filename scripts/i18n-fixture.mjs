export function createLocaleFixture(initial = 'en') {
  const dictionaries = new Map()
  const listeners = new Set()
  let active = initial
  const notify = () => { for (const listener of listeners) listener() }
  return {
    dictionaries,
    listeners,
    register(namespace, contents) {
      if (dictionaries.has(namespace)) throw new Error(`Duplicate namespace: ${namespace}`)
      dictionaries.set(namespace, contents)
      notify()
      return () => { dictionaries.delete(namespace); notify() }
    },
    bind(namespace) {
      return (key, params) => {
        const contents = dictionaries.get(namespace)
        const text = contents?.[active]?.[key] ?? contents?.en?.[key] ?? key
        return text.replace(/\{([^}]+)\}/gu, (placeholder, name) => String(params?.[name] ?? placeholder))
      }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    setLanguage(language) { active = language; notify() },
  }
}
