import { contextBridge, ipcRenderer } from 'electron'
import { validSnapshot, validIntent, type ControlSnapshot, type ControlIntent } from '../src/shared/control-adapter.ts'
contextBridge.exposeInMainWorld('floatControls', {
  state:async()=>{
    const state:unknown=await ipcRenderer.invoke('float-controls:state')
    if(!validSnapshot(state))throw new Error('Invalid controls state')
    return state
  },
  action:async(intent:ControlIntent)=> validIntent(intent) && await ipcRenderer.invoke('float-controls:action',intent)===true,
  subscribe:(listener:(snapshot:ControlSnapshot)=>void)=>{
    const handle=(_event:unknown,value:unknown)=>{if(validSnapshot(value))listener(value)}
    ipcRenderer.on('float-controls:snapshot',handle)
    return ()=>ipcRenderer.removeListener('float-controls:snapshot',handle)
  },
})
