import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeLiveCatalogSnapshotPath, peekNativeLiveCatalog, refreshNativeLiveCatalog } from "../src/codex/catalog/native-live";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ccx-native-live-"));
  dirs.push(dir);
  return {
    configDir: dir,
    codexHome: dir,
    runtime: { command: "/bin/codex", version: "1.2.3" },
    token: { accessToken: "secret-token", chatgptAccountId: "private-account" },
  };
}

function response(models: unknown) {
  return new Response(JSON.stringify({ models }), { headers: { "content-type": "application/json" } });
}

const model = { slug: "gpt-6-sol", display_name: "GPT-6 Sol", supported_reasoning_levels: [], context_window: 123456 };

describe("native live Codex catalog", () => {
  test("fetches native rows with bounded account request and retains metadata privately", async () => {
    const options = fixture();
    const seen: { url?: string; init?: RequestInit } = {};
    const result = await refreshNativeLiveCatalog({ ...options, fetch: async (input, init) => {
      seen.url = String(input);
      seen.init = init;
      return response([model]);
    } });
    expect(result.source).toBe("live");
    expect(result.catalog?.models?.[0]?.context_window).toBe(123456);
    expect(seen.url).toBe("https://chatgpt.com/backend-api/codex/models?client_version=1.2.3");
    expect(seen.init?.redirect).toBe("error");
    expect((seen.init?.headers as Record<string, string>).Authorization).toBe("Bearer secret-token");
    expect((seen.init?.headers as Record<string, string>).originator).toBe("Codex Desktop");
    const path = nativeLiveCatalogSnapshotPath(options.configDir);
    const raw = readFileSync(path, "utf8");
    expect(raw).not.toContain("secret-token");
    expect(raw).not.toContain("private-account");
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(peekNativeLiveCatalog(options).source).toBe("retained");
  });

  test("keeps last good only for the matching account and runtime", async () => {
    const options = fixture();
    await refreshNativeLiveCatalog({ ...options, fetch: async () => response([model]) });
    expect((await refreshNativeLiveCatalog({ ...options, force: true, fetch: async () => { throw new Error("offline"); } })).source).toBe("retained");
    expect(peekNativeLiveCatalog({ ...options, token: { ...options.token, chatgptAccountId: "other" } }).catalog).toBeNull();
    expect(peekNativeLiveCatalog({ ...options, runtime: { ...options.runtime, version: "1.2.4" } }).catalog).toBeNull();
  });

  test("rejects routed, duplicate and malformed native rows", async () => {
    for (const rows of [[model, model], [{ ...model, slug: "provider/gpt-6-sol" }], [{ slug: "gpt-6-sol" }]]) {
      const options = fixture();
      const result = await refreshNativeLiveCatalog({ ...options, fetch: async () => response(rows) });
      expect(result.source).toBe("unavailable");
      expect(result.catalog).toBeNull();
    }
  });

  test("does not publish a response after the main account switches", async () => {
    const options = fixture();
    let active = options.token;
    const result = await refreshNativeLiveCatalog({
      ...options,
      token: () => active,
      fetch: async () => {
        active = { accessToken: "new-token", chatgptAccountId: "new-account" };
        return response([model]);
      },
    });
    expect(result.source).toBe("unavailable");
    expect(peekNativeLiveCatalog({ ...options, token: active }).catalog).toBeNull();
  });

  test("does not publish a response after the selected runtime switches", async () => {
    const options = fixture();
    let runtime = options.runtime;
    const result = await refreshNativeLiveCatalog({
      ...options,
      runtime: () => runtime,
      fetch: async () => {
        runtime = { ...runtime, version: "1.2.4" };
        return response([model]);
      },
    });
    expect(result.source).toBe("unavailable");
    expect(peekNativeLiveCatalog({ ...options, runtime }).catalog).toBeNull();
  });

  test("shares an in-flight request and refreshes after TTL or force", async () => {
    const options = fixture();
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let now = 1_000_000;
    const fetcher = async () => { calls++; await gate; return response([model]); };
    const request = { ...options, now: () => now, fetch: fetcher };
    const first = refreshNativeLiveCatalog(request);
    const second = refreshNativeLiveCatalog(request);
    release();
    expect((await first).source).toBe("live");
    expect((await second).source).toBe("live");
    expect(calls).toBe(1);
    await refreshNativeLiveCatalog(request);
    expect(calls).toBe(1);
    await refreshNativeLiveCatalog({ ...request, force: true });
    expect(calls).toBe(2);
    now += 5 * 60_000 + 1;
    await refreshNativeLiveCatalog(request);
    expect(calls).toBe(3);
  });

  test("reports sanitized failure while using retained rows", async () => {
    const options = fixture();
    await refreshNativeLiveCatalog({ ...options, fetch: async () => response([model]) });
    const result = await refreshNativeLiveCatalog({ ...options, force: true, fetch: async () => { throw new Error("sensitive network details"); } });
    expect(result.source).toBe("retained");
    expect(result.reason).toBe("network");
    expect(JSON.stringify(result)).not.toContain("sensitive network details");
  });
});
