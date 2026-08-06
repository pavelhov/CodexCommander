# Client Apps design QA

## Comparison target

- Source visual truth: `<Codex image-generation output>/exec-ef014282-eb95-4ec9-baf9-588577fc4725.png`
- Rendered implementation: `http://127.0.0.1:4175/#integrations`
- Implementation screenshot: `<client-apps-worktree>/.tmp/client-apps-final-desktop.png`
- Full-view comparison: `<client-apps-worktree>/.tmp/client-apps-final-comparison.jpg`
- Focused workspace comparison: `<client-apps-worktree>/.tmp/client-apps-final-focus-comparison.jpg`
- Viewport: 1440 × 1024 CSS px, light/system theme
- Source pixels: 1487 × 1058; normalized to 1440 × 1024 for comparison
- Implementation pixels: 1440 × 1024 at 1× CSS density
- State: three ready providers; Codex App/CLI/SDK, Claude Code, and OpenCode configured; OpenCode selected; remaining detected clients in Available; proxy reachable; 22 models in the OpenCodex catalog; two proxy access keys
- Data: local visual-QA fixture only; no provider keys, account identifiers, or user configuration bytes were captured

## Evidence reviewed

The full-view comparison confirms the same core composition as the source: grouped sidebar navigation, provider → proxy → client relationship, two-column client/detail workspace, available-client grid, and the API Access banner. The focused comparison was required because row typography, icon fidelity, status vocabulary, and the OpenCode/OpenCode Go distinction are too small to judge reliably in the full view.

Additional responsive evidence:

- Tablet, 900 × 900: `<client-apps-worktree>/.tmp/client-apps-tablet.png`; one-column detail layout, no horizontal overflow (`scrollWidth === viewportWidth`)
- Mobile, 390 × 844: `<client-apps-worktree>/.tmp/client-apps-mobile.png`; mobile top bar, stacked flow, wrapped chips, single-column client rows, no clipped controls
- Short mobile drawer, 390 × 600: grouped navigation scrolls independently (`clientHeight 350`, `scrollHeight 547`, `overflow-y: auto`) while footer controls remain visible

Primary interactions tested in the in-app browser:

- “Set up a client” targets the Available section.
- Selecting Claude Code updates the detail panel to Claude Code.
- “Review changes” reveals the reversible change history.
- API Access opens `#integrations/keys`; “Back to Client Apps” returns to `#integrations`.
- Browser console errors checked after the interaction pass: none.

## Required fidelity surfaces

- Fonts and typography: uses the existing OpenCodex system font stack, weights, caption scale, and heading hierarchy. Long product labels wrap without clipping at tablet/mobile widths.
- Spacing and layout rhythm: desktop proportions and section order closely match the source. Tablet collapses the detail column below the catalog; mobile stacks the flow and actions cleanly.
- Colors and tokens: uses existing `--surface`, border, semantic green/amber/red, and focus tokens. No one-off palette was introduced.
- Image quality and asset fidelity: all product/provider marks come from the repository’s real provider icon assets or its existing icon library. No emoji, CSS art, inline SVG substitutes, or placeholder image boxes remain.
- Copy and content: names provider accounts, the proxy, client apps, and proxy access keys as separate concepts. “Applied” describes configuration evidence; the page does not invent health, idle, last-request, or per-client route facts.
- Accessibility and interaction: semantic buttons, lists, headings, switch labels, selected state, visible focus styles, disabled restore state, and responsive tap targets are present. Automated screen-reader and zoom testing remain outside this visual pass.

## Comparison history

### Pass 1 — blocked

- [P2] Large workspace surfaces used `--raised`, making the catalog and detail regions materially darker/heavier than the source.
- [P2] The initial fixture showed five configured clients, changing above-the-fold density relative to the selected three-client source state.
- [P2] The visual fixture did not serve `/provider-icons/*`, so several otherwise-correct repository assets rendered as broken images.
- [P2] The client labels “Codex CLI” and “Claude” obscured that the connection covers Codex App/CLI/SDK and Claude Code; the refresh action read “Update.”

Fixes made:

- Switched Client Apps workspace cards from `--raised` to `--surface`, retaining existing borders and semantic tokens.
- Normalized the fixture to the same three configured-client state as the source.
- Corrected the fixture’s static asset routing and recaptured with repository SVG assets visible.
- Added explicit Codex App/CLI/SDK and Claude Code labels and a Client Apps-specific “Refresh” translation in all six locales.

Post-fix evidence: `client-apps-final-comparison.jpg` and `client-apps-final-focus-comparison.jpg`.

### Pass 2 — passed

No actionable P0/P1/P2 visual or responsive findings remain.

Accepted intentional differences:

- The source mock’s “healthy,” “idle,” “last request,” and selected/default-route claims are replaced by verifiable provider/proxy/model readiness and applied configuration state. The runtime does not have evidence for those source claims.
- The implementation preserves the repository’s current sidebar shell, footer utilities, icon library, and button vocabulary instead of introducing image-only navigation artifacts from the generated concept.
- “View connection” replaces the mock’s “Test OpenCode” because the current management contract can inspect/configure a client but cannot prove live client traffic.

### Pass 3 — passed after frontier audit

Sol’s final audit found no P0/P1 issues and identified truthfulness and resilience gaps that were corrected before the final capture:

- Provider readiness now counts only providers that can actually route, including safe handling for keyless providers and excluding keyed providers with no key.
- Model and change-history failures render unavailable/stale states instead of looking like fresh empty data.
- Model counts explicitly say they belong to the shared OpenCodex catalog rather than implying per-client inventory.
- Cross-tier provider search suspends tab semantics while grouped results from all tiers are visible.
- Passive legacy redirects select the correct sidebar destination immediately, and grouped navigation scrolls on short screens.

The desktop source/implementation comparison, tablet capture, mobile capture, overflow measurements, interaction checks, and console check were repeated after these corrections. No browser console errors or actionable visual regressions remain.

### Convergence pass — passed

- Rechecked the merged workspace at 1440 × 1000 and 390 × 844 CSS px against an isolated proxy with real management routes.
- The overview keeps OpenCode navigation-only while the dedicated `#integrations/opencode` page owns apply, refresh, auto-connect, protected credential delivery, and OpenCode Go provider guidance.
- Desktop and mobile widths had no horizontal overflow (`scrollWidth === clientWidth`); opening a detail after scrolling now resets to its heading instead of inheriting the catalog position.
- All observed management requests returned successfully, and the final clean browser session produced no console warnings or errors.

## Findings

No actionable P0/P1/P2 findings remain.

## Follow-up polish

- [P3] A future runtime-level client probe could justify a real “Test connection” action, but it should not be simulated in the UI.
- [P3] Add automated 200% text-zoom and high-contrast snapshots when those test fixtures become available.

final result: passed
