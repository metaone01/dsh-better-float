import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Socket } from 'node:net'
import { StringDecoder } from 'node:string_decoder'

export const MAX_FRAME = 8192
export class PipeFrameSizeError extends Error {
  constructor() { super('Companion request exceeds the UTF-8 frame limit'); this.name = 'PipeFrameSizeError' }
}
export function frameBytes(frame: unknown): number {
  return Buffer.byteLength(JSON.stringify(frame) + '\n')
}
export interface Pairing { readonly pipe: string; readonly secret: string }
export function validPairing(value: unknown): value is Pairing {
  const record = value as Pairing | null
  return !!record && typeof record.pipe === 'string' && typeof record.secret === 'string'
    && /^[a-f0-9]{64}$/.test(record.secret)
    && (process.platform === 'win32'
      ? /^\\\\\.\\pipe\\dsh-better-float-[a-f0-9]{32}$/.test(record.pipe)
      : /^\/[^\0]+\/dsh-better-float-[a-f0-9]{32}\.sock$/.test(record.pipe))
}
export function proof(secret: string, text: string): string {
  return createHmac('sha256', Buffer.from(secret,'hex')).update(text).digest('hex')
}
export function matches(secret: string, text: string, candidate: unknown): boolean {
  return typeof candidate === 'string' && /^[a-f0-9]{64}$/.test(candidate)
    && timingSafeEqual(Buffer.from(proof(secret,text),'hex'),Buffer.from(candidate,'hex'))
}
export function sendFrame(socket: Socket, frame: unknown): void {
  const wire = JSON.stringify(frame) + '\n'
  if (Buffer.byteLength(wire) > MAX_FRAME) throw new PipeFrameSizeError()
  if (socket.writableLength > MAX_FRAME * 16) throw new Error('pipe backpressure limit')
  socket.write(wire)
}
/** Bounded NDJSON; errors fail closed instead of logging payloads or secrets. */
export function receiveFrames(socket: Socket, receive: (frame: Record<string, unknown>) => void): void {
  const decoder = new StringDecoder('utf8')
  let pending = ''
  socket.on('data', bytes => {
    if (bytes.length > MAX_FRAME * 16) { socket.destroy(); return }
    pending += decoder.write(bytes)
    for (;;) {
      const newline = pending.indexOf('\n')
      if (newline < 0) break
      const line = pending.slice(0,newline)
      pending = pending.slice(newline+1)
      if (Buffer.byteLength(line) + 1 > MAX_FRAME) { socket.destroy(); return }
      try {
        const value: unknown = JSON.parse(line)
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid frame')
        receive(value as Record<string,unknown>)
      } catch { socket.destroy(); return }
      if (socket.destroyed) return
    }
    if (Buffer.byteLength(pending) > MAX_FRAME) socket.destroy()
  })
}
