/**
 * Determine which harness home DSH Desktop actually reads.
 *
 * ## Why this cannot be hardcoded, and why it took three attempts
 *
 * Three homes exist on this machine and all three look plausible:
 *
 *   ~/.dsh                                    — what `defaultDshHome()` computes
 *   %APPDATA%/dsh-desktop/harness             — what a stale log named
 *   %APPDATA%/@deepseek-ai/dsh-desktop/       — where the crash report was written
 *
 * An install into the wrong one fails **silently**: the files are present, the
 * patch is correct, and the app shows nothing. Each wrong guess cost a full
 * install-and-restart cycle, so the resolution is evidence-based and verified
 * against an artifact the app itself produced.
 *
 * ## The evidence, strongest first
 *
 * 1. **`$DSH_HOME`**, when set and non-blank. It has the highest precedence in
 *    the shell's own `resolveDshHome`.
 * 2. **A directory this build actually wrote to**, proved by recency. The crash
 *    log and the window state are both written by the running shell, so their
 *    home is the live one. This outranks any computation, because it is an
 *    observation rather than an inference.
 * 3. **`~/.dsh`**, the documented fallback.
 * 4. `%APPDATA%/dsh-desktop/harness`, kept only for reporting: an older build
 *    set `DSH_HOME` to it, and it must never be mistaken for the live one.
 *
 * @module
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Whether a directory looks like a harness home at all.
 *
 * `profiles/` is created on first run and is the one structure every home
 * shares. Its presence does not prove liveness — recency does that.
 * @param dir - candidate home.
 * @returns whether the marker exists.
 */
function looksLikeHome(dir) {
  return existsSync(join(dir, 'profiles'))
}

/** Most recent modification time in a directory tree, or 0 when unreadable. */
function lastWrite(dir, depth = 0) {
  if (depth > 3) return 0
  let newest = 0
  try {
    newest = statSync(dir).mtimeMs
  } catch {
    return 0
  }
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return newest
  }
  for (const entry of entries) {
    const child = join(dir, entry.name)
    if (entry.isDirectory()) newest = Math.max(newest, lastWrite(child, depth + 1))
    else {
      try {
        newest = Math.max(newest, statSync(child).mtimeMs)
      } catch { /* unreadable file, skip */ }
    }
  }
  return newest
}

/**
 * Every candidate home, with what is known about it.
 * @param env - environment mapping used to read `DSH_HOME`.
 * @returns candidates, most likely first.
 */
export function surveyHomes(env = process.env) {
  const appData = env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')

  const candidates = [
    { path: join(homedir(), '.dsh'), origin: 'defaultDshHome()' },
    { path: join(appData, '@deepseek-ai', 'dsh-desktop'), origin: 'scoped app data' },
    { path: join(appData, 'dsh-desktop', 'harness'), origin: 'legacy (an older build set DSH_HOME)' },
  ]

  const explicit = env.DSH_HOME
  if (typeof explicit === 'string' && explicit.trim().length > 0) {
    candidates.unshift({ path: explicit.trim(), origin: 'DSH_HOME' })
  }

  return candidates.map((candidate) => ({
    ...candidate,
    exists: existsSync(candidate.path),
    isHome: looksLikeHome(candidate.path),
    // A home is live only if something in it was written recently. The crash log
    // and the window state are written by the running shell, so a recent write is
    // direct evidence rather than a guess.
    lastWrite: existsSync(candidate.path) ? lastWrite(candidate.path) : 0,
    hasCrashLogs: existsSync(join(candidate.path, 'logs')),
  }))
}

/**
 * The home the app reads, decided by observation before inference.
 *
 * Prefers an explicit `$DSH_HOME`, then the most recently written candidate that
 * actually has a `profiles/` tree. Recency rather than "has profiles" alone,
 * because several stale homes satisfy the structural test.
 * @param env - environment mapping used to read `DSH_HOME`.
 * @returns the resolved home and why it was chosen.
 */
export function resolveHarnessHome(env = process.env) {
  const explicit = env.DSH_HOME
  if (typeof explicit === 'string' && explicit.trim().length > 0) {
    return { home: explicit.trim(), source: 'DSH_HOME' }
  }

  const live = surveyHomes(env)
    .filter((candidate) => candidate.exists && candidate.isHome && candidate.lastWrite > 0)
    .sort((a, b) => b.lastWrite - a.lastWrite)

  const best = live[0]
  if (best !== undefined) {
    const age = Math.round((Date.now() - best.lastWrite) / 1000)
    return {
      home: best.path,
      source: `most recently written home (${best.origin}, ${age}s ago)`,
    }
  }

  return { home: join(homedir(), '.dsh'), source: 'default (~/.dsh); nothing written yet' }
}

/**
 * Every path worth sweeping for a stale install.
 * @param env - environment mapping used to read `DSH_HOME`.
 * @returns absolute paths, deduplicated, resolved home first.
 */
export function candidateHomes(env = process.env) {
  const resolved = resolveHarnessHome(env).home
  const rest = surveyHomes(env).map((candidate) => candidate.path)
  return [...new Set([resolved, ...rest])]
}

/**
 * Describe a candidate home for reporting, without deciding anything.
 *
 * Kept separate from resolution so a report can show every home — including the
 * stale ones — while resolution stays free to pick one. A single function that
 * did both is how the wrong home got chosen in the first place: describing a
 * candidate and choosing it are different questions.
 * @param home - absolute path to inspect.
 * @returns what is known about that path.
 */
export function describeHome(home) {
  const exists = existsSync(home)
  return {
    path: home,
    exists,
    hasProfiles: exists && looksLikeHome(home),
    lastWrite: exists ? lastWrite(home) : 0,
    hasCrashLogs: exists && existsSync(join(home, 'logs')),
  }
}
