/**
 * The skeleton ancestor chain: rebuilding context instead of copying styles.
 *
 * When the in-place escape is blocked, the float container has to live outside
 * X's real ancestor chain. The instinct is to snapshot the computed styles and
 * inline them. Don't — inline values outrank every stylesheet, which silently
 * breaks theme switching, state classes and `:hover`, and fights React's own
 * `style` prop for the same keys. That is a functional bug, not a cosmetic one.
 *
 * ## The inversion
 *
 * Copy the *ancestors* instead of the *styles*. In the container, rebuild the
 * chain from the root down to X's parent as empty shells that carry only the
 * `tagName`, `className` and `data-*` attributes. Then give every shell
 * `display: contents`.
 *
 * This works because **selectors match the DOM tree, not the box tree**. A
 * `display: contents` element generates no box, so it disturbs no layout — but
 * it is still there for `#app > .x`, `:nth-child`, `+`, `~` and `:has()` to
 * match against, and inherited properties still propagate through it.
 *
 * That claim is measured, not assumed: the spike bench (`npm run spike`) rebuilds
 * a tree both ways and reports that child, descendant, `:nth-child`, adjacent
 * sibling and `:has()` rules all reproduce the real tree's result on a skeleton.
 *
 * ## Two details that bite
 *
 * 1. Shells must have their `::before` / `::after` suppressed, or those
 *    pseudo-elements render as visible children of the shell.
 * 2. A shell cannot serve as a `@container` query container — see
 *    `isContainerQueryContainer` in `css-inplace.ts` for the precise behaviour,
 *    which is subtler than "the property is ignored".
 */
import type { AncestorSnapshot } from '../shared/types.ts'
import { kebab } from './css-inplace.ts'

/** Attribute carrying the reason a shell exists, for debugging and for spies. */
export const SHELL_ATTRIBUTE = 'data-dsh-float-shell'

/** Stylesheet installed once, covering every shell this plugin builds. */
const STYLE_ID = 'dsh-better-float-skeleton'
const STYLE_TEXT = `
[${SHELL_ATTRIBUTE}]::before,
[${SHELL_ATTRIBUTE}]::after { content: none !important; }
[${SHELL_ATTRIBUTE}][data-dsh-float-shell="contents"] { display: contents !important; }
[${SHELL_ATTRIBUTE}][data-dsh-float-shell="container"] { display: block !important; }
`

/**
 * Install the shell stylesheet once per document.
 *
 * Popouts are separate documents, so this takes the document rather than
 * assuming the main one, and is idempotent so repeated extractions are cheap.
 * @param owner - the document that should receive the sheet.
 */
export function ensureShellStyles(owner: Document): void {
  if (owner.getElementById(STYLE_ID) !== null) return
  const style = owner.createElement('style')
  style.id = STYLE_ID
  style.textContent = STYLE_TEXT
  owner.head.appendChild(style)
}

/**
 * Give a `display: contents` shell a real box so it can act as a query
 * container, pinning it to the size the original container measured.
 *
 * This is the one place the skeleton gives up "does not disturb layout". It is
 * unavoidable: container queries need a box to measure, and there is no way to
 * have one without it participating in layout. Keeping it absolutely
 * positioned and sized to the original keeps the distortion contained.
 * @param shell - the shell element.
 * @param size - the original container's measured size, if known.
 */
export function pinContainerBox(
  shell: HTMLElement,
  size: { readonly width: number; readonly height: number } | null,
): void {
  shell.setAttribute(SHELL_ATTRIBUTE, 'container')
  const style = shell.style
  style.setProperty('position', 'absolute')
  style.setProperty('inset', '0')
  style.setProperty('overflow', 'visible')
  if (size !== null) {
    style.setProperty('width', `${size.width}px`)
    style.setProperty('height', `${size.height}px`)
  }
}

/**
 * Build one shell for an ancestor.
 * @param snapshot - the ancestor to reproduce.
 * @param owner - the document that owns the new element.
 * @returns the shell element.
 */
function buildShell(snapshot: AncestorSnapshot, owner: Document): HTMLElement {
  const shell = owner.createElement(snapshot.tagName)
  if (snapshot.className !== '') shell.className = snapshot.className
  if (snapshot.id !== '') shell.id = snapshot.id
  for (const [name, value] of Object.entries(snapshot.dataAttributes)) {
    shell.setAttribute(name, value)
  }
  shell.setAttribute(SHELL_ATTRIBUTE, snapshot.isContainer ? 'container' : 'contents')
  if (snapshot.isContainer) {
    // A container needs a real box, which is exactly the case `display:contents`
    // cannot serve. Pin it instead and let the caller refine the size.
    pinContainerBox(shell, null)
  }
  return shell
}

/**
 * Rebuild an ancestor chain inside a container and return the innermost shell.
 *
 * The returned element is where X's subtree should be attached. If `ancestors`
 * is empty the container itself is the attachment point, which is the
 * degenerate "zero skeleton" case — and exactly how the in-place escape is
 * expressed in this same code path.
 * @param container - the float container.
 * @param ancestors - outermost first, as captured by `snapshotAncestor`.
 * @param owner - the target document. Defaults to the container's own document.
 * @returns the element to append the extracted subtree into.
 */
export function buildSkeleton(
  container: HTMLElement,
  ancestors: readonly AncestorSnapshot[],
  owner: Document = container.ownerDocument,
): HTMLElement {
  ensureShellStyles(owner)
  let cursor: HTMLElement = container
  for (const snapshot of ancestors) {
    const shell = buildShell(snapshot, owner)
    cursor.appendChild(shell)
    cursor = shell
  }
  return cursor
}

/**
 * Keep rebuilt shells in step with the real ancestors' class names.
 *
 * State classes like `.is-error` or `.is-streaming` are applied to a real
 * ancestor at runtime, and a shell that never hears about it will style the
 * extracted subtree wrongly. Mirroring `class` (and `data-*`) is far cheaper
 * than mirroring computed styles and cannot go stale in the same way, because
 * it copies the input to the cascade rather than one snapshot of its output.
 * @param real - the live ancestor chain, outermost first.
 * @param shells - the rebuilt shells, in the same order.
 * @returns a stop function that disconnects every observer.
 */
export function mirrorAncestorState(
  real: readonly Element[],
  shells: readonly HTMLElement[],
): () => void {
  const observers: MutationObserver[] = []
  const count = Math.min(real.length, shells.length)
  for (let index = 0; index < count; index += 1) {
    const source = real[index]
    const shell = shells[index]
    if (source === undefined || shell === undefined) continue
    const sync = (): void => {
      if (shell.className !== source.className) shell.className = source.className
      for (const attribute of Array.from(shell.attributes)) {
        if (attribute.name.startsWith('data-') && attribute.name !== SHELL_ATTRIBUTE) {
          shell.removeAttribute(attribute.name)
        }
      }
      for (const attribute of source.attributes) {
        if (attribute.name.startsWith('data-')) {
          shell.setAttribute(attribute.name, attribute.value)
        }
      }
    }
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(source, {
      attributes: true,
      attributeFilter: ['class', 'style', 'data-theme', 'data-state'],
    })
    observers.push(observer)
  }
  return () => {
    for (const observer of observers) observer.disconnect()
    observers.length = 0
  }
}

/**
 * Reproduce `:nth-child` position for the extracted element.
 *
 * A moved element becomes the only child of its new parent, so `:nth-child(n)`
 * selectors that used to match it stop matching. `display: none` siblings still
 * count toward the index, so inserting inert dummies before it restores the
 * original position without adding any layout.
 * @param parent - the element the target was appended to.
 * @param target - the extracted subtree's root.
 * @param index - the target's original 1-based index among its siblings.
 * @param owner - the document that owns the dummies.
 */
export function restoreSiblingIndex(
  parent: Element,
  target: Element,
  index: number,
  owner: Document = parent.ownerDocument,
): void {
  if (index <= 1) return
  const fragment = owner.createDocumentFragment()
  for (let position = 1; position < index; position += 1) {
    const dummy = owner.createElement('dsh-float-slot')
    dummy.setAttribute('aria-hidden', 'true')
    dummy.style.setProperty('display', 'none')
    fragment.appendChild(dummy)
  }
  parent.insertBefore(fragment, target)
}
