window.__ModuleLoader__.load({ id: 'dsh-better-float-acceptance-fixture', factory(require) {
  const React = require('react')
  const { createRoot } = require('react-dom/client')
  const { flushSync } = require('react-dom')
  const Context = React.createContext('context stays live')
  return { inject: ['uiRenderer', 'shortcuts', 'sessions'], apply(ctx) {
    ctx.effect(() => {
      const container = document.createElement('div')
      container.id = 'dsh-bf-acceptance-fixture'
      container.style.cssText = 'position:fixed;left:50px;top:160px;width:360px;z-index:1200;background:white;color:black;padding:12px;border:2px solid #4677cc'
      document.body.append(container)
      const root = createRoot(container)
      let setValue, setCount, setExtras
      const control = { events: [], invoke: () => ctx.shortcuts.registry.invoke('betterFloat.scout', {region:'page',modal:null,target:document.body}),
        companion: () => require('dsh-better-float/client').createCompanionBridge(),
        semantic: () => require('dsh-better-float/client').openSemanticControls(container.querySelector('[data-acceptance-target]')),
        limited: () => flushSync(() => setExtras(false)),
        openSource: source => require('dsh-better-float/client').openSemanticControls(source),
        seedWorkspaceSessions: async () => {
          const ids = []
          const workspaceId = document.querySelector('[data-row-key^="workspace:"]').getAttribute('data-row-key').slice('workspace:'.length)
          for (let index = 0; index < 3; index++) ids.push(await ctx.sessions.create({sessionId:`session-bf-workspace-20261011-ws-${index}`,workspaceId}))
          const response = await fetch('api/better-float-acceptance/seed-workspace',{method:'POST',credentials:'same-origin'})
          if(!response.ok)throw new Error(`Offline acceptance seed unavailable: HTTP ${response.status}: ${(await response.text()).slice(0,600)}`)
          const seed = await response.json()
          if(seed.modelSubmitted!==false || seed.storageReadbackValidated!==true || seed.ids.length!==3)throw new Error('Invalid offline acceptance seed')
          await ctx.sessions.refresh()
          return ids
        },
        catalog: () => ctx.shortcuts.catalog.getSnapshot().filter(row=>row.id.startsWith('betterFloat')),
        unmount: () => root.unmount(), update: () => flushSync(() => setValue('external update')),
        setCount: (value) => flushSync(() => setCount(value)) }
      function Fixture() {
        const [count, updateCount] = React.useState(0)
        const [value, updateValue] = React.useState('unsaved input')
        const [extras, updateExtras] = React.useState(true)
        setExtras = updateExtras
        setValue = updateValue
        setCount = updateCount
        const context = React.useContext(Context)
        return React.createElement('section', { 'data-acceptance-target': '', style: { display:'block',width:330,padding:8 },
          onClick: () => { control.events.push('ancestor') } },
          React.createElement('button', { 'data-counter': '', onClick: e => {
            control.events.push(`button:${e.isTrusted}`); updateCount(n => n+1)
          } }, `Count ${count}`),
          React.createElement('input', { 'data-state-input': '', value, onChange: e => updateValue(e.target.value),
            style: { display:'block',width:220,marginTop:8 } }),
          React.createElement('output', { 'data-context': '' }, context),
          React.createElement('div', { 'data-scroll': '', style: { overflow:'auto',width:160,height:60,marginTop:8 } },
            React.createElement('div', {style:{width:350,height:500}}, 'Scrollable content')),
          extras ? React.createElement('iframe', { 'data-state-frame': '', srcDoc:'<p>stateful iframe</p>',
            style:{width:180,height:50} }) : null)
      }
      flushSync(() => root.render(React.createElement(Context.Provider, { value: 'context stays live' }, React.createElement(Fixture))))
      Object.defineProperty(window, '__BF_ACCEPTANCE__', { value: control, configurable: true })
      return () => { root.unmount(); container.remove(); delete window.__BF_ACCEPTANCE__ }
    }, 'acceptance fixture')
  } }
} })
