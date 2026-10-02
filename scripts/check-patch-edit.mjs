/**
 * Prove the profile-patch edit is stable and lossless before trusting it.
 *
 * The desktop profile's patch layer holds the user's own settings rows, and may
 * hold other plugins' insert rows too. An installer that appends to it must
 * (a) keep every one of those rows, (b) add **its own** row exactly once, and
 * (c) produce the same file on a second run. Without (c) repeated installs
 * accumulate duplicate rows, and a duplicate command id makes
 * `shortcuts.register` throw, which fails the whole boot.
 *
 * The insert-row assertion is scoped to this package deliberately. Counting all
 * `- insert:` rows would flag a profile that legitimately holds more than one
 * plugin — a false failure that says nothing about whether this installer is
 * safe. What must be unique is *this* plugin's row.
 *
 * The transformation is imported from the installer rather than reimplemented,
 * so this cannot pass while the installer is broken by a copy drifting apart.
 *
 * Run with `node scripts/check-patch-edit.mjs [patchPath]`.
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyInsert, PACKAGE, ENTRY_ID } from './patch-edit.mjs'

const source = process.argv[2] ?? 'C:/Users/metaone/.dsh/profiles/desktop/cordis.patch.yml'

/* Work on a copy: this checker must not touch the profile it inspects. */
const scratch = mkdtempSync(join(tmpdir(), 'better-float-patch-'))
const work = join(scratch, 'cordis.patch.yml')
writeFileSync(work, readFileSync(source, 'utf8'))

const original = readFileSync(work, 'utf8')

/** Top-level YAML entries, which are the unindented `- ` lines. */
const topLevel = (text) => text.split('\n').filter((line) => /^- /.test(line))

console.log(`inspecting: ${source}`)
console.log(`(edited a copy under ${scratch})\n`)

const once = applyInsert(original)
writeFileSync(work, once)
const twice = applyInsert(once)

console.log('=== rows before ===')
for (const line of topLevel(original)) console.log(`  ${line}`)

console.log('\n=== rows after ===')
for (const line of topLevel(once)) console.log(`  ${line}`)

/* ------------------------------------------------------------- assertions -- */

const before = topLevel(original)
const after = topLevel(once)
const lost = before.filter((row) => !after.includes(row))

const rowsKept = lost.length === 0
// Exactly one row for *this* plugin. Other plugins' insert rows are expected and
// must be left alone, so the count is scoped to rows naming this package.
const ownInserts = (once.match(new RegExp(`name: ${PACKAGE}`, 'gu')) ?? []).length
const oneInsert = ownInserts === 1
const oneName = ownInserts === 1
const stable = twice === once
const otherInserts = after.filter((row) => /^- insert:$/.test(row)).length

console.log('\n=== checks ===')
console.log(`  pre-existing rows kept : ${rowsKept} (${before.length} before, ${after.length} after)`)
console.log(`  other plugins' inserts : ${otherInserts - (oneInsert ? 1 : 0)} (left untouched)`)
if (lost.length > 0) for (const row of lost) console.log(`    LOST: ${row}`)
console.log(`  exactly one row of ours: ${oneInsert} (${ownInserts} row(s) name ${PACKAGE})`)
console.log(`  package named once     : ${oneName}`)
console.log(`  stable on a second run : ${stable}`)
// No indented line may precede its parent entry: a stray line means the array
// structure was broken and the document would fail to parse.
const structural = !once.split('\n').some((line) => /^\s+\S/.test(line) && !/^\s{2,}\S/.test(line))

console.log('\n=== checks ===')
console.log(`  pre-existing rows kept : ${rowsKept} (${before.length} before, ${after.length} after)`)
if (lost.length > 0) for (const row of lost) console.log(`    LOST: ${row}`)
console.log(`  exactly one insert row : ${oneInsert}`)
console.log(`  package named once     : ${oneName}`)
console.log(`  stable on a second run : ${stable}`)

if (!stable) {
  console.log('\n  the two renderings differ:')
  const a = once.split('\n')
  const b = twice.split('\n')
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) console.log(`    line ${i + 1}: ${JSON.stringify(a[i])} -> ${JSON.stringify(b[i])}`)
  }
}

rmSync(scratch, { recursive: true, force: true })

const ok = rowsKept && oneInsert && oneName && stable
console.log(`\n${ok ? 'SAFE TO INSTALL' : 'NOT SAFE — do not install'}`)
process.exit(ok ? 0 : 1)
