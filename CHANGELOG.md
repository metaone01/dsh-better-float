# Changelog

## 0.1.1 — 2026-10-15

- Publish as `@metaone01/dsh-better-float`, with matching DSH and browser module registration.

- Ship prebuilt Host, client and optional companion files in the npm package, including the required `cordis.patch.yml`.
- Build before packaging, without install-time `prepare` scripts or bundled Electron/React runtimes.
- Add MIT licensing and complete npm package metadata.
- Rewrite Chinese and English onboarding, troubleshooting and preview documentation.
- Label external window extraction as **Preview / 预览** in the UI and documentation; this feature needs additional setup and supports limited adapters.
- Move historical handoff, testing and design notes to `docs/history/`; keep generated packages and runtime output out of Git.

This release preparation does not certify all DSH versions, operating systems or external window scenarios. See the preview guide for current limits.
