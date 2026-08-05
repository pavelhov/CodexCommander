import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import {
  abortAndReleaseAllTurns,
  getAgentActivitySnapshot,
  resetAgentActivityForTests,
  setDraining,
  trackStreamLifetime,
  tryAdmitTurn,
  type ActiveTurnLease,
} from "../src/server/lifecycle";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";

const ownedLeases: ActiveTurnLease[] = [];

function headersWithMetadata(
  metadata?: unknown,
  extra?: HeadersInit,
): Headers {
  const headers = new Headers(extra);
  if (metadata !== undefined) {
    headers.set(
      "x-codex-turn-metadata",
      typeof metadata === "string" ? metadata : JSON.stringify(metadata),
    );
  }
  return headers;
}

function admit(input: {
  headers?: Headers;
  clientMetadata?: unknown;
  startedAt?: number;
} = {}): ActiveTurnLease {
  const lease = tryAdmitTurn({
    headers: input.headers ?? new Headers(),
    ...(input.clientMetadata !== undefined ? { clientMetadata: input.clientMetadata } : {}),
    ...(input.startedAt !== undefined ? { startedAt: input.startedAt } : {}),
  });
  expect(lease).not.toBeNull();
  ownedLeases.push(lease!);
  return lease!;
}

afterEach(() => {
  for (const lease of ownedLeases.splice(0).reverse()) lease.release();
  resetAgentActivityForTests();
  setDraining(false);
});

describe("agent activity registry", () => {
  test("reports schema/count/timestamp semantics with an allowlisted stable DTO", () => {
    const unrelated = tryAdmitTurn();
    expect(unrelated).not.toBeNull();
    ownedLeases.push(unrelated!);
    const lease = admit({
      headers: headersWithMetadata({
        turn_id: "raw-turn-must-not-leak",
        thread_id: "raw-thread-must-not-leak",
        title: "private title",
        path: "/private/path",
      }),
      startedAt: 1_000.9,
    });
    lease.markAgentActivityRunning({
      provider: "openai",
      model: "gpt-5.6-sol",
    });
    lease.markAgentActivityFirstOutput(1_200.8);

    const first = getAgentActivitySnapshot();
    const second = getAgentActivitySnapshot();
    expect(Object.keys(first).sort()).toEqual([
      "activeTurnCount",
      "activities",
      "displayedActivityCount",
      "generatedAt",
      "proxyState",
      "schemaVersion",
      "truncated",
      "unattributedActiveCount",
    ]);
    expect(first).toMatchObject({
      schemaVersion: 1,
      proxyState: "active",
      activeTurnCount: 2,
      displayedActivityCount: 1,
      unattributedActiveCount: 0,
      truncated: false,
    });
    expect(Number.isInteger(first.generatedAt)).toBe(true);
    expect(first.activities[0]).toEqual({
      id: first.activities[0]!.id,
      role: "primary",
      provider: "openai",
      model: "gpt-5.6-sol",
      phase: "running",
      startedAt: 1_000,
      firstOutputAt: 1_200,
    });
    expect(second.activities[0]!.id).toBe(first.activities[0]!.id);
    const serialized = JSON.stringify(first);
    for (const forbidden of [
      "raw-turn-must-not-leak",
      "raw-thread-must-not-leak",
      "private title",
      "/private/path",
      "headers",
      "credentials",
      "account",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }

    lease.release();
    expect(getAgentActivitySnapshot()).toMatchObject({
      proxyState: "active",
      activeTurnCount: 1,
      displayedActivityCount: 0,
      truncated: false,
    });
    unrelated!.release();
    expect(getAgentActivitySnapshot()).toMatchObject({
      proxyState: "idle",
      activeTurnCount: 0,
      displayedActivityCount: 0,
    });
  });

  test("uses only exact existing child markers and rejects malformed metadata", () => {
    admit({
      headers: new Headers({ "x-openai-subagent": "collab_spawn" }),
      startedAt: 1,
    });
    admit({
      headers: headersWithMetadata({ subagent_kind: "thread_spawn", turn_id: "child-2" }),
      startedAt: 2,
    });
    admit({
      clientMetadata: { subagent_kind: "thread_spawn", turn_id: "child-3" },
      startedAt: 3,
    });
    for (const [index, marker] of ["review", "compact", "thread_spawn "].entries()) {
      admit({
        headers: new Headers({ "x-openai-subagent": marker }),
        startedAt: 10 + index,
      });
    }
    admit({ headers: headersWithMetadata("{not-json"), startedAt: 20 });
    admit({
      clientMetadata: {
        subagent_kind: 42,
        turn_id: { nested: "secret" },
        parent_turn_id: " x ",
        thread_id: "\u0000bad",
      },
      startedAt: 21,
    });

    expect(getAgentActivitySnapshot().activities.map(activity => activity.role)).toEqual([
      "subagent",
      "subagent",
      "subagent",
      "primary",
      "primary",
      "primary",
      "primary",
      "primary",
    ]);
  });

  test("orders equal timestamps by stable random handle and omits account-decorated labels", () => {
    const leases = Array.from({ length: 3 }, () => admit({ startedAt: 50 }));
    leases[0]!.markAgentActivityRunning({
      provider: "openai:account@example.test",
      model: "safe-model",
    });
    const snapshot = getAgentActivitySnapshot();
    const ids = snapshot.activities.map(activity => activity.id);
    expect(ids).toEqual([...ids].sort());
    expect(snapshot.activities.find(activity => activity.model === "safe-model")?.provider).toBeUndefined();
  });

  test("correlates exact turn ids first, then uniquely exact thread ids, never sessions", () => {
    const turnParent = admit({
      clientMetadata: { turn_id: "parent-turn", thread_id: "parent-thread" },
      startedAt: 1,
    });
    const turnChild = admit({
      headers: new Headers({ "x-openai-subagent": "collab_spawn" }),
      clientMetadata: {
        turn_id: "child-turn",
        parent_turn_id: "parent-turn",
        thread_id: "child-thread",
        // Deliberately conflicts with the turn parent below: exact turn linkage wins.
        parent_thread_id: "thread-only-parent",
      },
      startedAt: 2,
    });
    const threadParent = admit({
      clientMetadata: { thread_id: "thread-only-parent" },
      startedAt: 3,
    });
    const threadChild = admit({
      headers: new Headers({ "x-openai-subagent": "collab_spawn" }),
      clientMetadata: { parent_thread_id: "thread-only-parent" },
      startedAt: 4,
    });
    admit({ headers: new Headers({ session_id: "shared-session" }), startedAt: 5 });
    const sessionChild = admit({
      headers: new Headers({
        "x-openai-subagent": "collab_spawn",
        session_id: "shared-session",
      }),
      startedAt: 6,
    });

    const snapshot = getAgentActivitySnapshot();
    const byStartedAt = new Map(snapshot.activities.map(activity => [activity.startedAt, activity]));
    expect(byStartedAt.get(2)?.parentId).toBe(byStartedAt.get(1)?.id);
    expect(byStartedAt.get(4)?.parentId).toBe(byStartedAt.get(3)?.id);
    expect(byStartedAt.get(6)?.parentId).toBeUndefined();
    expect(snapshot.unattributedActiveCount).toBe(1);
    void turnParent;
    void turnChild;
    void threadParent;
    void threadChild;
    void sessionChild;
  });

  test("does not let malformed structured parent metadata fall back to a header edge", () => {
    admit({ clientMetadata: { thread_id: "real-parent" }, startedAt: 1 });
    admit({
      headers: new Headers({
        "x-openai-subagent": "collab_spawn",
        "x-codex-parent-thread-id": "real-parent",
      }),
      clientMetadata: { parent_thread_id: 42 },
      startedAt: 2,
    });
    const snapshot = getAgentActivitySnapshot();
    expect(snapshot.activities[1]).toMatchObject({ role: "subagent", startedAt: 2 });
    expect(snapshot.activities[1]!.parentId).toBeUndefined();
    expect(snapshot.unattributedActiveCount).toBe(1);
  });

  test("fails closed on ambiguity, missing proof, self-links, and child-only cycles", () => {
    admit({ clientMetadata: { turn_id: "duplicate-parent" }, startedAt: 1 });
    admit({ clientMetadata: { turn_id: "duplicate-parent" }, startedAt: 2 });
    admit({
      headers: new Headers({ "x-openai-subagent": "collab_spawn" }),
      clientMetadata: { turn_id: "child", parent_turn_id: "duplicate-parent" },
      startedAt: 3,
    });
    admit({ clientMetadata: { turn_id: "only-primary" }, startedAt: 4 });
    admit({
      headers: new Headers({ "x-openai-subagent": "collab_spawn" }),
      clientMetadata: { turn_id: "standalone-child" },
      startedAt: 5,
    });
    admit({
      headers: new Headers({ "x-openai-subagent": "collab_spawn" }),
      clientMetadata: { turn_id: "self", parent_turn_id: "self" },
      startedAt: 6,
    });
    admit({
      headers: new Headers({ "x-openai-subagent": "collab_spawn" }),
      clientMetadata: { turn_id: "cycle-a", parent_turn_id: "cycle-b" },
      startedAt: 7,
    });
    admit({
      headers: new Headers({ "x-openai-subagent": "collab_spawn" }),
      clientMetadata: { turn_id: "cycle-b", parent_turn_id: "cycle-a" },
      startedAt: 8,
    });

    const snapshot = getAgentActivitySnapshot();
    for (const startedAt of [3, 5, 6, 7, 8]) {
      expect(snapshot.activities.find(activity => activity.startedAt === startedAt)?.parentId).toBeUndefined();
    }
    expect(snapshot.unattributedActiveCount).toBe(5);
  });

  test("sorts stably and never emits a dangling parent after DTO truncation", () => {
    admit({
      headers: new Headers({ "x-openai-subagent": "collab_spawn" }),
      clientMetadata: { turn_id: "early-child", parent_turn_id: "late-parent" },
      startedAt: 1,
    });
    for (let startedAt = 2; startedAt <= 64; startedAt += 1) {
      admit({ clientMetadata: { turn_id: `filler-${startedAt}` }, startedAt });
    }
    admit({ clientMetadata: { turn_id: "late-parent" }, startedAt: 100 });
    admit({ clientMetadata: { turn_id: "after-parent" }, startedAt: 101 });

    const snapshot = getAgentActivitySnapshot();
    expect(snapshot).toMatchObject({
      activeTurnCount: 66,
      displayedActivityCount: 64,
      unattributedActiveCount: 0,
      truncated: true,
    });
    expect(snapshot.activities[0]).toMatchObject({ startedAt: 1, role: "subagent" });
    expect(snapshot.activities[0]!.parentId).toBeUndefined();
    expect(snapshot.activities.map(activity => activity.startedAt)).toEqual(
      Array.from({ length: 64 }, (_, index) => index + 1),
    );
    const emittedIds = new Set(snapshot.activities.map(activity => activity.id));
    expect(snapshot.activities.every(activity => !activity.parentId || emittedIds.has(activity.parentId))).toBe(true);
  });

  test("bounds tracked rows at the existing 256-turn gate and truncates only tracked rows", () => {
    const leases = Array.from({ length: 256 }, (_, index) => admit({
      clientMetadata: { turn_id: `turn-${index}` },
      startedAt: index,
    }));
    expect(tryAdmitTurn({ headers: new Headers(), startedAt: 300 })).toBeNull();
    expect(getAgentActivitySnapshot()).toMatchObject({
      activeTurnCount: 256,
      displayedActivityCount: 64,
      truncated: true,
    });
    expect(leases).toHaveLength(256);
  });

  test("activity cleanup is owned by stream completion, cancellation, and forced lease release", async () => {
    const completedLease = admit({ startedAt: 1 });
    const completed = trackStreamLifetime(
      new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }),
      new AbortController(),
      undefined,
      completedLease,
    );
    expect(getAgentActivitySnapshot().displayedActivityCount).toBe(1);
    await new Response(completed).arrayBuffer();
    expect(getAgentActivitySnapshot().displayedActivityCount).toBe(0);

    const cancelledLease = admit({ startedAt: 2 });
    const cancelled = trackStreamLifetime(
      new ReadableStream<Uint8Array>({ start() { /* held open until cancellation */ } }),
      new AbortController(),
      undefined,
      cancelledLease,
    );
    await cancelled.cancel("client closed");
    expect(getAgentActivitySnapshot().displayedActivityCount).toBe(0);

    const forcedLease = admit({ startedAt: 3 });
    const controller = new AbortController();
    forcedLease.bindAbortController(controller);
    setDraining(true);
    expect(getAgentActivitySnapshot().proxyState).toBe("draining");
    abortAndReleaseAllTurns();
    expect(controller.signal.aborted).toBe(true);
    expect(getAgentActivitySnapshot()).toMatchObject({
      proxyState: "draining",
      activeTurnCount: 0,
      displayedActivityCount: 0,
    });
  });
});

describe("GET /api/agent-activity", () => {
  test("uses the existing auth/origin gate, allows authenticated no-Origin loopback, and disables caching", async () => {
    const previousHome = process.env.OPENCODEX_HOME;
    const previousAdminToken = process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
    const home = mkdtempSync(join(tmpdir(), "ocx-agent-activity-route-"));
    process.env.OPENCODEX_HOME = home;
    process.env.OPENCODEX_ADMIN_AUTH_TOKEN = "admin-secret";
    saveConfig({
      port: 0,
      hostname: "127.0.0.1",
      defaultProvider: "fixture",
      providers: {
        fixture: {
          adapter: "openai-chat",
          baseUrl: "https://example.test/v1",
          disabled: true,
          models: ["fixture-model"],
        },
      },
    } as OcxConfig);
    const server = startServer(0);
    try {
      const missing = await fetch(new URL("/api/agent-activity", server.url));
      expect(missing.status).toBe(401);

      const allowed = await fetch(new URL("/api/agent-activity", server.url), {
        headers: { "x-opencodex-api-key": "admin-secret" },
      });
      expect(allowed.status).toBe(200);
      expect(allowed.headers.get("cache-control")).toBe("no-store");
      expect(await allowed.json()).toMatchObject({
        schemaVersion: 1,
        proxyState: "idle",
        activeTurnCount: 0,
        displayedActivityCount: 0,
        unattributedActiveCount: 0,
        truncated: false,
        activities: [],
      });

      const rejectedOrigin = await fetch(new URL("/api/agent-activity", server.url), {
        headers: {
          "x-opencodex-api-key": "admin-secret",
          origin: "https://attacker.test",
        },
      });
      expect(rejectedOrigin.status).toBe(403);
    } finally {
      await server.stop(true);
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      if (previousAdminToken === undefined) delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
      else process.env.OPENCODEX_ADMIN_AUTH_TOKEN = previousAdminToken;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
