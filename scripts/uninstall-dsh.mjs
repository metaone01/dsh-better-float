/**
 * Remove better-float from every harness home on this machine.
 *
 * Needed because an experiment that goes wrong should be undoable without
 * hand-editing YAML under a home directory. The desktop shell has a safety net —
 * a startup watchdog and a plugin-recovery pass that can quarantine a bad plugin
 * — but relying on that is worse than a removal the user controls, and the
 * recovery pass renames the whole patch layer rather than the one row.
 *
 * Every profile the plugin may have reached is swept:
 *
 *   - `<home>/profiles/desktop` — the profile the Electron app boots
 *   - `<home>/profiles/web`     — the CLI profile an early installer patched by mistake
 *
 * and every candidate home, not just the resolved one, because an install left
 * in a home the app no longer reads still looks like a working install.
 *
 * The patch is restored from the backup the installer wrote rather than blanked,
 * so rows the user added before installing survive.
 *
 * Run with `npm run uninstall:dsh`.
 */
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { candidateHomes } from './harness-home.mjs'

const PACKAGE = 'dsh-better-float'
const PROFILES = ['desktop', 'web']

const PATCH_TEMPLATE = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
[]

`

console.log('better-float · DSH Desktop uninstaller\n')

let removed = false

for (const home of candidateHomes()) {
  if (!existsSync(home)) continue

  for (const profile of PROFILES) {
    const dir = join(home, 'profiles', profile)
    if (!existsSync(dir)) continue

    const target = join(dir, 'node_modules', PACKAGE)
    const patch = join(dir, 'cordis.patch.yml')
    const backup = `${patch}.before-better-float`

    console.log(`${home}/profiles/${profile}`)

    /* ------------------------------------------------------ package dir --- */

    if (existsSync(target)) {
      // Confined to the one directory this plugin owns. Nothing else is touched.
      rmSync(target, { recursive: true, force: true })
      console.log(`  removed ${target}`)
      removed = true
    } else {
      console.log('  package directory already absent')
    }

    /* ---------------------------------------------------- profile patch --- */

    if (!existsSync(patch)) {
      console.log('  profile patch absent; nothing to restore')
    } else if (!readFileSync(patch, 'utf8').includes(PACKAGE)) {
      console.log('  profile patch does not mention the plugin; leaving it untouched')
    } else if (existsSync(backup)) {
      // Restoring the backup is safer than rewriting, because the patch may hold
      // rows the user added after installing.
      copyFileSync(backup, patch)
      rmSync(backup, { force: true })
      console.log('  restored the profile patch from its pre-install backup')
      removed = true
    } else {
      // No backup means the installer's record was lost. Removing just this
      // plugin's rows keeps every other entry intact, which rewriting the file
      // from a template would not.
      const kept = readFileSync(patch, 'utf8')
        .split('\n')
        .filter((line) => !/better-float/u.test(line))
        .join('\n')
        .replace(/\n{3,}/gu, '\n\n')
        .trimEnd()

      const hasRows = kept.split('\n').some((line) => /^- /.test(line.trim()))
      writeFileSync(patch, hasRows ? `${kept}\n` : PATCH_TEMPLATE, 'utf8')
      console.log(hasRows
        ? '  removed the plugin rows, leaving the other entries in place'
        : '  no backup found; reset the profile patch to an empty array')
      removed = true
    }

    console.log('')
  }
}

if (removed) {
  console.log('uninstalled. Restart DSH Desktop for the change to take effect.')
} else {
  console.log('nothing to do.')
}
