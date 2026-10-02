/**
 * Host companion half.
 *
 * The bundle roster loads the package on the host as well as in the browser, so
 * this export must exist and must be inert: everything this plugin does happens
 * in the renderer, and the desktop-side window management is a patch to
 * `apps/desktop` rather than a host service. See `desktop/` for those files.
 */

/** No host-side behaviour. Present so the roster entry loads cleanly. */
export function apply(): void {}
