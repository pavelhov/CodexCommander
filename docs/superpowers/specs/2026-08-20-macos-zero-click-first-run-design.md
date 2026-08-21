# macOS Zero-Click First-Run Bootstrap

## Summary

The packaged macOS app currently contains the complete CodexCommander runtime but
cannot start on a fresh Mac when `~/.codexcommander/config.json` is absent. A direct
app launch performs an explicit Start, which first persists the desired Codex routing
state. The existing field-scoped mutator deliberately refuses to create a missing
configuration file, so Start stops with:

> Codex routing could not be enabled: No config file exists to record the switch in.

The macOS app will gain a direct-launch-only bootstrap step. It will create the existing
secret-free `getDefaultConfig()` through exclusive final-entry creation when, and only when,
the CodexCommander configuration is genuinely absent. It will not run the interactive CLI
wizard, write credentials, overwrite existing configuration, create Codex-owned configuration,
or move the application.

## Goals

- Make first launch zero-click when Codex is already initialized.
- Start the proxy and route Codex through the existing default ChatGPT passthrough
  provider without requiring terminal access.
- Keep the dashboard available when Codex itself has not initialized its configuration.
- Preserve every existing valid CodexCommander configuration byte-for-byte during
  bootstrap admission.
- Refuse malformed, unreadable, unsafe, or conflicting configuration instead of
  replacing it with defaults.
- Preserve existing CLI, passive-launch, external-provider, routing-recovery, and
  lifecycle-authority semantics.
- Treat an app outside Applications as usable for the current session, while keeping
  Launch at Login unavailable until the user moves it.

## Non-goals

- Reimplement the interactive `ccx init` wizard in Swift.
- Prompt for, generate, import, or copy API keys, OAuth credentials, account state, or
  provider-specific configuration.
- Create or repair `$CODEX_HOME/config.toml`.
- Automatically move, copy, or relaunch `CodexCommander.app`.
- Change ordinary `ccx start`, `ccx ensure`, `setIntegrationEnabled()`, or passive
  companion launch behavior.
- Add a persistent first-run marker or a background file watcher.

## Product decisions

1. First launch is zero-click when the required Codex state already exists.
2. Missing Codex-owned configuration is a recoverable prerequisite, not permission to
   manufacture another application's file.
3. An app launched from Desktop or Downloads may run for the current session but does
   not register as a Login Item.
4. An app running from `/AppTranslocation/` must not start a detached proxy from an
   ephemeral runtime path. It asks the user to move the app and reopen it.
5. The TypeScript runtime remains the sole owner of the configuration schema and fresh
   defaults. Swift receives structured outcomes only.

## Existing invariants to preserve

- `getDefaultConfig()` is the canonical fresh configuration. It currently selects the
  no-secret OpenAI/ChatGPT passthrough provider.
- `mutatePersistedConfig()` and `setIntegrationEnabled()` fail closed on a missing or
  malformed file. Their contracts remain unchanged.
- Explicit Start is the operation that may turn a prior native/OFF decision back on.
- External user-managed Codex providers are preserved.
- Lifecycle and configuration mutations remain serialized by their existing authorities.
- CodexCommander never silently overwrites malformed or untrusted configuration.
- The native lifecycle bridge emits one bounded, secret-free JSON frame.

## Architecture

### 1. Configuration initializer

Add a narrow primitive to `src/config.ts` that initializes a supplied, schema-valid
configuration only if the persisted file is genuinely absent.

The initializer returns a discriminated result:

- `created` — final-entry creation succeeded exclusively with owner-only requested permissions,
  and descriptor writing and flushing completed before the result was reported.
- `existing` — a valid configuration appeared before the commit or already existed.
- `refused` — a file or filesystem object exists but is invalid, unreadable, unsafe, or
  otherwise cannot be admitted.

The primitive owns:

- the existing configuration mutation lock;
- an under-lock re-read immediately before committing;
- schema validation of the candidate;
- direct exclusive creation of the final `config.json` entry with `wx`, owner-only
  permissions, descriptor-based writing, and a descriptor flush before success;
- state-directory permissions and existing ownership metadata behavior; and
- stable, non-secret refusal reason codes.

The candidate is trusted in-process data produced by the app bootstrap policy. Validation
still proves schema correctness, but the initializer is not an isolation boundary against
hostile getters, serialization methods, or an active same-user filesystem process. Under the
configuration mutation transaction it probes the final entry, opens that final entry directly
with exclusive-create semantics, and never overwrites. If exclusive creation reports `EEXIST`,
it re-probes once and adopts only a complete valid ordinary single-link configuration.
Persisted bytes are the pretty-printed schema-validated configuration, including its
schema-produced property order, rather than the raw candidate object's literal property order.
The final entry may be transiently visible as empty or partial between exclusive creation and
the completed descriptor write and flush. The initializer does not report `created` until those
operations finish. An incomplete preflight read in an already owned root is not adopted or
rejected before coordination; cooperating initializers recheck under the mutation coordination,
and that under-lock probe is authoritative.

It does not import macOS, lifecycle, provider-selection, or Codex-path logic. It does
not change `mutatePersistedConfig()`.

### 2. macOS bootstrap policy

Add a TypeScript policy in the macOS/lifecycle layer. The policy classifies Codex's
configuration path as absent or not absent using the established effective Codex home.
Only an actual missing-path result counts as absent; a directory, unsafe link,
permission error, or other filesystem failure is left for existing routing admission
to reject.

The candidate is always a clone of `getDefaultConfig()`:

- When Codex configuration is present, persist the clone unchanged.
- When Codex configuration is absent, add
  `clientIntegrations.codex = false` before persistence.

The `false` value belongs to CodexCommander's own configuration and prevents a fresh
proxy from attempting Codex catalog injection before Codex has created its files.
No credential-bearing input participates in bootstrap.

### 3. Lifecycle orchestration

Only direct macOS app Start receives bootstrap authority. The orchestration enters the
existing lifecycle authority, performs the app bootstrap under the configuration lock,
and then continues without releasing lifecycle authority.

- A present Codex configuration follows the existing explicit Start transaction.
- A newly bootstrapped configuration with Codex integration off starts or attaches to
  the proxy without enabling Codex routing.
- An existing valid CodexCommander configuration paired with absent Codex
  configuration remains byte-for-byte untouched by bootstrap. Existing Start behavior
  may bring up the proxy and encounter the expected missing-Codex sync refusal; when
  the proxy is proven running, orchestration reports `codex-first-run` rather than
  claiming that routing succeeded or flattening the prerequisite into a generic error.
- A refused bootstrap returns a structured configuration error without attempting to
  replace the file.
- A concurrently created valid configuration is adopted and processed through the
  existing Start behavior.

The returned action remains `start`, even when the fresh-Codex-missing branch performs
only the proxy portion of Start. This keeps the native bridge contract aligned with the
user action.

Ordinary CLI Start, Ensure, passive companion launches, Restore, Stop, and routing
toggles do not receive this bootstrap hook.

### 4. Native lifecycle bridge

Extend the bounded lifecycle JSON result with an optional structured setup requirement.
The initial recognized value is `codex-first-run`.

The field is additive and secret-free. Swift must tolerate:

- the field being absent when talking to older helpers;
- the recognized value; and
- unknown future values without rejecting the entire lifecycle result.

The Swift action coordinator maps a running result with `codex-first-run` to a dedicated
setup-required outcome instead of treating it as `START_FAILED`.

### 5. Native UI

When setup is required, the menu shows a persistent, nonfatal card:

- The proxy is described as running.
- The explanation says Codex has not created its local configuration yet.
- The user is told to open Codex once, then use the existing **Route Codex Through
  Proxy** operation.
- Dashboard, Logs, Refresh, provider management, and proxy-stop controls remain usable.
- The app does not open the dashboard, launch Codex, retry in the background, or dismiss
  the card on a timer.

The existing route operation is the only retry path. Once Codex configuration exists,
it turns integration back on and performs the normal identity-attested live sync.

### 6. Launch at Login presentation

An app outside `/Applications`, `~/Applications`, or the repository's supported source
build path receives a distinct relocation-required presentation:

- Proxy startup remains enabled for a physical Desktop/Downloads bundle.
- The Launch at Login toggle is disabled.
- The row says Launch at Login is available after moving the app to Applications.
- A non-destructive action opens the Applications folder in Finder.
- The condition is not styled or reported as a proxy/lifecycle failure.

An `/AppTranslocation/` bundle is different: detached startup is blocked because the
embedded runtime path is ephemeral. The app asks the user to move it to Applications
and reopen it.

## Startup state matrix

### Missing CodexCommander config, Codex ready

1. Create the canonical default through exclusive final-entry creation and descriptor flush.
2. Execute normal explicit Start.
3. Start or attach to the proxy.
4. Synchronize the model catalog.
5. Route Codex through the attested proxy.

Expected outcome: running and ready with no first-run prompt.

### Missing CodexCommander config, Codex not initialized

1. Create the canonical default with `clientIntegrations.codex = false`.
2. Start or attach to the proxy without changing Codex routing.
3. Return `setupRequired: "codex-first-run"`.
4. Keep the dashboard and menu controls available.

Expected outcome: proxy running, Codex native, actionable setup card visible.

### Existing valid CodexCommander config

Do not bootstrap, merge, backfill, or rewrite it. Continue through existing lifecycle
behavior, including preservation of external Codex providers and explicit Start's
current routing semantics. If Codex configuration is absent but the proxy is proven
running, report the structured Codex first-run requirement and keep the dashboard
available. Do not claim that Codex routing succeeded.

### Existing invalid or unsafe CodexCommander config

Refuse bootstrap and leave the bytes or filesystem object untouched. Return a stable
configuration-repair result. Do not silently run on transient defaults.

### Competing first launch or configuration edit

Re-read under the configuration mutation lock. If a valid file now exists, adopt it.
If an invalid object now exists, refuse it. Never overwrite the winner.

## Race behavior

- If Codex creates its configuration after bootstrap classified it as absent, the
  proxy remains native until the explicit route retry. This is a safe false negative.
- If Codex configuration disappears after being classified as present, existing
  routing admission fails closed.
- If CodexCommander configuration disappears after bootstrap but before routing intent
  is saved, the existing field-scoped mutation refusal remains authoritative.
- If another process creates CodexCommander configuration between the initial read and
  exclusive creation, the one post-`EEXIST` probe adopts a complete valid ordinary file or
  refuses the observed state instead of replacing it.
- No retry loop recreates a file that vanished during an admitted mutation.
- Active same-user mutation after the coordinated probe is outside this initializer's trust
  boundary. Such a process already has authority to alter the resulting file immediately after
  initialization; this bootstrap does not add descriptor-relative or pathname-swap defenses for it.

## Error handling

User-visible errors use stable classifications rather than parsing raw exception text:

- configuration needs repair;
- configuration is inaccessible;
- Codex first-run setup is required;
- app must be moved and reopened because it is translocated; and
- ordinary lifecycle or routing failure.

Messages do not include credentials, raw configuration, account identities, request
content, or private filesystem paths. Existing Logs and diagnostics remain the detailed
troubleshooting surfaces.

## Security and privacy

- The bootstrap candidate comes only from checked-in runtime defaults.
- The default contains no API key or OAuth credential.
- Existing configuration is never used as a stale base for a replacement write.
- Bootstrap uses the existing mutation lock and ownership metadata, then creates the final file
  directly with `wx`, mode `0600`, descriptor-based writing, and a flush before success.
- Missing, invalid, unreadable, and conflicting states remain distinct.
- The same-user active-filesystem-adversary case is explicitly out of scope; static symlinks,
  nonregular entries, hard links, linked roots, inaccessible state, and unowned roots are still
  refused before creation.
- External Codex routes and recovery journals stay under existing ownership checks.
- The native bridge remains bounded and secret-free.
- No new telemetry, logs, or persistent onboarding identifiers are introduced.

## Distribution behavior

The feature does not make the development app a universal release artifact. Public
distribution must continue using the release packaging path, which preserves bundle
metadata and produces the requested architecture slices. The documented Control-click
Open/Gatekeeper behavior for an ad-hoc, unnotarized preview remains unchanged.

The app must not treat copying provider or credential state from another Mac as part of
first-run bootstrap.

## Testing

### Configuration unit tests

- Missing file creates the exact validated candidate.
- Existing valid file is unchanged byte-for-byte.
- Invalid JSON and schema-invalid files are refused unchanged.
- A directory, unreadable object, unsafe link, or ownership failure is refused.
- An `EEXIST` winner is re-probed once: a complete valid ordinary single-link file is adopted,
  while an invalid or unsafe winner is refused.
- A transient incomplete preflight in an already owned root is rechecked under the mutation
  transaction before it can be classified as invalid.
- Two coordinated CodexCommander processes produce exactly one `created` and one `existing`,
  with canonical bytes and a final single-link file.
- The state directory and file retain the existing hardened permissions/ownership
  behavior.
- Candidate schema validation occurs before persistence.

### Lifecycle tests

- Missing app config plus present Codex config bootstraps and runs explicit Start.
- Missing app config plus absent Codex config bootstraps with integration off and starts
  the proxy without routing.
- Existing valid config bypasses bootstrap.
- Existing valid app config plus absent Codex config remains unchanged by bootstrap and
  reports setup required only when the proxy is proven running.
- Existing explicit OFF intent is not changed by the bootstrap initializer.
- Existing external Codex routing remains preserved.
- Refused bootstrap does not spawn or attach to a proxy through transient defaults.
- Already-running, current-home proxy behavior remains identity-attested.
- Codex appearance/disappearance races produce the documented safe outcomes.
- Ordinary CLI Start and `setIntegrationEnabled()` still refuse a missing config.

### Bridge and Swift tests

- Lifecycle JSON remains under its byte bound.
- Results without `setupRequired` decode as before.
- `codex-first-run` maps to a dedicated setup outcome.
- Unknown setup values do not invalidate the full result.
- The setup card leaves dashboard and proxy controls enabled.
- Route retry uses the existing route operation.
- Physical non-Applications paths show neutral relocation guidance.
- Translocated paths block detached startup and show move-and-reopen guidance.

### End-to-end verification

Use temporary CodexCommander and Codex homes; never exercise the developer's real home.
Verify a fresh-home packaged app flow with Codex present and absent without contacting a
real provider. Run:

- focused Bun configuration and lifecycle tests;
- focused Swift core and UI tests;
- `bun run typecheck`;
- `bun run test:parallel` with serial fallback if required;
- `bun run privacy:scan`;
- `bun run test:macos`; and
- `bun run build:macos`.

## Documentation changes

Update the macOS menu-bar guide and installation/quickstart documentation to state:

- a fresh direct app launch creates the secret-free default automatically;
- Codex must initialize its own configuration before routing;
- the app does not copy providers or credentials from another Mac;
- Desktop/Downloads launches work for the current session but not Launch at Login;
- translocated apps must be moved and reopened; and
- the universal release archive remains the supported distribution artifact.

## Acceptance criteria

1. Copying a supported packaged app to a fresh Apple-silicon or Intel Mac and launching
   it from Applications no longer produces the missing CodexCommander configuration
   error.
2. With Codex already initialized, the first app launch reaches the same running,
   synchronized, routed state as an explicitly configured default installation.
3. Without Codex configuration, the proxy and dashboard run, Codex remains native, and
   the menu presents an accurate retry action.
4. No existing valid, invalid, unreadable, unsafe, external-provider, or explicitly OFF
   configuration is replaced by bootstrap defaults.
5. CLI and passive-launch behavior remain backward compatible.
6. An app outside Applications is not misreported as a proxy failure, and an
   AppTranslocation runtime is not used for detached startup.
7. All focused and repository-required verification commands pass.
