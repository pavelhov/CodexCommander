import { describe, expect, test } from "bun:test";
import { isAtomicResidualError } from "../src/codex/features";
import { AtomicWriteResidualTempError, AtomicWriteSecretResidualError } from "../src/config";

describe("Codex feature atomic-write residual gate", () => {
  test("both residual classes retain the destination memo", () => {
    expect(isAtomicResidualError(new AtomicWriteResidualTempError("/tmp/x.ccx.1.1.tmp", true))).toBe(true);
    expect(isAtomicResidualError(new AtomicWriteSecretResidualError("/tmp/x.ccx.1.1.tmp"))).toBe(true);
    expect(isAtomicResidualError(new Error("ordinary failure"))).toBe(false);
    expect(isAtomicResidualError(new TypeError("not a residual"))).toBe(false);
  });
});
