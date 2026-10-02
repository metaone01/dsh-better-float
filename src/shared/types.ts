/**
 * Shared vocabulary for the whole plugin.
 *
 * Kept free of DOM, React and host imports so the engine modules can be unit
 * tested and spike-tested in isolation. Anything that needs the DOM lives in
 * the module that owns the behaviour, not here.
 */

/** How faithfully an extraction reproduces the source element. */
export type Tier =
  /** Live move: the same node object is relocated. Highest fidelity. */
  | 'live'
  /** Semantic rebuild: re-render the same component from its data. */
  | 'semantic'
  /** Clone: a detached copy plus a rebuilt style environment. */
  | 'clone'
  /** Bitmap: an image of the element. Last resort. */
  | 'bitmap'

/** Where an extracted panel currently lives. */
export type PaneHost =
  /** Floating over the app, still in the app's document. */
  | 'float'
  /** In a standalone OS window. */
  | 'popout'

/** CSS strategy used to keep the relocated subtree looking right. */
export type CssStrategy =
  /** Mount the float container inside X's own parent and use position:fixed. */
  | 'in-place'
  /** Rebuild the lost ancestors as display:contents shells. */
  | 'skeleton'
  /** Inline the drifted computed values. Fallback only — see C7. */
  | 'inline'

/** Whether the extracted subtree keeps its original layout context. */
export type SizingMode =
  /** Keep the original flex/grid context; the element reflows at panel size. */
  | 'fluid'
  /** Freeze the measured rect; visually 1:1 at the moment of capture. */
  | 'frozen'

/** A point in viewport coordinates. */
export interface Point {
  readonly x: number
  readonly y: number
}

/** A rectangle in viewport coordinates. */
export interface Rect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** One captured element, as it travels from scout to float to popout. */
export interface CaptureTarget {
  /** The element the user picked. */
  readonly element: Element
  /** The rect measured at capture time, in the source document's viewport. */
  readonly rect: Rect
  /** An ancestor chain snapshot, outermost first, for skeleton rebuilding. */
  readonly ancestry: readonly AncestorSnapshot[]
  /** Static analysis verdict; may downgrade the requested tier. */
  readonly prognosis: Prognosis
}

/** A serialisable description of one ancestor, used to rebuild a skeleton. */
export interface AncestorSnapshot {
  readonly tagName: string
  readonly className: string
  readonly id: string
  readonly dataAttributes: Readonly<Record<string, string>>
  /** Inline style, captured for the @container repair path only. */
  readonly inlineStyle: string
  /** Whether this ancestor is a container-query container (needs a real box). */
  readonly isContainer: boolean
}

/** Static pre-flight verdict on whether an element can be moved safely. */
export interface Prognosis {
  readonly canMove: boolean
  /** Reasons that force a downgrade, most severe first. */
  readonly downgrades: readonly Downgrade[]
}

export type DowngradeReason =
  /** An ancestor establishes a containing block for position:fixed. */
  | 'fixed-containing-block'
  /** Ancestor chain crosses a shadow boundary. */
  | 'shadow-boundary'
  /** Element looks like a virtualised list row. */
  | 'virtualized-row'
  /** Element or a descendant contains an iframe. */
  | 'contains-iframe'
  /** Element is live media that would reset. */
  | 'live-media'
  /** The chain uses @container queries that a skeleton cannot reproduce. */
  | 'container-query'

export interface Downgrade {
  readonly reason: DowngradeReason
  /** Human-readable explanation, surfaced to the user. */
  readonly detail: string
}
