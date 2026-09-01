import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { saveConfig } from "../../src/config";
import { ensureArtifactsDirectory } from "../../src/images/artifact-storage";
import {
  MediaRuntime,
  type ServerMediaRuntime,
  type SubmitRuntimeVideoInput,
} from "../../src/images/media-runtime";
import {
  deriveVideoOperationKey,
  deriveVideoRequestBodyDigest,
} from "../../src/images/video-operation-key";
import { openVideoJobStore } from "../../src/images/video-job-store";
import { startServer } from "../../src/server";
import { resetLifecycleDrainStateForTests } from "../../src/server/lifecycle";
import type { ManagementAuthState } from "../../src/server/management-auth";
import type { CodexCommanderConfig } from "../../src/types";

const DATA_KEY_A = "ccx_data_operation_scope_a";
const DATA_KEY_B = "ccx_data_operation_scope_b";
const CLIENT_REQUEST_ID = "shared-video-request-id";
const roots: string[] = [];
const servers: Array<ReturnType<typeof startServer>> = [];
const upstreams: Bun.Server<unknown>[] = [];
const previousCommanderHome = process.env.CODEXCOMMANDER_HOME;
const previousCodexHome = process.env.CODEX_HOME;
const previousAdminToken = process.env.CODEXCOMMANDER_ADMIN_AUTH_TOKEN;

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.stop(true).catch(() => {})));
  for (const upstream of upstreams.splice(0)) upstream.stop(true);
  resetLifecycleDrainStateForTests();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (previousCommanderHome === undefined) delete process.env.CODEXCOMMANDER_HOME;
  else process.env.CODEXCOMMANDER_HOME = previousCommanderHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  if (previousAdminToken === undefined) delete process.env.CODEXCOMMANDER_ADMIN_AUTH_TOKEN;
  else process.env.CODEXCOMMANDER_ADMIN_AUTH_TOKEN = previousAdminToken;
});

function sse(payloads: Array<Record<string, unknown>>): Response {
  const text = payloads.map(payload =>
    `event: ${String(payload.type)}\ndata: ${JSON.stringify(payload)}\n\n`).join("")
    + "data: [DONE]\n\n";
  return new Response(text, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function bodyHasFunctionOutput(body: Record<string, unknown>): boolean {
  return Array.isArray(body.input)
    && body.input.some(item => item !== null
      && typeof item === "object"
      && (item as { type?: unknown }).type === "function_call_output");
}

function promptFromBody(body: Record<string, unknown>): string {
  if (typeof body.input === "string") return body.input;
  return JSON.stringify(body.input ?? "video prompt");
}

function startModelUpstream(): Bun.Server<unknown> {
  let responseNumber = 0;
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const body = await req.json() as Record<string, unknown>;
      responseNumber += 1;
      if (bodyHasFunctionOutput(body)) {
        return sse([
          {
            type: "response.output_text.delta",
            item_id: `msg_${responseNumber}`,
            output_index: 0,
            content_index: 0,
            delta: "Video request handled.",
          },
          {
            type: "response.completed",
            response: { id: `resp_final_${responseNumber}`, status: "completed", output: [] },
          },
        ]);
      }
      const call = {
        type: "function_call",
        id: `fc_${responseNumber}`,
        call_id: `call_${responseNumber}`,
        name: "video_gen",
        arguments: JSON.stringify({
          prompt: `tool prompt for ${promptFromBody(body)}`,
          duration: 6,
          resolution: "720p",
          aspect_ratio: "16:9",
        }),
        status: "completed",
      };
      return sse([
        { type: "response.output_item.done", output_index: 0, item: call },
        {
          type: "response.completed",
          response: { id: `resp_call_${responseNumber}`, status: "completed", output: [call] },
        },
      ]);
    },
  });
  upstreams.push(upstream);
  return upstream;
}

interface Fixture {
  server: ReturnType<typeof startServer>;
  captured: SubmitRuntimeVideoInput[];
  journalPath: string;
  paidPosts: () => number;
}

interface FixtureOptions {
  root?: string;
  hostname?: string;
  dataKeyA?: string;
  paidCounter?: { value: number };
  managementAuthState?: ManagementAuthState;
  replayAuthorityUnavailable?: boolean;
}

function startFixture(options: FixtureOptions = {}): Fixture {
  const root = options.root ?? mkdtempSync(join(tmpdir(), "ccx-video-operation-scope-"));
  if (!options.root) roots.push(root);
  process.env.CODEXCOMMANDER_HOME = root;
  process.env.CODEX_HOME = join(root, "codex");
  mkdirSync(process.env.CODEX_HOME, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);

  const upstream = startModelUpstream();
  const upstreamBase = new URL("/v1", upstream.url).toString().replace(/\/$/, "");
  const config: CodexCommanderConfig = {
    port: 0,
    hostname: options.hostname ?? "0.0.0.0",
    websockets: true,
    multiAgentGuidanceEnabled: true,
    clientIntegrations: { codex: false },
    defaultProvider: "fixture",
    providers: {
      fixture: {
        adapter: "openai-responses",
        authMode: "key",
        baseUrl: upstreamBase,
        apiKey: "fixture-model-key",
        allowPrivateNetwork: true,
        liveModels: false,
        models: ["fixture-model"],
      },
      xai: {
        adapter: "openai-chat",
        authMode: "key",
        baseUrl: "https://api.x.ai/v1",
        apiKey: "fixture-xai-media-key",
        liveModels: false,
      },
    },
    apiKeys: [
      { id: "private-principal-a", name: "A", key: options.dataKeyA ?? DATA_KEY_A, createdAt: "2026-08-31T00:00:00.000Z" },
      { id: "private-principal-b", name: "B", key: DATA_KEY_B, createdAt: "2026-08-31T00:00:00.000Z" },
    ],
    images: {
      bridgeEnabled: false,
      videoBridgeEnabled: true,
      authSource: "api_key",
      videoMaxRounds: 1,
    },
  };
  saveConfig(config);

  const journalPath = join(root, "private", "media-journal.sqlite");
  const store = openVideoJobStore({ path: journalPath });
  const paidCounter = options.paidCounter ?? { value: 0 };
  const runtime = new MediaRuntime(store, {
    submitVideoJob: async () => ({ requestId: `paid-video-${++paidCounter.value}` }),
    pollVideoJob: async () => ({ status: "done", videoUrl: "https://signed.invalid/video" }),
    downloadVideo: async (_url, _signal, options) => {
      const artifactId = `operation-scope-${paidCounter.value}.mp4`;
      options?.onReserveArtifact?.(artifactId);
      const dir = await ensureArtifactsDirectory();
      const path = join(dir, artifactId);
      writeFileSync(path, "video", { mode: 0o600 });
      return path;
    },
    sleep: async () => {},
    pollIntervalMs: 1,
  });
  const captured: SubmitRuntimeVideoInput[] = [];
  const mediaRuntime = new Proxy(runtime, {
    get(target, property, receiver) {
      if (property === "deriveVideoOperationIdentity" && options.replayAuthorityUnavailable) {
        return undefined;
      }
      if (property === "submitVideo") {
        return async (input: SubmitRuntimeVideoInput) => {
          captured.push(input);
          return target.submitVideo(input);
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as ServerMediaRuntime;
  const server = startServer(0, {
    mediaRuntime,
    localAttestationSecret: "L".repeat(43),
    ...(options.managementAuthState ? { managementAuthState: options.managementAuthState } : {}),
  });
  servers.push(server);
  return { server, captured, journalPath, paidPosts: () => paidCounter.value };
}

function responseBody(prompt: string): Record<string, unknown> {
  return {
    model: "fixture/fixture-model",
    input: `Create a six second video of ${prompt}.`,
    stream: true,
  };
}

async function postVideo(
  server: ReturnType<typeof startServer>,
  key: string,
  prompt: string,
): Promise<void> {
  const response = await fetch(new URL("/v1/responses", server.url), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-codexcommander-api-key": key,
      "x-client-request-id": CLIENT_REQUEST_ID,
    },
    body: JSON.stringify(responseBody(prompt)),
  });
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("Video request handled.");
}

async function stopFixtureServer(server: ReturnType<typeof startServer>): Promise<void> {
  const index = servers.indexOf(server);
  if (index >= 0) servers.splice(index, 1);
  await server.stop(true);
}

describe("video operation scope at authenticated Responses ingress", () => {
  test("HTTP exact retry dedupes, prompt reuse collides safely, and principals are namespaced", async () => {
    const fixture = startFixture();
    await postVideo(fixture.server, DATA_KEY_A, "a private paper boat alpha");
    await postVideo(fixture.server, DATA_KEY_A, "a private paper boat alpha");
    await postVideo(fixture.server, DATA_KEY_A, "a different private fox beta");
    await postVideo(fixture.server, DATA_KEY_B, "a private paper boat alpha");

    expect(fixture.captured).toHaveLength(4);
    const [first, exactRetry, reusedId, otherPrincipal] = fixture.captured;
    expect(exactRetry?.operationKey).toBe(first?.operationKey);
    expect(exactRetry?.requestSemanticsDigest).toBe(first?.requestSemanticsDigest);
    expect(reusedId?.operationKey).toBe(first?.operationKey);
    expect(reusedId?.requestSemanticsDigest).not.toBe(first?.requestSemanticsDigest);
    expect(otherPrincipal?.operationKey).not.toBe(first?.operationKey);
    expect(otherPrincipal?.requestSemanticsDigest).not.toBe(first?.requestSemanticsDigest);
    expect(fixture.paidPosts()).toBe(2);

    const clientKnownContext = {
      digestSecret: DATA_KEY_A,
      admission: { kind: "configured", keyId: "private-principal-a" } as const,
    };
    expect(deriveVideoOperationKey(CLIENT_REQUEST_ID, clientKnownContext))
      .not.toBe(first?.operationKey);
    expect(deriveVideoRequestBodyDigest(
      responseBody("a private paper boat alpha"),
      clientKnownContext,
    )).not.toBe(first?.requestSemanticsDigest);

    for (const input of fixture.captured) {
      expect(input.operationKey).toMatch(/^hmac-sha256:[a-f0-9]{64}$/);
      expect(input.requestSemanticsDigest).toMatch(/^hmac-sha256:[a-f0-9]{64}$/);
    }
    const privateMetadata = JSON.stringify(fixture.captured.map(input => ({
      operationKey: input.operationKey,
      requestSemanticsDigest: input.requestSemanticsDigest,
    })));
    for (const forbidden of [
      CLIENT_REQUEST_ID,
      DATA_KEY_A,
      DATA_KEY_B,
      "private-principal-a",
      "private-principal-b",
      "paper boat alpha",
      "fox beta",
    ]) expect(privateMetadata).not.toContain(forbidden);

    const database = new Database(fixture.journalPath, { readonly: true });
    const rows = database.query<{
      operation_key: string;
      request_semantics_digest: string;
    }, []>("SELECT operation_key, request_semantics_digest FROM video_jobs ORDER BY created_at").all();
    database.close();
    expect(rows).toHaveLength(2);
    expect(rows[0]?.operation_key).not.toBe(rows[1]?.operation_key);
    const persisted = JSON.stringify(rows);
    expect(persisted).not.toContain("paper boat alpha");
    expect(persisted).not.toContain("fox beta");
    expect(persisted).not.toContain("private-principal");
    expect(persisted).not.toContain(CLIENT_REQUEST_ID);
  });

  test("loopback exact retry survives a server restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "ccx-video-operation-restart-loopback-"));
    roots.push(root);
    const paidCounter = { value: 0 };
    const first = startFixture({ root, hostname: "127.0.0.1", paidCounter });
    await postVideo(first.server, DATA_KEY_A, "a private restart-safe lighthouse");
    const firstIdentity = first.captured[0];
    await stopFixtureServer(first.server);

    const restarted = startFixture({ root, hostname: "127.0.0.1", paidCounter });
    await postVideo(restarted.server, DATA_KEY_A, "a private restart-safe lighthouse");
    expect(restarted.captured).toHaveLength(1);
    expect(restarted.captured[0]?.operationKey).toBe(firstIdentity?.operationKey);
    expect(restarted.captured[0]?.requestSemanticsDigest).toBe(firstIdentity?.requestSemanticsDigest);
    expect(paidCounter.value).toBe(1);
  });

  test("configured-key rotation preserves retry identity for the same principal id", async () => {
    const root = mkdtempSync(join(tmpdir(), "ccx-video-operation-restart-rotation-"));
    roots.push(root);
    const paidCounter = { value: 0 };
    const first = startFixture({ root, dataKeyA: DATA_KEY_A, paidCounter });
    await postVideo(first.server, DATA_KEY_A, "a private rotation-safe observatory");
    const firstIdentity = first.captured[0];
    await stopFixtureServer(first.server);

    const rotatedKey = "ccx_data_operation_scope_a_rotated";
    const restarted = startFixture({ root, dataKeyA: rotatedKey, paidCounter });
    await postVideo(restarted.server, rotatedKey, "a private rotation-safe observatory");
    expect(restarted.captured).toHaveLength(1);
    expect(restarted.captured[0]?.operationKey).toBe(firstIdentity?.operationKey);
    expect(restarted.captured[0]?.requestSemanticsDigest).toBe(firstIdentity?.requestSemanticsDigest);
    expect(paidCounter.value).toBe(1);
  });

  test("dedupe survives unavailable and rotated management credentials", async () => {
    const root = mkdtempSync(join(tmpdir(), "ccx-video-operation-admin-independent-"));
    roots.push(root);
    const paidCounter = { value: 0 };
    const unavailable = startFixture({
      root,
      paidCounter,
      managementAuthState: { available: false, reason: "fixture management unavailable" },
    });
    await postVideo(unavailable.server, DATA_KEY_A, "a private management-independent sundial");
    const firstIdentity = unavailable.captured[0];
    await stopFixtureServer(unavailable.server);

    process.env.CODEXCOMMANDER_ADMIN_AUTH_TOKEN = "first-rotatable-management-value";
    const firstAdmin = startFixture({ root, paidCounter });
    await postVideo(firstAdmin.server, DATA_KEY_A, "a private management-independent sundial");
    expect(firstAdmin.captured[0]?.operationKey).toBe(firstIdentity?.operationKey);
    expect(firstAdmin.captured[0]?.requestSemanticsDigest).toBe(firstIdentity?.requestSemanticsDigest);
    await stopFixtureServer(firstAdmin.server);

    process.env.CODEXCOMMANDER_ADMIN_AUTH_TOKEN = "second-rotatable-management-value";
    const rotatedAdmin = startFixture({ root, paidCounter });
    await postVideo(rotatedAdmin.server, DATA_KEY_A, "a private management-independent sundial");
    expect(rotatedAdmin.captured[0]?.operationKey).toBe(firstIdentity?.operationKey);
    expect(rotatedAdmin.captured[0]?.requestSemanticsDigest).toBe(firstIdentity?.requestSemanticsDigest);
    expect(paidCounter.value).toBe(1);
  });

  test("unavailable journal authority fails valid HTTP retry admission before paid submission", async () => {
    const fixture = startFixture({ replayAuthorityUnavailable: true });

    const response = await fetch(new URL("/v1/responses", fixture.server.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-codexcommander-api-key": DATA_KEY_A,
        "x-client-request-id": CLIENT_REQUEST_ID,
      },
      body: JSON.stringify(responseBody("a private request that must not be billed")),
    });
    expect(response.status).toBe(503);
    const payload = await response.json() as { error?: { code?: unknown; message?: unknown } };
    expect(payload.error?.code).toBe("video_retry_protection_unavailable");
    expect(payload.error?.message).toBe("Video retry protection is temporarily unavailable");
    expect(JSON.stringify(payload)).not.toContain("journal");
    expect(JSON.stringify(payload)).not.toContain("authority");
    expect(fixture.captured).toHaveLength(0);
    expect(fixture.paidPosts()).toBe(0);
  });

  test("two video turns on one WebSocket never reuse the handshake request id", async () => {
    const fixture = startFixture();
    const target = new URL("/v1/responses", fixture.server.url);
    target.protocol = "ws:";

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(target, {
        headers: {
          "x-codexcommander-api-key": DATA_KEY_A,
          "x-client-request-id": CLIENT_REQUEST_ID,
        },
      } as unknown as string[]);
      const prompts = ["a private red kite one", "a private blue kite two"];
      let terminalCount = 0;
      const timer = setTimeout(() => {
        try { socket.close(); } catch { /* already closed */ }
        reject(new Error("timed out waiting for two WebSocket video turns"));
      }, 10_000);
      const finish = (error?: unknown) => {
        clearTimeout(timer);
        try { socket.close(); } catch { /* already closed */ }
        if (error) reject(error);
        else resolve();
      };
      socket.addEventListener("open", () => {
        socket.send(JSON.stringify({ type: "response.create", ...responseBody(prompts[0]!) }));
      });
      socket.addEventListener("message", event => {
        let frame: { type?: unknown };
        try {
          frame = JSON.parse(String(event.data)) as { type?: unknown };
        } catch {
          return;
        }
        if (frame.type === "error") return finish(new Error(`unexpected WS error: ${String(event.data)}`));
        if (frame.type !== "response.completed") return;
        terminalCount += 1;
        if (terminalCount === 1) {
          socket.send(JSON.stringify({ type: "response.create", ...responseBody(prompts[1]!) }));
        } else {
          finish();
        }
      });
      socket.addEventListener("error", () => finish(new Error("WebSocket transport error")));
    });

    expect(fixture.captured).toHaveLength(2);
    expect(fixture.paidPosts()).toBe(2);
    expect(fixture.captured.map(input => input.operationKey)).toEqual([undefined, undefined]);
    expect(fixture.captured.map(input => input.requestSemanticsDigest)).toEqual([undefined, undefined]);
    expect(fixture.captured[0]?.request.prompt).toContain("red kite one");
    expect(fixture.captured[1]?.request.prompt).toContain("blue kite two");
  });
});
