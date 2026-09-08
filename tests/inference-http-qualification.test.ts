import { expect, test } from "bun:test";
import { qualifyHttpPilot, REQUIRED_HTTP_SCENARIOS, canonicalRecorderFetch } from "./helpers/inference-http-qualification";

test("adapter evidence cannot qualify full HTTP ingress and missing scenarios fail closed", () => {
  const result = qualifyHttpPilot({});
  expect(result.verdict).toBe("UNAVAILABLE");
  expect(result.actualClientFullIngress).toBe(false);
  expect(result.requiredScenariosComplete).toBe(false);
  expect(result.requiredScenarios.map(row => row.id)).toEqual([...REQUIRED_HTTP_SCENARIOS]);
});
test("canonical seam redirects only the exact canonical URL and rejects redirects and other egress", async () => {
  let calls = 0;
  const fetcher = canonicalRecorderFetch("http://127.0.0.1:1234", new Set(["http://127.0.0.1:1234"]), (async (url, init) => {
    calls++; expect(String(url)).toBe("http://127.0.0.1:1234/responses");
    expect(init?.redirect).toBe("manual"); return new Response(null);
  }) as typeof fetch);
  await fetcher("https://chatgpt.com/backend-api/codex/responses");
  for (const url of ["https://chatgpt.com/backend-api/codex/responses?x=1", "https://api.openai.com/v1/responses", "http://127.0.0.1:1235", "https://chatgpt.com/backend-api/codex/responses/", "https://user@chatgpt.com/backend-api/codex/responses"]) await expect(fetcher(url)).rejects.toThrow();
  expect(calls).toBe(1);
});

test("fresh-client identity normalization preserves relationships and all substantive history", async () => {
  const { normalizeClientRun } = await import("./helpers/inference-http-qualification");
  const arm = (id: string, elapsed: string) => [{ prompt_cache_key: id, client_metadata: { thread_id: id, root_turn_id: id, "x-codex-turn-metadata": JSON.stringify({ thread_id: id, turn_started_at_unix_ms: Number(elapsed), request_kind: "fixture" }) }, input: [{ type: "message", id, role: "user", content: "fixture" }, { type: "reasoning", id: "rs_fixture", encrypted_content: "fixture-ciphertext" }, { type: "function_call_output", id, call_id: "call_fixture", output: `Chunk ID: abc123\nWall time: ${elapsed} seconds\nProcess exited with code 0\nFinal output:\nfixture-tool` }] }];
  expect(normalizeClientRun(arm("client-a", "1"))).toEqual(normalizeClientRun(arm("client-b", "2")));
  for (const mutate of [
    (row: any) => row.input[1].encrypted_content = "changed",
    (row: any) => row.input[1].id = "rs_changed",
    (row: any) => row.input[2].output = row.input[2].output.replace("code 0", "code 1"),
    (row: any) => row.input[2].output = row.input[2].output.replace("fixture-tool", "changed"),
    (row: any) => delete row.input[0].id,
    (row: any) => row.client_metadata.thread_id = "different-relationship",
  ]) {
    const changed = arm("client-b", "2"); mutate(changed[0]); expect(normalizeClientRun(changed)).not.toEqual(normalizeClientRun(arm("client-a", "1")));
  }
});

test("missing capture, fixture receipt, usage, identity, containment or baseline never becomes ready", () => {
  const digest = "a".repeat(64);
  const complete = { actualClientFullIngress: true, dispatchComplete: true, containmentVerified: true, baselinePresent: true,
    identity: { clientSha256: digest, runtimeSourceSha256: digest, configSha256: digest, catalogSha256: digest, transport: "http" as const },
    capture: { directSends: 2, commanderSends: 2, canonicalSends: 2, nativeRoute: true, ownershipPresent: true, continuationPresent: true, differingPaths: [], ingressDifferingPaths: [], clientExitCodes: [0, 0], dispatchSends: 2, providerUsageSends: 2 },
    requiredScenarios: REQUIRED_HTTP_SCENARIOS.map(id => ({ id, verdict: "PASS" as const, evidence: "executed_production_mock" as const, receiptSha256: digest })) };
  expect(qualifyHttpPilot(complete).verdict).toBe("PASS");
  for (const mutate of [
    (row: any) => delete row.capture,
    (row: any) => row.capture.providerUsageSends = 1,
    (row: any) => row.capture.canonicalSends = 3,
    (row: any) => row.requiredScenarios.pop(),
    (row: any) => delete row.requiredScenarios[0].receiptSha256,
    (row: any) => row.identity.clientSha256 = null,
    (row: any) => delete row.identity.clientSha256,
    (row: any) => row.identity = {},
    (row: any) => row.containmentVerified = false,
    (row: any) => row.baselinePresent = false,
  ]) { const changed = structuredClone(complete); mutate(changed); expect(qualifyHttpPilot(changed).verdict).toBe("UNAVAILABLE"); }
  const failed = structuredClone(complete) as any; failed.requiredScenarios[0].verdict = "FAIL";
  expect(qualifyHttpPilot(failed).verdict).toBe("FAIL");
});
