# Testing better-float in DSH Desktop

Everything below reflects what the shipped app actually does, read from
`app.asar` on this machine — not from the plan document.

> **Status:** the plugin installs, loads, activates, and registers its shortcut.
> Its panel layer is contributed to `shell.overlay`. The picker has **not** been
> exercised by a real click yet — §3 is the part still to do.
>
> For the host contract behind these steps, and the `FAILED`-entry bug that was
> fixed last, see [`HANDOFF.md`](./HANDOFF.md).

---

## 1. Where it is installed

| | |
|---|---|
| App | `G:\Deepseek Harness Desktop` (Electron 44.0.0, DSH runtime 0.1.7-rc.1) |
| **Harness home** | **`C:\Users\metaone\.dsh`** |
| Profile the app boots | `profiles/desktop` |
| Plugin files | `C:\Users\metaone\.dsh\profiles\desktop\node_modules\dsh-better-float\` |
| Activation row | `C:\Users\metaone\.dsh\profiles\desktop\cordis.patch.yml` |

### Two facts that cost real time to establish

**The profile is `desktop`, not `web`.** The shell hardcodes it:

```js
function resolveDesktopPaths(dshHome = resolveDshHome()) {
  return { profile: join(dshHome, "profiles", "desktop") }
}
```

`profiles/web` is the CLI's profile (`dsh web`). A plugin installed there is
invisible to the app: no error, no UI, and the Plugins page shows only the
built-ins. That is what the first attempt did.

**The home is `~/.dsh`, not `%APPDATA%\dsh-desktop\harness`.** The shell never
assigns `DSH_HOME` for the harness child, so the runtime falls back:

```js
function defaultDshHome() { return join(homedir(), '.dsh') }
function resolveDshHome(configured, env = process.env) {
  return resolve(configured ?? (env.DSH_HOME?.trim() ? env.DSH_HOME : defaultDshHome()))
}
```

`%APPDATA%\dsh-desktop\harness` exists and holds a `profiles/` tree, which is
why it looked authoritative — but no current build reads it. The log at
`%APPDATA%\dsh-desktop\logs\harness.log` records a launch from an older build
that *did* set `DSH_HOME`, which is exactly the misleading evidence. That is what
the second attempt did.

**A third path is a decoy rather than a home.** `%APPDATA%\@deepseek-ai\dsh-desktop`
is the Electron *userData* directory: it holds caches, window state, and
`logs/`, but it has **no `profiles/` tree**, so it is not a harness home at all.
Crash reports land there simply because it is where Electron logs. An installer
that treated it as a target would write files nothing reads.

`npm run which:home` reports every candidate with its evidence — origin, whether
it has a `profiles/` tree, and when it was last written. The last of those is the
one that decides: writing time is an observation about the running app, whereas
"looks like a home" is true of several directories at once. `npm run verify:dsh`
then re-reads the profile name out of the shipped shell rather than trusting any
note.

---

## 2. How it is activated

A package joins the browser roster by declaring `dsh.client`. The node half
scans Loader entries for it:

```js
const decl = parseDshClient(packageName, pkg.dsh?.client)
if (decl === void 0 || decl.platform !== "web") return null
const clientRel = clientExportOf(packageName, pkg.exports)
if (clientRel === void 0) throw new Error(`... declares dsh.client but exports no "./client" bundle`)
```

So the package needs **both** a `dsh.client.platform` and a `"./client"` export.

The row that makes the Loader import it lives in the profile's patch layer,
which is **appended to**, not rewritten — the desktop profile already holds four
of the user's own settings rows, and they are preserved.

### The client bundle's required shape

A client bundle must register in exactly this form, where **`require` is a
parameter of the factory** and every external is requested inside its body:

```js
window.__ModuleLoader__.load({
  id: "dsh-better-float",
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    let react = require("react")     // inside the factory, where `require` exists
    …
    exports.apply = apply
    return module.exports
  },
})
```

Getting this wrong **stops the app from starting**, with a plugin-host error
dialog reading:

```
web boot: 1 entry did not activate
dsh-better-float: import failed
```

An earlier build of this plugin did exactly that. esbuild, asked for an IIFE with
`react` marked external, generated a shim at module scope:

```js
var __require = ((x) => typeof require !== "undefined" ? require : …)(function (x) {
  throw Error('Dynamic require of "' + x + '" is not supported')
})
var import_react = __require("react")   // module scope: no `require` here
```

`__require` closes over the *global* `require`, which does not exist in a classic
script. The bundle now builds as CommonJS and is wrapped by hand into the loader
call, and `npm run check:shape` verifies by brace-depth tracking that every
`require(...)` sits inside the factory.

The full error text is also written to
`%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-<timestamp>-web-boot.log`.

---

## 3. How to run it

```bash
npm run check          # typecheck + build + 50 static checks + patch-edit safety
npm run install:dsh    # install into ~/.dsh/profiles/desktop
npm run verify:dsh     # re-read everything independently
npm run uninstall:dsh  # remove it; restores the patch from the backup
```

**Restart DSH Desktop after installing.** The patch is composed at boot and the
client roster is built into the page then; reloading the window is not enough.

---

## 4. What to press, and what each result means

| Step | Action | Expected | What it proves |
|---|---|---|---|
| 1 | `Ctrl+Shift+S` (macOS: `Cmd+Shift+S`) | Pick mode: a ring follows the cursor, everything else dims, a hint bar appears at the bottom | The plugin loaded, the shortcut registered, and `resolve` returned `handled` |
| 2 | Move the cursor | The ring tracks, a label beside it names the element (`div.chat-message > p`) | Hit testing and the overlay work |
| 3 | `↑` / `↓` | The selection widens / narrows along the ancestor chain | Ancestor stepping works |
| 4 | Click | A panel appears with a title bar, `⤢`, and `✕` | Extraction and panel mounting work |
| 5 | **Interact inside the panel** | Buttons, inputs, and scrolling all still work | **The critical one.** The element was *moved*, not copied, so its framework binding survived. If the panel looks right but ignores clicks, that is the exact failure this design exists to avoid — report it |
| 6 | Drag the title bar; resize from the corner | The panel moves and resizes; clicking raises it above the others | Panel chrome and z-ordering work |
| 7 | `✕` | The panel closes and **the page is restored** | The stand-in was retired and the element returned |
| 8 | `Esc` during pick mode | Pick mode ends with nothing extracted | Cancellation works |

### DOM checks, if the UI does not appear

Each layer fails independently, so check them in order:

```js
// 1. Is the plugin registered as a browser module at all?
window.__DSH_BOOT__?.entries?.map(e => e.id)
//    must contain "dsh-better-float"

// 2. Did the seat mount? Expect 1 while the app is running.
document.querySelectorAll('[data-better-float="layer"]').length

// 3. After a pick, is a panel in the DOM? Expect 1 per open panel.
document.querySelectorAll('.dsh-bf-panel').length

// 4. Settings → Shortcuts → search "floating panel"
//    The row must be listed.
```

- Check 4 fails → the plugin did not load; look at the patch row and the app's log.
- Check 4 passes but check 2 fails → the plugin loaded and the seat registration failed.
- Checks 1–3 pass but pressing the key does nothing → the command is registered but not dispatching.

If none of the plugin's script appears in `__DSH_BOOT__`, check for a crash report:

```
%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*-web-boot.log
```

That file carries the renderer console output at the moment the entry failed to
activate, which is where an import error is actually explained. It is written
only when a plugin entry fails, so its absence is meaningful.

---

## 5. What does not work yet

**`⤢` (detach to a separate window) is inert.** It logs a warning and does
nothing. The code exists (`src/detach/`, `desktop/popout-manager.ts`) but it
needs a patch to the app's main process, and the app ships as `app.asar` — a
read-only archive that cannot be edited in place. Dragging a panel out of the
window is inert for the same reason.

**Dragging a pick out of the window** is disabled: the shortcut calls
`pick(false)`. Offering the gesture with no handler behind it would strand the
user mid-drag.

Those two are the only planned features that a plugin cannot deliver. Everything
else — the picker, ancestor stepping, extraction, the floating panels, and
restoring the page on close — is implemented in the plugin itself and needs no
change to the app.

---

## 6. If the app will not start

A browser-side plugin **can** stop the app from starting: the host treats a
client entry that fails to import as a boot failure and shows the
"DeepSeek Harness is unavailable" dialog. That happened once here, from a wrong
bundle shape (§2), so this is a real risk rather than a theoretical one.

The dialog itself offers the fix: **"Disable third-party plugins, back up profile
patch, and restart."** That renames the profile patch, which is the same
recovery as below and preserves the original for inspection.

From a terminal:

```bash
npm run uninstall:dsh
```

That removes the plugin directory and restores the patch layer from the backup
taken at install time — including the four settings rows, which are never
touched.

If the app still will not start, disable the whole patch layer. Renaming it makes
the profile boot with bundle defaults only:

```
%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml  →  cordis.patch.yml.off
```

---

## 7. Verification already performed

| Check | Result |
|---|---|
| TypeScript, strict | clean |
| Build | 51 KB client bundle; no bundled `react-dom`, no bundled `@deepseek-ai/*` |
| **Bundle shape** | factory takes `require`; every `require(...)` inside it; no `__require` shim; `module.exports` returned — 8/8 |
| Static checks | 50 passed, including that the shortcut returns `handled` and calls `.pick()` |
| Patch edit | 4 pre-existing rows preserved, exactly one insert row, stable when re-run |
| Registration | bundle registers under `dsh-better-float`, matching the package name |
| Roster eligibility | `dsh.client.platform: 'web'` and a `"./client"` export — both required by the scanner |
| **App launch with the plugin installed** | 4 processes stayed up; **no crash report written** |
| Live spike (Electron 44.4.5 / Chromium 152) | `moveBefore` preserved focus, selection, animation, and avoided an iframe reload — 4/4 |
| Skeleton selector fidelity | child, descendant, `:nth-child`, sibling, and `:has()` all reproduced — 5/5 |

### About that launch row

The launch is real evidence but a narrow one, so it is worth being precise. The
broken build wrote `crash-*-web-boot.log` **within seconds** of starting and
showed the app's plugin-host error dialog. After the fix, the app ran with no
crash report at all, and the two reports on disk both predate the fix.

What that rules out: the client entry failing to import. What it does not
establish: that the picker works. Registration and activation are separate
stages, so §4 remains the real test.

### Not yet verified

Interactive behaviour — the shortcut firing, the picker, extraction, panel
interaction, and page restore. Those can only be confirmed by using the app.
