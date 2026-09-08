import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { warmCodexAccount } from "../src/codex/warmup";
import { validateApiKey } from "../src/oauth/key-providers";
import { readDispatchJournal } from "../src/usage/dispatch-log";

const originalFetch = globalThis.fetch;
let root: string;
let previousHome: string | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ccx-validation-accounting-"));
  previousHome = process.env.CODEXCOMMANDER_HOME;
  process.env.CODEXCOMMANDER_HOME = root;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (previousHome === undefined) delete process.env.CODEXCOMMANDER_HOME;
  else process.env.CODEXCOMMANDER_HOME = previousHome;
  rmSync(root, { recursive: true, force: true });
});

test("warmup fallback records one validation request and separate model attempts without credentials", async () => {
  let calls = 0;
  globalThis.fetch = (async () => ++calls === 1
    ? new Response("unavailable model", { status: 400 })
    : new Response('data: {"type":"response.completed","response":{"usage":{"input_tokens":2,"output_tokens":1}}}\n\n')) as typeof fetch;
  await warmCodexAccount({ accessToken: "validation-private-token", chatgptAccountId: "validation-private-account" });
  const journal = readDispatchJournal();
  expect(calls).toBe(2);
  expect(journal.requests).toHaveLength(1);
  expect(journal.attempts).toHaveLength(2);
  expect(journal.sends.map(send => send.outcome)).toEqual(["protocol_failure", "protocol_success"]);
  expect(journal.sends.every(send => send.start.metadata?.surface === "validation" && send.start.metadata?.reason === "warmup")).toBe(true);
  expect(journal.sends[1]?.usage).toMatchObject({ inputTokens: 2, outputTokens: 1 });
  const raw = readFileSync(join(root, "dispatch.jsonl"), "utf8");
  expect(raw).not.toContain("validation-private");
  expect(raw).not.toContain("Reply with OK");
});

test("warmup EOF stays unknown and transport errors retain original failure", async () => {
  globalThis.fetch = (async () => new Response('data: {"type":"response.created"}\n\n')) as typeof fetch;
  await expect(warmCodexAccount({ accessToken: "fixture", chatgptAccountId: "fixture" })).rejects.toMatchObject({ code: "no_terminal" });
  expect(readDispatchJournal().sends[0]?.outcome).toBe("unknown");
  globalThis.fetch = (async () => { throw new Error("fixture rejection"); }) as typeof fetch;
  await expect(warmCodexAccount({ accessToken: "fixture", chatgptAccountId: "fixture" })).rejects.toMatchObject({ code: "transport" });
  expect(readDispatchJournal().sends[1]?.outcome).toBe("transport_failure");
});

test("Anthropic key validation counts inference while model discovery does not consume or create scope", async () => {
  const response = new Response('{"fixture":true}');
  globalThis.fetch = (async () => response) as typeof fetch;
  const provider = { label: "Fixture", dashboardUrl: "https://fixture.invalid", adapter: "anthropic" as const, baseUrl: "https://fixture.invalid" };
  expect(await validateApiKey("fixture", provider, "validation-private-key")).toBe(true);
  expect(response.bodyUsed).toBe(false);
  const journal = readDispatchJournal();
  expect(journal.requests).toHaveLength(1);
  expect(journal.sends).toHaveLength(1);
  expect(journal.sends[0]).toMatchObject({ outcome: "unknown", start: { metadata: { surface: "validation", reason: "key-validation" } } });
  globalThis.fetch = (async () => new Response('{"data":[]}')) as typeof fetch;
  expect(await validateApiKey("fixture", { ...provider, adapter: "openai-chat" }, "fixture")).toBe(true);
  expect(readDispatchJournal().requests).toHaveLength(1);
  expect(readFileSync(join(root, "dispatch.jsonl"), "utf8")).not.toContain("validation-private-key");
});
