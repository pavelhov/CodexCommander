import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import { MAX_DECOMPRESSED_BODY_BYTES } from "../src/server/request-decompress";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";
import { INTERNAL_DEADLINE_MS, SERVER_BUDGET_MS } from "./helpers/test-budget";

const previousHome = process.env.CODEXCOMMANDER_HOME;
const previousApiToken = process.env.CODEXCOMMANDER_API_AUTH_TOKEN;
let testHome = "";
let codexHome: IsolatedCodexHome;

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "ccx-server-body-limit-"));
  process.env.CODEXCOMMANDER_HOME = testHome;
  process.env.CODEXCOMMANDER_API_AUTH_TOKEN = "body-limit-test-token";
  codexHome = installIsolatedCodexHome("ccx-body-limit-codex-");
  saveConfig({
    port: 0,
    hostname: "0.0.0.0",
    multiAgentGuidanceEnabled: true,
    clientIntegrations: { codex: false },
    defaultProvider: "test",
    providers: {
      test: { adapter: "openai-chat", baseUrl: "https://example.test/v1", disabled: true },
    },
  });
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.CODEXCOMMANDER_HOME;
  else process.env.CODEXCOMMANDER_HOME = previousHome;
  if (previousApiToken === undefined) delete process.env.CODEXCOMMANDER_API_AUTH_TOKEN;
  else process.env.CODEXCOMMANDER_API_AUTH_TOKEN = previousApiToken;
  codexHome.restore();
  rmSync(testHome, { recursive: true, force: true });
});

function requestWithDeclaredBodySize(port: number, bytes: number): Promise<{ status: number; raw: string }> {
  return new Promise((resolve, reject) => {
    let raw = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) return reject(error);
      const status = Number(raw.match(/^HTTP\/1\.[01] (\d{3})/)?.[1] ?? 0);
      resolve({ status, raw });
    };
    const socket = createConnection({ host: "127.0.0.1", port }, () => {
      // Header-only requests let Bun enforce its real ingress limit without allocating
      // hundreds of MiB. Below that limit, the unchanged auth gate responds before reading.
      socket.write([
        "POST /v1/responses HTTP/1.1",
        `Host: 127.0.0.1:${port}`,
        "Content-Type: application/json",
        `Content-Length: ${bytes}`,
        "Connection: close",
        "",
        "",
      ].join("\r\n"));
    });
    socket.setEncoding("utf8");
    socket.setTimeout(INTERNAL_DEADLINE_MS, () => finish(new Error("body-limit request timed out")));
    socket.on("data", chunk => { raw += chunk; });
    socket.on("end", () => finish());
    socket.on("error", error => finish(error));
  });
}

describe("real server HTTP ingress body limit", () => {
  test.each([
    ["above Bun's 128 MiB default", 128 * 1024 * 1024 + 1],
    ["exactly at the shared cap", MAX_DECOMPRESSED_BODY_BYTES],
  ])("admits declared bodies %s to the application handler", async (_label, bytes) => {
    const server = startServer(0);
    try {
      const response = await requestWithDeclaredBodySize(server.port!, bytes);
      expect(response.status).toBe(401);
      expect(response.raw).toContain('"type":"authentication_error"');
    } finally {
      await server.stop(true);
    }
  }, SERVER_BUDGET_MS);

  test("rejects a declared body one byte above the shared cap at ingress", async () => {
    const server = startServer(0);
    try {
      const response = await requestWithDeclaredBodySize(server.port!, MAX_DECOMPRESSED_BODY_BYTES + 1);
      expect(response.status).toBe(413);
      expect(response.raw).not.toContain('"type":"authentication_error"');
    } finally {
      await server.stop(true);
    }
  }, SERVER_BUDGET_MS);
});
