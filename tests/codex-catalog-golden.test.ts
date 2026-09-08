import { describe, expect, test } from "bun:test";
import { buildCatalogEntries } from "../src/codex/catalog";

// Behavior-preservation ORACLE for the future codex-catalog.ts split (implementation contract).
// buildCatalogEntries is the pure core (no fs/network). This snapshots its full serialized
// output for a fixed input set so a later build/discovery/persistence split can prove it did
// not change the injected catalog. If this snapshot changes, the split changed behavior.

function template(): Record<string, unknown> {
  return {
    slug: "gpt-5.5",
    display_name: "gpt-5.5",
    description: "Native GPT model",
    priority: 1,
    visibility: "list",
    base_instructions: "You are Codex, an agent based on GPT-5.\nUse tools carefully.",
    model_messages: { instructions_template: "You are Codex, an agent based on GPT-5." },
    tool_mode: "code",
    use_responses_lite: true,
    supports_websockets: true,
    web_search_tool_type: "text_and_image",
    supports_search_tool: true,
    service_tier: "fast",
    service_tiers: [{ id: "fast" }],
    supported_reasoning_levels: [
      { effort: "low", description: "native low" },
      { effort: "high", description: "native high" },
    ],
  };
}

describe("codex-catalog golden (pure buildCatalogEntries oracle)", () => {
  test("native + routed build is stable for a fixed input set", () => {
    const goModels = [
      { id: "claude-opus-4.6", provider: "kiro", owned_by: "kiro" },
      { id: "glm-5.2", provider: "opencode-go", owned_by: "opencode" },
    ] as unknown as Parameters<typeof buildCatalogEntries>[2];

    const entries = buildCatalogEntries(
      template() as unknown as Parameters<typeof buildCatalogEntries>[0],
      ["gpt-5.5", "gpt-5.4"],
      goModels,
      ["gpt-5.5", "kiro/claude-opus-4.6"],
      false,
    );

    // Stable projection: the fields that define the injected catalog's identity/ordering/shape.
    const projection = entries.map(e => {
      const r = e as Record<string, unknown>;
      return {
        slug: r.slug,
        priority: r.priority,
        description: r.description,
        base_instructions: r.base_instructions,
        supports_websockets: r.supports_websockets ?? null,
      };
    });

    // Routed entries are identity-neutralized; native gpt slugs keep the GPT-5 line.
    const bySlug = Object.fromEntries(projection.map(p => [p.slug, p]));
    expect(typeof (bySlug["gpt-5.5"] as Record<string, unknown>).base_instructions).toBe("string");
    expect((bySlug["gpt-5.5"] as { base_instructions: string }).base_instructions).toContain("based on GPT-5");
    const routed = bySlug["kiro/claude-opus-4.6"] as { base_instructions: string } | undefined;
    expect(routed).toBeDefined();
    expect(routed!.base_instructions).not.toContain("based on GPT-5");

    // Featured ordering: featured slugs get the lowest priorities (0,1).
    expect((bySlug["gpt-5.5"] as { priority: number }).priority).toBe(0);
    expect((bySlug["kiro/claude-opus-4.6"] as { priority: number }).priority).toBe(1);

    // ws opt-out: supports_websockets stripped when wsEnabled=false.
    for (const p of projection) expect(p.supports_websockets).toBeNull();

    // Full structural snapshot (the oracle): exact slug set + priority + ws projection.
    expect(projection.map(p => `${p.slug}@${p.priority}`).sort()).toEqual([
      "gpt-5.4@102",
      "gpt-5.5@0",
      "kiro/claude-opus-4.6@1",
      "opencode-go/glm-5.2@5",
    ]);
  });
});

import nativeSource from "./fixtures/catalog/native-codex-2026-09-08.json";
import { mergeCatalogEntriesForSync } from "../src/codex/catalog/sync";
import { ensureStrictCatalogFields } from "../src/codex/catalog/parsing";

const nativeBehaviorFields = nativeSource.source.extracted_fields.filter(key =>
  !["slug", "display_name", "supports_websockets", "prefer_websockets"].includes(key));
function behavior(entry: Record<string, unknown>) {
  return Object.fromEntries(nativeBehaviorFields.filter(key => key in entry).map(key => [key, entry[key]]));
}

describe("versioned native catalog fidelity", () => {
  for (const source of nativeSource.models) {
    test(`${source.slug} preserves source behavior and exact-account clones`, () => {
      const built = buildCatalogEntries(source, [source.slug], [], [], true, "default", new Set(), ["main", "second"]);
      for (const entry of built) {
        expect(behavior(entry)).toEqual(behavior(source));
        expect(entry.supports_websockets).not.toBe(true);
        expect(entry.prefer_websockets).not.toBe(true);
      }
      const merged = mergeCatalogEntriesForSync([source], [], new Map(), [], true,
        new Set(), source, new Set(), new Set(), "default", new Set(), false, true,
        built.filter(entry => String(entry.slug).includes("/")), [source.slug]);
      for (const entry of merged) expect(behavior(entry)).toEqual(behavior(source));
      expect(mergeCatalogEntriesForSync(merged, [], new Map(), [], true,
        new Set(), source, new Set(), new Set(), "default", new Set(), false, true,
        built.filter(entry => String(entry.slug).includes("/")), [source.slug])).toEqual(merged);
    });
  }
  test("external entries retain strict compatibility defaults", () => {
    const row = ensureStrictCatalogFields({ slug: "external/model" }, { isRouted: true });
    expect(row.context_window).toBe(128000);
    expect(row.max_context_window).toBe(128000);
    expect(row.auto_compact_token_limit).toBe(115200);
  });
});


test("all supplied native source rows outrank template and pinned fallback", () => {
  const built = buildCatalogEntries(nativeSource.models[0]!, nativeSource.models.map(row => row.slug), [],
    [], false, "default", new Set(), ["second"], new Set(), new Set(), nativeSource.models);
  for (const row of built) {
    const slug = String(row.slug).replace(/^second\//, "");
    expect(behavior(row)).toEqual(behavior(nativeSource.models.find(source => source.slug === slug)!));
  }
  const stale = nativeSource.models.map(row => ({ ...row, context_window: 372000, auto_compact_token_limit: 334800 }));
  const refreshed = mergeCatalogEntriesForSync(stale, [], new Map(), [], false, new Set(), null,
    new Set(), new Set(), "default", new Set(), false, true, [], nativeSource.models.map(row => row.slug),
    new Set(), nativeSource.models);
  for (const row of refreshed) {
    expect(behavior(row)).toEqual(behavior(nativeSource.models.find(source => source.slug === row.slug)!));
  }
});

test("source absence stays absent and missing source is marked as fallback", () => {
  const minimal = { slug: "future-native", display_name: "Future Native" };
  const [native] = buildCatalogEntries(minimal, [minimal.slug], []);
  expect(behavior(native!)).toEqual({});
  const [pinned] = buildCatalogEntries(null, ["gpt-5.6-sol"], []);
  expect(pinned!.codexcommander_native_source).toBe("pinned-fallback");
  expect(pinned!.auto_compact_token_limit).toBeNull();
  const [fallback] = buildCatalogEntries(null, ["future-native"], []);
  expect(fallback!.codexcommander_native_source).toBe("synthetic-fallback");
  expect(fallback!.context_window).toBe(128000);
});
