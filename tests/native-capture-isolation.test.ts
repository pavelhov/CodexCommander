import { expect, test } from "bun:test";
import { assertDeclaredLoopback, guardedFetch, isolatedEnvironment, nativeCaptureCapability } from "./helpers/inference-recorder";

test("remote destinations, undeclared ports and URL credentials fail before fetch", async () => {
  let calls = 0;
  const origins = new Set(["http://127.0.0.1:1234"]);
  const fetcher = guardedFetch(origins, (async () => { calls++; return new Response(null); }) as typeof fetch);
  for (const url of ["https://example.com", "http://localhost:1234", "http://127.0.0.1:1235", "http://user:pass@127.0.0.1:1234"]) {
    await expect(fetcher(url)).rejects.toThrow("destination rejected");
  }
  expect(calls).toBe(0);
  expect(assertDeclaredLoopback("http://127.0.0.1:1234/responses", origins).pathname).toBe("/responses");
});
test("redirect escape is disabled even with inherited fetch options", async () => {
  let observed: RequestInit | undefined;
  const fetcher = guardedFetch(new Set(["http://127.0.0.1:1234"]), (async (_input, init) => {
    observed = init; return new Response(null, { status: 307, headers: { location: "https://example.com" } });
  }) as typeof fetch);
  await expect(fetcher("http://127.0.0.1:1234", { redirect: "follow" })).rejects.toThrow("redirect rejected");
  expect(observed!.redirect).toBe("manual"); expect((observed as { proxy: unknown }).proxy).toBeNull();
});
test("child environment never copies provider, proxy, tools or native user configuration", () => {
  const env = isolatedEnvironment("/fixture/disposable");
  for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "HTTP_PROXY", "HTTPS_PROXY", "PATH", "BUN_OPTIONS", "NODE_OPTIONS", "CODEX_CONFIG", "MCP_CONFIG"]) expect(env[key]).toBeUndefined();
  expect(env.CODEX_HOME).toBe("/fixture/disposable/codex");
});
test("native evidence stays unavailable without verified containment and supported transport", () => {
  for (const args of [[false, false], [true, false], [true, true]]) {
    const result = nativeCaptureCapability(...args as [boolean, boolean]);
    expect(result.executed).toBe(false); expect(result.verdict).toBe("UNAVAILABLE");
    expect(result.desktopNativeDefault).toBe("UNAVAILABLE");
  }
});
