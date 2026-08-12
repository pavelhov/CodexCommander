import { describe, expect, test } from "bun:test";

import {
  observeCodexRoutingDocument,
} from "../src/codex/routing-document";

describe("Codex routing document observation", () => {
  test("returns a discriminated invalid observation", () => {
    expect(observeCodexRoutingDocument('model_provider = "unterminated')).toEqual({
      kind: "invalid",
      content: 'model_provider = "unterminated',
      routingKind: "unknown",
      effectiveProvider: null,
      externalProvider: null,
    });
  });

  test("uses one parsed document for profile-aware ownership and routing", () => {
    const observation = observeCodexRoutingDocument([
      'profile = "work"',
      'model_provider = "openai"',
      "[model_providers.custom]",
      'base_url = "https://gateway.example/v1"',
      "[profiles.work]",
      'model_provider = "custom"',
      "",
    ].join("\n"));
    expect(observation.kind).toBe("parsed");
    expect(observation).toMatchObject({
      routingKind: "native",
      effectiveProvider: "custom",
      externalProvider: "custom",
    });
  });

  test("never treats multiline decoys as a provider selection", () => {
    expect(observeCodexRoutingDocument([
      'note = """',
      'model_provider = "multiline-decoy"',
      '"""',
      "",
    ].join("\n"))).toMatchObject({
      kind: "parsed",
      routingKind: "native",
      effectiveProvider: null,
      externalProvider: null,
    });
  });
});
