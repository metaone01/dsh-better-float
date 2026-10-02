import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

const app = 'G:/Deepseek Harness Desktop/DeepSeek Harness.exe'
const userData = 'G:/Code/fork/dsh-better-float/.dsh-debug-userdata'
const port = Number(process.argv[2] ?? 9222)
if (!existsSync(app)) throw new Error(`not found: ${app}`)

const child = spawn(app, [
  '--no-sandbox',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${userData}`,
], {
  detached: false,
  stdio: 'ignore',
  env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'ELECTRON_RUN_AS_NODE')),
})
console.log(`DSH debug process ${child.pid}; user data: ${userData}; CDP: ${port}`)
child.on('exit', (code, signal) => console.log(`DSH exited code=${code} signal=${signal}`))
await new Promise((resolve) => {
  process.on('SIGINT', resolve)
  process.on('SIGTERM', resolve)
})
