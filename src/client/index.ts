/**
 * better-float: pick an element, pull it out as a floating panel.
 *
 * This is the client half. It registers a shortcut and mounts the panel surface
 * into the frame-wide `shell.overlay` seat.
 *
 * ## How a shortcut actually fires
 *
 * A command's action does **not** live in a separate handler registration.
 * `shortcuts.register` takes one object whose `resolve(context)` returns
 * `{ status: 'handled', run }` — returning `run` is what claims the keypress and
 * supplies the work. `{ status: 'pass' }` means "not mine", and the keystroke
 * falls through to the app with nothing happening. Getting that backwards
 * produces a shortcut that registers cleanly, appears in the settings UI, and
 * silently does nothing when pressed.
 *
 * ## Why React mounts a box it never looks inside
 *
 * The seat is a React slot, so its component is a React component. But an
 * extracted element is a *live* DOM node taken out of the app: if React owned
 * it, the next commit would reconcile against a child it never created and
 * delete it. So the component renders one empty container and hands that node to
 * the imperative panel code; React's children array for it is always empty, and
 * the panels live in a subtree React has no opinion about. This is what lets the
 * extracted element keep whatever framework backing it already had.
 *
 * ## Why the `inject` declaration is load-bearing
 *
 * Cordis starts a plugin's fiber only once every name in its `inject` list is
 * present, and it supplies the context with **exactly** those names. A service
 * that is not declared is not merely unavailable on a cold start — it is absent
 * from the context object, so reading `ctx.slots` throws a TypeError and the
 * entry ends up FAILED.
 *
 * The list therefore has to appear twice: as the `inject` export in this file,
 * and as `dsh.client.inject` in package.json. The host resolves its boot order
 * from the manifest before any bundle has executed, so it cannot read the export
 * to learn the dependency; the export is what Cordis itself honours at mount
 * time. Declaring only one of the two leaves the plugin either unordered or
 * unstarted.
 *
 * ## Loading constraints
 *
 * The harness loads this file through `window.__ModuleLoader__.load({ id,
 * factory })`, so it may value-import only the platform modules from the
 * platform seed — `react`, `react/jsx-runtime`, `react-dom`, `react-dom/client`,
 * `@deepseek-ai/cordis`, `@deepseek-ai/dsh-client-store`,
 * `@deepseek-ai/dsh-client-ui-slots`, `@deepseek-ai/dsh-client-ui-primitives`,
 * and `@deepseek-ai/dsh-client-ui-dockkit`. Anything else a factory requires must
 * be a registered package row or the require throws.
 */

import { createElement } from 'react'
import { createPanelManager, type PanelManager } from '../float/manager.ts'

/** Minimal shape of the parts of the host context this plugin uses. */
interface ClientContext {
  readonly effect: (run: () => unknown, label?: string) => () => void
  readonly slots: SlotsService
  readonly shortcuts?: ShortcutsService
}

/**
 * The services this plugin needs before it can start.
 *
 * This is not optional bookkeeping. Cordis starts a fiber only once every name
 * in `inject` is available on the context, and it supplies *only* those names —
 * a service that is not listed is simply absent, so reading it throws. Declaring
 * the list is what makes `ctx.slots` and `ctx.shortcuts` exist at all.
 *
 * The same list must also appear as `dsh.client.inject` in package.json: the
 * host cannot resolve module-level exports from a bundle it has not loaded yet,
 * so the declaration is what lets the entry be ordered after its dependencies.
 * Declaring it in only one of the two places leaves the plugin silently inert.
 */
const inject = ['slots', 'shortcuts'] as const

/** Where the keypress landed, as resolved before the command runs. */
interface ShortcutContext {
  readonly source?: 'keyboard' | 'menu' | 'iframe' | 'webview'
  readonly region: 'page' | 'editable' | 'terminal'
  readonly modal: string | null
  readonly target: Element | null
}

/** A command claims the input by returning `run`; `pass` lets it through. */
type ShortcutResolution =
  | { readonly status: 'handled'; readonly run: () => void }
  | { readonly status: 'blocked'; readonly reason: string }
  | { readonly status: 'pass' }

interface ShortcutsService {
  register(command: {
    readonly id: string
    readonly label: () => string
    readonly aliases: readonly string[]
    readonly defaults: Readonly<Record<string, { readonly code: string; readonly modifiers: readonly string[] }>>
    readonly regions: readonly ('page' | 'editable' | 'terminal')[]
    readonly modals: readonly string[]
    resolve: (context: ShortcutContext) => ShortcutResolution
  }): () => void
}

interface SlotsService {
  /**
   * Wait for a slot to be declared, then register a contributor to it.
   *
   * The inject step is required rather than optional: a slot name only exists
   * once its owner declares it, and registering against an undeclared name
   * throws. `inject` re-runs its callback whenever the declaration epoch changes,
   * disposing the previous contribution first.
   */
  inject(name: string, callback: () => () => void): () => void
  /**
   * Contribute one entry to a declared slot.
   *
   * The option fields are per-kind, and the registry enforces them:
   *
   *   single  — one entry per priority; a second registration throws
   *   keyed   — requires `key`, which deduplicates entries
   *   list    — requires `id`, which deduplicates entries
   *   chain   — requires `select`
   *
   * `priority` decides ordering and shadowing: entries render lowest-first, and a
   * higher priority overrides a lower one for `single`/`keyed` slots. It is read
   * as `options.priority ?? 0`. There is no `order` field — passing one is
   * accepted silently and ignored.
   */
  register(
    options: {
      readonly name: string
      /** Required for a `list` slot; the deduplication key. */
      readonly id?: string
      /** Required for a `keyed` slot. */
      readonly key?: string
      readonly priority?: number
    },
    component: (props: Record<string, unknown>) => unknown,
  ): () => void
}

/** The shortcut id. Must match the dotted pattern the registry validates. */
const COMMAND_ID = 'betterFloat.scout'
const OVERVIEW_COMMAND_ID = 'betterFloat.overview'

/** The frame-wide seat, declared by `ui-layout` as a root-scoped list. */
const OVERLAY_SLOT = 'shell.overlay'

/**
 * The live panel managers, keyed by document.
 *
 * A module-level map rather than component state because the shortcut handler
 * has no React scope of its own — it runs from the shortcut registry, outside
 * any component. Panels attach to the document element and are `position:
 * fixed`, so the manager only needs the document, not a container from the seat.
 */
const managers = new WeakMap<Document, PanelManager>()

/**
 * The panel layer registered into `shell.overlay`.
 *
 * It exists for two reasons: the slot must have a contributor for the plugin to
 * count as mounted, and it gives the plugin a stable node to point at when
 * confirming in the DOM that it loaded. The panels themselves are not its
 * children — they are `position: fixed` and attach to the document element, so
 * nothing here depends on this component's lifecycle beyond registration.
 *
 * `createElement` is used instead of JSX because this file is `.ts`; adding a
 * second JSX-enabled entry point for one element would be worse than one call.
 * @returns an empty container, marked for DOM inspection.
 */
function PanelLayer(): unknown {
  return createElement('div', {
    id: 'dsh-better-float-layer',
    'data-better-float': 'layer',
  })
}

/**
 * Get the panel manager for a document, creating it on first use.
 * @param owner - the document panels are created in.
 * @returns the manager.
 */
function managerFor(owner: Document): PanelManager {
  const existing = managers.get(owner)
  if (existing !== undefined) return existing

  const manager = createPanelManager(owner, {
    onError: (message) => {
      // Worth surfacing: a failed extraction leaves a panel mounted with an
      // empty body, which otherwise looks like the feature doing nothing.
      console.error(`[better-float] ${message}`)
    },
    onDetachRequest: () => {
      // Detaching needs the desktop shell (a new BrowserWindow plus an IPC
      // channel). This plugin cannot provide that from inside the renderer, so
      // the button is left inert rather than appearing to work. `desktop/`
      // carries the main-process half for a build that can patch the app.
      console.warn('[better-float] detaching to a separate window needs the desktop shell')
    },
  })

  managers.set(owner, manager)
  return manager
}

/**
 * Client entry point, called by the module loader.
 * @param ctx - the host client context.
 */
export function apply(ctx: ClientContext): void {
  // The seat first: its container must exist before a shortcut can open a panel
  // into it. `inject` waits for `ui-layout` to declare the slot, and re-runs its
  // callback whenever the declaration epoch changes.
  ctx.effect(() => ctx.slots.inject(OVERLAY_SLOT, () => ctx.slots.register({
    name: OVERLAY_SLOT,
    // `shell.overlay` is declared `kind: 'list'`, and the registry requires an
    // `id` for every entry in a list slot — it is the deduplication key, so a
    // second registration under the same id throws.
    id: 'better-float',
    // The field the registry reads is `priority`, not `order`. Entries render
    // lowest-first, so a high value puts the panels above the app's own overlays.
    // `order` is not a field `SlotCore.register` consults and is ignored silently.
    priority: 1000,
  }, PanelLayer as (props: Record<string, unknown>) => unknown)), 'better-float: panel layer')
  ctx.effect(() => {
    // `shortcuts` is guaranteed by this plugin's `inject` declaration, so it is
    // read directly rather than probed for. The optional marker on the interface
    // is a type-level concession to the declaration living outside this module,
    // not a case that can happen at runtime — if the service were missing the
    // fiber would not have started at all.
    const shortcuts = ctx.shortcuts
    if (shortcuts === undefined) {
      // Unreachable when `inject` is honoured. Kept because a silent no-op is
      // the worst outcome here: the shortcut would appear in settings and do
      // nothing when pressed.
      throw new Error('better-float: the shortcut service is missing; declare it in inject')
    }

    const dispose = shortcuts.register({
      id: COMMAND_ID,
      label: () => 'Pull an element out as a floating panel',
      aliases: ['pick element float panel detach window'],
      // primary+shift+KeyS, not primary+KeyS: `primary + KeyC/V/X/Z/Y/Q/H` and
      // bare `primary + KeyA` are reserved even with shift added, and the
      // registry rejects them. Two modifiers including primary also satisfies
      // the web allow-list for Windows and macOS. The host's Linux Web
      // allow-list is intentionally narrower, so no web:linux default is
      // declared; an unsupported profile would reject the whole registration.
      defaults: {
        'desktop:macos': { code: 'KeyS', modifiers: ['primary', 'shift'] },
        'desktop:windows': { code: 'KeyS', modifiers: ['primary', 'shift'] },
        'desktop:linux': { code: 'KeyS', modifiers: ['primary', 'shift'] },
        'web:macos': { code: 'KeyS', modifiers: ['primary', 'shift'] },
        'web:windows': { code: 'KeyS', modifiers: ['primary', 'shift'] },
      },
      // The picker works over the page and over editable regions — pulling an
      // element out of a form is a legitimate thing to want. `terminal` is
      // omitted because the picker would fight xterm's own pointer handling.
      regions: ['page', 'editable'],
      // No modal gate: an empty list means the command is not scoped to any
      // declared modal, so an unknown overlay cannot silently swallow it.
      modals: [],
      resolve: () => {
        const doc = globalThis.document
        if (doc === undefined) return { status: 'pass' }

        // The panel manager does not depend on the seat having mounted: panels
        // are `position: fixed` and attach to the document element, so the seat
        // is a registration host rather than a mount point. Making the picker
        // wait for it would disable the feature for no reason.
        const manager = managerFor(doc)
        // A second press while picking means "get me out", which the manager
        // already treats as a cancel.
        return { status: 'handled', run: () => manager.pick(false) }
      },
    })
    const disposeOverview = shortcuts.register({
      id: OVERVIEW_COMMAND_ID,
      label: () => 'Show floating windows',
      aliases: ['floating windows overview recall window'],
      // The registry validates every profile: primary+shift+F conflicts with
      // session.fork's Web default even when this plugin runs on Desktop.
      defaults: {
        'desktop:macos': { code: 'KeyS', modifiers: ['primary', 'alt', 'shift'] },
        'desktop:windows': { code: 'KeyS', modifiers: ['primary', 'alt', 'shift'] },
        'desktop:linux': { code: 'KeyS', modifiers: ['primary', 'alt', 'shift'] },
        'web:macos': { code: 'KeyS', modifiers: ['primary', 'alt', 'shift'] },
        'web:windows': { code: 'KeyS', modifiers: ['primary', 'alt', 'shift'] },
      },
      regions: ['page', 'editable'],
      modals: [],
      resolve: () => {
        const doc = globalThis.document
        if (doc === undefined) return { status: 'pass' }
        const manager = managerFor(doc)
        return { status: 'handled', run: () => manager.toggleOverview() }
      },
    })
    return () => {
      disposeOverview()
      dispose()
    }
  }, 'better-float: scout shortcut')
}

/** Exported for the host companion half and for tests. */
export { COMMAND_ID, OVERVIEW_COMMAND_ID, OVERLAY_SLOT, inject }
