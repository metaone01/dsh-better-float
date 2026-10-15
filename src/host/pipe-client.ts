import { connect, type Socket } from 'node:net'
import { randomBytes } from 'node:crypto'
import { readPrivatePairing } from './pairing-security.ts'
import { proof, matches, validPairing, receiveFrames, sendFrame, frameBytes, MAX_FRAME, PipeFrameSizeError, type Pairing } from './pipe-protocol.ts'
import { validCompanionValue, type CompanionRequest, type CompanionValue } from '../shared/companion.ts'

export function createPipeClient(pairingFile: string) {
  let socket: Socket | null = null
  let connecting: Promise<void> | null = null
  let pairing: Pairing | null = null
  let session = ''
  let sequence = 0
  let disposed = false
  const pending = new Map<number,{ resolve: (value: CompanionValue) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  const reset = (): void => {
    for (const task of pending.values()) { clearTimeout(task.timer); task.reject(new Error('companion disconnected')) }
    pending.clear()
    session = ''
  }
  const ready = async (): Promise<void> => {
    if (disposed) throw new Error('companion disposed')
    if (socket && !socket.destroyed && session) return
    if (connecting) return connecting
    connecting = (async () => {
      const config = await readPrivatePairing(pairingFile)
      if (!validPairing(config)) throw new Error('invalid pairing configuration')
      if (disposed) throw new Error('companion disposed')
      pairing = config
      await new Promise<void>((resolve,reject) => {
        const candidate = connect(config.pipe)
        socket = candidate
        let authenticated = false
        let challenge = ''
        const nonce = randomBytes(32).toString('hex')
        const timer = setTimeout(() => { candidate.destroy(); reject(new Error('companion handshake timeout')) },1500)
        const fail = (): void => {
          clearTimeout(timer)
          if (socket === candidate) { socket = null; reset() }
          if (!authenticated) reject(new Error('companion unavailable or authentication failed'))
        }
        candidate.on('error', fail)
        candidate.on('close', fail)
        receiveFrames(candidate, frame => {
          if (!authenticated) {
            if (frame.type === 'challenge' && frame.version === 1 && !challenge
              && typeof frame.nonce === 'string' && /^[a-f0-9]{64}$/.test(frame.nonce)) {
              challenge = frame.nonce
              sendFrame(candidate,{type:'auth',nonce,proof:proof(config.secret,`client:${challenge}:${nonce}`)})
            } else if (frame.type === 'ready' && challenge && matches(config.secret,`server:${challenge}:${nonce}`,frame.proof)) {
              session = `${challenge}:${nonce}`
              authenticated = true
              clearTimeout(timer)
              resolve()
            } else candidate.destroy()
            return
          }
          if (frame.type !== 'reply' || typeof frame.seq !== 'number' || !Number.isSafeInteger(frame.seq)) { candidate.destroy(); return }
          const body = JSON.stringify(frame.result)
          if (!matches(config.secret,`reply:${session}:${frame.seq}:${body}`,frame.proof)) { candidate.destroy(); return }
          const task = pending.get(frame.seq)
          if (!task) return
          clearTimeout(task.timer)
          pending.delete(frame.seq)
          const result = frame.result as {ok?:boolean;value?:unknown} | null
          if (result?.ok && validCompanionValue(result.value)) task.resolve(result.value)
          else task.reject(new Error('companion rejected request'))
        })
      })
    })().finally(() => { connecting = null })
    return connecting
  }
  return {
    async request(request: CompanionRequest | {readonly op:'shutdown'}): Promise<CompanionValue> {
      await ready()
      const current = socket
      if (!current || !pairing || disposed || !session) throw new Error('companion unavailable')
      if (pending.size >= 16) throw new Error('too many companion requests')
      const seq = ++sequence
      const frame = { type:'request',seq,payload:request,
        proof:proof(pairing.secret,`request:${session}:${seq}:${JSON.stringify(request)}`) }
      // A local size error belongs to this request, not every lease on the socket.
      if (frameBytes(frame) > MAX_FRAME) throw new PipeFrameSizeError()
      return new Promise((resolve,reject) => {
        const timer = setTimeout(() => {
          pending.delete(seq)
          reject(new Error('companion request timeout'))
          current.destroy()
        },1500)
        pending.set(seq,{resolve,reject,timer})
        try { sendFrame(current,frame) }
        catch (error) {
          clearTimeout(timer)
          pending.delete(seq)
          reject(error instanceof Error ? error : new Error('companion send failed'))
        }
      })
    },
    dispose(): void { disposed = true; socket?.destroy(); reset() },
  }
}
