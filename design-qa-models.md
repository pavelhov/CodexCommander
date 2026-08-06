# Models redesign QA

## Evidence

- Visual source: `<Codex image-generation output>/exec-d9d59c99-9a68-415c-b930-4351f490cedb.png`
- Final implementation screenshot: `<workspace>/.tmp/design-qa/models-main-final.png`
- Full side-by-side comparison: `<workspace>/.tmp/design-qa/models-comparison-final.png`
- Current-behavior comparison: `<workspace>/.tmp/design-qa/models-behavior-comparison-final.png`
- Catalog-table comparison: `<workspace>/.tmp/design-qa/models-table-comparison-final.png`
- Responsive evidence:
  - `<workspace>/.tmp/design-qa/models-responsive-1024-final.png`
  - `<workspace>/.tmp/design-qa/models-responsive-768-final.png`
  - `<workspace>/.tmp/design-qa/models-responsive-600-rows-final.png`
  - `<workspace>/.tmp/design-qa/models-responsive-600-editor-final.png`

## Capture contract

- Source frame: 1487 × 1058 CSS pixels.
- Implementation frame: 1719 × 1058 CSS pixels with the persistent 232 px app sidebar cropped, yielding the same 1487 × 1058 comparison frame.
- Density: 1×.
- State: English, system/light theme, 22/22 visible, Classic v1, Uncapped, no combos configured, all provider groups collapsed.
- Data source: the authenticated local proxy at `http://127.0.0.1:10100/#models`, using its real OpenAI, Kimi, and xAI catalog.

## Pass history

1. Initial implementation matched the selected information architecture but the main frame was too narrow and vertically dense. Increased the Models workspace maximum width, top spacing, behavior-card height, search height, provider-row height, and rail-row height.
2. Side-by-side review found that context status chips performed immediate writes despite looking passive. Converted row chips to read-only status, moved explicit per-provider actions into the Context editor, staged shared context changes, and added one atomic Apply operation.
3. Reviewer verification found collapsed search matches and delayed collaboration-mode feedback. Active search now auto-expands matching groups, and the mode PUT response updates the summary immediately.
4. Final visual and interaction pass restored the Combos empty/setup state, retained the exact-ID/cache behavior note, added native radio keyboard behavior, associated cell labels for assistive technology, and removed the extra focusable Advanced tooltip control.

## Final comparison findings

- Layout and hierarchy: passed. Provider rail, Current behavior summary, catalog toolbar, table hierarchy, and Advanced disclosure match the selected direction.
- Typography: passed. The implementation is intentionally denser than the concept image because it uses the existing OpenCodex type and control tokens; this is a P3 fidelity delta, not a readability defect.
- Spacing and surfaces: passed. No overlap, clipping, broken wrapping, or unintended card treatment at the tested widths.
- Color and state: passed. Uncapped/full-context states use the existing green semantic tokens; mixed/capped states use amber; disabled and selected controls remain distinguishable.
- Icons and assets: passed. Existing product icon components are used consistently; no placeholder, CSS-art, custom-SVG, or fake imagery shortcuts were introduced.
- Copy: passed. Classic v1, Automatic, Concurrent v2, Uncapped, Limited, and Mixed limits are explicit. The page also preserves exact-ID and next-turn behavior that the concept omitted.
- Intentional functional additions versus the concept: OpenAI native badge, custom-model `+` actions, Combos setup strip, and operational catalog notes remain because they are existing product capabilities.

## Interaction and accessibility checks

- Collaboration and Context editors open and close correctly.
- Collaboration choices are native radios with arrow-key semantics and visible focus treatment.
- Context choices stage locally; changing the radio or cap selector sends no write until Apply.
- Apply is disabled for an unchanged policy and uses one atomic `value + setAll` request when a shared limit changes.
- Provider context chips are read-only; explicit Limit/Use full context actions live in Provider overrides.
- Search filters providers/models and auto-expands matching collapsed groups.
- Collapse all, Expand all, provider disclosure, Combos setup, and Advanced/Shadow Call controls remain reachable.
- Column values carry assistive labels even though the visual header is presentational.
- Narrow layouts checked at 1024, 768, and 600 CSS px; the 600 px Context editor uses full-width 44 px Apply/override targets.
- Browser console after the final interaction pass: no warnings or errors.

## Convergence verification

- Rechecked against the merged Client Apps/provider architecture on the isolated proxy, at 1440 × 1000 and 390 × 844 CSS px.
- A registry-local LM Studio provider appeared with `Auto-discovery on`; its link opened the exact Provider Settings surface with both live discovery and local/private-network access enabled.
- Collaboration remained explicit (`Classic v1`, `Automatic`, `Concurrent v2`), and the context summary remained explicit (`Uncapped` versus an applied routed-provider limit).
- Mobile width stayed exact (`scrollWidth === clientWidth === 390`), and the final clean browser session produced no console warnings or errors.

## Remaining severity

- P0: none.
- P1: none.
- P2: none.
- P3: concept art uses larger typography and roomier provider rows than the established product tokens.

final result: passed
