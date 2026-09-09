import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { BASELINE_REVISION, boundedChildText, guardedFetch, isolatedEnvironment, interruptCaptureChild, settleCaptureChild } from "./inference-recorder";
import { fakeChatGptJwt } from "./fake-chatgpt-jwt";
import { nativeSuccessSSE } from "../fixtures/inference-accounting/fixtures";
import { semanticDiff } from "./inference-diff";

export const REQUIRED_HTTP_SCENARIOS = ["actual-client-tool-continuation", "image-compact-passthrough", "exact-account2-one-send-rejection", "same-account-full-input", "missing-provenance", "retry-reset-5xx-eof", "cancellation"] as const;
type Verdict = "PASS" | "FAIL" | "UNAVAILABLE";
type Scenario = typeof REQUIRED_HTTP_SCENARIOS[number];
export interface HttpScenarioEvidence { id: Scenario; verdict: Verdict; evidence: "actual_client_full_ingress" | "executed_production_mock" | "unavailable"; receiptSha256?: string }
export interface HttpPilotQualification {
  schemaVersion: 1; mockTests?: { exitCode: number; passed: number; failed: number }; reason?: string; verdict: Verdict; actualClientFullIngress: boolean; requiredScenariosComplete: boolean; dispatchComplete: boolean;
  identity: { clientSha256: string | null; runtimeSourceSha256: string | null; configSha256: string | null; catalogSha256: string | null; transport: "http" };
  requiredScenarios: HttpScenarioEvidence[]; containmentVerified: boolean; baselinePresent: boolean;
  desktopNativeDefault: "UNAVAILABLE"; debitParity: "UNAVAILABLE";
  capture?: { directSends: number; commanderSends: number; canonicalSends: number; nativeRoute: boolean; ownershipPresent: boolean; continuationPresent: boolean; differingPaths: string[]; clientExitCodes: number[]; ingressDifferingPaths: string[]; dispatchSends: number; providerUsageSends: number };
}
export function qualifyHttpPilot(input: Partial<HttpPilotQualification>): HttpPilotQualification {
  const requiredScenarios = REQUIRED_HTTP_SCENARIOS.map(id => input.requiredScenarios?.find(row => row.id === id) ?? { id, verdict: "UNAVAILABLE" as const, evidence: "unavailable" as const });
  const requiredScenariosComplete = requiredScenarios.every(row => row.verdict === "PASS" && row.evidence !== "unavailable" && /^[a-f0-9]{64}$/.test(row.receiptSha256 ?? ""));
  const identity = input.identity ?? { clientSha256: null, runtimeSourceSha256: null, configSha256: null, catalogSha256: null, transport: "http" };
  const capture = input.capture;
  const actualClientFullIngress = input.actualClientFullIngress === true && capture?.directSends === 2 && capture.commanderSends === 2 && capture.canonicalSends === 2 && capture.nativeRoute && capture.ownershipPresent && capture.continuationPresent && capture.clientExitCodes.length === 2 && capture.clientExitCodes.every(code => code === 0);
  const dispatchComplete = input.dispatchComplete === true && capture?.dispatchSends === 2 && capture.providerUsageSends === 2;
  const complete = actualClientFullIngress && dispatchComplete && requiredScenariosComplete && input.containmentVerified === true && input.baselinePresent === true && identity.transport === "http" && (["clientSha256", "runtimeSourceSha256", "configSha256", "catalogSha256"] as const).every(key => typeof identity[key] === "string" && /^[a-f0-9]{64}$/.test(identity[key]!));
  return { ...input, schemaVersion: 1, identity, actualClientFullIngress, dispatchComplete, requiredScenariosComplete, requiredScenarios, containmentVerified: input.containmentVerified === true, baselinePresent: input.baselinePresent === true, verdict: requiredScenarios.some(row => row.verdict === "FAIL") ? "FAIL" : complete ? "PASS" : "UNAVAILABLE", desktopNativeDefault: "UNAVAILABLE", debitParity: "UNAVAILABLE" };
}
/** Only ephemeral identity values and exact builtin execution timing wrappers vary between fresh clients.
 * Presence, relationships, opaque provider IDs and all other body fields remain significant. */
export function normalizeClientRun(rows: readonly Record<string, any>[]): unknown {
  const ids = new Map<string, string>();
  const identity = (value: unknown) => {
    if (typeof value !== "string") return value;
    if (!ids.has(value)) ids.set(value, `fixture-identity-${ids.size}`);
    return ids.get(value);
  };
  return rows.map(row => {
    const copy = structuredClone(row);
    if (Object.hasOwn(copy, "prompt_cache_key")) copy.prompt_cache_key = identity(copy.prompt_cache_key);
    if (copy.client_metadata && typeof copy.client_metadata === "object") {
      for (const key of ["thread_id", "session_id", "turn_id", "root_turn_id", "x-codex-installation-id", "x-codex-window-id", "x-codex-session-id"]) if (Object.hasOwn(copy.client_metadata, key)) copy.client_metadata[key] = identity(copy.client_metadata[key]);
    }
    if (typeof copy.client_metadata?.["x-codex-turn-metadata"] === "string") {
      try { const metadata = JSON.parse(copy.client_metadata["x-codex-turn-metadata"]); for (const key of ["installation_id", "session_id", "thread_id", "turn_id", "window_id", "context_window_id", "root_turn_id"]) if (Object.hasOwn(metadata, key)) metadata[key] = identity(metadata[key]); if (typeof metadata.turn_started_at_unix_ms === "number" && Number.isFinite(metadata.turn_started_at_unix_ms)) metadata.turn_started_at_unix_ms = 0; copy.client_metadata["x-codex-turn-metadata"] = JSON.stringify(metadata); } catch {}
    }
    if (Array.isArray(copy.input)) for (const item of copy.input) {
      if (item.type === "message" && typeof item.id === "string" && !item.id.startsWith("fixture-")) item.id = identity(item.id);
      if (item.type === "function_call_output" && item.call_id === "call_fixture") {
        if (typeof item.id === "string") item.id = identity(item.id);
        if (typeof item.output === "string") item.output = item.output
          .replace(/^Chunk ID: [a-f0-9]+\n/, "Chunk ID: fixture\n")
          .replace(/^Wall time: [0-9.]+ seconds\n/m, "Wall time: fixture seconds\n")
          .replace(/^Wall time: [0-9.]+s\n/m, "Wall time: fixture seconds\n");
      }
    }
    return copy;
  });
}
const CANONICAL = "https://chatgpt.com/backend-api/codex/responses";
/** Installed before runtime import. This never changes the effective canonical provider config. */
export function canonicalRecorderFetch(recorder: string, origins: ReadonlySet<string>, implementation: typeof fetch = fetch, onCanonical?: () => void): typeof fetch {
  const guarded = guardedFetch(origins, implementation);
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (url !== CANONICAL) return guarded(input, init);
    onCanonical?.();
    return guarded(input instanceof Request ? new Request(`${recorder}/responses`, input) : `${recorder}/responses`, init);
  }) as typeof fetch;
}
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const disabled = ["shell_snapshot", "code_mode_host", "apps", "browser_use", "browser_use_external", "computer_use", "hooks", "image_generation", "in_app_browser", "in_app_chat", "in_app_local_automation", "plugins", "remote_plugin", "multi_agent", "multi_agent_v2", "skill_mcp_dependency_install", "skill_search", "sleep_tool", "view_image", "workspace_dependencies"];
function toolResponse(body: Record<string, any>): string {
  const tools = body.tools ?? [];
  if (!Array.isArray(tools) || tools.some((tool: any) => /^(mcp|browser|computer|web_search|image_gen|apps)/.test(String(tool.name ?? tool.type)))) throw new Error("external tool schema unavailable");
  // Only a fixed, harmless command is ever requested; unknown client tool schemas fail closed.
  const exec = tools.find((tool: any) => tool.type === "function" && ["exec_command", "shell_command", "shell"].includes(tool.name));
  if (!exec) throw new Error("native exec capability unavailable");
  const argumentsValue = exec.name === "exec_command" ? { cmd: "/usr/bin/printf fixture-tool", max_output_tokens: 256 } : exec.name === "shell_command" ? { command: "/usr/bin/printf fixture-tool" } : { command: ["/usr/bin/printf", "fixture-tool"] };
  const item = { type: "function_call", id: "fc_fixture", call_id: "call_fixture", name: exec.name, arguments: JSON.stringify(argumentsValue), status: "completed" };
  const reasoning = { type: "reasoning", id: "rs_fixture", summary: [], encrypted_content: "fixture-opaque-encrypted-state" };
  return [{ type: "response.created", response: { id: "resp_fixture_tool", status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: reasoning }, { type: "response.output_item.done", output_index: 0, item: reasoning },
    { type: "response.output_item.added", output_index: 1, item: { ...item, arguments: "", status: "in_progress" } },
    { type: "response.function_call_arguments.delta", output_index: 1, item_id: item.id, delta: item.arguments },
    { type: "response.output_item.done", output_index: 1, item },
    { type: "response.completed", response: { id: "resp_fixture_tool", status: "completed", output: [reasoning, item], usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } } }].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}
/** Child-only execution: disposable homes are established before this module imports runtime code. */
let failureStage = "capability";
async function runHttpQualification(sourceRoot: string): Promise<HttpPilotQualification> {
  const binary = "/Applications/ChatGPT.app/Contents/Resources/codex";
  if (process.platform !== "darwin" || !await Bun.file("/usr/bin/sandbox-exec").exists() || !await Bun.file(binary).exists()) return qualifyHttpPilot({});
  const home = process.env.HOME!;
  const runtimeDigest = createHash("sha256");
  for (const path of [...new Bun.Glob("src/**/*.{ts,mjs}").scanSync({ cwd: sourceRoot })].sort()) { runtimeDigest.update(path); runtimeDigest.update(await readFile(join(sourceRoot, path))); }
  const ingress: Record<string, any>[] = [];
  const token = fakeChatGptJwt({ chatgpt_account_id: "fixture-account-a" });
  const wire: Record<string, any>[][] = [[], []]; let arm = 0; let badCapture = false; let deniedRequests = 0; let canonicalSends = 0;
  const denied = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { deniedRequests++; return new Response(null); } });
  const recorder = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (new URL(request.url).pathname === "/containment") return new Response("allowed");
    try {
      if (request.method !== "POST" || new URL(request.url).pathname !== "/responses" || wire[arm]!.length >= 2) throw new Error("capture route or count rejected");
      if (request.headers.get("authorization") !== `Bearer ${token}`) throw new Error("synthetic owner mismatch");
      const body = JSON.parse(await boundedChildText(request.body!, 524288, () => {}));
      wire[arm]!.push(body);
      return new Response(wire[arm]!.length === 1 ? toolResponse(body) : nativeSuccessSSE, { headers: { "content-type": "text/event-stream" } });
    } catch { badCapture = true; return new Response(null, { status: 400 }); }
  } });
  const recorderOrigin = `http://127.0.0.1:${recorder.port}`;
  const origins = new Set([recorderOrigin]); const oldFetch = globalThis.fetch;
  globalThis.fetch = canonicalRecorderFetch(recorderOrigin, origins, oldFetch, () => canonicalSends++);
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    const provider = { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward", codexAccountMode: "direct" };
    const configValue = { port: 0, hostname: "127.0.0.1", multiAgentGuidanceEnabled: false, defaultProvider: "openai", providers: { openai: provider } };
    failureStage = "config_import";
    const config = await import(join(sourceRoot, "src/config.ts"));
    failureStage = "config_save"; config.saveConfig(configValue);
    failureStage = "runtime_import";
    const runtime = await import(join(sourceRoot, "src/server/index.ts"));
    const nativePolicy = await import(join(sourceRoot, "src/responses/native-policy.ts"));
    failureStage = "server_start";
    const serve = Bun.serve;
    (Bun as any).serve = (options: any) => serve({ ...options, async fetch(request: Request, context: any) {
      if (new URL(request.url).pathname === "/v1/responses" && request.method === "POST") ingress.push(JSON.parse(await boundedChildText(request.clone().body!, 524288, () => {})));
      return options.fetch(request, context);
    } });
    try { server = runtime.startServer(0, { managementAuthState: { available: false, reason: "offline fixture" } }); }
    finally { Bun.serve = serve; }
    const commanderOrigin = `http://127.0.0.1:${server!.port}`; origins.add(commanderOrigin);
    const profile = `(version 1) (allow default) (deny network*) (allow network-outbound (remote tcp "localhost:${recorder.port}") (remote tcp "localhost:${server!.port}"))`;
    const env = { ...isolatedEnvironment(home), RUST_LOG: "off", FIXTURE_CODEX_TOKEN: token };
    const run = async (args: string[], limit: number) => {
      const child = Bun.spawn(["/usr/bin/sandbox-exec", "-p", profile, ...args], { cwd: home, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const stop = () => interruptCaptureChild(child); const timer = setTimeout(stop, limit);
      try { const [output, , code] = await Promise.all([boundedChildText(child.stdout, 65536, stop), boundedChildText(child.stderr, 65536, stop), child.exited]); return { output, code }; }
      finally { clearTimeout(timer); await settleCaptureChild(child); }
    };
    failureStage = "containment_smoke";
    const smoke = await run([process.execPath, "--no-env-file", `--config=${join(home, "bunfig.toml")}`, "-e", `for(const url of ${JSON.stringify([recorderOrigin + "/containment", commanderOrigin + "/health"])}){const r=await fetch(url,{proxy:null});if(!r)process.exit(2)}try{await fetch("http://127.0.0.1:${denied.port}",{proxy:null});process.exit(3)}catch{}console.log("contained")`], 5000);
    if (smoke.code || smoke.output.trim() !== "contained" || deniedRequests) return qualifyHttpPilot({ reason: "containment_smoke_failed" });
    const version = await run([binary, "--version"], 5000);
    if (version.code || !/^codex-cli \d+\.\d+\.\d+\s*$/.test(version.output)) return qualifyHttpPilot({ containmentVerified: true });
    failureStage = "client_arms";
    const codes: number[] = [];
    for (arm = 0; arm < 2; arm++) {
      // Fresh client state, identical workspace path and prompt across both arms.
      // The outer OS sandbox owns containment. Nested client read-only sandboxing blocks
      // this installed CLI builtin exec; only the fixed printf fixture is requested.
      await rm(join(home, "codex"), { recursive: true, force: true }); await mkdir(join(home, "codex"));
      const origin = arm === 0 ? recorderOrigin : `${commanderOrigin}/v1`;
      const result = await run([binary, "exec", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", "--json", "-s", "danger-full-access", "-C", home,
        ...disabled.flatMap(feature => ["--disable", feature]), "--enable", "skip_host_skill_discovery", "--enable", "shell_tool", "--enable", "unified_exec",
        "-c", 'web_search="disabled"', "-c", 'model="gpt-5.4"', "-c", 'model_provider="fixture"', "-c", 'model_providers.fixture.name="Synthetic loopback"', "-c", `model_providers.fixture.base_url="${origin}"`,
        "-c", 'model_providers.fixture.env_key="FIXTURE_CODEX_TOKEN"', "-c", 'model_providers.fixture.wire_api="responses"', "-c", "model_providers.fixture.requires_openai_auth=false", "-c", "model_providers.fixture.supports_websockets=false", "-c", "model_providers.fixture.request_max_retries=0", "-c", "model_providers.fixture.stream_max_retries=0", "fixture prompt"], 12000);
      codes.push(result.code);
    }
    failureStage = "accounting";
    const { readDispatchJournal } = await import(join(sourceRoot, "src/usage/dispatch-log.ts"));
    const { summarizeDispatchEvents } = await import(join(sourceRoot, "src/usage/dispatch-summary.ts"));
    const journal = readDispatchJournal(); const summary = summarizeDispatchEvents(journal.events, journal);
    const nativeRoute = nativePolicy.isNativeResponsesProvider(provider);
    const ownershipPresent = Boolean(nativePolicy.nativeRequestOwner(provider, new Headers({ authorization: `Bearer ${token}` })));
    const continuationPresent = wire.every(rows => rows.length === 2 && Array.isArray(rows[1]?.input) && rows[1]!.input.some((item: any) => item.type === "function_call_output" && item.call_id === "call_fixture" && typeof item.output === "string" && /(?:^|\n)(?:Process exited with code 0|Exit code: 0)\n/.test(item.output) && item.output.trimEnd().endsWith("\nfixture-tool")) && rows[1]!.input.some((item: any) => item.type === "reasoning" && item.id === "rs_fixture" && item.encrypted_content === "fixture-opaque-encrypted-state"));
    const differences = semanticDiff(normalizeClientRun(wire[0]!), normalizeClientRun(wire[1]!));
    const ingressDifferences = semanticDiff(ingress, wire[1]);
    // No values, arbitrary field names, instructions, tool results or credentials leave memory.
    const safeKeys = new Set(["model", "input", "tools", "instructions", "type", "content", "text", "id", "encrypted_content", "call_id", "arguments", "output", "name", "reasoning", "effort", "store", "stream", "include", "client_metadata", "prompt_cache_key", "x-codex-turn-metadata", "x-codex-thread-id"]);
    const differingPaths = [...new Set(differences.map(diff => diff.path.split("/").map(part => part === "" || /^\d+$/.test(part) || (safeKeys.has(part) || /^(x-codex-[a-z_-]+|x-openai-[a-z_-]+|session_id|thread_id|turn_id|conversation_id)$/.test(part)) ? part : "opaque-field").join("/")))];
    const runtimeSourceSha256 = runtimeDigest.digest("hex");
    const mockFiles = ["tests/native-http-policy.test.ts", "tests/native-http-qualification-scenarios.test.ts", "tests/upstream-retry.test.ts", "tests/upstream-transient-retry.test.ts", "tests/passthrough-abort.test.ts"];
    const mockChild = Bun.spawn(["/usr/bin/sandbox-exec", "-p", "(version 1) (allow default) (deny network*)", process.execPath, "--no-env-file", `--config=${join(home, "bunfig.toml")}`, "test", ...mockFiles.map(file => join(sourceRoot, file))], { cwd: home, env: isolatedEnvironment(home), stdout: "pipe", stderr: "pipe" });
    const stopMock = () => interruptCaptureChild(mockChild); const mockTimer = setTimeout(stopMock, 20000);
    let mockCode = -1; let mockOutput = "";
    try { const [stdout, stderr, code] = await Promise.all([boundedChildText(mockChild.stdout, 65536, stopMock), boundedChildText(mockChild.stderr, 65536, stopMock), mockChild.exited]); mockCode = code; mockOutput = stdout + stderr; }
    finally { clearTimeout(mockTimer); await settleCaptureChild(mockChild); }
    const mockPassed = mockCode === 0 && /\b0 fail\b/.test(mockOutput) && !/\b[1-9]\d* (skip|todo)\b/.test(mockOutput);
    const mockBindings: { id: Scenario; titles: string[] }[] = [
      { id: "image-compact-passthrough", titles: ["qualification native compact image and opaque input passthrough", "qualification native responses image and opaque input passthrough"] },
      { id: "exact-account2-one-send-rejection", titles: ["native responses exact second account returns opaque rejection without retry or stripping", "native compact exact second account returns opaque rejection without retry or stripping"] },
      { id: "same-account-full-input", titles: ["same-account canonical continuation with full input never appends cached history"] },
      { id: "missing-provenance", titles: ["unknown turn state is omitted without replay or an extra send"] },
      { id: "retry-reset-5xx-eof", titles: ["retries a Bun-shaped reset and returns the second attempt's response", "retries a 502 then returns the 200; failed body is cancelled", "SSE passthrough reports incomplete on EOF before a terminal payload"] },
      { id: "cancellation", titles: ["CASE A: client cancel aborts the upstream fetch", "turn-level abort signal aborts the upstream fetch before headers arrive"] },
    ];
    const mockSourceHash = hash((await Promise.all(mockFiles.map(file => readFile(join(sourceRoot, file), "utf8")))).join("\n"));
    const mockEvidence: HttpScenarioEvidence[] = mockBindings.map(binding => ({ id: binding.id, evidence: "executed_production_mock", verdict: mockPassed && binding.titles.every(title => mockOutput.split("\n").some(line => line.startsWith("(pass)") && line.includes(title))) ? "PASS" : "UNAVAILABLE", receiptSha256: hash(JSON.stringify({ mockCode, source: mockSourceHash, runtimeSourceSha256, titles: binding.titles, passed: binding.titles.map(title => mockOutput.split("\n").some(line => line.startsWith("(pass)") && line.includes(title))) })) }));
    const baseline = Bun.spawn(["/usr/bin/git", "cat-file", "-e", `${BASELINE_REVISION}^{commit}`], { cwd: sourceRoot, env: isolatedEnvironment(home), stdout: "ignore", stderr: "ignore" });
    const baselinePresent = await baseline.exited === 0;
    const capture = { directSends: wire[0]!.length, commanderSends: wire[1]!.length, canonicalSends, nativeRoute, ownershipPresent, continuationPresent, differingPaths, ingressDifferingPaths: [...new Set(ingressDifferences.map(diff => diff.path.split("/").map(part => part === "" || /^\d+$/.test(part) || (safeKeys.has(part) || /^(x-codex-[a-z_-]+|x-openai-[a-z_-]+|session_id|thread_id|turn_id|conversation_id)$/.test(part)) ? part : "opaque-field").join("/")))], clientExitCodes: codes, dispatchSends: summary.counts.sends, providerUsageSends: summary.providerTokens.observedSends };
    const actualClientFullIngress = !badCapture && codes.every(code => code === 0) && continuationPresent && canonicalSends === 2 && nativeRoute && ownershipPresent;
    const dispatchComplete = summary.eventCoverageComplete && summary.complete && summary.counts.sends === 2;
    const clientSha256 = hash(await readFile(binary));
    const catalogBytes = await readFile(join(sourceRoot, "tests/fixtures/catalog/native-codex-2026-09-08.json"));
    const catalog = JSON.parse(catalogBytes.toString("utf8"));
    const catalogSha256 = catalog.source?.version === version.output.trim() && catalog.source?.binary_sha256 === clientSha256 ? hash(catalogBytes) : null;
    const identity = { clientSha256, runtimeSourceSha256, configSha256: hash(JSON.stringify(configValue)), catalogSha256, transport: "http" as const };
    return qualifyHttpPilot({ mockTests: { exitCode: mockCode, passed: Number(/(\d+) pass\b/.exec(mockOutput)?.[1] ?? 0), failed: Number(/(\d+) fail\b/.exec(mockOutput)?.[1] ?? 0) }, identity, baselinePresent, containmentVerified: true, capture, actualClientFullIngress, dispatchComplete, requiredScenarios: [...mockEvidence, { id: "actual-client-tool-continuation", evidence: "actual_client_full_ingress", verdict: actualClientFullIngress && dispatchComplete ? differences.length === 0 && ingressDifferences.length === 0 ? "PASS" : "FAIL" : "UNAVAILABLE", receiptSha256: hash(JSON.stringify(capture)) }] });
  } finally { await server?.stop(true); recorder.stop(true); denied.stop(true); globalThis.fetch = oldFetch; }
}
export async function captureHttpQualificationInChild(sourceRoot: string, scratch: string): Promise<HttpPilotQualification> {
  const home = await mkdtemp(join(resolve(scratch), "http-qualification-"));
  try {
    await Promise.all(["tmp", "codex", "commander", "config"].map(name => mkdir(join(home, name)))); await Bun.write(join(home, "bunfig.toml"), "");
    const child = Bun.spawn([process.execPath, "--no-env-file", `--config=${join(home, "bunfig.toml")}`, resolve(import.meta.path), "--child", sourceRoot], { cwd: home, env: isolatedEnvironment(home), detached: true, stdout: "pipe", stderr: "pipe" });
    const stop = () => interruptCaptureChild(child, true); const timer = setTimeout(stop, 60000);
    try {
      const [output, , code] = await Promise.all([boundedChildText(child.stdout, 65536, stop), boundedChildText(child.stderr, 65536, stop), child.exited]);
      return code === 0 ? qualifyHttpPilot(JSON.parse(output)) : qualifyHttpPilot({});
    } finally { clearTimeout(timer); await settleCaptureChild(child, true); }
  } finally { await rm(home, { recursive: true, force: true }); }
}
if (import.meta.main) {
  if (process.argv[2] !== "--child" || process.argv.length !== 4) throw new Error("offline child invocation required");
  console.log = console.warn = console.info = console.error = () => {};
  try { process.stdout.write(JSON.stringify(await runHttpQualification(process.argv[3]!))); }
  catch { process.stdout.write(JSON.stringify(qualifyHttpPilot({ reason: failureStage }))); }
}
