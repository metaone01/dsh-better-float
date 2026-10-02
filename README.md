# dsh-better-float

Pick any element in the app with a keyboard shortcut, then pull it out as a
floating panel.

## Current Desktop Controls

- `Ctrl+Shift+S`: pick an element; use the wheel or arrow keys to select its hierarchy.
- `Ctrl+Alt+Shift+S`: open the screenshot grid of floating windows.
- Select a window preview, then click with the crosshair to place its top-left corner.
- `Esc`: cancel picking, close the overview, or cancel placement.
- On macOS, use `Cmd` instead of `Ctrl`.

Independent OS windows require the host integration described in
[`desktop/INTEGRATION.md`](./desktop/INTEGRATION.md); the standard plugin currently
provides same-document floating panels. Host source excerpts and local debugging
artifacts referenced by historical notes are not distributed in this repository.

> **Picking this up for the first time? Read [`HANDOFF.md`](./HANDOFF.md).**
> It records the host contract this plugin must satisfy — the nine platform
> specifiers a bundle may import, the `inject` declaration that must appear twice,
> the per-kind slot rules — and the two failures that cost the most time to find.
> The extracted host source it cites is in [`docs/`](./docs).

This is the implementation of the plan in
`better-float-implementation-plan.md`, which was itself a correction pass over an
earlier generic design. Read that plan's §0 before changing anything here; most
of the structure in this repository exists to avoid one specific failure it
describes.

---

## What actually happens, in order

1. **Pick.** A shortcut puts the app into pick mode. A click-through overlay
   follows the pointer and outlines whatever is underneath. `↑` / `↓` step out
   to the parent or in to a child.
2. **Extract.** On release the element is moved — not copied — into a panel, and
   a placeholder takes its place in the page.
3. **Float.** The panel is a normal floating surface: drag it by its bar, resize
   from the corner, raise it by clicking, close it with the ✕.
4. **Detach.** Drag it into an edge band, or press the ⤢ button, to open it in a
   standalone window with its own title bar, always-on-top and click-through
   settings.

---

## The three ideas worth understanding first

Everything else is detail. These are the parts where the obvious implementation
is wrong.

### 1. Move the node; do not copy it

Cloning loses canvas pixels, video position, form values, scroll offsets, focus,
animation progress and open popovers, and it severs the element from whatever
framework was updating it. Moving the node keeps all of it, because the object
identity never changes and the framework keeps rendering into the same node —
now in a new place. `src/capture/tier0-live.ts`.

### 2. The parent needs a stand-in, or the app crashes

Once the element is moved out, its old parent still believes it has that child.
The next time the framework removes or replaces it, the DOM throws
`NotFoundError` and takes down the surrounding subtree.

`src/capture/stand-in.ts` puts a placeholder in the old slot and intercepts the
parent's child-mutation methods **as own properties on that one element**, so
references to the moved node are silently rewritten to the placeholder. The
restore function must be called before the element returns — there is a comment
at the top of that file explaining what goes wrong if it is not.

### 3. Copy the ancestors, not the styles

The instinct is to snapshot computed styles and inline them. That breaks the
app: inline values outrank every stylesheet, so theme switching, state classes
and `:hover` all stop working, and the inline values fight the framework's own
`style` prop for the same keys.

Instead, rebuild the *lost ancestors* as empty shells carrying only tag, class
and `data-*`, and give them `display: contents`. Selectors match the DOM tree,
not the box tree, so those shells restore descendant, child, sibling and `:has()`
matching while generating no boxes at all. `src/capture/css-skeleton.ts`.

Where the element's own parent can host the panel, no shells are needed at all —
that is `src/capture/css-inplace.ts`, and it is tried first.

---

## Layout

```
src/
  client/index.ts        plugin entry: registers the shortcut and the overlay seat
  scout/                 pick mode: hit testing, stepping, the highlight overlay
    hit.ts               elementFromPoint, ancestor stepping, edge detection
    overlay.ts           the click-through overlay and its visuals
    index.ts             the pick session state machine
    ancestry.ts          containing-block detection, shared by scout and capture
  capture/               turning a picked element into a panel
    index.ts             picks the tier and coordinates the pieces below
    tier0-live.ts        the move itself, plus the pre-flight prognosis
    stand-in.ts          ★ the structural stand-in
    css-inplace.ts       ★ mount inside the real parent, position:fixed
    css-skeleton.ts      ★ rebuild ancestors as display:contents shells
    events-reflect.ts    ★ calling framework handlers from the moved node
    tier2-clone.ts       the copy, for windows
    tier3-bitmap.ts      the image, as a last resort
  float/                 the panel surface
    index.ts             panel chrome, drag, resize, close
    manager.ts           owns panels and guarantees every extraction is undone
    geometry.ts          pure clamping and sizing rules
    pointer.ts           gesture to delta, and frame coalescing
  detach/                sending a panel to its own window
    dropzone.ts          the edge-band gesture
    transport.ts         IPC for windows, BroadcastChannel for state
  shared/                types and the platform declarations TypeScript lacks
desktop/                 patches for apps/desktop — read the header of each
spikes/                  runnable bench that answers the plan's blocking questions
scripts/                 build, static checks, spike runner
```

---

## Running it

```bash
npm install
node node_modules/electron/install.js   # downloads the Electron binary (~100 MB)
npm run typecheck        # strict, no errors expected
npm run build            # produces lib/client.js and lib/index.js
npm run spike:check      # 47 static checks, including the purity gate
npm run spike:versions   # asks the engine what it actually supports
npm run spike            # runs the spike bench and writes spikes/report.json
```

`spike:check` is the one to run before committing. It catches the failures that
otherwise only appear when the host refuses to load the plugin: a forbidden host
import, a bundle that never registers with the module loader, a reserved
keybinding, an `innerHTML` that crept into the clone path, or the
`container-type` detection trap described below.

The Electron scripts go through `scripts/run-electron.mjs` rather than calling
`electron` directly. That launcher strips `ELECTRON_RUN_AS_NODE` from the child
environment, without which Electron silently degrades into a plain Node process
and reports a confusing `TypeError` from a correct script. It also adds the
software-rendering flags that a restricted environment needs.

---

## Verified so far

Measured on Electron 44.4.5 / Chromium 152 with `npm run spike:versions` and
`npm run spike`. These are results, not expectations.

| Question | Result |
|---|---|
| Does `moveBefore` preserve runtime state? | **Yes — 4/4.** Focus, text selection, an in-flight CSS transition and a loaded iframe all survive the move. This is what lets Tier 0 be the default path. |
| Does the structural stand-in survive parent churn? | **Yes — 7/7** operations clean, including the two run after release. No `NotFoundError`. |
| Does a `display: contents` shell reproduce real selectors? | **Yes — 5/5.** Child, descendant, `:nth-child`, adjacent sibling and `:has()` all produce the same computed result as the real tree. |
| Can a light-DOM shell reach into a shadow root? | **No.** A genuine platform limit, so the design downgrades rather than trying to bridge it. |
| Must scoped-style attributes be copied onto shells? | **Yes.** A `data-v-*` rule stops matching on a shell that omits the attribute. |
| Does a shell work as a `@container` query container? | **No — and detecting it is subtle.** See below. |

### The `container-type` trap

An earlier draft of the design said `container-type` is "silently ignored" on an
element with `display: contents`. That is close enough to be dangerous. What
actually happens, measured:

- The computed `container-type` **still reads as `inline-size`** on a
  `display: contents` element.
- But no `@container` rule resolves against it.

So detecting the gap by comparing the computed value against `normal` always
reports "no gap", and the repair is silently skipped. The check must also
require that the element generates a box — which is what
`isContainerQueryContainer` in `src/capture/css-inplace.ts` does, and what
`spike:check` now enforces.

### Not yet verified

- **S0** — whether pointer coordinates keep arriving past the window edge. This
  needs a real mouse drag out of the window, so it cannot be automated. The bench
  window has an armed panel for it; its verdict decides whether detaching can use
  exact placement or must rely on the edge band, which is already implemented.
- **S1 / S5** — whether a usable `WindowProxy` can be obtained, and whether
  sharing a renderer process is survivable. Both need the desktop shell.

---

## Installing into the harness

Two ways, depending on whether the harness is a source checkout or the packaged
app.

### Into the packaged DSH Desktop app

```bash
npm run check          # typecheck + build + 50 static checks + patch-edit safety
npm run install:dsh    # writes into the profile the app actually boots
npm run verify:dsh     # re-reads everything, including from the shipped shell
```

Then **restart the app** — the patch layer is composed at boot, so reloading the
window is not enough.

Two things about the target are easy to get wrong, and both fail **silently** —
files present, patch correct, app unchanged:

| | |
|---|---|
| **Profile** | `profiles/desktop`, because `resolveDesktopPaths` in the shell names it. `profiles/web` is the CLI's profile and the app never reads it. |
| **Home** | `~/.dsh`, because the shell never assigns `DSH_HOME` for the harness child and `resolveDshHome` falls back to `defaultDshHome()`. `%APPDATA%\dsh-desktop\harness` is a leftover from a build that did set it. |

Rather than hardcode either, `scripts/harness-home.mjs` applies the shell's own
precedence rule and `verify:dsh` re-reads the answer out of `app.asar` to confirm
the install landed where the app looks.

`npm run uninstall:dsh` reverses it, restoring the patch layer from the backup —
the desktop profile holds the user's own settings rows, and those are never
touched by either script.

See `TESTING-IN-DSH.md` for what to press, what each behaviour proves, and what
is deliberately not wired up yet.

### Into a source checkout

The plugin is consumed as a package, so it goes under `packages/` and is listed in
the browser bundle's roster.

1. Add the package to the workspace and run its build.
2. Add a roster row to the bundle patch that ships the browser app, mirroring the
   pattern in `apps/web/tests/fixtures/plugins/fixture-live-client/`:
   ```yaml
   - insert:
       - id: better-float
         name: dsh-better-float
   ```
3. For the desktop, copy `desktop/popout-manager.ts` into `apps/desktop/src/`,
   call its `installPopoutManager` and `registerIpc` from the ready path once the
   primary window exists, and call `dispose` on shutdown. That file's header
   explains why it is a patch rather than part of this package, and
   `desktop/INTEGRATION.md` is the step-by-step version.

Nothing in this package imports a host module. Every service arrives through
`ctx.inject`. That is not stylistic — the harness's purity gate rejects the
alternative at build time.

---

## Constraints that shape the code

| Constraint | Consequence |
|---|---|
| `@deepseek-ai/*` value imports are forbidden | all host access goes through `ctx.inject`; the constraint is checked by `spike:check` |
| `primary + KeyC/V/X/Z/Y/Q/H` are reserved | the shortcut is `primary + shift + KeyS` |
| `moveBefore` throws across documents | a standalone window necessarily falls back to `adoptNode`, losing iframes, focus and animations |
| Custom-scheme origin is `scheme://host` | popouts use `dsh-app://app/?dsh-popout=<id>`, never a new host, or cross-window messaging and storage break |
| Pointer events stop at the window edge | detaching arms an edge band instead of following the cursor outside |
| `container-type` is ignored without a layout box | a `display: contents` shell cannot be a query container; that one ancestor needs a real box |
| No `affinity` on the primary window | a crashing panel cannot take the app down with it |

---

## What is not built yet

The plan's stages 2 and 3 are partially open, and honestly so:

- **Detach is wired but unproven.** `src/detach/` and `desktop/popout-manager.ts`
  are complete, but nothing has been run against a real shell yet. Spikes S1 and
  S5 in the plan cover the two unknowns: whether a usable `WindowProxy` can be
  obtained, and whether sharing a renderer process is survivable. Neither blocks
  the in-app floating path, which is the highest-fidelity part and works without
  either.
- **Cross-window content transfer sends a description, not a node.** A live node
  cannot cross a process boundary. The popout rebuilds from the description; the
  clone path is the fallback today.
- **Tier 1 (semantic rebuild) has no implementation.** The plan argues it should
  become the preferred cross-window path, since re-rendering the same component
  keeps full interactivity with no round trip. It needs a way to identify what an
  element represents, which is a harness-side annotation that does not exist yet.
- **The window attribute panel in the UI is minimal** — always-on-top,
  click-through and frameless are supported by the manager but only always-on-top
  is exposed on the panel today.

## Where to start if you are picking this up

1. `npm run spike:versions` — confirms the engine has what the design needs, and
   prints the one-line conclusion.
2. `npm run spike` — the bench window shows what already holds and what does not.
   Press start on the S0 panel and drag out of the window; that is the one
   measurement still missing.
3. Read `better-float-implementation-plan.md` §13 for the measured results, then
   §0 for the twelve corrections that shape the structure of this repository.

The in-app floating path (stages 0–1) is implemented and does not depend on any
open spike. The detach path (stage 2) is implemented but unproven against a real
desktop shell.
