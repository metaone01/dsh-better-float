import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const isolated = join(root, '.dsh-debug-userdata-e0e1-20261003')
const app = 'G:/Deepseek Harness Desktop/DeepSeek Harness.exe'
const port = Number(process.argv[2] ?? 9222)
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid CDP port')
await new Promise((resolve, reject) => {
  const server = createServer()
  server.once('error', () => reject(new Error(`Loopback port ${port} is already occupied; refusing to attach to another instance`)))
  server.listen(port, '127.0.0.1', () => server.close(resolve))
})
if (!existsSync(app) || !existsSync(join(isolated, 'harness', 'profiles', 'desktop', 'package.json'))) {
  throw new Error('Expected installed DSH and prepared isolated profile')
}
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'ELECTRON_RUN_AS_NODE'))
env.DSH_HOME = join(isolated, 'harness')
const child = spawn(app, [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1',
  `--user-data-dir=${join(isolated, 'electron')}`], {
  env, stdio: 'ignore', windowsHide: true,
})
child.on('error', error => { console.error(error); process.exitCode = 1 })
child.on('exit', (code, signal) => console.log(`Isolated DSH exited: code=${code}, signal=${signal}`))
console.log(JSON.stringify({ pid: child.pid, userData: join(isolated, 'electron'), harnessHome: env.DSH_HOME, port }))
