/** Per-parent guards keep React's child operations directed at the reserved slot. */
import { moveNode } from './tier0-live.ts'

const GUARDED_METHODS = ['removeChild', 'insertBefore', 'appendChild', 'replaceChild'] as const
type GuardedMethod = (typeof GUARDED_METHODS)[number]
const GUARD_KEY = Symbol.for('dsh-better-float.stand-in')

interface Slot {
  readonly placeholder: Element
  removed: boolean
}

interface MethodOverride {
  readonly descriptor: PropertyDescriptor | undefined
  readonly value: (...args: unknown[]) => unknown
}

interface GuardState {
  readonly installed: Partial<Record<GuardedMethod, MethodOverride>>
  readonly slots: Map<Element, Slot>
}

function rewrite(value: unknown, state: GuardState): unknown {
  return state.slots.get(value as Element)?.placeholder ?? value
}

function releaseMethods(parent: Element, state: GuardState): void {
  for (const method of GUARDED_METHODS) {
    const installed = state.installed[method]
    // Do not overwrite a subsequent patch installed by the host or another plugin.
    if (installed === undefined || Object.getOwnPropertyDescriptor(parent, method)?.value !== installed.value) continue
    if (installed.descriptor === undefined) {
      delete (parent as unknown as Record<string, unknown>)[method]
    } else {
      Object.defineProperty(parent, method, installed.descriptor)
    }
  }
  delete (parent as unknown as Record<symbol, unknown>)[GUARD_KEY]
}

/**
 * Reserve one slot per extracted child. Multiple panels sharing a parent share
 * the guard, not the placeholder; closing one must not unpatch the others.
 * The returned idempotent function restores only a still-live host slot.
 */
export function installStructuralStandIn(parent: Element, original: Element, placeholder: Element): () => void {
  const record = parent as unknown as Record<symbol, GuardState | undefined>
  let state = record[GUARD_KEY]
  if (state?.slots.has(original)) throw new Error('This element has already been extracted.')

  if (state === undefined) {
    state = { installed: {}, slots: new Map() }
    const guard = state
    try {
      for (const method of GUARDED_METHODS) {
        const descriptor = Object.getOwnPropertyDescriptor(parent, method)
        const inherited = Reflect.get(parent, method) as (...args: unknown[]) => unknown
        const override = function (this: unknown, ...args: unknown[]): unknown {
          if (this !== parent) return Reflect.apply(inherited, this, args)
          const rewritten = args.map((value) => rewrite(value, guard))
          const result = Reflect.apply(inherited, parent, rewritten)
          const removed = method === 'removeChild' ? args[0] : method === 'replaceChild' ? args[1] : undefined
          const slot = guard.slots.get(removed as Element)
          if (slot !== undefined) slot.removed = true
          // DOM mutation methods return the logical node, not our placeholder.
          const returned = method === 'replaceChild' ? args[1] : args[0]
          return guard.slots.has(returned as Element) ? returned : result
        }
        Object.defineProperty(parent, method, { value: override, writable: true, configurable: true, enumerable: false })
        state.installed[method] = { descriptor, value: override }
      }
      Object.defineProperty(parent, GUARD_KEY, { value: state, configurable: true })
    } catch (error) {
      releaseMethods(parent, state)
      throw error
    }
  }

  const guard = state
  const slot: Slot = { placeholder, removed: false }
  try {
    if (original.parentNode !== parent) throw new Error('The element no longer belongs to its captured parent.')
    parent.insertBefore(placeholder, original)
    guard.slots.set(original, slot)
  } catch (error) {
    placeholder.remove()
    if (guard.slots.size === 0) releaseMethods(parent, guard)
    throw error
  }

  let released = false
  return () => {
    if (released) return
    released = true
    guard.slots.delete(original)
    if (guard.slots.size === 0) releaseMethods(parent, guard)
    if (!slot.removed && parent.isConnected && placeholder.parentNode === parent && original.parentNode !== parent) {
      // replaceChild detaches the live node; an atomic move preserves focus,
      // selection, iframe and animation state on the return trip as well.
      try {
        moveNode(original, parent, placeholder)
      } finally {
        placeholder.remove()
      }
    } else {
      placeholder.remove()
    }
  }
}

/** Watch direct slot removal and ancestor unmounts, with one notification. */
export function watchStandIn(parent: Element, placeholder: Element, onRemoved: () => void): () => void {
  let fired = false
  const wasConnected = parent.isConnected
  const observer = new MutationObserver(() => {
    if (fired || (placeholder.parentNode === parent && (!wasConnected || parent.isConnected))) return
    fired = true
    observer.disconnect()
    onRemoved()
  })
  observer.observe(parent, { childList: true })
  if (wasConnected) {
    observer.observe(parent.ownerDocument, { childList: true, subtree: true })
    if (parent.getRootNode() !== parent.ownerDocument) observer.observe(parent.getRootNode(), { childList: true, subtree: true })
  }
  return () => observer.disconnect()
}

/** A zero-footprint, inaccessible slot in the element's own document. */
export function createPlaceholder(owner: Document = document): Element {
  const node = owner.createElement('dsh-float-anchor')
  node.setAttribute('aria-hidden', 'true')
  node.style.setProperty('display', 'none')
  node.style.setProperty('pointer-events', 'none')
  return node
}
