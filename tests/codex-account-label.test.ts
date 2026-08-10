import { describe, expect, test } from "bun:test";
import {
  CODEX_ACCOUNT_LOG_LABEL_RE,
  codexAccountLogLabel,
  createCodexAccountLogLabel,
  withCodexAccountLogLabel,
} from "../src/codex/account-label";

describe("codex account privacy labels", () => {
  test("generates non-PII log labels", () => {
    expect(createCodexAccountLogLabel()).toMatch(CODEX_ACCOUNT_LOG_LABEL_RE);
  });

  test("avoids existing log labels", () => {
    const existing = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const label = createCodexAccountLogLabel(existing);
      expect(existing.has(label)).toBe(false);
      existing.add(label);
    }
  });

  test("adds a label to new account records", () => {
    const labelled = withCodexAccountLogLabel(
      { id: "pool-a", email: "pool-a@example.test", isMain: false },
      [],
    );
    expect(labelled.logLabel).toMatch(CODEX_ACCOUNT_LOG_LABEL_RE);
  });

  test("rejects invalid labels without synthesizing replacements", () => {
    expect(codexAccountLogLabel({ id: "invalid-label", email: "invalid@example.test", logLabel: "invalid", isMain: false })).toBeNull();
  });
});
