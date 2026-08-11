import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeApiError, runtimeRequest } from "../src/cli/runtime-api";
import { stopProxyGracefully } from "../src/lib/process-control";
import { fetchClaudeContextWindows } from "../src/cli/claude";
import {
  API_KEY_HEADER,
  ATTESTATION_CHALLENGE_HEADER,
  ATTESTATION_PROOF_HEADER,
} from "../src/identity";
import { createLocalAttestationProof } from "../src/lib/local-management-attestation";
import type { CodexCommanderConfig } from "../src/types";

const previousHome = process.env.CODEXCOMMANDER_HOME;
const previousDataToken = process.env.CODEXCOMMANDER_API_AUTH_TOKEN;
const previousAdminToken = process.env.CODEXCOMMANDER_ADMIN_AUTH_TOKEN;
const homes: string[] = [];
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (previousHome === undefined) delete process.env.CODEXCOMMANDER_HOME;
  else process.env.CODEXCOMMANDER_HOME = previousHome;
  if (previousDataToken === undefined) delete process.env.CODEXCOMMANDER_API_AUTH_TOKEN;
  else process.env.CODEXCOMMANDER_API_AUTH_TOKEN = previousDataToken;
  if (previousAdminToken === undefined) delete process.env.CODEXCOMMANDER_ADMIN_AUTH_TOKEN;
  else process.env.CODEXCOMMANDER_ADMIN_AUTH_TOKEN = previousAdminToken;
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

async function capturedManagementToken(): Promise<string | null> {
  let token: string | null = null;
  const pid = 4242;
  const port = 10100;
  const attestationSecret = "A".repeat(43);
  await runtimeRequest("/api/config", {}, {
    baseUrl: "http://127.0.0.1:10100",
    managementAttestation: {
      readRuntimeFn: () => ({ pid, port, hostname: "127.0.0.1", attestationSecret }),
      verifyPidFn: candidate => candidate,
    },
    fetchImpl: async (input, init) => {
      if (String(input).endsWith("/healthz")) {
        const headers = new Headers(init?.headers);
        expect(headers.get(API_KEY_HEADER)).toBeNull();
        expect(init?.body).toBeUndefined();
        const challenge = headers.get(ATTESTATION_CHALLENGE_HEADER)!;
        const proof = createLocalAttestationProof(attestationSecret, challenge, pid, port)!;
        return Response.json(
          { service: "codexcommander", status: "ok", version: "test", uptime: 1, pid, port },
          { headers: { [ATTESTATION_PROOF_HEADER]: proof } },
        );
      }
      token = new Headers(init?.headers).get(API_KEY_HEADER);
      return Response.json({ ok: true });
    },
  });
  return token;
}

describe("CLI management authentication", () => {
  test("the management environment token replaces the data token", async () => {
    process.env.CODEXCOMMANDER_API_AUTH_TOKEN = "data-secret";
    process.env.CODEXCOMMANDER_ADMIN_AUTH_TOKEN = "admin-secret";
    expect(await capturedManagementToken()).toBe("admin-secret");
  });

  test("the protected management token file is used when the environment token is absent", async () => {
    const home = mkdtempSync(join(tmpdir(), "ccx-cli-admin-auth-"));
    homes.push(home);
    process.env.CODEXCOMMANDER_HOME = home;
    process.env.CODEXCOMMANDER_API_AUTH_TOKEN = "data-secret";
    delete process.env.CODEXCOMMANDER_ADMIN_AUTH_TOKEN;
    writeFileSync(join(home, "admin-api-token"), `ccx_admin_${"a".repeat(43)}\n`, { mode: 0o600 });
    expect(await capturedManagementToken()).toBe(`ccx_admin_${"a".repeat(43)}`);
  });

  test("a spoofed listener receives neither the admin token nor a mutating body", async () => {
    process.env.CODEXCOMMANDER_ADMIN_AUTH_TOKEN = "admin-secret";
    const attestationSecret = "A".repeat(43);
    let managementCalls = 0;
    const seen: Array<{ token: string | null; body: BodyInit | null | undefined }> = [];
    const request = runtimeRequest("/api/providers", {
      method: "POST",
      body: JSON.stringify({ provider: { apiKey: "upstream-secret" } }),
    }, {
      managementAttestation: {
        attempts: 1,
        readRuntimeFn: () => ({ pid: 4242, port: 10100, hostname: "127.0.0.1", attestationSecret }),
        verifyPidFn: candidate => candidate,
      },
      fetchImpl: async (input, init) => {
        seen.push({ token: new Headers(init?.headers).get(API_KEY_HEADER), body: init?.body });
        if (!String(input).endsWith("/healthz")) managementCalls += 1;
        return Response.json(
          { service: "codexcommander", pid: 4242, port: 10100 },
          { headers: { [ATTESTATION_PROOF_HEADER]: "B".repeat(43) } },
        );
      },
    });
    await expect(request).rejects.toBeInstanceOf(RuntimeApiError);
    expect(managementCalls).toBe(0);
    expect(seen).toEqual([{ token: null, body: undefined }]);
  });

  test("GET credentials in standard bearer headers are also held behind attestation", async () => {
    const home = mkdtempSync(join(tmpdir(), "ccx-cli-header-attestation-"));
    homes.push(home);
    process.env.CODEXCOMMANDER_HOME = home;
    delete process.env.CODEXCOMMANDER_ADMIN_AUTH_TOKEN;
    const attestationSecret = "A".repeat(43);
    for (const [name, value] of [
      ["Authorization", "Bearer caller-secret"],
      ["x-api-key", "caller-api-secret"],
    ] as const) {
      let calls = 0;
      await expect(runtimeRequest("/api/config", { headers: { [name]: value } }, {
        managementAttestation: {
          attempts: 1,
          readRuntimeFn: () => ({ pid: 4242, port: 10100, hostname: "127.0.0.1", attestationSecret }),
          verifyPidFn: candidate => candidate,
        },
        fetchImpl: async (_input, init) => {
          calls += 1;
          const headers = new Headers(init?.headers);
          expect(headers.get(name)).toBeNull();
          return new Response("spoof", { headers: { [ATTESTATION_PROOF_HEADER]: "B".repeat(43) } });
        },
      })).rejects.toBeInstanceOf(RuntimeApiError);
      expect(calls).toBe(1);
    }
  });

  test("graceful stop sends the management token instead of the data token", async () => {
    let token: string | null = null;
    const attestationSecret = "A".repeat(43);
    const result = await stopProxyGracefully(1234, {
      readRuntime: () => ({ pid: 1234, port: 10100, hostname: "127.0.0.1", attestationSecret }),
      verifyPidFn: candidate => candidate,
      waitExit: () => true,
      env: {
        CODEXCOMMANDER_API_AUTH_TOKEN: "data-secret",
        CODEXCOMMANDER_ADMIN_AUTH_TOKEN: "admin-secret",
      },
      fetchFn: async (input, init) => {
        if (String(input).endsWith("/healthz")) {
          const challenge = new Headers(init?.headers).get(ATTESTATION_CHALLENGE_HEADER)!;
          const proof = createLocalAttestationProof(attestationSecret, challenge, 1234, 10100)!;
          return new Response("", { headers: { [ATTESTATION_PROOF_HEADER]: proof } });
        }
        token = new Headers(init?.headers).get(API_KEY_HEADER);
        return new Response(null, { status: 200 });
      },
    });
    expect(result).toBe(true);
    expect(token).toBe("admin-secret");
  });

  test("Claude context discovery sends the management token", async () => {
    process.env.CODEXCOMMANDER_API_AUTH_TOKEN = "data-secret";
    process.env.CODEXCOMMANDER_ADMIN_AUTH_TOKEN = "admin-secret";
    let token: string | null = null;
    const attestationSecret = "A".repeat(43);
    const fetchImpl = (async (input, init) => {
      if (String(input).endsWith("/healthz")) {
        const challenge = new Headers(init?.headers).get(ATTESTATION_CHALLENGE_HEADER)!;
        const proof = createLocalAttestationProof(attestationSecret, challenge, 4242, 10100)!;
        return new Response("", { headers: { [ATTESTATION_PROOF_HEADER]: proof } });
      }
      token = new Headers(init?.headers).get(API_KEY_HEADER);
      return Response.json({ contextWindows: { "gpt-test": 200_000 } });
    }) as typeof fetch;
    globalThis.fetch = fetchImpl;
    const config = {
      port: 10100,
      defaultProvider: "test",
      providers: {},
      apiKeys: [{
        id: "configured",
        name: "Configured data key",
        key: "ccx_data_configured-secret",
        createdAt: "2026-07-28T00:00:00.000Z",
      }],
    } as CodexCommanderConfig;

    expect(await fetchClaudeContextWindows(config, 10100, 3_000, {
      fetchFn: fetchImpl,
      readRuntimeFn: () => ({ pid: 4242, port: 10100, hostname: "127.0.0.1", attestationSecret }),
      verifyPidFn: candidate => candidate,
    })).toEqual({ "gpt-test": 200_000 });
    expect(token).toBe("admin-secret");
  });
});
