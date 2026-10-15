export const COMPANION_CHANNEL = '/api/better-float-companion'
export const COMPANION_VERSION = 1
export const LEASE_MS = 8000
export type CompanionRequest =
  | { readonly op: 'ping' }
  | { readonly op: 'open-test'; readonly lease: string; readonly id: string }
  | { readonly op: 'list' | 'pulse' | 'release'; readonly lease: string }
  | { readonly op: 'close'; readonly lease: string; readonly id: string }
  | { readonly op:'open-controls'; readonly lease:string; readonly id:string; readonly snapshot:ControlSnapshot }
  | { readonly op:'sync-controls'; readonly lease:string; readonly id:string; readonly snapshot:ControlSnapshot; readonly ack:number }
export interface TestWindow { readonly id: string; readonly lease: string }
export interface CompanionValue {
  readonly version: 1
  readonly testOnly: true
  readonly windows: readonly TestWindow[]
  readonly actions?:readonly ControlAction[]
}
export type CompanionResult = { readonly ok: true; readonly value: CompanionValue }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string; readonly details: object } }
const identity = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value)
export function validCompanionRequest(value: unknown): value is CompanionRequest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const request = value as Record<string, unknown>
  const fields = request.op === 'open-controls' ? ['op','lease','id','snapshot']
    : request.op === 'sync-controls' ? ['op','lease','id','snapshot','ack'] : request.op === 'ping' ? ['op']
    : request.op === 'open-test' || request.op === 'close' ? ['op','lease','id']
    : ['list','pulse','release'].includes(String(request.op)) ? ['op','lease'] : []
  return fields.length > 0 && Object.keys(request).every(key => fields.includes(key))
    && (request.op === 'ping' || identity(request.lease))
    && (!fields.includes('id') || identity(request.id))
    && (!fields.includes('snapshot') || validSnapshot(request.snapshot))
    && (!fields.includes('ack') || (typeof request.ack==='number' && Number.isSafeInteger(request.ack) && request.ack>=0))
}
export function validCompanionValue(value: unknown): value is CompanionValue {
  if (value === null || typeof value !== 'object') return false
  const record = value as CompanionValue
  return record.version === 1 && record.testOnly === true && Array.isArray(record.windows)
    && record.windows.length <= 12 && record.windows.every(window => window && identity(window.id) && identity(window.lease))
    && (record.actions===undefined || (Array.isArray(record.actions) && record.actions.length<=32 && record.actions.every(validAction)))
}
import { validSnapshot, validAction, type ControlSnapshot, type ControlAction } from './control-adapter.ts'
