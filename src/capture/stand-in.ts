/**
 * The structural stand-in: keeping React from noticing that its child left.
 *
 * ## Why this must exist
 *
 * When X is moved out of its parent P, React still believes P's child is X. The
 * next time React removes, reorders or replaces that child it calls
 * `P.removeChild(X)` — and X is no longer a child of P, so the DOM throws
 * `NotFoundError`. That exception escapes through the commit phase and takes
 * down the whole subtree, not just the extracted element.
 *
 * ## The fix
 *
 * Put an inert placeholder A in X's old slot, then intercept the four child
 * mutation methods **on P's own instance** so any reference to X is rewritten
 * to A. React keeps working, unaware, and the page's layout keeps the slot
 * occupied.
 *
 * ## Why instance properties rather than the prototype
 *
 * Patching `Node.prototype` would change behaviour for the entire page,
 * including unrelated code holding the same reference, and would leak across
 * plugin disposal. Defining own properties on one element shadows the prototype
 * for that element only, and deleting them restores the original exactly.
 *
 * ## The detach rule
 *
 * The guard is only correct while X is away. When X returns to P, the guard
 * must come off first, or React's legitimate operations get hijacked forever
 * and A lingers. Always call the returned restore function.
 */

/** The child-mutating methods that can receive X as an argument. */
const GUARDED_METHODS = ['removeChild', 'insertBefore', 'appendChild', 'replaceChild'] as const

type GuardedMethod = (typeof GUARDED_METHODS)[number]

/** Marks the guard so a second install on the same pair can be detected. */
const GUARD_KEY = Symbol.for('dsh-better-float.stand-in')

interface GuardState {
  /**
   * Own-property value that was on the parent before we shadowed it, per
   * method. `undefined` means the method lived on the prototype, so removing
   * our own property is a complete restore.
   */
  readonly installed: Partial<Record<GuardedMethod, unknown>>
  /** Elements whose references must be rewritten to the placeholder. */
  readonly aliases: Set<Element>
  active: boolean
}

/**
 * Rewrite a child argument from any alias to the placeholder.
 * @param value - the argument React passed.
 * @param state - the guard holding the alias set.
 * @param placeholder - the node that occupies the slot.
 * @returns the placeholder when the argument was an alias, else the original.
 */
function rewrite(value: unknown, state: GuardState, placeholder: Element): unknown {
  if (value instanceof Element && state.aliases.has(value)) return placeholder
  return value
}

/**
 * Install a placeholder in X's old slot, then redirect React's child mutations.
 *
 * The placeholder is inserted before the guard is installed, so the slot is
 * already occupied by the time anything can call into the parent.
 * @param parent - P, X's original parent.
 * @param original - X, the element that is leaving.
 * @param placeholder - A, the node that takes X's place. Must handle its own removal.
 * @returns a restore function. It must be called before X returns to P.
 */
export function installStructuralStandIn(
  parent: Element,
  original: Element,
  placeholder: Element,
): () => void {
  const existing = (parent as unknown as Record<symbol, GuardState | undefined>)[GUARD_KEY]
  if (existing?.active === true) {
    // A guard is already live for this parent. Fold the new alias in rather than
    // stacking a second layer of interception over the first.
    existing.aliases.add(original)
    return () => {
      existing.aliases.delete(original)
    }
  }

  // Reserve the slot without detaching X yet. Inserting A immediately before X
  // leaves X attached until the caller can use `moveBefore`; replacing X here
  // would already lose focus, animation and iframe state before the move starts.
  if (original.parentNode === parent) {
    parent.insertBefore(placeholder, original)
  } else {
    parent.appendChild(placeholder)
  }

  const state: GuardState = {
    installed: {},
    aliases: new Set([original]),
    active: true,
  }

  for (const method of GUARDED_METHODS) {
    // Capture the implementation that was reachable *before* we shadow it, plus
    // whether it was an own property. `Reflect.get` walks the prototype chain,
    // so this works for both cases, and the descriptor tells the restore path
    // whether deleting our override is enough.
    const descriptor = Object.getOwnPropertyDescriptor(parent, method)
    const inherited = Reflect.get(parent, method) as ((...args: unknown[]) => unknown) | undefined
    if (typeof inherited !== 'function') continue
    state.installed[method] = descriptor === undefined ? undefined : descriptor.value

    const override = function (this: unknown, ...args: unknown[]): unknown {
      if (!state.active) return Reflect.apply(inherited, parent, args)
      if (method === 'replaceChild') {
        return Reflect.apply(inherited, parent, [
          rewrite(args[0], state, placeholder),
          rewrite(args[1], state, placeholder),
        ])
      }
      const rewritten = args.map((value, index) =>
        index === 0 ? rewrite(value, state, placeholder) : value,
      )
      return Reflect.apply(inherited, parent, rewritten)
    }

    Object.defineProperty(parent, method, {
      value: override,
      writable: true,
      configurable: true,
      enumerable: false,
    })
  }

  Object.defineProperty(parent, GUARD_KEY, {
    value: state,
    writable: true,
    configurable: true,
    enumerable: false,
  })

  return () => {
    if (!state.active) return
    state.active = false
    for (const method of GUARDED_METHODS) {
      const own = state.installed[method]
      if (own === undefined) {
        // Nothing was shadowed on this element, so deleting our override
        // re-exposes the prototype implementation.
        delete (parent as unknown as Record<string, unknown>)[method]
      } else {
        Object.defineProperty(parent, method, {
          value: own,
          writable: true,
          configurable: true,
          enumerable: false,
        })
      }
    }
    delete (parent as unknown as Record<symbol, unknown>)[GUARD_KEY]
    // X is coming home. If it is still elsewhere, put it back in its slot first
    // so the caller does not have to reconstruct the original sibling index.
    if (placeholder.parentNode === parent && original.parentNode !== parent) {
      parent.replaceChild(original, placeholder)
    }
  }
}

/**
 * Watch a placeholder and run a callback when it leaves the parent.
 *
 * This is the "the host removed the slot, so the panel has no home" signal.
 * React unmounting the surrounding component removes the placeholder, and at
 * that point a floating panel detached from its layout context should close
 * rather than linger as an orphan.
 * @param parent - the parent to observe.
 * @param placeholder - the node whose removal matters.
 * @param onRemoved - called once, when the placeholder is no longer a child.
 * @returns a stop function that is safe to call after the callback fires.
 */
export function watchStandIn(
  parent: Element,
  placeholder: Element,
  onRemoved: () => void,
): () => void {
  let fired = false
  const observer = new MutationObserver(() => {
    if (fired || placeholder.parentNode === parent) return
    fired = true
    observer.disconnect()
    onRemoved()
  })
  observer.observe(parent, { childList: true })
  return () => {
    observer.disconnect()
  }
}

/**
 * Build the placeholder that takes X's place.
 *
 * A plain zero-footprint element is the safest default: it keeps the slot
 * index stable for `:nth-child` and for React's own bookkeeping, and it costs
 * the layout nothing. It is deliberately not `display: none` because a
 * `display: none` sibling still counts for `:nth-child` — which is what we want
 * — while contributing no box.
 * @returns a detached placeholder element.
 */
export function createPlaceholder(): Element {
  const node = document.createElement('dsh-float-anchor')
  node.setAttribute('aria-hidden', 'true')
  const style = node.style
  style.setProperty('display', 'none')
  style.setProperty('pointer-events', 'none')
  return node
}
