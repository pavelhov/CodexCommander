import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertFixedSynthetic, captureRequest } from "./helpers/inference-recorder";
import { compareFixture, semanticDiff } from "./helpers/inference-diff";
import { syntheticBody } from "./fixtures/inference-accounting/fixtures";
import { captureInChild, captureKilledChild, captureSurfacesInChild } from "../scripts/inference-offline-report";

describe("fixed synthetic offline inference evidence", () => {
  test("unknown fields, encrypted history, images, tools and identities remain semantic", () => {
    for (const key of ["unknown_extension", "input", "tools", "metadata"]) {
      const changed = structuredClone(syntheticBody) as Record<string, unknown>; delete changed[key];
      expect(semanticDiff(syntheticBody, changed).length).toBeGreaterThan(0);
    }
    const sample = { wire: [{ headers: { host: "127.0.0.1:1", connection: "keep-alive" }, body: syntheticBody }], sends: 1, clientAttempts: 1, outcome: "success" };
    expect(compareFixture(sample, { ...sample, wire: [{ ...sample.wire[0], headers: { host: "127.0.0.1:2", connection: "keep-alive" } }] }).verdict).toBe("PASS");
    expect(compareFixture(sample, { ...sample, telemetry: { events: ["new telemetry"] } } as typeof sample).verdict).toBe("PASS");
    expect(compareFixture(sample, { ...sample, sends: 2 }).verdict).toBe("REGRESSION");
    expect(compareFixture(sample, { ...sample, wire: [{ ...sample.wire[0], headers: { connection: "close" } }] }).verdict).toBe("REGRESSION");
  });
  test("sanitizer removes credential headers and rejects private values or arbitrary keys", async () => {
    const request = new Request("http://127.0.0.1/responses", { method: "POST", headers: { authorization: "fixture credential", "content-type": "application/json" }, body: JSON.stringify(syntheticBody) });
    expect((await captureRequest(request)).headers).toEqual({ "content-type": "application/json" });
    expect(() => assertFixedSynthetic({ input: "unrecognized private content" })).toThrow("nonfixture");
    expect(() => assertFixedSynthetic({ arbitrary_private_key: true })).toThrow("field");
    expect(() => assertFixedSynthetic({ access_token: "fixture prompt" })).toThrow("field");
    expect(() => assertFixedSynthetic({ metadata: { account_selector: 123456 } })).toThrow("number");
    expect(() => assertFixedSynthetic(syntheticBody)).not.toThrow();
  });
  test("actual adapter and shared retry sends remain independently countable", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "ccx-offline-test-"));
    try {
      const captures = await captureInChild(resolve(import.meta.dir, ".."), scratch);
      const byId = Object.fromEntries(captures.map(c => [c.id, c]));
      expect(byId["compact-routed"]!.sends).toBe(1); expect(byId["compact-routed"]!.outcome).toBe("http_200");
      expect(byId["responses-websocket-reconnect"]!.sends).toBe(2);
      expect(byId["responses-websocket-reconnect"]!.telemetry.events.filter(event => event.kind === "request")).toHaveLength(2);
      expect(byId.success!.sends).toBe(1); expect(byId.success!.wire.length).toBe(1);
      expect(byId.success!.outcome).toBe("protocol_success");
      expect(byId["transient-retry"]!.sends).toBe(2);
      expect(byId["reset-retry"]!.sends).toBe(2);
      expect(byId.unauthorized!.outcome).toBe("http_401");
      expect(byId["rate-limit"]!.outcome).toBe("http_429");
      expect(byId.eof!.outcome).toBe("incomplete_eof");
      expect(byId["cancel-before-headers"]!.outcome).toBe("cancelled_before_headers");
      expect(byId["cancel-after-output"]!.outcome).toBe("cancelled_after_output");
      for (const capture of captures) {
        expect(capture.clientAttempts).toBe(capture.id === "responses-websocket-reconnect" ? 2 : 1);
        expect(capture.telemetry.available).toBe(true);
        expect(capture.telemetry.events.filter(event => event.kind === "start").length).toBe(capture.sends);
      }
    } finally { await rm(scratch, { recursive: true, force: true }); }
  }, 25000);
});

test("process kill preserves an unresolved actual send without inventing completion", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "ccx-offline-kill-test-"));
  try {
    const capture = await captureKilledChild(resolve(import.meta.dir, ".."), scratch);
    expect(capture.sends).toBe(1); expect(capture.wire).toHaveLength(1);
    expect(capture.outcome).toBe("unknown_after_process_kill");
    expect(capture.telemetry.events.filter(event => event.kind === "start")).toHaveLength(1);
    expect(capture.telemetry.events.filter(event => event.kind === "terminal")).toHaveLength(0);
  } finally { await rm(scratch, { recursive: true, force: true }); }
}, 10000);

test("report imports independent sidecar and HTTP/2 fixture evidence without equating it to WebSocket", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "ccx-offline-surface-test-"));
  try {
    const rows = await captureSurfacesInChild(resolve(import.meta.dir, ".."), scratch);
    expect(rows.map(row => row.id)).toEqual(["sidecar-failure-main-success", "vision-cache-hit", "cursor_native_h2_precommit_reconnect"]);
    expect(rows[0]!.semantics.sendInvocations).toBe(2);
    expect(rows[0]!.telemetry.requestCount).toBe(2);
    expect(rows[0]!.telemetry.outcomes).toContain("protocol_failure");
    expect(rows[0]!.telemetry.outcomes).toContain("protocol_success");
    expect(rows[1]!.semantics.cacheHitSends).toBe(0);
    expect(rows[2]!.semantics).toEqual({ sendInvocations: 2, transportAttempts: 2, peerRequests: 1 });
    expect(rows[2]!.scope).toContain("not_websocket");
  } finally { await rm(scratch, { recursive: true, force: true }); }
}, 20000);
