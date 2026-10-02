/**
 * Ambient declarations for platform APIs this plugin uses that TypeScript's
 * bundled DOM library does not yet describe.
 *
 * Kept in one file so the modules that call these stay free of casts, and so
 * the reason each declaration exists is recorded next to it.
 */

declare global {
  interface Element {
    /**
     * Atomically move this node under a new parent without detaching it.
     *
     * Chromium 133+ (so present in Electron 44). The state-preserving
     * primitive: unlike `appendChild` after `removeChild`, it keeps CSS
     * animation progress, focus, open popovers, `<dialog>` state and — most
     * importantly — avoids reloading an `<iframe>`.
     *
     * Throws `HierarchyRequestError` when the destination is a different
     * document, which is why the popout path must fall back to `adoptNode`.
     * @param node - the node to insert.
     * @param child - the child to insert before, or null to append.
     */
    moveBefore(node: Node, child: Node | null): void
  }

  interface Highlight {
    readonly priority: number
    readonly type: string
    add(range: AbstractRange): void
    clear(): void
  }

  interface HighlightRegistry {
    set(name: string, highlight: Highlight): void
    delete(name: string): boolean
  }

  interface Window {
    /** CSS Custom Highlight API registry; absent on older engines. */
    readonly highlight?: HighlightRegistry
  }
}

export {}
