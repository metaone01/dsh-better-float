import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {createRequire} from 'node:module'
import {randomBytes} from 'node:crypto'
import {mkdtemp,writeFile,readFile,unlink,rmdir,symlink} from 'node:fs/promises'
import {resolve,join} from 'node:path'
import {createServer} from 'node:net'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'

const require=createRequire(import.meta.url)
const {outputFiles}=await build({stdin:{contents:`export {verifyExistingPairing,recoverStalePairing,removeOwnedPairing,PairingStartupError} from './companion/pairing-lifecycle.ts';
export {protectPairingDirectory} from './src/host/pairing-security.ts';`,resolveDir:process.cwd()},bundle:true,platform:'node',format:'cjs',write:false})
const module={exports:{}}
new Function('require','module','exports',outputFiles[0].text)(require,module,module.exports)
const {verifyExistingPairing,recoverStalePairing,removeOwnedPairing,protectPairingDirectory}=module.exports
const folder=await mkdtemp(resolve('.dsh-debug-userdata-pairing-recovery-'))
await protectPairingDirectory(folder)
const file=join(folder,'pairing.json')
const pairing={pipe:`\\\\.\\pipe\\dsh-better-float-${randomBytes(16).toString('hex')}`,secret:randomBytes(32).toString('hex')}
let checks=0
const test=async(name,run)=>{await run();checks++;console.log(`PASS ${name}`)}
const save=async value=>writeFile(file,JSON.stringify(value),{flag:'wx',mode:0o600})
let server
try {
  await test('missing credential does not require recovery',async()=>assert.equal(await recoverStalePairing(file),false))
  await test('existing broad credential ACL fails before any recovery or permission repair',async()=>{
    await save(pairing)
    const acl=async broaden=>{
      const source=`$ErrorActionPreference='Stop';$target=$env:DSH_BF_TEST_RECOVERY_FILE;$acl=[System.IO.File]::GetAccessControl($target);$sid=[System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-545');${broaden?"$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid,'Read','Allow'))":"$acl.PurgeAccessRules($sid)"};[System.IO.File]::SetAccessControl($target,$acl)`
      await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(source,'utf16le').toString('base64')],{env:{...process.env,DSH_BF_TEST_RECOVERY_FILE:file},windowsHide:true,timeout:5000})
    }
    await acl(true)
    try {
      await assert.rejects(verifyExistingPairing(file),error=>error.reason==='invalid')
      await assert.rejects(recoverStalePairing(file),error=>error.reason==='invalid')
      assert.deepEqual(JSON.parse(await readFile(file,'utf8')),pairing)
    }finally{await acl(false);await unlink(file)}
  })
  await test('valid private orphan is removed for fresh exclusive publication',async()=>{
    await save(pairing);assert.equal(await recoverStalePairing(file),true)
    await assert.rejects(readFile(file),{code:'ENOENT'})
  })
  await test('listening owner is never overwritten even without authentication',async()=>{
    await save(pairing);server=createServer(socket=>socket.on('error',()=>{}))
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(pairing.pipe,resolve)})
    await assert.rejects(recoverStalePairing(file),error=>error.reason==='active')
    assert.deepEqual(JSON.parse(await readFile(file,'utf8')),pairing)
    await new Promise(resolve=>server.close(resolve));server=null
  })
  await test('normal exit removes only its own credential',async()=>{
    await removeOwnedPairing(file,{...pairing,secret:randomBytes(32).toString('hex')})
    assert.deepEqual(JSON.parse(await readFile(file,'utf8')),pairing)
    await removeOwnedPairing(file,pairing);await assert.rejects(readFile(file),{code:'ENOENT'})
  })
  await test('malformed orphan fails closed and remains unchanged',async()=>{
    await save({pipe:'not-a-task-pipe',secret:pairing.secret})
    const before=await readFile(file,'utf8')
    await assert.rejects(recoverStalePairing(file),error=>error.reason==='invalid')
    assert.equal(await readFile(file,'utf8'),before);await unlink(file)
  })
  await test('linked credential fails closed without touching its target',async()=>{
    const linked=join(folder,'linked-credentials')
    await save(pairing)
    try {
      // Windows junctions exercise parent-link rejection without symlink privilege.
      await symlink(folder,linked,'junction')
      await assert.rejects(recoverStalePairing(join(linked,'pairing.json')),error=>error.reason==='invalid')
      assert.deepEqual(JSON.parse(await readFile(file,'utf8')),pairing)
    }finally{await rmdir(linked).catch(error=>{if(error.code!=='ENOENT')throw error});await unlink(file)}
  })
  console.log(`${checks} pairing lifecycle checks passed; Electron single-instance/race acceptance is separate.`)
} finally {
  if(server)await new Promise(resolve=>server.close(resolve))
  await unlink(file).catch(error=>{if(error.code!=='ENOENT')throw error})
  await rmdir(folder)
}
