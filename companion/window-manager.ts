import {BrowserWindow,ipcMain} from 'electron'
import {join} from 'node:path'
import {validIntent,validSnapshot,type ControlSnapshot,type ControlIntent} from '../src/shared/control-adapter.ts'
import {appearanceCss} from '../src/shared/control-appearance.ts'
import type {TestSurface} from './server.ts'
import {sceneCss} from './control-scene.ts'

interface ControlsSurface {
  window:BrowserWindow;snapshot:ControlSnapshot;intent:(intent:ControlIntent)=>boolean;
  cssKey?:string;appearanceSignature?:string;pending?:ControlSnapshot;updating?:boolean
}

/** One white-listed preload surface per owned window; no general invoke bridge. */
export function createCompanionWindows(directory:string,show=true) {
  const surfaces=new Map<number,ControlsSurface>()
  const setAppearance=async(surface:ControlsSurface,snapshot:ControlSnapshot):Promise<void>=>{
    const appearance=snapshot.appearance
    const signature=JSON.stringify({appearance,scene:snapshot.scene})
    if(signature===surface.appearanceSignature)return
    const css=appearanceCss(appearance)+sceneCss(snapshot.scene,appearance?.mode==='captured' && !!appearance.frame)
    const key=css?await surface.window.webContents.insertCSS(css):undefined
    if(surface.window.isDestroyed())return
    if(surface.cssKey)await surface.window.webContents.removeInsertedCSS(surface.cssKey)
    surface.cssKey=key
    surface.appearanceSignature=signature
  }
  const flush=async(surface:ControlsSurface):Promise<void>=>{
    if(surface.updating)return
    surface.updating=true
    try {
      while(surface.pending && !surface.window.isDestroyed()) {
        const next=surface.pending
        surface.pending=undefined
        try {await setAppearance(surface,next)}
        catch {
          if(surface.window.isDestroyed())return
          // Style failures never broaden CSP or disable business controls.
          if(surface.cssKey)await surface.window.webContents.removeInsertedCSS(surface.cssKey).catch(()=>{})
          surface.cssKey=undefined;surface.appearanceSignature=undefined
          if(!surface.pending)surface.snapshot={...next,appearance:{mode:'fallback',reason:'unavailable'}}
        }
        if(!surface.pending && !surface.window.isDestroyed())surface.window.webContents.send('float-controls:snapshot',surface.snapshot)
      }
    } finally {surface.updating=false}
  }
  ipcMain.handle('float-controls:state',event=>{
    const surface=surfaces.get(event.sender.id)
    if(!surface || event.senderFrame!==surface.window.webContents.mainFrame)throw new Error('Unowned controls sender')
    return surface.snapshot
  })
  ipcMain.handle('float-controls:action',(event,intent:unknown)=>{
    const surface=surfaces.get(event.sender.id)
    return !!surface && event.senderFrame===surface.window.webContents.mainFrame && validIntent(intent) && surface.intent(intent)
  })
  return {
    async open(_id:string,snapshot?:ControlSnapshot,onIntent?:(intent:ControlIntent)=>boolean):Promise<TestSurface> {
      if(snapshot && !validSnapshot(snapshot))throw new Error('Invalid controls snapshot')
      const window=new BrowserWindow({width:440,height:snapshot?420:240,show:false,title:snapshot?'Better Float · External window (Preview)':'Better Float · Connection test',
        webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,
          ...(snapshot?{preload:join(directory,'preload.cjs')}:{})}})
      if(snapshot && onIntent)surfaces.set(window.webContents.id,{window,snapshot,intent:onIntent})
      const contentsId=window.webContents.id
      window.on('closed',()=>surfaces.delete(contentsId))
      window.webContents.on('did-finish-load',()=>{
        const surface=surfaces.get(contentsId)
        if(surface && !window.isDestroyed()){
          // Chromium drops document-scoped inserted CSS on navigation/reload.
          surface.cssKey=undefined;surface.appearanceSignature=undefined
          surface.pending=surface.snapshot;void flush(surface).catch(()=>{})
        }
      })
      window.webContents.setWindowOpenHandler(()=>({action:'deny'}))
      window.webContents.on('will-navigate',event=>event.preventDefault())
      try {
        await window.loadFile(join(directory,snapshot?'controls-window.html':'test-window.html'))
        const surface=surfaces.get(contentsId)
        if(surface){
          const frame=surface.snapshot.appearance?.mode==='captured'?surface.snapshot.appearance.frame:undefined
          if(frame)window.setContentSize(Math.min(2048,Math.max(240,Math.ceil(frame.width+48))),Math.min(2048,Math.max(180,Math.ceil(frame.height+48))))
          surface.pending=surface.snapshot;await flush(surface)
        }
        if(show)window.showInactive()
      }
      catch(error){window.destroy();throw error}
      return{close:()=>{if(!window.isDestroyed())window.destroy()},alive:()=>!window.isDestroyed(),update:next=>{
        const surface=surfaces.get(contentsId)
        if(surface && !window.isDestroyed() && validSnapshot(next) && next.revision>=surface.snapshot.revision) {
          const previous=surface.snapshot.appearance
          const retain=next.appearance===undefined && previous?.mode==='captured'
            && Object.keys(previous.assignments).length===next.controls.length
            && next.controls.every(control=>Object.hasOwn(previous.assignments,control.key))
          surface.snapshot={...next,...retain?{appearance:previous}:next.appearance===undefined && previous?.mode==='fallback'?{appearance:previous}:{}}
          surface.pending=surface.snapshot
          void flush(surface).catch(()=>{if(!window.isDestroyed())window.destroy()})
        }
      }}
    },
    dispose():void {
      for(const surface of surfaces.values())if(!surface.window.isDestroyed())surface.window.destroy()
      surfaces.clear()
      ipcMain.removeHandler('float-controls:state');ipcMain.removeHandler('float-controls:action')
    },
  }
}
