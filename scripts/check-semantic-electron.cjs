const{app,BrowserWindow}=require('electron')
const{build}=require('esbuild')
const{join}=require('node:path')
app.setPath('userData',join(__dirname,'..','.dsh-debug-userdata-semantic'))
app.on('window-all-closed',()=>{})
app.whenReady().then(async()=>{
  let window
  try{
    const{outputFiles}=await build({entryPoints:[join(__dirname,'semantic-browser-cases.mjs')],bundle:true,write:false,format:'iife',globalName:'SemanticChecks'})
    window=new BrowserWindow({show:false,webPreferences:{nodeIntegration:false,contextIsolation:true}})
    await window.loadURL('data:text/html,<html><body></body></html>')
    await window.webContents.executeJavaScript(outputFiles[0].text)
    const result=await window.webContents.executeJavaScript('SemanticChecks.run()')
    console.log(`Semantic browser: ${result.checks} assertions passed (native DOM, not host React/live companion acceptance)`)
    app.exit(0)
  }catch(error){console.error(error);app.exit(1)}finally{window?.destroy()}
})
