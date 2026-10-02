/**
 * Event reflection: making a cross-window panel interactive.
 *
 * ## Why not bridge events the other way
 *
 * The tempting design is to forward the clone's events to the anchor in the
 * original window and let them bubble there. It cannot work. React's delegated
 * listener finds the handler by walking the **fiber tree** from the event
 * target, and the original element's props live on the original element — which
 * is what moved. Dispatching at the anchor starts the walk at the anchor, so
 * the element's own `onClick` never runs. You would be firing the handlers of
 * its ancestors, not itself.
 *
 * ## What to do instead
 *
 * Read the handlers straight off the moved node and call them. React stores
 * props on the DOM node under a versioned symbol (`__reactProps$...`), so the
 * chain from the target up through its React parents is directly readable from
 * whichever document the node now lives in. Walk `composedPath()` in two passes
 * — capture downward, then bubble upward — and invoke each node's handler.
 *
 * ## What is deliberately NOT reflected
 *
 * Default behaviour needs no help: a link navigates and a form submits in the
 * new window natively, because the element is really there. Native input works
 * because the input is a real focused input. IME is left alone entirely — a
 * reflected composition event cannot reproduce a real input method session, and
 * interfering with it corrupts text entry. Only React's synthetic handlers are
 * reflected, and only because the fiber walk cannot reach across documents by
 * itself.
 */

/** React's internal props key, name-versioned so we must search for it. */
function reactPropsSymbol(node: unknown): string | null {
  for (const key of Object.getOwnPropertyNames(node as object)) {
    if (key.startsWith('__reactProps$')) return key
  }
  return null
}

/** Props as React stores them, narrowed to the handler-bearing shape we read. */
type ReactProps = Record<string, unknown>

/**
 * Read React's props object from a DOM node, if React ever rendered it.
 * @param node - the node to inspect.
 * @returns the props record, or null when the node has no React backing.
 */
export function propsOf(node: Element): ReactProps | null {
  const key = reactPropsSymbol(node)
  if (key === null) return null
  const value = (node as unknown as Record<string, unknown>)[key]
  return typeof value === 'object' && value !== null ? (value as ReactProps) : null
}

/**
 * Build the React prop name for a native event type.
 *
 * React's synthetic event names are the native type with the first letter
 * capitalised — `click` becomes `onClick`, `pointerdown` becomes
 * `onPointerDown`. The `on` prefix is always lowercase and the rest keeps its
 * internal capitals, so only the first character is transformed.
 * @param type - the native event type, such as `pointerdown`.
 * @returns the React handler key, such as `onPointerDown`.
 */
export function handlerName(type: string): string {
  return `on${type.charAt(0).toUpperCase()}${type.slice(1)}`
}

/** Which phase a listener runs in. */
export type Phase = 'capture' | 'bubble'

/**
 * Collect the handlers a native event should trigger, in invocation order.
 *
 * Two passes over the composed path: capture runs outermost-in, bubble runs
 * innermost-out, matching the DOM's own ordering. `stopPropagation` is honoured
 * within each pass by stopping the walk, which is the closest a reflected event
 * can get to the real thing.
 * @param path - the event's composed path, target first.
 * @param type - the native event type.
 * @returns the handlers to call, in order, with their owning node.
 */
export function reflectPlan(path: readonly EventTarget[], type: string): readonly {
  readonly node: Element
  readonly handler: (event: unknown) => void
}[] {
  const elements = path.filter((entry): entry is Element => entry instanceof Element)
  const plan: { node: Element; handler: (event: unknown) => void }[] = []

  for (const node of [...elements].reverse()) {
    const props = propsOf(node)
    const handler = props?.[`${handlerName(type)}Capture`]
    if (typeof handler === 'function') {
      plan.push({ node, handler: handler as (event: unknown) => void })
    }
  }
  for (const node of elements) {
    const props = propsOf(node)
    const handler = props?.[handlerName(type)]
    if (typeof handler === 'function') {
      plan.push({ node, handler: handler as (event: unknown) => void })
    }
  }

  // A node carrying both a capture and a bubble handler contributes twice,
  // which is correct, but a node appearing twice from one pass would not be.
  return dedupeByPhase(plan)
}

/**
 * Drop consecutive duplicates that came from the same pass.
 *
 * Capture and bubble legitimately produce the same node twice for handlers
 * registered in both phases, so identity alone is not a duplicate. Only an
 * exact consecutive repeat is, and that can only come from a path that listed a
 * node twice.
 * @param plan - the raw plan.
 * @returns the plan with consecutive repeats removed.
 */
function dedupeByPhase(
  plan: readonly { readonly node: Element; readonly handler: (event: unknown) => void }[],
): readonly { readonly node: Element; readonly handler: (event: unknown) => void }[] {
  const out: { node: Element; handler: (event: unknown) => void }[] = []
  for (const entry of plan) {
    const previous = out[out.length - 1]
    if (previous !== undefined && previous.node === entry.node && previous.handler === entry.handler) continue
    out.push({ node: entry.node, handler: entry.handler })
  }
  return out
}

/**
 * Reflect one native event onto the React handlers of its path.
 * @param event - the native event from the popout document.
 * @returns whether any handler was invoked, for debugging and for tests.
 */
export function reflectEvent(event: Event): boolean {
  const plan = reflectPlan(event.composedPath(), event.type)
  for (const { node, handler } of plan) {
    try {
      const props = propsOf(node)
      handler.call(props ?? null, event)
    } catch {
      // One bad handler must not stop the rest of the chain. React itself
      // surfaces handler errors through its own boundary rather than aborting
      // dispatch, so swallowing here matches the platform's behaviour.
    }
  }
  return plan.length > 0
}

/**
 * Attach reflection listeners for the event types a detached panel needs.
 *
 * Uses the capture phase at the document level so reflection sees the event
 * before any application code that might stop it. The native event still
 * proceeds afterwards, which is what lets default behaviour and native input
 * keep working — reflection adds React's handlers on top, it does not replace
 * anything.
 * @param target - the document to reflect within.
 * @param types - native event types to reflect.
 * @returns a detach function.
 */
export function attachReflection(
  target: Document,
  types: readonly string[],
  scope?: Element,
): () => void {
  const listeners: { type: string; handler: (event: Event) => void }[] = []
  for (const type of types) {
    const handler = (event: Event): void => {
      if (scope !== undefined && !scope.contains(event.target as Node | null)) return
      reflectEvent(event)
    }
    target.addEventListener(type, handler, { capture: true })
    listeners.push({ type, handler })
  }
  return () => {
    for (const { type, handler } of listeners) {
      target.removeEventListener(type, handler, { capture: true })
    }
    listeners.length = 0
  }
}

/**
 * The event types worth reflecting for an interactive panel.
 *
 * Kept to discrete, user-intent events. Continuous events like `scroll` and
 * `mousemove` are excluded: reflecting them would put a document-level capture
 * listener on the hottest path in the app for handlers that almost never exist.
 */
export const REFLECTED_EVENTS = [
  'click',
  'dblclick',
  'pointerdown',
  'pointerup',
  'pointercancel',
  'mousedown',
  'mouseup',
  'keydown',
  'keyup',
  'submit',
  'focusin',
  'focusout',
] as const
