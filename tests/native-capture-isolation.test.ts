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

test("the Bun child actually ignores dotenv, inherited credentials and cwd preload configuration", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const home = await mkdtemp(join(tmpdir(), "ccx-offline-env-test-"));
  try {
    await Bun.write(join(home, ".env"), "OPENAI_API_KEY=fixture\nHTTP_PROXY=http://127.0.0.1:1\n");
    await Bun.write(join(home, "bunfig.toml"), 'preload = ["./fixture-preload.ts"]\n');
    await Bun.write(join(home, "fixture-preload.ts"), 'process.env.FIXTURE_PRELOAD = "loaded";');
    await Bun.write(join(home, "isolated.toml"), "");
    const child = Bun.spawn([process.execPath, "--no-env-file", `--config=${join(home, "isolated.toml")}`, "-e", 'console.log(JSON.stringify([Boolean(process.env.OPENAI_API_KEY),Boolean(process.env.HTTP_PROXY),Boolean(process.env.FIXTURE_PRELOAD)]))'], { cwd: home, env: isolatedEnvironment(home), stdout: "pipe", stderr: "pipe" });
    const [output, , exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit).toBe(0); expect(JSON.parse(output)).toEqual([false, false, false]);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("bounded output termination awaits a sleeping capture child before cleanup", async () => {
  const { boundedChildText, interruptCaptureChild, settleCaptureChild } = await import("./helpers/inference-recorder");
  const child = Bun.spawn([process.execPath, "--no-env-file", "-e", 'console.log("fixture output");setInterval(()=>{},1000)'], { detached: process.platform !== "win32", env: {}, stdout: "pipe", stderr: "ignore" });
  try {
    await expect(boundedChildText(child.stdout, 1, () => interruptCaptureChild(child, true))).rejects.toThrow("output limit");
  } finally { await settleCaptureChild(child, true); }
  expect(await child.exited).not.toBe(0);
  expect(() => process.kill(child.pid, 0)).toThrow();
});
