import { describe, expect, test } from "bun:test";
import {
  parseShadowCallData,
  shadowSourceModelBadge,
  shadowSourceModelLabel,
  shadowSourceModelList,
} from "../src/pages/shadow-call-source";

/**
 * The GUI used to spell the intercepted slug into six locale files, which went
 * stale every time Codex changed its helper model. It now renders whatever the
 * runtime reports, so the cases that matter are: the runtime reported a list,
 * the runtime response is current, and the operator configured an override.
 * Without these, a formatting or response-validation regression ships silently green.
 */
describe("shadowSourceModelList", () => {
  test("renders the models the runtime reported", () => {
    expect(shadowSourceModelList(["gpt-5.4-mini", "gpt-5.6-luna"]))
      .toEqual(["gpt-5.4-mini", "gpt-5.6-luna"]);
  });

  test("renders a configured override rather than the defaults", () => {
    expect(shadowSourceModelList(["gpt-6-helper"])).toEqual(["gpt-6-helper"]);
  });

  test("renders no invented model before a current response is available", () => {
    expect(shadowSourceModelList(undefined)).toEqual([]);
  });

  test("drops blank entries and trims the rest", () => {
    expect(shadowSourceModelList([" gpt-5.6-luna ", "", "   "])).toEqual(["gpt-5.6-luna"]);
  });

  test("the current response parser rejects missing, empty, and malformed sourceModels", () => {
    expect(() => parseShadowCallData({ enabled: true, model: "helper" })).toThrow();
    expect(() => parseShadowCallData({ enabled: true, model: "helper", sourceModels: [] })).toThrow();
    expect(() => parseShadowCallData({ enabled: true, model: "helper", sourceModels: "gpt-5.6-luna" })).toThrow();
    expect(parseShadowCallData({ enabled: true, model: "helper", sourceModels: [" gpt-5.6-luna "] }))
      .toEqual({ enabled: true, model: "helper", sourceModels: ["gpt-5.6-luna"] });
  });
});

describe("shadow source model rendering", () => {
  test("label joins every reported model", () => {
    expect(shadowSourceModelLabel(["gpt-5.4-mini", "gpt-5.6-luna"]))
      .toBe("gpt-5.4-mini, gpt-5.6-luna");
  });

  test("badge drops the shared gpt- prefix to keep the row compact", () => {
    expect(shadowSourceModelBadge(["gpt-5.4-mini", "gpt-5.6-luna"]))
      .toBe("5.4-mini, 5.6-luna");
  });

  test("badge leaves a non-gpt id untouched", () => {
    expect(shadowSourceModelBadge(["helper-x"])).toBe("helper-x");
  });

  test("both renderings stay empty before a current response is available", () => {
    expect(shadowSourceModelLabel(undefined)).toBe("");
    expect(shadowSourceModelBadge(undefined)).toBe("");
  });
});
