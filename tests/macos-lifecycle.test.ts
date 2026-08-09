import { describe, expect, test } from "bun:test";
import {
  MACOS_LIFECYCLE_JSON_MAX_BYTES,
  encodeMacOSLifecycleResult,
} from "../src/cli/macos-lifecycle";
import {
  APPLY_CODEX_CATALOG_ACTION,
  type ApplyCodexCatalogLifecycleResult,
} from "../src/codex/catalog-apply";
import type { ProxyLifecycleResult } from "../src/cli/proxy-lifecycle";

function success(message = "CodexCommander is running."): ProxyLifecycleResult {
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
      ...success("CodexCommander is running, but its Codex model catalog did not converge."),
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

  test("the fixed catalog action keeps only bounded worker counts", () => {
    const result: ApplyCodexCatalogLifecycleResult = {
      schemaVersion: 1,
      action: APPLY_CODEX_CATALOG_ACTION,
      ok: true,
      state: "running",
      changed: true,
      pid: null,
      port: null,
      message: "Agent catalog applied.",
      catalogUpdated: true,
      codexRestartRequired: false,
      staleWorkerCount: 2,
      stoppedWorkerCount: 2,
      survivingWorkerCount: 0,
    };
    const encoded = encodeMacOSLifecycleResult(APPLY_CODEX_CATALOG_ACTION, result);
    expect(encoded.exitCode).toBe(0);
    expect(Buffer.byteLength(encoded.frame, "utf8")).toBeLessThanOrEqual(MACOS_LIFECYCLE_JSON_MAX_BYTES);
    expect(JSON.parse(encoded.frame)).toEqual(result);
    expect(encoded.frame).not.toContain("stoppedPids");
    expect(encoded.frame).not.toContain("survivingPids");
  });

  test("an oversized catalog action becomes a matching bounded catalog failure", () => {
    const result: ApplyCodexCatalogLifecycleResult = {
      schemaVersion: 1,
      action: APPLY_CODEX_CATALOG_ACTION,
      ok: true,
      state: "running",
      changed: true,
      pid: null,
      port: null,
      message: "x".repeat(4_096),
      catalogUpdated: true,
      codexRestartRequired: false,
      staleWorkerCount: 2,
      stoppedWorkerCount: 2,
      survivingWorkerCount: 0,
    };
    const encoded = encodeMacOSLifecycleResult(APPLY_CODEX_CATALOG_ACTION, result);
    expect(encoded.exitCode).toBe(1);
    expect(Buffer.byteLength(encoded.frame, "utf8")).toBeLessThanOrEqual(MACOS_LIFECYCLE_JSON_MAX_BYTES);
    expect(JSON.parse(encoded.frame)).toMatchObject({
      action: APPLY_CODEX_CATALOG_ACTION,
      ok: false,
      catalogUpdated: false,
      codexRestartRequired: false,
      staleWorkerCount: 0,
      stoppedWorkerCount: 0,
      survivingWorkerCount: 0,
    });
  });
});
