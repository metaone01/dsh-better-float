# Desktop integration patch

`popout-manager.ts` in this folder is **not** part of the plugin package. It is a
patch for `apps/desktop/src`, and it has to be applied by hand because the
plugin's purity gate forbids it from reaching Electron directly.

This file is the exact sequence to apply, so the integration is a checklist
rather than an exploration.

---

## 1. Copy the file

```
apps/desktop/src/better-float/popout-manager.ts   ←  desktop/popout-manager.ts
```

Nothing in it imports from the plugin, so it can live wherever suits the
desktop app's own structure.

---

## 2. Install it once, after the primary window exists

In `apps/desktop/src/main.ts`, in the ready path, after `createWindow` has
produced the primary window:

```ts
import { ipcMain } from 'electron'
import { installPopoutManager, BETTER_FLOAT_IPC } from './better-float/popout-manager.ts'

let float: ReturnType<typeof installPopoutManager> | null = null

// ...after the primary window exists:
float = installPopoutManager({
  // The same preload the primary window uses. The popout needs the same
  // contextBridge surface, otherwise the client half cannot reach IPC.
  preload,
  // Must match the primary window's host, so the shared allow-list in
  // `assertDesktopSender` keeps covering every window.
  host: 'app',
  // The `/` path is the app shell. The query parameter is what makes the
  // document a popout — not a different host, which would change the origin.
  documentUrl: 'dsh-app://app/',
  primary: () => primaryWindow,
})
float.registerIpc(ipcMain)
```

On shutdown, alongside the existing teardown:

```ts
app.on('will-quit', () => {
  float?.dispose()
})
```

---

## 3. Let popout documents through

The scheme handler that serves `dsh-app://` must serve the same document for the
popout URL. Nothing else is needed: it is the same origin, the same bundle and
the same roster, and the client half reads `?dsh-popout=<id>` to know which
panel it hosts.

Two things **not** to do, both of which look reasonable and break things:

- **Do not add `dsh-app://popout/` as a second host.** A custom scheme's origin
  is `scheme://host`, so a second host is a second origin. That severs
  `BroadcastChannel`, `localStorage`, cross-window drag-and-drop and
  `adoptNode` in one step, and widens the `assertDesktopSender` allow-list for
  no benefit.
- **Do not set `webPreferences.affinity` on the primary window.** It would share
  a renderer process between the app and every panel, so a crashing panel takes
  the application with it. The plan's D7 has the full argument; the short
  version is that the fidelity it buys is already discounted by `moveBefore`
  failing across documents anyway.

---

## 4. Expose the bridge to the renderer

The client half looks for `globalThis.dshDesktop.invoke`. If the preload already
exposes a product API object, add the six channels to it; the client half's
`CHANNELS` in `src/detach/transport.ts` lists the names.

```ts
contextBridge.exposeInMainWorld('dshDesktop', {
  invoke: (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args),
  // ...existing surface
})
```

If no bridge is exposed the plugin still works — it degrades to in-app floating
only, and the detach button reports why.

---

## 5. Verify

After integrating, these are the checks worth running, in order. Each has a
specific failure it catches.

| Check | What it catches |
|---|---|
| Press `primary+shift+S`, pick an element, panel appears, interactions work | the shortcut registered, and the live move kept the framework's handlers alive |
| Close the panel; the original slot is filled again | the restore path ran and the placeholder was released |
| Pick an element inside a modal, close the modal while the panel is open | the stand-in held, and the panel closed instead of orphaning |
| Press the detach button | the window opened on the same origin rather than about:blank |
| In the popout, check `BroadcastChannel` still delivers | the popout kept the primary window's host |
| Enable click-through, then press `Ctrl/Cmd+Shift+Alt+P` | the rescue shortcut is registered and restores interactivity |
| Quit the app with panels open | `dispose` unregistered the global shortcuts rather than leaving them grabbed |

---

## Known limitations to tell the user about

- A panel detached to a window is a **snapshot**, not a live view. Cross-process
  DOM transfer is not possible; the receiving window rebuilds from a
  description.
- Iframes reload, animation restarts, and focus is lost when an element moves to
  a separate window, because `moveBefore` cannot cross documents.
- Click-through is off by default. When on, the window cannot be clicked at all,
  which is why the global rescue shortcut exists.
