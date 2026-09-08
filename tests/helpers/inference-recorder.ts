import type { DispatchEvent } from "../../src/usage/dispatch";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fixtures, syntheticBody, successSSE, nativeSuccessSSE } from "../fixtures/inference-accounting/fixtures";

export const BASELINE_REVISION = "f4f9b384db475e3dc7011394988269abc98123cc";
export function isolatedEnvironment(home: string): Record<string, string> {
  return { HOME: home, USERPROFILE: home, CODEX_HOME: join(home, "codex"), CODEXCOMMANDER_HOME: join(home, "commander"),
    XDG_CONFIG_HOME: join(home, "config"), TMPDIR: join(home, "tmp"), TEMP: join(home, "tmp"), TMP: join(home, "tmp"),
    NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1", TZ: "UTC" };
}
/** No native execution path exists without an implemented and verified OS containment backend. */
export function nativeCaptureCapability(binaryPresent = false, supportedTransport = false) {
  return { verdict: "UNAVAILABLE" as const, executed: false, transport: "custom-provider-http", desktopNativeDefault: "UNAVAILABLE",
    reason: !binaryPresent ? "binary_not_probed_without_containment" : !supportedTransport ? "unsupported_transport" : "os_egress_containment_unavailable" };
}
export function assertDeclaredLoopback(input: string | URL, origins: ReadonlySet<string>): URL {
  const url = new URL(input);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || !origins.has(url.origin)) {
    throw new Error("offline destination rejected");
  }
  return url;
}
export function guardedFetch(origins: ReadonlySet<string>, implementation: typeof fetch = fetch): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = assertDeclaredLoopback(input instanceof Request ? input.url : input.toString(), origins);
    if (init && "proxy" in init && (init as { proxy?: unknown }).proxy) throw new Error("offline proxy rejected");
    // Bun proxy:null explicitly bypasses proxy environment variables. Redirects never escape.
    const response = await implementation(input instanceof Request ? input : url, { ...init, redirect: "manual", proxy: null } as RequestInit);
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new Error("offline redirect rejected"); }
    return response;
  }) as typeof fetch;
}
const syntheticKeys = new Set<string>(["previous_response_id", "store", "instructions", "include"]);
const syntheticStrings = new Set<string>(["reasoning.encrypted_content", "keep-alive", "close", `Bun/${Bun.version}`, "gzip, deflate", "gzip, deflate, br, zstd", "", "fixture-account-b", "fixture-previous", "application/json", "*/*", "gzip, deflate, br", "identity"]);
function collectStrings(value: unknown): void {
  if (typeof value === "string") syntheticStrings.add(value);
  else if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) { syntheticKeys.add(key); collectStrings(child); }
}
collectStrings(syntheticBody);
const credentialKey = /^(authorization|proxy-authorization|cookie|set-cookie|api[-_]?key|access[-_]?token|refresh[-_]?token|password|secret)$/i;
/** Fail closed before any persistence. Unrecognized values are never echoed in errors. */
export function assertFixedSynthetic(value: unknown, depth = 0): void {
  if (depth > 32) throw new Error("capture depth rejected");
  if (typeof value === "string") { if (!syntheticStrings.has(value)) throw new Error("nonfixture capture rejected"); }
  else if (value === null || typeof value === "boolean") return;
  else if (typeof value === "number") { if (!Number.isFinite(value) || Math.abs(value) > 1e6) throw new Error("capture number rejected"); }
  else if (Array.isArray(value)) { if (value.length > 256) throw new Error("capture size rejected"); for (const item of value) assertFixedSynthetic(item, depth + 1); }
  else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (credentialKey.test(key) || !syntheticKeys.has(key)) throw new Error("capture field rejected");
      assertFixedSynthetic(item, depth + 1);
    }
  } else throw new Error("capture type rejected");
}
export interface WireCapture { path: string; method: string; headers: Record<string, string>; body: unknown }
export async function captureRequest(request: Request): Promise<WireCapture> {
  const text = await request.text();
  if (text.length > 64 * 1024) throw new Error("capture size rejected");
  const body: unknown = JSON.parse(text); assertFixedSynthetic(body);
  const headers: Record<string, string> = {};
  for (const [key, value] of request.headers) {
    if (credentialKey.test(key)) continue;
    if (["host", "content-length"].includes(key)) continue;
    if (!["accept", "accept-encoding", "connection", "content-type", "user-agent", "chatgpt-account-id"].includes(key) || !syntheticStrings.has(value)) throw new Error("nonfixture header rejected");
    headers[key] = value;
  }
  const path = new URL(request.url).pathname;
  if (!["/responses", "/v1/responses"].includes(path) || request.method !== "POST") throw new Error("capture route rejected");
  return { path, method: request.method, headers, body };
}
export interface FixtureCapture { id: string; wire: WireCapture[]; sends: number; clientAttempts: number; outcome: string; response: string; faultInjection: string; telemetry: { events: DispatchEvent[]; summary: unknown; available: boolean } }
export async function runAdapterCapture(sourceRoot: string, direct = false): Promise<FixtureCapture[]> {
  const origins = new Set<string>(); const originalFetch = globalThis.fetch;
  globalThis.fetch = guardedFetch(origins, originalFetch);
  const captures: FixtureCapture[] = [];
  // These modules have no provider discovery / native launch side effects. Every fetch remains guarded.
  try {
  const adapterModule = await import(pathToFileURL(resolve(sourceRoot, "src/adapters/openai-responses.ts")).href);
  const retry = await import(pathToFileURL(resolve(sourceRoot, "src/lib/upstream-retry.ts")).href);
  const accountingAvailable = !direct && await Bun.file(resolve(sourceRoot, "src/usage/dispatch-http.ts")).exists();
  const accounting = accountingAvailable ? await import(pathToFileURL(resolve(sourceRoot, "src/usage/dispatch.ts")).href) : undefined;
  const httpAccounting = accountingAvailable ? await import(pathToFileURL(resolve(sourceRoot, "src/usage/dispatch-http.ts")).href) : undefined;
  const budgetModule = await import(pathToFileURL(resolve(sourceRoot, "src/lib/translator-budget.ts")).href);
    for (const fixture of fixtures) {
      const wire: WireCapture[] = []; const events: DispatchEvent[] = [];
      const attempt = accounting?.createDispatchRequest((event: DispatchEvent) => events.push(event)).attempt({ surface: "responses", protocol: "responses" }); let captureFailure: unknown = false; const controller = new AbortController();
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
        try { wire.push(await captureRequest(request)); } catch (error) { captureFailure = error; return new Response(null, { status: 400 }); }
        if (fixture.fault === "cancel-before") { controller.abort(); return new Response(null); }
        if (fixture.fault === "401" || fixture.fault === "429") return new Response(null, { status: Number(fixture.fault) });
        if (fixture.fault === "503" && wire.length === 1) return new Response(null, { status: 503, headers: { "retry-after": "0" } });
        if (fixture.fault === "cancel-after") return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("data: fixture output\n\n")); }, cancel() {} }));
        return new Response(fixture.fault === "eof" ? "data: " : successSSE);
      } });
      const origin = `http://127.0.0.1:${server.port}`; origins.add(origin);
      const budget = budgetModule.createTranslatorBudget();
      try {
        const body: Record<string, unknown> = structuredClone(syntheticBody);
        if ("continuation" in fixture) body.previous_response_id = "fixture-previous";
        if ("secondAccount" in fixture) (body.metadata as Record<string, unknown>).account_selector = "fixture-account-b";
        const built = direct ? { url: `${origin}/responses`, headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : adapterModule.createResponsesPassthroughAdapter({ adapter: "openai-responses", baseUrl: origin, authMode: "forward" }).buildRequest({
          modelId: "fixture-model", context: { messages: [] }, stream: true, options: {}, _rawBody: body,
        }, { headers: new Headers(), translatorBudget: budget });
        let observedResponse: Response | undefined;
        let sends = 0; let outcome = "unknown"; let response = "";
        try {
          const send = async () => {
            sends++;
            const fetched = await retry.fetchWithAttemptDeadline(built.url, { method: "POST", headers: built.headers, body: built.body, redirect: "manual" }, 2000, controller.signal, false, { attempt, clientSignal: controller.signal });
            // Deterministic ambiguous reset after actual recorder arrival, at the shared transport seam.
            if (fixture.fault === "reset" && sends === 1) { await fetched.body?.cancel(); httpAccounting?.closeAdapterObservation(fetched); throw Object.assign(new Error("synthetic reset"), { code: "ECONNRESET" }); }
            return fetched;
          };
          const result: Response = await (direct ? send() : retry.fetchWithTransientRetry(send, { attempts: 2, abortSignal: controller.signal }));
          observedResponse = result;
          if (fixture.fault === "cancel-after") {
            const reader = result.body!.getReader(); await reader.read(); controller.abort(); await reader.cancel().catch(() => {}); outcome = "cancelled_after_output";
          } else {
            response = await result.text();
            if (![successSSE, "data: ", ""].includes(response)) { response = ""; throw new Error("nonfixture response rejected"); }
            outcome = !result.ok ? `http_${result.status}` : fixture.fault === "eof" ? "incomplete_eof" : "protocol_success";
          }
        } catch { outcome = controller.signal.aborted ? "cancelled_before_headers" : "transport_failure"; }
        finally { built.releaseBodyObservation?.(); if (observedResponse) httpAccounting?.closeAdapterObservation(observedResponse); }
        if (captureFailure) throw captureFailure;
        captures.push({ id: fixture.id, wire, sends, clientAttempts: 1, outcome, response, faultInjection: fixture.fault === "reset" ? "after_recorder_arrival_at_fetch_seam" : "loopback_response", telemetry: { events, available: accountingAvailable, summary: accounting?.foldDispatchEvents(events) ?? null } });
      } finally { budget.dispose(); origins.delete(origin); server.stop(true); }
    }
  } finally { globalThis.fetch = originalFetch; }
  return captures;
}

/** Consume child output under a hard byte cap. Never return its contents to artifacts. */
export async function boundedChildText(stream: ReadableStream<Uint8Array>, maxBytes: number, stop: () => void): Promise<string> {
  const reader = stream.getReader(); const parts: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) { stop(); await reader.cancel(); throw new Error("child output limit exceeded"); }
      parts.push(chunk.value);
    }
    return new TextDecoder().decode(Buffer.concat(parts));
  } finally { reader.releaseLock(); }
}

/** A capability probe, not desktop/native-default qualification. Native request bodies stay in memory. */
export async function probeNativeCapture(scratch: string) {
  const { mkdir, mkdtemp, rm, readFile } = await import("node:fs/promises");
  const { createHash } = await import("node:crypto");
  const binary = "/Applications/ChatGPT.app/Contents/Resources/codex";
  const unavailable = (reason: string) => ({ verdict: "UNAVAILABLE", executed: false, transport: "custom-provider-http", desktopNativeDefault: "UNAVAILABLE", reason });
  if (process.platform !== "darwin" || !await Bun.file("/usr/bin/sandbox-exec").exists()) return unavailable("os_egress_containment_unavailable");
  if (!await Bun.file(binary).exists()) return unavailable("native_binary_unavailable");
  const home = await mkdtemp(join(scratch, "native-"));
  let nativeStarted = false;
  let requests = 0; let nonfixture = false; const toolCategories = new Set<string>(); let bounded = true;
  let blockedRequests = 0;
  const blocked = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { blockedRequests++; return new Response("blocked-port"); } });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (new URL(request.url).pathname === "/containment") return new Response("allowed");
    requests++;
    if (requests > 4) return new Response(null, { status: 400 });
    // Native built-in instructions are not fixed fixture material. Never serialize them.
    if (Number(request.headers.get("content-length") ?? 0) > 65536) { bounded = false; return new Response(null, { status: 400 }); }
    let bytes = 0; const parts: Uint8Array[] = []; const reader = request.body?.getReader();
    if (reader) {
      while (true) { const item = await reader.read(); if (item.done) break; bytes += item.value.byteLength; if (bytes > 65536) { bounded = false; await reader.cancel(); return new Response(null, { status: 400 }); } parts.push(item.value); }
    }
    try {
      const body = JSON.parse(new TextDecoder().decode(Buffer.concat(parts)));
      if (Array.isArray(body.tools)) for (const tool of body.tools) {
        const name = typeof tool.name === "string" ? tool.name : typeof tool.type === "string" ? tool.type : "";
        toolCategories.add(/mcp|browser|computer|web_search|app/.test(name) && name !== "apply_patch" ? "external_integration" : /apply_patch|request_user_input|update_plan/.test(name) ? "builtin_nonexternal" : "other_schema");
      }
      try { assertFixedSynthetic(body); } catch { nonfixture = true; }
    } catch { nonfixture = true; }
    return new Response(nativeSuccessSSE, { headers: { "content-type": "text/event-stream" } });
  } });
  const profile = `(version 1) (allow default) (deny network*) (allow network-outbound (remote tcp "localhost:${server.port}"))`;
  const env = { ...isolatedEnvironment(home), RUST_LOG: "off" };
  async function run(args: string[], limitMs: number): Promise<{ code: number; text: string; failureCategory: string }> {
    const child = Bun.spawn(["/usr/bin/sandbox-exec", "-p", profile, ...args], { cwd: home, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), limitMs);
    try {
      const [text, stderr, code] = await Promise.all([boundedChildText(child.stdout, 65536, () => child.kill()), boundedChildText(child.stderr, 65536, () => child.kill()), child.exited]);
      return { code, text, failureCategory: /stream|response|SSE/i.test(stderr + text) ? "stream_protocol" : /sandbox|permission denied|operation not permitted/i.test(stderr) ? "containment" : code === 0 ? "none" : "unclassified" };
    } finally { clearTimeout(timer); }
  }
  try {
    await Promise.all(["tmp", "codex", "commander", "config"].map(name => mkdir(join(home, name))));
    await Bun.write(join(home, "bunfig.toml"), "");
    const smoke = await run([process.execPath, "--no-env-file", `--config=${join(home, "bunfig.toml")}`, "-e",
      `const a=await fetch("http://127.0.0.1:${server.port}/containment",{proxy:null});if(await a.text()!=="allowed")process.exit(2);try{await fetch("http://127.0.0.1:${blocked.port}",{proxy:null});process.exit(3)}catch{}console.log("contained")`], 5000);
    if (smoke.code !== 0 || smoke.text.trim() !== "contained" || blockedRequests) return unavailable("egress_smoke_failed");
    const version = await run([binary, "--version"], 5000);
    if (version.code !== 0 || !/^codex-cli \d+\.\d+\.\d+\s*$/.test(version.text)) return unavailable("binary_version_unverified");
    const disabled = ["shell_tool", "unified_exec", "shell_snapshot", "code_mode_host", "apps", "browser_use", "browser_use_external", "computer_use", "hooks", "image_generation", "in_app_browser", "in_app_chat", "in_app_local_automation", "plugins", "remote_plugin", "multi_agent", "multi_agent_v2", "skill_mcp_dependency_install", "skill_search", "sleep_tool", "view_image", "workspace_dependencies"];
    nativeStarted = true;
    const result = await run([binary, "exec", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", "--json", "-s", "read-only", "-C", home,
      ...disabled.flatMap(feature => ["--disable", feature]), "--enable", "skip_host_skill_discovery",
      "-c", 'web_search="disabled"', "-c", 'model="fixture-model"', "-c", 'model_provider="fixture"',
      "-c", 'model_providers.fixture.name="Synthetic loopback"', "-c", `model_providers.fixture.base_url="http://127.0.0.1:${server.port}"`,
      "-c", 'model_providers.fixture.wire_api="responses"', "-c", "model_providers.fixture.requires_openai_auth=false", "-c", "model_providers.fixture.supports_websockets=false",
      "fixture prompt"], 10000);
    return { verdict: "UNAVAILABLE", executed: true, transport: "custom-provider-http", desktopNativeDefault: "UNAVAILABLE",
      reason: toolCategories.has("external_integration") ? "external_tool_schema_advertised" : !requests ? "native_transport_not_exercised" : nonfixture ? "native_capture_not_fixed_synthetic_serializable" : "matched_native_proxy_arm_unavailable",
      binary: { version: version.text.trim(), sha256: createHash("sha256").update(await readFile(binary)).digest("hex") },
      containment: "verified_allowed_port_and_denied_other_loopback_port", requests, blockedRequests, exitCode: result.code,
      bounded, toolCategories: [...toolCategories].sort(), failureCategory: result.failureCategory, rawCapturePersisted: false };
  } catch { return { ...unavailable("bounded_native_probe_failed"), executed: nativeStarted }; }
  finally { server.stop(true); blocked.stop(true); await rm(home, { recursive: true, force: true }); }
}
