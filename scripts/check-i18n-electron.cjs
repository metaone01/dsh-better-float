const { app, BrowserWindow, nativeTheme } = require('electron')
const { build } = require('esbuild')
const { mkdir, writeFile } = require('node:fs/promises')
const { join } = require('node:path')

const root = join(__dirname, '..')
app.setPath('userData', join(root, '.dsh-debug-userdata-i18n'))
app.on('window-all-closed', () => {})
app.whenReady().then(async () => {
  let window
  try {
    const { outputFiles } = await build({ entryPoints: [join(__dirname, 'i18n-browser-cases.mjs')],
      bundle: true, write: false, format: 'iife', globalName: 'I18nChecks',
    })
    await mkdir(join(root, 'spikes'), { recursive: true })
    let total = 0
    for (const [name, width, height] of [['desktop', 1280, 800], ['mobile', 390, 844]]) {
      nativeTheme.themeSource = name === 'desktop' ? 'dark' : 'light'
      window = new BrowserWindow({ width, height, useContentSize: true, show: false,
        webPreferences: { nodeIntegration: false, contextIsolation: true, offscreen: true, backgroundThrottling: false },
      })
      await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><html style="color-scheme:light"><head><meta charset="utf-8"></head><body></body></html>'))
      await window.webContents.executeJavaScript(outputFiles[0].text)
      const result = await window.webContents.executeJavaScript('I18nChecks.run()', true)
      await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
      total += result.checks
      const screenshot = await window.webContents.capturePage()
      const pixels = screenshot.toBitmap()
      let colored = 0
      for (let offset = 0; offset < pixels.length; offset += 4) {
        if (pixels[offset + 3] > 0 && pixels[offset] < 240) colored++
      }
      if (colored < 1000) throw new Error(`${name}: screenshot is blank`)
      await writeFile(join(root, 'spikes', `i18n-${name}.png`), screenshot.toPNG())
      for (const scheme of ['light', 'dark']) {
        for (const language of ['zh', 'en']) {
          const rect = await window.webContents.executeJavaScript(`I18nChecks.showHint('${language}', '${scheme}')`)
          await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
          let hint
          // Hidden offscreen windows may return the previous frame on the first capture.
          for (let attempt = 0; attempt < 5; attempt++) {
            hint = await window.webContents.capturePage(rect)
            const bitmap = hint.toBitmap()
            const colors = new Set()
            for (let offset = 0; offset < bitmap.length; offset += 4) {
              colors.add(bitmap.readUInt32LE(offset))
              if (colors.size > 16) break
            }
            if (colors.size > 16) break
            if (attempt === 4) throw new Error(`${name}/${language}/${scheme}: hint screenshot is blank`)
            await new Promise(resolve => setTimeout(resolve, 50))
          }
          const filename = scheme === 'light' ? `i18n-hint-${language}-${name}.png` : `i18n-hint-${language}-${name}-dark.png`
          await writeFile(join(root, 'spikes', filename), hint.toPNG())
        }
      }
      console.log(`i18n browser: ${name} ${result.width}x${result.height}, ${result.checks} assertions passed`)
      window.destroy()
      window = null
    }
    console.log(`i18n browser: ${total} assertions passed in real Chromium`)
    app.exit(0)
  } catch (error) {
    console.error(error)
    window?.destroy()
    app.exit(1)
  }
})
