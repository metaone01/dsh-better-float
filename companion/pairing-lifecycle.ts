import { connect } from 'node:net'
import { lstat, unlink } from 'node:fs/promises'
import { readPrivatePairing } from '../src/host/pairing-security.ts'
import { validPairing, type Pairing } from '../src/host/pipe-protocol.ts'

export class PairingStartupError extends Error {
  constructor(readonly reason:'active'|'invalid'|'unreachable'|'changed') {
    super(`Companion pairing ${reason}`)
  }
}
const samePairing = (left:Pairing,right:Pairing):boolean => left.pipe===right.pipe && left.secret===right.secret

export async function verifyExistingPairing(file:string):Promise<void> {
  try { await lstat(file) }
  catch(error) { if((error as NodeJS.ErrnoException).code==='ENOENT') return; throw new PairingStartupError('invalid') }
  await checkedPairing(file)
}

async function checkedPairing(file:string):Promise<Pairing> {
  try {
    const pairing = await readPrivatePairing(file)
    if(validPairing(pairing)) return pairing
  }catch {}
  throw new PairingStartupError('invalid')
}

async function pipeExists(pipe:string):Promise<boolean> {
  return new Promise((resolve,reject) => {
    const socket = connect(pipe)
    const timer = setTimeout(() => { socket.destroy();reject(new PairingStartupError('unreachable')) },1000)
    socket.once('connect',() => { clearTimeout(timer);socket.destroy();resolve(true) })
    socket.once('error',(error:NodeJS.ErrnoException) => {
      clearTimeout(timer)
      // Timeout, permission and resource errors are not proof that the owner exited.
      if(error.code==='ENOENT' || (process.platform!=='win32' && error.code==='ECONNREFUSED')) resolve(false)
      else reject(new PairingStartupError('unreachable'))
    })
  })
}

/** Caller must hold Electron's single-instance lock for this userData directory. */
export async function recoverStalePairing(file:string):Promise<boolean> {
  let before
  try { before = await lstat(file) }
  catch(error) { if((error as NodeJS.ErrnoException).code==='ENOENT') return false; throw new PairingStartupError('invalid') }
  const pairing = await checkedPairing(file)
  if(await pipeExists(pairing.pipe)) throw new PairingStartupError('active')
  const after = await lstat(file)
  if(before.dev!==after.dev || before.ino!==after.ino || before.mtimeMs!==after.mtimeMs
    || !samePairing(pairing,await checkedPairing(file))) throw new PairingStartupError('changed')
  await unlink(file)
  return true
}

export async function removeOwnedPairing(file:string,owned:Pairing):Promise<void> {
  // Never unlink another process's replacement credential during shutdown.
  if(samePairing(owned,await checkedPairing(file))) await unlink(file)
}
