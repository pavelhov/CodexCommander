import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { saveConfig } from "../src/config";
import {
  getAccountSet,
  getAuthStorePath,
  oauthAccountSetRevision,
  saveCredential,
  setActiveAccount,
} from "../src/oauth/store";
import {
  createMediaActionAttestationProof,
  type MediaActionAttestationInput,
  verifyMediaActionAttestationProof,
} from "../src/lib/media-action-attestation";
import { createLocalAttestationSecret } from "../src/lib/local-management-attestation";
import { handleManagementAPI } from "../src/server/management-api";
import type { MediaManagementRuntime } from "../src/server/management/media-routes";
import type { CodexCommanderConfig } from "../src/types";
import { ManagementRequest } from "./helpers/management-auth";

let testDir = "";
let previousHome: string | undefined;

function config(): CodexCommanderConfig {
  return {
    port: 10100,
    multiAgentGuidanceEnabled: true,
    defaultProvider: "xai",
    providers: {
      xai: {
        adapter: "openai-chat",
        baseUrl: "https://api.x.ai/v1",
        authMode: "oauth",
      },
      anthropic: {
        adapter: "anthropic",
        baseUrl: "https://api.anthropic.com",
        authMode: "oauth",
      },
    },
    images: {
      bridgeEnabled: false,
      videoBridgeEnabled: true,
      authSource: "subscription_oauth",
    },
  };
}

async function addAccounts(provider: "xai" | "anthropic"): Promise<[string, string]> {
  await saveCredential(provider, {
    access: `${provider}-access-first`,
    refresh: `${provider}-refresh-first`,
    expires: Date.now() + 60_000,
    accountId: `${provider}-subject-first`,
  });
  await saveCredential(provider, {
    access: `${provider}-access-second`,
    refresh: `${provider}-refresh-second`,
    expires: Date.now() + 60_000,
    accountId: `${provider}-subject-second`,
  });
  const ids = getAccountSet(provider)!.accounts.map(account => account.id);
  await setActiveAccount(provider, ids[0]!);
  return [ids[0]!, ids[1]!];
}

beforeEach(() => {
  previousHome = process.env.CODEXCOMMANDER_HOME;
  testDir = mkdtempSync(join(tmpdir(), "ccx-xai-oauth-authz-"));
  process.env.CODEXCOMMANDER_HOME = testDir;
  saveConfig(config());
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.CODEXCOMMANDER_HOME;
  else process.env.CODEXCOMMANDER_HOME = previousHome;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

describe("xAI management billing-identity authorization", () => {
  test("raw admin cannot switch, delete, or logout the active subscription account", async () => {
    const cfg = config();
    const [first, second] = await addAccounts("xai");
    const before = readFileSync(getAuthStorePath(), "utf8");
    let attestationCalls = 0;
    const runtime: MediaManagementRuntime = {
      state: "ready",
      authorizeInteractiveCliAction: () => {
        attestationCalls += 1;
        return false;
      },
    };
    const dispatch = async (path: string, method: "PUT" | "DELETE" | "POST", body?: unknown) => {
      const req = new ManagementRequest(`http://127.0.0.1:10100${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return (await handleManagementAPI(req, new URL(req.url), cfg, { mediaManagement: runtime }, "admin-token"))!;
    };

    const switched = await dispatch("/api/oauth/accounts/active", "PUT", { provider: "xai", accountId: second });
    expect(switched.status).toBe(403);
    expect(await switched.json()).toMatchObject({ code: "xai_media_oauth_attestation_required" });
    expect(readFileSync(getAuthStorePath(), "utf8")).toBe(before);

    const removed = await dispatch(`/api/oauth/accounts?provider=xai&id=${encodeURIComponent(first)}`, "DELETE");
    expect(removed.status).toBe(403);
    expect(readFileSync(getAuthStorePath(), "utf8")).toBe(before);

    const logout = await dispatch("/api/oauth/logout?provider=xai", "POST");
    expect(logout.status).toBe(403);
    expect(readFileSync(getAuthStorePath(), "utf8")).toBe(before);
    expect(getAccountSet("xai")?.activeAccountId).toBe(first);
    expect(attestationCalls).toBe(0);
  });

  test("safe no-op/inactive xAI operations and unrelated providers remain compatible", async () => {
    const cfg = config();
    const [xaiFirst, xaiSecond] = await addAccounts("xai");
    const [anthropicFirst, anthropicSecond] = await addAccounts("anthropic");
    const dispatch = async (path: string, method: "PUT" | "DELETE", body?: unknown) => {
      const req = new ManagementRequest(`http://127.0.0.1:10100${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return (await handleManagementAPI(req, new URL(req.url), cfg, {}, "admin-token"))!;
    };

    expect((await dispatch("/api/oauth/accounts/active", "PUT", { provider: "xai", accountId: xaiFirst })).status).toBe(200);
    expect((await dispatch(`/api/oauth/accounts?provider=xai&id=${encodeURIComponent(xaiSecond)}`, "DELETE")).status).toBe(200);
    expect(getAccountSet("xai")?.activeAccountId).toBe(xaiFirst);

    expect((await dispatch("/api/oauth/accounts/active", "PUT", {
      provider: "anthropic",
      accountId: anthropicSecond,
    })).status).toBe(200);
    expect((await dispatch(`/api/oauth/accounts?provider=anthropic&id=${encodeURIComponent(anthropicFirst)}`, "DELETE")).status).toBe(200);
    expect(getAccountSet("anthropic")?.activeAccountId).toBe(anthropicSecond);
  });

  test("confirmed GUI and exact revision-bound CLI proof may change the xAI billing identity", async () => {
    const cfg = config();
    const [first, second] = await addAccounts("xai");
    const secret = createLocalAttestationSecret();
    const pid = 4_321;
    const port = 10_100;
    const now = 2_000_000_000_000;
    const consumed = new Set<string>();
    const runtime: MediaManagementRuntime = {
      state: "ready",
      authorizeInteractiveCliAction: (input, proof) => {
        if (consumed.has(input.nonce) || !verifyMediaActionAttestationProof(secret, input, pid, port, proof, now)) return false;
        consumed.add(input.nonce);
        return true;
      },
    };
    const dispatch = async (
      path: string,
      method: "PUT" | "DELETE",
      body: Record<string, unknown> | undefined,
      principal: "admin-token" | "confirmed-gui-session",
      proof?: string | null,
    ) => {
      const req = new ManagementRequest(`http://127.0.0.1:10100${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          ...(proof ? { "x-codexcommander-media-action-proof": proof } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return (await handleManagementAPI(req, new URL(req.url), cfg, { mediaManagement: runtime }, principal))!;
    };

    const gui = await dispatch(
      "/api/oauth/accounts/active",
      "PUT",
      { provider: "xai", accountId: second },
      "confirmed-gui-session",
    );
    expect(gui.status).toBe(200);
    expect(getAccountSet("xai")?.activeAccountId).toBe(second);

    const revision = oauthAccountSetRevision(getAccountSet("xai"));
    const envelope = {
      provider: "xai",
      accountId: first,
      expectedRevision: revision,
      action: "xai_oauth_select",
      target: "xai_oauth",
      id: first,
      confirmation: true,
      caller: "interactive_cli",
      nonce: "o".repeat(43),
      issuedAt: now,
    } satisfies MediaActionAttestationInput & Record<string, unknown>;
    const proof = createMediaActionAttestationProof(secret, envelope, pid, port);
    const cli = await dispatch("/api/oauth/accounts/active", "PUT", envelope, "admin-token", proof);
    expect(cli.status).toBe(200);
    expect(getAccountSet("xai")?.activeAccountId).toBe(first);

    const staleRemove = {
      provider: "xai",
      expectedRevision: revision,
      action: "xai_oauth_remove",
      target: "xai_oauth",
      id: first,
      confirmation: true,
      caller: "interactive_cli",
      nonce: "r".repeat(43),
      issuedAt: now,
    } satisfies MediaActionAttestationInput & Record<string, unknown>;
    const beforeStale = readFileSync(getAuthStorePath(), "utf8");
    const stale = await dispatch(
      `/api/oauth/accounts?provider=xai&id=${encodeURIComponent(first)}`,
      "DELETE",
      staleRemove,
      "admin-token",
      createMediaActionAttestationProof(secret, staleRemove, pid, port),
    );
    expect(stale.status).toBe(409);
    expect(readFileSync(getAuthStorePath(), "utf8")).toBe(beforeStale);

    const removeEnvelope = {
      ...staleRemove,
      expectedRevision: oauthAccountSetRevision(getAccountSet("xai")),
      nonce: "s".repeat(43),
    } satisfies MediaActionAttestationInput & Record<string, unknown>;
    const removed = await dispatch(
      `/api/oauth/accounts?provider=xai&id=${encodeURIComponent(first)}`,
      "DELETE",
      removeEnvelope,
      "admin-token",
      createMediaActionAttestationProof(secret, removeEnvelope, pid, port),
    );
    expect(removed.status).toBe(200);
    expect(getAccountSet("xai")?.activeAccountId).toBe(second);
  });
});
