import { expect, test } from "bun:test";
import { isPositiveContextCap, summarizeContextPolicy } from "../src/pages/models-shared";

test("context policy summary distinguishes uncapped, fully limited, and mixed providers", () => {
  const providers = ["kimi", "xai"];

  expect(summarizeContextPolicy(providers, {}, 950_000)).toEqual({
    state: "uncapped",
    capped: 0,
    total: 2,
  });
  expect(summarizeContextPolicy(providers, { kimi: 950_000, xai: 950_000 }, 950_000)).toEqual({
    state: "limited",
    capped: 2,
    total: 2,
  });
  expect(summarizeContextPolicy(providers, { kimi: 950_000 }, 950_000)).toEqual({
    state: "mixed",
    capped: 1,
    total: 2,
  });
  expect(summarizeContextPolicy(providers, { kimi: 350_000, xai: 950_000 }, 950_000)).toEqual({
    state: "mixed",
    capped: 2,
    total: 2,
  });
});

test("context cap presence uses one positive finite predicate", () => {
  expect(isPositiveContextCap(950_000)).toBe(true);
  expect(isPositiveContextCap(0)).toBe(false);
  expect(isPositiveContextCap(-1)).toBe(false);
  expect(isPositiveContextCap(Number.NaN)).toBe(false);
  expect(isPositiveContextCap(undefined)).toBe(false);
});
