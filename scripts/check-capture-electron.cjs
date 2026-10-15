const { app, BrowserWindow } = require('electron')
const { build } = require('esbuild')
const { mkdtempSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

// Isolated throwaway profile: this never opens or patches the installed DSH.
app.setPath('userData', mkdtempSync(join(tmpdir(), 'dsh-capture-check-')))
app.on('window-all-closed', () => {})
const timeout = setTimeout(() => { console.error('capture regression timed out'); app.exit(1) }, 45000)
app.whenReady().then(async () => {
  let window
  try {
    const { outputFiles } = await build({ entryPoints: [join(__dirname, 'capture-browser-cases.mjs')],
      bundle: true, write: false, format: 'iife', globalName: 'CaptureChecks' })
    window = new BrowserWindow({ width: 1000, height: 700, show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true, offscreen: true, backgroundThrottling: false } })
    await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>'))
    await window.webContents.executeJavaScript(outputFiles[0].text)
    const result = await window.webContents.executeJavaScript('CaptureChecks.run()', true)
    console.log(`capture browser: ${result.checks} assertions passed in real Chromium ${process.versions.chrome}`)
    clearTimeout(timeout)
    window.destroy()
    app.exit(0)
  } catch (error) {
    console.error(error)
    clearTimeout(timeout)
    window?.destroy()
    app.exit(1)
  }
})
