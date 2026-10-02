/**
 * The profile-patch edit: append this plugin's row to a layer that holds the
 * user's own settings.
 *
 * ## Why this is a module rather than inline code
 *
 * The transformation has two properties that must both hold, and both are
 * invisible from reading the result:
 *
 *   1. **Lossless.** The desktop profile's patch carries the user's settings
 *      rows. Rewriting the file from a template — the obvious implementation —
 *      silently discards them.
 *   2. **Idempotent.** A second install must replace this plugin's row, not add
 *      another. Two rows with the same command id make `shortcuts.register`
 *      throw a duplicate error, which fails the whole harness boot rather than
 *      just this plugin.
 *
 * An earlier version had (1) but not (2): the writer emitted a two-line comment
 * banner while the matcher expected three, so a re-install failed to recognise
 * its own output. Because a wrong result here is silent until boot, the logic
 * lives in one place with a checker (`check-patch-edit.mjs`) that imports it —
 * so the checker cannot pass while the installer is broken.
 *
 * @module
 */

export const PACKAGE = 'dsh-better-float'
export const ENTRY_ID = 'better-float'

/**
 * The comment banner written above this plugin's row.
 *
 * Used for both writing and matching, so the two can never disagree.
 */
export const BANNER = `#
# better-float: pick an element with a shortcut and pull it out as a floating
# panel. Remove the row below to disable it.
`

/**
 * This plugin's loader row, as YAML.
 * @returns the row text, ending in a newline.
 */
export function insertEntry() {
  return `- insert:\n    - id: ${ENTRY_ID}\n      name: ${PACKAGE}\n`
}

/**
 * Whether `block` appears in `lines` starting at index `at`.
 *
 * Trailing whitespace is ignored, because the file may have been written by an
 * editor that normalised it; leading whitespace is significant, because it is
 * what makes the line part of a YAML entry rather than a sibling of it.
 * @param lines - the document, split.
 * @param at - the index to compare from.
 * @param block - the expected lines.
 * @returns whether every line matches at that position.
 */
function matchesAt(lines, at, block) {
  for (let offset = 0; offset < block.length; offset += 1) {
    const actual = (lines[at + offset] ?? '').trimEnd()
    if (actual !== block[offset]) return false
  }
  return true
}

/**
 * Append this plugin's row to a profile patch layer.
 *
 * Any previous row and banner for this plugin are removed first, so applying
 * this twice produces the same text as applying it once. Every other row is
 * copied through unchanged.
 * @param input - the current patch file contents.
 * @returns the new contents.
 */
export function applyInsert(input) {
  const bannerLines = BANNER.trimEnd().split('\n')
  const rowLines = insertEntry().trimEnd().split('\n')

  const lines = input.split('\n')
  const kept = []
  for (let i = 0; i < lines.length;) {
    if (matchesAt(lines, i, bannerLines)) { i += bannerLines.length; continue }
    if (matchesAt(lines, i, rowLines)) { i += rowLines.length; continue }
    kept.push(lines[i])
    i += 1
  }

  // Collapse the blank runs left behind when a previous install is removed, so
  // repeated runs do not grow the file with blank lines.
  const stripped = kept.join('\n').replace(/\n{3,}/gu, '\n\n').trimEnd()
  return `${stripped}\n${BANNER}${insertEntry()}`
}
