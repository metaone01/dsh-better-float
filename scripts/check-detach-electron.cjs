const { app, BrowserWindow } = require('electron')
const { build } = require('esbuild')
const { join } = require('node:path')
app.setPath('userData', join(__dirname, '..', '.dsh-debug-userdata-detach'))
app.on('window-all-closed', () => {})
app.whenReady().then(async () => {
  let window
  const timeout = setTimeout(() => { console.error('detach browser checks timed out'); app.exit(1) }, 30000)
  try {
    const { outputFiles } = await build({ entryPoints: [join(__dirname, 'detach-browser-cases.mjs')],
      bundle: true, write: false, format: 'iife', globalName: 'DetachChecks' })
    window = new BrowserWindow({ width: 1100, height: 800, show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true } })
    await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>'))
    await window.webContents.executeJavaScript(outputFiles[0].text)
    const result = await window.webContents.executeJavaScript('DetachChecks.run()', true)
    console.log(`detach Chromium: ${result.checks} assertions passed (${result.input})`)
    const position = await window.webContents.executeJavaScript('DetachChecks.prepareTrusted()', true)
    const input = async event => {
      window.webContents.sendInputEvent(event)
      await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(resolve))')
    }
    try {
      await input({ type: 'mouseMove', x: position.x, y: position.y })
      await input({ type: 'mouseDown', x: position.x, y: position.y, button: 'left', clickCount: 1 })
      await input({ type: 'mouseMove', x: position.x + 40, y: position.y + 30 })
      await input({ type: 'mouseUp', x: position.x + 40, y: position.y + 30, button: 'left', clickCount: 1 })
      let state = await window.webContents.executeJavaScript('DetachChecks.trustedState()')
      if (state.rect.x !== 140 || state.rect.y !== 130 || state.trusted !== 'true') throw new Error('Trusted drag did not move panel')
      const point = { x: position.detach.x + 40, y: position.detach.y + 30 }
      await input({ type: 'mouseMove', ...point })
      await input({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
      await input({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
      state = await window.webContents.executeJavaScript('DetachChecks.trustedState()')
      if (!state.status.includes('cannot open') || state.input !== 'state stays live') throw new Error('Trusted detach did not downgrade safely')
      console.log('detach Chromium: trusted input drag and detach feedback passed (not live DSH/native-window acceptance)')
    } finally {
      await window.webContents.executeJavaScript('DetachChecks.cleanupTrusted()')
    }
    app.exit(0)
  } catch (error) {
    console.error(error)
    app.exit(1)
  } finally {
    clearTimeout(timeout)
    window?.destroy()
  }
})
