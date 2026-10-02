# HANDOFF — dsh-better-float

State at handoff: **the plugin loads, activates, and its shortcut is registered.**
The last blocker — a `FAILED` entry caused by a missing service declaration — is
fixed and verified. What remains is a live UI trial of the picker itself.

Read this file first. It contains the facts that are expensive to rediscover:
the host's contract, the exact shape a bundle must have, and the traps that cost
the most time in this build.

---

## 1. What this is

A DSH (DeepSeek Harness) plugin. Press a shortcut, pick a DOM element, and it is
pulled out into a floating panel that stays interactive.

| Path | Role |
| --- | --- |
| `src/client/index.ts` | Client half — the entry the host loads in the renderer |
| `src/index.ts` | Host half — intentionally an empty `apply()` (see §6) |
| `src/scout/` | The picker: hit-testing, ancestry stepping, highlight overlay |
| `src/capture/` | Extraction tiers — live move, clone, bitmap, stand-in, skeleton |
| `src/float/` | The panel: geometry, pointer handling, manager |
| `src/detach/` | Drop-zone and transport types for the (unavailable) window detach |
| `scripts/` | Build, gates, installer, verifier, diagnostics |
| `docs/` | Extracted host source. **The reference material — see §3** |
| `desktop/` | Main-process half, for a build that can patch the app (see §7) |

---

## 2. Run it

```bash
npm install
npm run check        # typecheck + build + 4 gates; must be green before install
npm run install:dsh  # copies into the active DSH profile
npm run launch:dsh   # launches DSH Desktop, holding a parent so the GUI survives
```

Then press **Ctrl+Shift+S** (Cmd+Shift+S on macOS) and click an element.

The harness home is resolved by observation, not assumption — `~/.dsh` on this
machine, profile `desktop`. `npm run which:home` reports the reasoning. Three
plausible homes exist here and an install into the wrong one **fails silently**:
the files are present, the patch is correct, and the app shows nothing.

Other commands:

| Command | Purpose |
| --- | --- |
| `npm run app:probe` | Is the plugin in the boot manifest? Is the app even up? |
| `npm run app:verify` | Is it *active*, not merely loaded? Needs a debug port |
| `npm run app:debug` | Relaunch with `--remote-debugging-port=9222` for diagnosis |
| `npm run verify:dsh` | Read back what the app will see, from outside |
| `npm run uninstall:dsh` | Remove the plugin and its patch row |

---

## 3. The host contract — read this before changing the bundle

Everything below was extracted from the shipped app and is reproduced in `docs/`.
Each claim names the file that proves it.

**The loader protocol.** A client bundle is fetched as a classic script and must
register itself:

```js
window.__ModuleLoader__.load({
  id: 'dsh-better-float',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var react = require('react')      // require is a FACTORY PARAMETER
    exports.apply = apply
    return module.exports
  },
})
```

`require` exists **only inside the factory**. A `require(...)` at module scope is
evaluated where no `require` binding exists. → `docs/host-client-module-system.txt`

**The platform seed — the complete list of bare specifiers a factory may
`require`.** There are exactly nine:

```
react  react/jsx-runtime  react-dom  react-dom/client  @deepseek-ai/cordis
@deepseek-ai/dsh-client-store  @deepseek-ai/dsh-client-ui-slots
@deepseek-ai/dsh-client-ui-primitives  @deepseek-ai/dsh-client-ui-dockkit
```

Anything else must be a registered package row or the require **throws**.
→ `docs/host-platform-seed-table.txt`, `docs/host-module-interop-helper.txt`

**`react` resolves to a synthetic namespace, not React itself.** The shell binds
it via an interop helper that copies React's members onto an object that also
carries `default`. Both `require('react').createElement` and
`require('react').default.createElement` work. → `docs/host-react-binding.txt`

**`inject` is load-bearing, and must appear twice.** Cordis supplies a plugin's
`ctx` with *exactly* the names in its `inject`, and starts the fiber only once
they are all present. A service that is not declared is **absent** — so reading
`ctx.slots` throws a `TypeError` and the entry ends `FAILED`.

The list has to be declared in both places:

- the bundle's **`inject` export** — what Cordis honours at mount
- **`dsh.client.inject`** in package.json — what the host reads to order the
  boot graph, *before* any bundle has executed

Declaring only one leaves the plugin unordered or unstarted. This was the final
bug. → §5, and `docs/host-client-modules-registry.txt`

**Slot registration.** `shell.overlay` is declared `kind: 'list'` by
`ui-layout`, and `SlotCore.register` enforces per-kind fields:

```
single → one entry per priority
keyed  → requires options.key
list   → requires options.id    ← shell.overlay
chain  → requires options.select
```

Ordering is **`priority`** (read as `options.priority ?? 0`, lowest renders
first). There is no `order` field; passing one is accepted and silently ignored.
Registering against an undeclared slot throws.
→ `docs/host-slot-core-validation.txt`, `docs/host-ui-slots-source.txt`

**Shortcut resolution.** `shortcuts.register({ id, label, aliases, defaults,
regions, modals, resolve })` — and `resolve()` must return
`{ status: 'handled', run }`. Returning `'pass'` means "not mine", and the
keystroke falls through: a shortcut that appears in settings and does nothing.
Two modifiers are required (`primary + shift + KeyS`); `primary + KeyC/V/X/Z/Y/Q/H`
and bare `primary + KeyA` are reserved even with shift.

**The boot audit decodes to a state.** `MS` in the shell reports:
`import failed (…importError.message)` when `fiber === undefined`, `pending
(waiting for service: …)` when the state is PENDING, and `failed` when the fiber
reached FAILED — meaning the factory materialized fine and **`apply()` threw**.
→ `docs/host-boot-audit.txt`

---

## 4. The gates, and why each exists

`npm run check` runs them in order. All were green at handoff.

| Gate | Catches |
| --- | --- |
| `typecheck` | ordinary type errors |
| `check:shape` | **15 checks** — loader shape, `require` inside the factory, no esbuild shim, and the `inject` declaration in both the bundle and the manifest |
| `check:inject` | regression test: proves `check:shape`'s `inject` checks **fail** on the broken shape, then restores. A check that passes on good input proves nothing |
| `check:static` | 50 checks — the spike bench, including camelCase-vs-kebab CSS traps |
| `check:patch` | the profile patch edit keeps every foreign row, adds exactly one of ours, and is idempotent |

`check:shape` and `check:inject` are the two that matter most: they encode the
failure that cost this build the most time, and they fail loudly on it.

---

## 5. What was wrong, and why it was hard

Symptom: `web boot: 1 entry did not activate` / `dsh-better-float: failed`, and
pressing the shortcut did nothing. The plugin was **in the boot manifest**, its
batch served **HTTP 200**, the loader was in `live` mode, and the bundle — once
extracted — evaluated, registered and materialized correctly in isolation with a
valid `apply`.

The cause: **no `inject` declaration**, so `ctx.slots` was `undefined` and
`apply()` threw on its first line. `dsh.client.inject` was missing from the
manifest too, and the plugin read `ctx.shortcuts` through a defensive
`(ctx as unknown as …).shortcuts` probe that silently gave up when the service
was absent — instead of failing loudly.

Four hypotheses were tested and discarded first, each by direct execution rather
than reasoning: the esbuild `__require` shim, the factory's return shape, the
React interop form, and the slot registration's `id`/`key`/`priority` fields.

**The lesson worth carrying:** the audit's one-line summary hides a state enum.
`…: failed` means the plugin's own `apply()` threw, which is a *completely
different* investigation from `import failed`. Decode the message before
theorising.

Two smaller bugs were fixed alongside:

- `order: 1000` → `priority: 1000`. The comment claimed the layer sat above the
  app's overlays; as written it was ignored and the layer sat at priority 0.
- `install-dsh.mjs` rebuilt the installed `package.json` by hand and dropped the
  new `inject` field. The installer now carries it across and asserts the bundle
  and the manifest agree before writing anything.

---

## 6. The empty host half is deliberate

`src/index.ts` is `export function apply() {}` and compiles to 57 bytes.

This is intentional, not incomplete. The host half is only ever `apply`ed in the
**main process**, which is asar-packed and read-only here; its real job in this
build is to be a valid ESM entry so the Loader row resolves and
`dsh-client-modules` finds the `dsh.client` declaration that admits the client
half to the browser roster. Every feature lives in the client half.

Do not add host-half logic expecting it to run in the renderer. It will not.

---

## 7. Known limits

**Detaching to a separate OS window does not work** through the plugin form.
`⤢` is deliberately inert and logs a warning. It needs a new `BrowserWindow` plus
an IPC channel, which requires main-process code — and the app is asar-packed, so
it cannot be patched in place. `desktop/` holds the main-process half for a build
that can patch the app. Everything else — picker, ancestor stepping, extraction,
floating panel, close-and-restore — works in-plugin.

**Verification is partial.** The plugin is proven to load, activate, register the
shortcut and contribute its panel layer. The picker has **not** been exercised by
a real click in the running app; `apply()` accepting the host context and the
shortcut resolving as `handled` are confirmed, the extraction UX is not.

**`app:verify` needs a debug port.** The shell does not expose
`--remote-debugging-port` by default, so `npm run app:debug` is a deliberate
extra step, not a normal launch.

---

## 8. Suggested next steps

1. **Trial the picker by hand.** Launch, press Ctrl+Shift+S, click an element,
   confirm the panel appears and the element survives inside it, then `✕` restores
   it. This is the only unverified surface.
2. **Harden the picker against the app's own overlays.** The plugin registers at
   `priority: 1000`, but that has never been tested against a real app overlay.
3. **Consider `dsh.client.external`.** If the plugin ever needs another
   `@deepseek-ai/*` package, it must be declared there so the host orders the row
   correctly. See the module-graph notes in
   `docs/host-client-modules-registry.txt`.
4. **Decide on `desktop/`.** Either finish the main-process detach against a
   writable build, or delete the directory and the `⤢` affordance with it.

---

## 9. Conventions in this codebase

Worth preserving — the existing code follows them consistently.

- **Comments explain why, not what.** Every non-obvious decision records the
  failure it prevents. Several comments name a concrete error message; those are
  the load-bearing ones.
- **Claims are verified by execution.** Reverse-engineering notes in `docs/` are
  dumps of real host source, not recollections. When a gate can test something,
  it does, and the negative case is tested too (`check:inject`).
- **Gates fail loudly.** Silent degradation is treated as the worst outcome: the
  `ctx.shortcuts === undefined` branch now *throws* rather than warning and
  continuing, because a plugin that does nothing is harder to diagnose than one
  that refuses to start.
- **ASCII straight quotes in code and config**; locale-appropriate quotes in prose.
