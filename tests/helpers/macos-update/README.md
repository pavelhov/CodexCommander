# Installed macOS updater qualification

This opt-in harness drives real AppKit buttons on the production AppDelegate and
real Sparkle downloader/installer. It invokes the bundled production lifecycle
helper and observes actual old→new bundle replacement and relaunch. It does not
mock installer acknowledgements. Normal CI skips the installed test.

Requires a macOS graphical login, full Xcode, Bun/Python 3, the pinned Sparkle
2.9.6 signing tools, and disposable matching Ed25519 trust material. The x86_64
case on Apple Silicon requires Rosetta. Do not point this harness at a live app.

1. In a **clean dedicated clone**, run `scripts/package-macos-release.sh` with
   `MACOS_BUILD_NUMBER=201`, `MACOS_PREVIOUS_BUILD_NUMBER=200`,
   `MACOS_UPDATE_PUBLIC_KEY_FILE` pointing to the disposable public key, and
   `RELEASE_OUTPUT_DIR` pointing to ignored scratch space. Retain the original
   archive/checksum, then extract with `ditto -x -k ARCHIVE SCRATCH/canonical-unpacked`.
2. Apply `fixture-source.patch` in that clone and build the universal executable:
   `swift build --disable-automatic-resolution -Xlinker -rpath -Xlinker @executable_path/../Frameworks --package-path app -c release --product CodexCommanderMenuBar --arch arm64 --arch x86_64`.
   Copy `app/.build/apple/Products/Release/CodexCommanderMenuBar` to
   `SCRATCH/driver-binary`, then restore the two changed clone files.
3. Export absolute `CCX_QUALIFICATION_WORKSPACE=SCRATCH`,
   `CCX_QUALIFICATION_SOURCE_APP=SCRATCH/canonical-unpacked/CodexCommander.app`,
   `CCX_QUALIFICATION_SIGNER=/path/to/pinned/bin/sign_update`, and
   `CCX_QUALIFICATION_PRIVATE_KEY=/private/scratch/key` (outside asset directories).
   Run `python3 tests/helpers/macos-update/fixture.py native arm64`.
   Modes are `stopped`, `native`, `owned`; architectures are `arm64`, `x86_64`.
   An optional third argument selects `success` (default), `supervised`,
   `supervised-cancel`, `independent`, `latest-off`, `cancel`, `cold-restart`,
   `download-failure`, `signature-failure`, `active-later`, or `active-anyway`.
   Active cases use an isolated custom provider and synthetic request; no real
   upstream or user credential is used.
4. Set `CCX_MACOS_UPDATE_FIXTURE` to the printed fixture directory and run
   `bun test tests/e2e-style/macos-update.test.ts`. Inspect its `steps.json`,
   `driver.log`, server log and CPU sample headers. Each execution needs a fresh
   source fixture, since a successful test installs the next integer build in place.

The fixture changes bundle ID, feed URL, ATS localhost permissions, root metadata,
entry driver, and the runtime's service label in **both** versions. Its fixture-only service
plist template explicitly supplies the same HOME and TMPDIR, since launchd does
not inherit the helper's isolated environment automatically. The entry
sets isolated HOME/CODEX_HOME/CODEXCOMMANDER_HOME/TMPDIR on relaunch and supplies an
explicit fixture path to the existing MenuAppInstanceLock.acquire(at:) API:
Foundation's temporaryDirectory may ignore TMPDIR. Unique bundle IDs isolate
CFPreferences even when HOME does not redirect its storage.

The patch adds only bounded trace lines to three real AppUpdater delegate
callbacks; all conditions and return values are preserved. The entry sends
existing AppDelegate actions and clicks real NSButtons. It never replaces
AppDelegate termination, UpdateController, helper, or Sparkle behavior.

Both versions have the same application code and differing integer build metadata.
The builder reads the source build from its plist and chooses source + 1 as target.
This proves update plumbing and semantic recovery, not a behavior difference
between two feature revisions. Ad-hoc fixture signatures do not qualify Developer
ID/notarization. The original unmodified archive remains the bundle-integrity
artifact; fixture changes must not be represented as canonical archive proof.

The runner stops only the fixture runtime, terminates processes matching its
unique installed path, and stops its localhost server. It verifies zero surviving fixture processes and
an absent namespaced launchd job; failed cleanup fails the test. Retain finite evidence;
remove generated fixture apps/state and disposable keys after investigation.
