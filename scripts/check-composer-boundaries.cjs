const {app,BrowserWindow}=require('electron')
const {build}=require('esbuild')
const {openSync,readSync,closeSync}=require('original-fs')
const {mkdtempSync}=require('node:fs')
const {writeFile,mkdir}=require('node:fs/promises')
const {tmpdir}=require('node:os')
const {join,resolve}=require('node:path')
const assert=require('node:assert/strict')
const root=resolve(__dirname,'..')
app.setPath('userData',join(mkdtempSync(join(tmpdir(),'better-float-composer-check-')),'electron'))
app.on('window-all-closed',()=>{})
const timeout=setTimeout(()=>app.exit(1),30000)

// Test-only reuse of the shipped Lexical core. No host process, profile or bundle is patched.
function shippedLexical(){
  const fd=openSync('G:/Deepseek Harness Desktop/resources/app.asar','r')
  try{
    const prefix=Buffer.alloc(16);readSync(fd,prefix,0,16,0)
    const bytes=Buffer.alloc(prefix.readUInt32LE(12));readSync(fd,bytes,0,bytes.length,16)
    let item=JSON.parse(bytes.toString());for(const part of 'dsh/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js'.split('/'))item=item.files[part]
    const contents=Buffer.alloc(item.size);readSync(fd,contents,0,contents.length,8+prefix.readUInt32LE(4)+Number(item.offset))
    const code=contents.toString(),start=code.indexOf('//#region ../../../node_modules/.pnpm/lexical@'),end=code.indexOf('//#endregion',start)
    assert.ok(start>=0 && end>start,'Shipped Lexical region is identifiable')
    const create=code.match(/this\.editor = (\w+)\(\{\s*namespace: "dsh-composer"/)?.[1]
    assert.ok(create,'Shipped composer editor constructor is identifiable')
    return `window.ShippedLexical=(()=>{${code.slice(start,end)};return {createEditor:${create}}})();true`
  }finally{closeSync(fd)}
}
app.whenReady().then(async()=>{
  let source,popup,manager,checks=0
  const test=async(name,run)=>{await run();checks++;console.log('PASS '+name)}
  try{
    const browser=await build({stdin:{contents:"export {captureControls} from './src/detach/semantic-adapter.ts'; export {validSnapshot,validIntent} from './src/shared/control-adapter.ts';export {selectionFailure} from './src/detach/selection-failure.ts'",resolveDir:root},bundle:true,write:false,format:'iife',globalName:'ComposerChecks'})
    source=new BrowserWindow({show:false,width:800,height:600,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}})
    await source.loadURL('data:text/html,<html><body style="margin:24px"></body></html>')
    await source.webContents.executeJavaScript(shippedLexical())
    await source.webContents.executeJavaScript(browser.outputFiles[0].text)
    const ev=expression=>source.webContents.executeJavaScript(expression,true)
    await ev(`(()=>{
      window.composer=document.createElement('section');composer.style.cssText='width:600px;height:230px;color:rgb(20,20,20);font:15px/24px sans-serif';
      composer.innerHTML='<div>聊天草稿</div><div data-composer-card style="border:1px solid rgb(170,170,170);border-radius:12px;background:white"><div contenteditable="true" role="textbox" aria-multiline="true" data-composer-input data-placeholder="请输入草稿" style="height:120px;width:580px"></div><button type="button">发送</button><button type="button">模型</button></div>';
      document.body.append(composer);window.editable=composer.querySelector('[data-composer-input]');
      window.editor=ShippedLexical.createEditor({namespace:'dsh-composer',onError:error=>{throw error}});editor.setRootElement(editable);
      window.seed=text=>{const paragraph=line=>({type:'paragraph',version:1,format:'',indent:0,direction:null,children:line?[{type:'text',version:1,text:line,format:0,detail:0,mode:'normal',style:''}]:[]});editor.setEditorState(editor.parseEditorState({root:{type:'root',version:1,format:'',indent:0,direction:null,children:text.split('\\n').map(paragraph)}}),{tag:'skip-dom-selection'})};
      seed('初始草稿');window.adapter=ComposerChecks.captureControls(composer);window.sendClicks=0;composer.querySelector('button').onclick=()=>sendClicks++;
      return true;
    })()`)
    await test('shipped Lexical is borrowed; valid multiline snapshot preserves source',async()=>{
      const snapshot=await ev('adapter.read(0)');assert.equal(snapshot.adapter,'composer-v1');assert.equal(snapshot.controls[0].value,'初始草稿');assert.equal(snapshot.controls[0].multiline,true);assert.equal(snapshot.controls[0].readOnly,false);assert.equal(await ev('ComposerChecks.validSnapshot(adapter.read(0))'),true);assert.equal(await ev('editor.getRootElement()===editable && editable.isConnected'),true)
    })
    await test('pure multiline draft writes use editor state and never send or focus source',async()=>{
      const result=await ev(`(()=>{const c=adapter.read(0).controls[0];adapter.apply({seq:1,key:'c0',kind:'input',binding:c.binding,expectedValue:c.value,value:'中文草稿\\n第二行'});return {value:adapter.read(1).controls[0].value,clicks:sendClicks,focused:document.activeElement===editable}})()`)
      assert.equal(result.value,'中文草稿\n第二行');assert.equal(result.clicks,0);assert.equal(result.focused,false)
    })
    await test('stale base, absent binding and unsupported placeholders cannot overwrite draft',async()=>{
      const result=await ev(`(()=>{const c=adapter.read(0).controls[0];let rejected=0;for(const extra of [{expectedValue:'过时'},{binding:undefined},{value:'伪造\\uFFFC引用'}])try{adapter.apply({seq:2,key:'c0',kind:'input',binding:c.binding,expectedValue:c.value,value:'不能写入',...extra})}catch{rejected++}return{rejected,value:adapter.read(0).controls[0].value}})()`)
      assert.equal(result.rejected,3);assert.equal(result.value,'中文草稿\n第二行')
    })
    await test('formatted draft becomes read-only; no content is flattened on rejected write',async()=>{
      const result=await ev(`(()=>{const json=editor.getEditorState().toJSON();json.root.children[0].children[0].format=1;editor.setEditorState(editor.parseEditorState(json),{tag:'skip-dom-selection'});const c=adapter.read(0).controls[0];let rejected=false;try{adapter.apply({seq:3,key:'c0',kind:'input',binding:c.binding,expectedValue:c.value,value:'replacement'})}catch{rejected=true}return{readOnly:c.readOnly,rejected,format:editor.getEditorState().toJSON().root.children[0].children[0].format}})()`)
      assert.equal(result.readOnly,true);assert.equal(result.rejected,true);assert.equal(result.format,1);await ev("seed('窗口草稿')")
      assert.equal(await ev("(()=>{const json=editor.getEditorState().toJSON();json.root.children[0].indent=1;editor.setEditorState(editor.parseEditorState(json),{tag:'skip-dom-selection'});return adapter.read(0).controls[0].readOnly})()"),true)
      await ev("seed('窗口草稿')")
    })
    await test('disabled editor and replaced resident editor fail closed',async()=>{
      assert.equal(await ev("editor.setEditable(false);adapter.read(0).controls[0].readOnly"),true);await ev('editor.setEditable(true)')
      assert.equal(await ev("(()=>{const old=editable.__lexicalEditor;editable.__lexicalEditor={};try{adapter.read(0);return false}catch{return true}finally{editable.__lexicalEditor=old}})()"),true)
    })
    await test('hidden/oversized drafts are excluded; unsupported decoration does not erase safe labels',async()=>{
      const result=await ev(`(()=>{const image=document.createElement('img');composer.append(image);const snapshot=adapter.read(0);image.remove();composer.hidden=true;let hidden=false;try{adapter.read(0)}catch{hidden=true}composer.hidden=false;seed('x'.repeat(513));let oversized=false;try{adapter.read(0)}catch{oversized=true}seed('窗口草稿');return{hidden,oversized,text:snapshot.scene?.items.map(item=>item.text).join(''),valid:ComposerChecks.validSnapshot(snapshot),card:snapshot.scene?.items.some(item=>item.icon?.shapes[0].tag==='rect')}})()`)
      assert.equal(result.hidden,true);assert.equal(result.oversized,true);assert.ok(result.text.includes('聊天草稿'));assert.ok(result.text.includes('发送'));assert.equal(result.valid,true);assert.equal(result.card,true)
    })
    await test('protocol rejects malformed composer shape, multiline flags and conflict payloads',async()=>{
      const result=await ev(`(()=>{const s=adapter.read(0);return [ComposerChecks.validSnapshot({...s,controls:[{...s.controls[0],multiline:'true'}]}),ComposerChecks.validSnapshot({...s,controls:[{key:'c0',kind:'button',text:'send',disabled:false,binding:s.controls[0].binding}]}),ComposerChecks.validIntent({kind:'input',key:'c0',value:'x',expectedValue:'x'.repeat(513)}),ComposerChecks.validIntent({kind:'click',key:'c0',expectedValue:'x'})]})()`)
      assert.deepEqual(result,[false,false,false,false])
    })
    await test('native textarea round trip and concrete failure classification',async()=>{
      const result=await ev(`(()=>{const field=document.createElement('textarea');field.value='原稿';document.body.append(field);const native=ComposerChecks.captureControls(field);native.apply({seq:1,key:'c0',kind:'input',value:'多行\\n文字'});const snapshot=native.read(1);field.remove();return {multiline:snapshot.controls[0].multiline,value:snapshot.controls[0].value,valid:ComposerChecks.validSnapshot(snapshot),editor:ComposerChecks.selectionFailure(Error('Unsupported editable control')),limit:ComposerChecks.selectionFailure(Error('Adapter supports at most six standard controls'))}})()`)
      assert.equal(result.multiline,true);assert.equal(result.value,'多行\n文字');assert.equal(result.valid,true);assert.equal(result.editor,'companionUnsupportedEditor');assert.equal(result.limit,'companionControlLimit')
    })
    const node=await build({entryPoints:[join(root,'companion/window-manager.ts')],bundle:true,platform:'node',format:'cjs',write:false,external:['electron']})
    const module={exports:{}};new Function('require','module','exports',node.outputFiles[0].text)(require,module,module.exports)
    manager=module.exports.createCompanionWindows(join(root,'lib/companion'),false)
    let seq=0,actionResults=[]
    const surface=await manager.open('composer-ui',await ev('adapter.read(0)'),intent=>{
      void ev(`(()=>{try{adapter.apply(${JSON.stringify({...intent,seq:++seq})});return true}catch{return false}})()`).then(async accepted=>{actionResults.push(accepted);surface.update(await ev(`adapter.read(${seq})`))});return true
    })
    popup=BrowserWindow.getAllWindows().find(window=>window!==source)
    const pe=expression=>popup.webContents.executeJavaScript(expression,true)
    const pause=()=>new Promise(resolve=>setTimeout(resolve,180))
    await pause()
    await test('native popup typing and composition keep local draft until explicit synchronization',async()=>{
      assert.equal(await pe('document.querySelector("textarea").value'),'窗口草稿')
      await pe('document.querySelector("textarea").focus()');popup.webContents.insertText('中文输入');await pause()
      assert.equal(await ev('adapter.read(0).controls[0].value'),'窗口草稿')
      await pe('document.querySelector("textarea").dispatchEvent(new CompositionEvent("compositionstart"))');assert.equal(await pe('document.querySelector("#draft-actions button").disabled'),true)
      await pe('document.querySelector("textarea").dispatchEvent(new CompositionEvent("compositionend"))')
      await pe('document.querySelector("#draft-actions button").click()');await pause();await pause()
      assert.equal(actionResults.at(-1),true);assert.equal(await ev('adapter.read(0).controls[0].value'),'窗口草稿中文输入');assert.ok((await pe('document.querySelector("#draft-actions span").textContent')).includes('已确认同步'))
      assert.equal(await ev('sendClicks'),0)
    })
    await test('source edits during local draft retain local text and block stale overwrite',async()=>{
      await pe('document.querySelector("textarea").focus()');popup.webContents.insertText('未同步');await pause()
      await ev("seed('原窗口的新草稿')");surface.update(await ev(`adapter.read(${++seq})`));await pause()
      assert.equal(await pe('document.querySelector("textarea").value'),'窗口草稿中文输入未同步');assert.equal(await pe('document.querySelector("#draft-actions button").disabled'),true);assert.equal(await ev('adapter.read(0).controls[0].value'),'原窗口的新草稿')
    })
    await test('decorative original send button is not rebound or clickable as a control',async()=>{
      assert.equal(await pe('document.querySelectorAll("#controls button").length'),0)
      await pe('[...document.querySelectorAll("#scene span")].find(node=>node.textContent==="发送").click()')
      assert.equal(await ev('sendClicks'),0)
    })
    await mkdir(join(root,'docs/screenshots'),{recursive:true})
    await writeFile(join(root,'docs/screenshots/composer-draft-regression.png'),(await popup.webContents.capturePage()).toPNG())
    const report={executedAt:new Date().toISOString(),checks,scope:'isolated Electron, shipped Lexical core and real native popup; not a running DSH composer or default-profile acceptance',defaultProfileModified:false,sendingEnabled:false}
    await writeFile(join(root,'docs/companion-selection-composer-regression-2026-10-11.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2))
    clearTimeout(timeout);manager.dispose();source.destroy();app.exit(0)
  }catch(error){console.error(error);clearTimeout(timeout);manager?.dispose();source?.destroy();app.exit(1)}
})
