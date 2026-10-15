const{app,BrowserWindow}=require('electron')
const{build}=require('esbuild')
const{join}=require('node:path')
app.setPath('userData',join(__dirname,'..','.dsh-debug-userdata-consent'))
app.on('window-all-closed',()=>{})
app.whenReady().then(async()=>{
  let window
  const timeout=setTimeout(()=>{console.error('Consent test timed out');app.exit(1)},30000)
  try{
    const{outputFiles}=await build({entryPoints:[join(__dirname,'consent-browser-cases.mjs')],bundle:true,write:false,format:'iife',globalName:'ConsentChecks'})
    window=new BrowserWindow({show:false,width:1100,height:800,webPreferences:{nodeIntegration:false,contextIsolation:true}})
    await window.loadURL('data:text/html,<html><head></head><body></body></html>')
    await window.webContents.executeJavaScript(outputFiles[0].text)
    const result=await window.webContents.executeJavaScript('ConsentChecks.run()',true)
    console.log(`Consent UI: ${result.checks} assertions passed; fake backend, real Chromium lifecycle`)
    app.exit(0)
  }catch(error){console.error(error);app.exit(1)}finally{clearTimeout(timeout);window?.destroy()}
})
