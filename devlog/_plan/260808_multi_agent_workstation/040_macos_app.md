# 040 — Self-contained macOS runtime

Status: implementation checkpoint
Date: 2026-08-08
Owner: WS-04

## Decision

The first self-contained release keeps the existing Bun-plus-source runtime model. The
application bundle now carries a package-shaped runtime at
`Contents/Resources/runtime/`:

- `package.json` and `bun.lock` for version and provenance;
- `src/` and `bin/` for the OpenCodex CLI and proxy;
- the lockfile-resolved `node_modules/` tree, including the Darwin Bun binary and native
  optional dependencies; and
- `gui/dist/` for the dashboard and provider assets.

The native companion resolves this runtime for installed Applications before fixed global
npm/Bun locations. Source builds at `dist/macos/OpenCodex.app` deliberately resolve the live
checkout first as a development fallback; ambient `PATH` is still ignored by lifecycle discovery.

Universal builds resolve lockfile-pinned production dependencies for both Darwin architectures
in one isolated, script-disabled staging install (network access may be required at build time;
the app never installs or fetches on first launch). The arm64 and x86_64 Bun executables are
combined with `lipo`, both Darwin keyring N-API packages are retained, and duplicate source
slices are removed. The release archive therefore does not label a host-only Bun binary as
universal.

## Why Bun-plus-source first

The standalone `bun build --compile` spike bundled 769 modules but failed `--version` because
package metadata was read from a `$bunfs`-relative `import.meta.url`. The runtime also contains
dynamic CLI subprocess paths and Worker URLs. Keeping the package layout avoids rewriting those
paths before a clean app release; a future compiled helper can introduce a runtime invocation
abstraction and explicit worker/resource handling as a separate unit.

## Verification

- `swift run --package-path app MenuBarCoreTests` — 87 passed, including released-bundle
  discovery with a sanitized environment and a working directory outside the repository.
- The macOS build-script test now checks package metadata, CLI source, Bun, GUI assets, and
  invokes the bundled Bun/CLI `--version` from an external temporary directory.
- The release packager asserts the runtime payload and archive entries in addition to the native
  executable and signature structure.
- An unpacked universal archive ran `--version` and imported the native keyring module under both
  arm64 and x86_64/Rosetta with a sanitized environment and no global Bun/npm paths.
- With isolated `HOME`, `OPENCODEX_HOME`, and `CODEX_HOME`, the bundled lifecycle helper started
  a proxy on port 19137, passed `/healthz` and status checks, stopped it, and left no listener.

`bun run build:macos` passed on this macOS host (arm64 development build). `bun run
package:macos` passed with the universal Swift executable, universal Bun runtime, both keyring
slices, archive assertions, and ad-hoc signature verification. The resulting app bundle was
approximately 102 MB for the arm64 development bundle and 166 MB unpacked (61 MB ZIP) for
the universal release after duplicate Bun slice packages were removed. No signing credentials,
notarization, publishing, or App Store submission is part of this checkpoint. The packager
exposes `distribution_ready=false` for this ad-hoc/test artifact; a public release attachment
requires a verified Developer ID Application identity, Gatekeeper acceptance, and
`xcrun stapler validate`. Nested Bun/keyring/main executables are signed and verified before
the outer bundle instead of relying on implicit deep signing.

The docs site also built successfully with `bun --bun run build`. The machine's default Node
22.8 executable is below Astro's Node 22.12 minimum and exits before compilation; that local
toolchain mismatch is separate from the successful Bun-hosted docs build.

## Remaining gates

- A clean macOS user/VM gate still needs provider OAuth, storage-worker paths, Codex restore,
  launchd service repair/replacement, reboot/login-item behavior, and quarantine testing.
- Developer ID signing, hardened-runtime entitlement review, notarization, stapling, DMG/ZIP
  quarantine testing, and an app-aware update/rollback channel remain WS-05 work.
- `ocx update` and the GUI update check classify a bundled runtime as `app`; they never query npm,
  run a source update, or mutate signed `Contents/Resources`. Installing a newer signed app is
  the only supported update path until the app updater/rollback channel exists.
- A future compiled-helper experiment must replace package-file metadata reads, classify the
  app installer separately from npm/source updates, and verify dynamic workers and nested
  native modules on both architectures.
