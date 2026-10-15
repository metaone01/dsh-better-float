const {app,BrowserWindow}=require('electron')
const {build}=require('esbuild')
const {mkdtempSync}=require('node:fs')
const {tmpdir}=require('node:os')
const {join,resolve}=require('node:path')
const assert=require('node:assert/strict')
const root=resolve(__dirname,'..')
app.setPath('userData',join(mkdtempSync(join(tmpdir(),'better-float-selection-diagnostic-')),'electron'))
const deadline=setTimeout(()=>app.exit(1),20000)
app.whenReady().then(async()=>{
  let window
  try{
    const browser=await build({stdin:{contents:"export {fixture} from './scripts/workspace-appearance-browser-cases.mjs'; export {captureControls} from './src/detach/semantic-adapter.ts'",resolveDir:root},bundle:true,write:false,format:'iife',globalName:'SelectionDiagnostic'})
    window=new BrowserWindow({show:false,width:600,height:600,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}})
    await window.loadURL('data:text/html,<html><body></body></html>')
    await window.webContents.executeJavaScript(browser.outputFiles[0].text)
    const report=await window.webContents.executeJavaScript(`(()=>{
      const normal=SelectionDiagnostic.fixture();
      const source=document.querySelector('#workspace-visual-source');
      const box=node=>{const r=node.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}};
      const originalBox=box(source);
      const wrapper=document.createElement('div');wrapper.style.display='contents';source.before(wrapper);wrapper.append(source);
      const wrapped=SelectionDiagnostic.captureControls(wrapper).read(0);
      source.querySelector('header>span').textContent='工作区';source.querySelector('[data-row-key="workspace:default"] .title').textContent='默认工作区';
      for(const [index,row] of [...source.querySelectorAll('[data-row-key^="session:"]')].entries())if(index===0)row.querySelector('.title').textContent='新会话';else row.remove();
      const chinese=SelectionDiagnostic.captureControls(wrapper).read(0);
      const cases=[];
      for(const [name,html] of [['native-text-input','<input type="text" value="test">'],['textarea','<textarea>test</textarea>'],['contenteditable','<div contenteditable="true">test</div>']]){
        const test=document.createElement('section');test.innerHTML=html;document.body.append(test);
        try{const snapshot=SelectionDiagnostic.captureControls(test).read(0);cases.push({name,accepted:true,controls:snapshot.controls.map(control=>control.kind)})}
        catch(error){cases.push({name,accepted:false,error:error.message})}
        finally{test.remove()}
      }
      const span=document.createElement('span');span.style.display='contents';span.textContent='普通文字';document.body.append(span);const textSnapshot=SelectionDiagnostic.captureControls(span).read(0);span.remove();
      return {scope:'isolated synthetic fixture, not the user selected DOM',normal:{box:originalBox,appearance:normal.appearance?.mode,scene:!!normal.scene},displayContents:{box:box(wrapper),appearance:wrapped.appearance.mode,frame:wrapped.appearance.frame,scene:!!wrapped.scene},chineseSingleSession:{appearance:chinese.appearance.mode,scene:!!chinese.scene,controls:chinese.controls.length,text:chinese.scene?.items.map(item=>item.text).join('')},displayContentsSpan:!!textSnapshot.scene,inputCases:cases};
    })()`)
    assert.equal(report.normal.appearance,'captured')
    assert.equal(report.displayContents.box.width,0)
    assert.equal(report.displayContents.appearance,'captured')
    assert.equal(report.displayContents.scene,true)
    assert.equal(report.chineseSingleSession.appearance,'captured')
    assert.equal(report.chineseSingleSession.controls,5)
    assert.ok(report.chineseSingleSession.text.includes('新会话'))
    assert.equal(report.displayContentsSpan,true)
    assert.equal(report.inputCases[0].accepted,true)
    assert.equal(report.inputCases[1].accepted,true)
    assert.equal(report.inputCases[2].accepted,false)
    assert.equal(report.inputCases[2].error,'Unsupported editable control')
    console.log(JSON.stringify(report,null,2))
    clearTimeout(deadline);window.destroy();app.exit(0)
  }catch(error){console.error(error);clearTimeout(deadline);window?.destroy();app.exit(1)}
})
