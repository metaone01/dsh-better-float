import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { existsSync } from 'node:fs'

const entry=resolve('lib/companion/main.cjs')
if(!existsSync(entry))throw new Error('Build companion first: node scripts/build-companion.mjs')
const env={...process.env,DSH_BETTER_FLOAT_COMPANION_DIR:resolve(process.env.DSH_BETTER_FLOAT_COMPANION_DIR??'.dsh-debug-userdata-companion')}
delete env.ELECTRON_RUN_AS_NODE
const port=process.argv[2]
if(port!==undefined && (!/^\d+$/.test(port) || +port<1 || +port>65535))throw new Error('Invalid optional loopback debug port')
const debug=port===undefined?[]:[`--remote-debugging-port=${port}`,'--remote-debugging-address=127.0.0.1']
const child=spawn(resolve('node_modules/electron/dist/electron.exe'),[...debug,entry],{env,stdio:'inherit',windowsHide:true})
child.on('error',()=>{console.error('Could not launch companion');process.exitCode=1})
child.on('exit',code=>{process.exitCode=code??1})
