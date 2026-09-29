import { expect, test } from "bun:test";
import { commanderOnlyModel, listedCodexModelSlugs, staleCodexWorkerCount } from "../src/models-codex-catalog";

test("published picker comparison only grays a confirmed missing routed model", () => {
  const slugs = listedCodexModelSlugs({ models: [
    { slug: "opencode-go/deepseek-v4.1-flash", visibility: "list" },
    { slug: "opencode-go/hidden", visibility: "hide" },
  ] });
  expect(slugs).toEqual(["opencode-go/deepseek-v4.1-flash"]);
  const published = new Set(slugs!);
  expect(commanderOnlyModel({ namespaced: "opencode-go/deepseek-v4.1-flash" }, true, published)).toBe(false);
  expect(commanderOnlyModel({ namespaced: "opencode-go/hidden" }, true, published)).toBe(true);
  expect(commanderOnlyModel({ namespaced: "opencode-go/missing" }, false, published)).toBe(false);
  expect(commanderOnlyModel({ namespaced: "gpt-6.1-sol", native: true }, true, published)).toBe(false);
  expect(commanderOnlyModel({ namespaced: "opencode-go/missing" }, true, null)).toBe(false);
  expect(listedCodexModelSlugs({ models: [{ slug: 42 }] })).toBeNull();
});

test("restart notice requires a current catalog, route, and confirmed stale workers", () => {
  const activation = {
    schemaVersion: 1,
    catalog: { status: "current" },
    routing: { status: "current" },
    workers: { status: "reload_required", staleCount: 2 },
  };
  expect(staleCodexWorkerCount({ activation })).toBe(2);
  expect(staleCodexWorkerCount({ activation: { ...activation, workers: { status: "current", staleCount: 0 } } })).toBe(0);
  expect(staleCodexWorkerCount({ activation: { ...activation, catalog: { status: "pending" } } })).toBeNull();
  expect(staleCodexWorkerCount({ activation: { ...activation, routing: { status: "external" } } })).toBeNull();
});
