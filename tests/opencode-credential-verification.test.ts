import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateApiKey } from "../src/oauth/key-providers";
import {
  noteProviderCredentialVerified,
  providerCredentialVerification,
  resetCredentialVerificationCacheForTests,
} from "../src/providers/credential-verification";
import type { OcxConfig } from "../src/types";

function config(key = "go-key-one"): OcxConfig {
  return {
    port: 10100,
    hostname: "127.0.0.1",
    defaultProvider: "opencode-go",
    providers: {
      "opencode-go": {
        adapter: "openai-chat",
        baseUrl: "https://opencode.ai/zen/go/v1",
        authMode: "key",
        apiKey: key,
      },
    },
  } as OcxConfig;
}

describe("OpenCode Go credential verification", () => {
  let root: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ocx-go-verify-"));
    previousHome = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = root;
    resetCredentialVerificationCacheForTests();
  });

  afterEach(() => {
    resetCredentialVerificationCacheForTests();
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  });

  test("public /models is never used to claim a key is valid", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ data: [{ id: "public-model" }] }));
    }) as typeof fetch;
    try {
      const result = await validateApiKey("opencode-go", {
        label: "OpenCode Go",
        baseUrl: "https://opencode.ai/zen/go/v1",
        dashboardUrl: "https://opencode.ai/console",
        adapter: "openai-chat",
      }, "definitely-invalid");
      expect(result).toBe("unknown");
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("first successful inference marks only the active key as verified", async () => {
    const first = config();
    expect(providerCredentialVerification(first, "opencode-go")).toBe("unverified");
    noteProviderCredentialVerified(first, "opencode-go", "go-key-one");
    await Bun.sleep(10);
    expect(providerCredentialVerification(first, "opencode-go")).toBe("verified");
    expect(providerCredentialVerification(config("go-key-two"), "opencode-go")).toBe("unverified");

    const raw = readFileSync(join(root, "provider-credential-verification.json"), "utf8");
    expect(raw).not.toContain("go-key-one");
    expect(raw).not.toContain("go-key-two");
  });

  test("malformed metadata is fail-closed and never overwritten by inference", async () => {
    mkdirSync(root, { recursive: true });
    const statePath = join(root, "provider-credential-verification.json");
    writeFileSync(statePath, "not-json\n");
    resetCredentialVerificationCacheForTests();
    noteProviderCredentialVerified(config(), "opencode-go", "go-key-one");
    await Bun.sleep(10);
    expect(readFileSync(statePath, "utf8")).toBe("not-json\n");
    expect(providerCredentialVerification(config(), "opencode-go")).toBe("unverified");
  });

  test("lookalike destinations never participate", async () => {
    const lookalike = config();
    lookalike.providers["opencode-go"]!.baseUrl = "https://evil.example/zen/go/v1";
    expect(providerCredentialVerification(lookalike, "opencode-go")).toBeNull();
    noteProviderCredentialVerified(lookalike, "opencode-go", "go-key-one");
    await Bun.sleep(5);
    expect(existsSync(join(root, "provider-credential-verification.json"))).toBe(false);
  });
});
