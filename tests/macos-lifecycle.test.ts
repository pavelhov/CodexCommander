import { describe, expect, test } from "bun:test";
import {
  MACOS_LIFECYCLE_JSON_MAX_BYTES,
  encodeMacOSLifecycleResult,
} from "../src/cli/macos-lifecycle";
import type { ProxyLifecycleResult } from "../src/cli/proxy-lifecycle";

function success(message = "OpenCodex is running."): ProxyLifecycleResult {
  return {
    schemaVersion: 1,
    action: "status",
    ok: true,
    state: "running",
    changed: false,
    pid: 42,
    port: 10100,
    message,
  };
}

describe("macOS lifecycle JSON frame", () => {
  test("normal success keeps a matching zero exit status", () => {
    const encoded = encodeMacOSLifecycleResult("status", success());
    expect(encoded.exitCode).toBe(0);
    expect(JSON.parse(encoded.frame)).toMatchObject({ ok: true, state: "running" });
  });

  test("an oversized success becomes a bounded failure with a matching nonzero exit", () => {
    const encoded = encodeMacOSLifecycleResult("status", success("x".repeat(4_096)));
    expect(encoded.exitCode).toBe(1);
    expect(Buffer.byteLength(encoded.frame, "utf8")).toBeLessThanOrEqual(MACOS_LIFECYCLE_JSON_MAX_BYTES);
    expect(JSON.parse(encoded.frame)).toMatchObject({ ok: false, state: "failed" });
  });

  test("a live proxy with failed catalog convergence stays running in the bounded failure frame", () => {
    const result: ProxyLifecycleResult = {
      ...success("OpenCodex is running, but its Codex model catalog did not converge."),
      action: "ensure",
      ok: false,
      state: "running",
      errorCode: "SYNC_FAILED",
    };
    const encoded = encodeMacOSLifecycleResult("ensure", result);
    expect(encoded.exitCode).toBe(1);
    expect(Buffer.byteLength(encoded.frame, "utf8")).toBeLessThanOrEqual(MACOS_LIFECYCLE_JSON_MAX_BYTES);
    expect(JSON.parse(encoded.frame)).toMatchObject({
      ok: false,
      state: "running",
      errorCode: "SYNC_FAILED",
    });
  });
});
