import { runWebSocketReconnectFixture } from "../tests/helpers/inference-websocket-fixture";
import type { DispatchEvent } from "../src/usage/dispatch";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { BASELINE_REVISION, interruptCaptureChild, settleCaptureChild, guardedFetch, boundedChildText, isolatedEnvironment, probeNativeCapture, runAdapterCapture, runCompactCapture, runKillCaptureChild, validateKillEvents, captureRequest, type FixtureCapture } from "../tests/helpers/inference-recorder";
import { compareFixture, semanticDiff, wireNormalizations } from "../tests/helpers/inference-diff";

const root = resolve(import.meta.dir, "..");
const script = resolve(import.meta.path);
export async function captureInChild(source: string, scratch: string, direct = false): Promise<FixtureCapture[]> {
  const home = await mkdtemp(join(scratch, "child-"));
  try {
    await Promise.all(["tmp", "codex", "commander", "config"].map(name => mkdir(join(home, name)))); await Bun.write(join(home, "bunfig.toml"), "");
    const child = Bun.spawn([process.execPath, "--no-env-file", `--config=${join(home, "bunfig.toml")}`, script, direct ? "--direct" : "--capture", source], {
      cwd: home, env: isolatedEnvironment(home), stdout: "pipe", stderr: "pipe",
    });
    const timer = setTimeout(() => interruptCaptureChild(child), 20_000);
    try {
      const [output, errors, code] = await Promise.all([boundedChildText(child.stdout, 2097152, () => interruptCaptureChild(child)), boundedChildText(child.stderr, 65536, () => interruptCaptureChild(child)), child.exited]);
      if (code !== 0 || output.length > 2 * 1024 * 1024 || errors.length > 64 * 1024) throw new Error("isolated capture failed");
      return JSON.parse(output) as FixtureCapture[];
    } finally { clearTimeout(timer); await settleCaptureChild(child); }
  } finally { await rm(home, { recursive: true, force: true }); }
}



interface SurfaceCapture {
  id: string; scope: string; semantics: Record<string, number | string | null>;
  telemetry: { events: DispatchEvent[]; requestCount: number | null; attemptCount: number | null; outcomes: string[]; coverage: string };
}
async function runSurfaceCaptures(sourceRoot: string): Promise<SurfaceCapture[]> {
  const { runSidecarDispatchFixture } = await import("../tests/helpers/dispatch-surface-fixtures");
  const rows: SurfaceCapture[] = [];
  for (const failure of [true, false]) {
    const result = await runSidecarDispatchFixture(sourceRoot, failure);
    if (result.mainText !== "synthetic main answer") throw new Error("surface fixture output rejected");
    rows.push({ id: result.scenario, scope: "actual_vision_admission_and_main_chat_adapter_loopback", semantics: { sendInvocations: result.sendCount, sidecarSends: result.sidecarSendCount, cacheHitSends: result.cacheHitSendCount, mainOutput: result.mainText }, telemetry: { events: result.events, requestCount: result.requestCount, attemptCount: result.attemptCount, outcomes: result.outcomes, coverage: result.coverage } });
  }
  const oldFetch = globalThis.fetch;
  // Cursor's actual HTTP/2 executor is loopback-controlled by its fixture. It has no HTTP fetch allowance.
  globalThis.fetch = guardedFetch(new Set(), oldFetch);
  try {
    const { runCursorReconnectFixture } = await import("../tests/helpers/cursor-dispatch-fixture");
    const result = await runCursorReconnectFixture(sourceRoot);
    rows.push({ id: result.scenario, scope: "actual_cursor_http2_precommit_retry_not_websocket", semantics: { sendInvocations: result.requestCount, transportAttempts: result.attemptCount, peerRequests: result.peerRequests }, telemetry: { events: "events" in result ? result.events as DispatchEvent[] : [], requestCount: null, attemptCount: result.attemptCount, outcomes: result.outcomes.flatMap(outcome => outcome ? [outcome] : []), coverage: result.accountingAvailable ? "complete" : "unavailable" } });
  } finally { globalThis.fetch = oldFetch; }
  return rows;
}
export async function captureSurfacesInChild(source: string, scratch: string): Promise<SurfaceCapture[]> {
  const home = await mkdtemp(join(scratch, "surface-"));
  try {
    await Promise.all(["tmp", "codex", "commander", "config"].map(name => mkdir(join(home, name)))); await Bun.write(join(home, "bunfig.toml"), "");
    const child = Bun.spawn([process.execPath, "--no-env-file", `--config=${join(home, "bunfig.toml")}`, script, "--surfaces", source], { cwd: home, env: isolatedEnvironment(home), stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => interruptCaptureChild(child), 15000);
    try {
      const [output, , code] = await Promise.all([boundedChildText(child.stdout, 131072, () => interruptCaptureChild(child)), boundedChildText(child.stderr, 65536, () => interruptCaptureChild(child)), child.exited]);
      if (code !== 0) throw new Error("surface fixture child failed");
      return JSON.parse(output);
    } finally { clearTimeout(timer); await settleCaptureChild(child); }
  } finally { await rm(home, { recursive: true, force: true }); }
}

export async function captureNativeInChild(baseline: string, current: string, scratch: string): Promise<Awaited<ReturnType<typeof probeNativeCapture>>> {
  const home = await mkdtemp(join(scratch, "native-parent-"));
  try {
    await Promise.all(["tmp", "codex", "commander", "config"].map(name => mkdir(join(home, name)))); await Bun.write(join(home, "bunfig.toml"), "");
    const child = Bun.spawn([process.execPath, "--no-env-file", `--config=${join(home, "bunfig.toml")}`, script, "--native", baseline, current, home], { cwd: home, env: isolatedEnvironment(home), detached: process.platform !== "win32", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => interruptCaptureChild(child, true), 30000);
    try {
      const [output, , code] = await Promise.all([boundedChildText(child.stdout, 65536, () => interruptCaptureChild(child, true)), boundedChildText(child.stderr, 65536, () => interruptCaptureChild(child, true)), child.exited]);
      if (code !== 0) throw new Error("native capture child failed");
      return JSON.parse(output);
    } finally { clearTimeout(timer); await settleCaptureChild(child, true); }
  } finally { await rm(home, { recursive: true, force: true }); }
}

export async function captureKilledChild(source: string, scratch: string): Promise<FixtureCapture> {
  const home = await mkdtemp(join(scratch, "kill-")); const wire: Awaited<ReturnType<typeof captureRequest>>[] = []; let rejected = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    try { wire.push(await captureRequest(request)); } catch { rejected = true; return new Response(null, { status: 400 }); }
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("data: ")); } }));
  } });
  try {
    await Promise.all(["tmp", "codex", "commander", "config"].map(name => mkdir(join(home, name)))); await Bun.write(join(home, "bunfig.toml"), "");
    const child = Bun.spawn([process.execPath, "--no-env-file", `--config=${join(home, "bunfig.toml")}`, script, "--kill", source, `http://127.0.0.1:${server.port}`], { cwd: home, env: isolatedEnvironment(home), stdout: "pipe", stderr: "pipe" });
    let output = ""; let killedAfterHeaders = false;
    const timer = setTimeout(() => interruptCaptureChild(child), 5000);
    try {
      const collect = async () => {
        const reader = child.stdout.getReader();
        try { while (true) { const chunk = await reader.read(); if (chunk.done) break; output += new TextDecoder().decode(chunk.value); if (output.length > 65536) { child.kill("SIGKILL"); throw new Error("kill output limit exceeded"); } if (!killedAfterHeaders && output.includes("headers-ready\n")) { killedAfterHeaders = true; child.kill("SIGKILL"); } } } finally { reader.releaseLock(); }
      };
      await Promise.all([collect(), boundedChildText(child.stderr, 65536, () => interruptCaptureChild(child)), child.exited]);
      if (!killedAfterHeaders || rejected || wire.length !== 1) throw new Error("process-kill fixture failed");
      const events = validateKillEvents(output.split("\n"));
      return { id: "process-kill", wire, sends: wire.length, clientAttempts: 1, outcome: "unknown_after_process_kill", response: "", faultInjection: "SIGKILL_after_headers", telemetry: { available: events.length > 0, events, summary: { unresolvedStarts: events.filter(event => event.kind === "start").length, terminalEvents: 0 } } };
    } finally { clearTimeout(timer); await settleCaptureChild(child); }
  } finally { server.stop(true); await rm(home, { recursive: true, force: true }); }
}

async function command(args: string[], cwd: string): Promise<string> {
  const child = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  const [output, , code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error("baseline provenance command failed");
  return output.trim();
}
export async function writeOfflineReport(outputRoot = join(root, ".tmp/inference-accounting")) {
  const run = await mkdtemp(join(await mkdir(outputRoot, { recursive: true }).then(() => outputRoot), "run-"));
  const baseline = join(run, "baseline-source"); await mkdir(baseline);
  await command(["git", "archive", "--format=tar", `--output=${join(run, "baseline.tar")}`, BASELINE_REVISION], root);
  await command(["tar", "-xf", join(run, "baseline.tar"), "-C", baseline], root);
  const startedAt = new Date().toISOString();
  const direct = await captureInChild(root, run, true);
  const before = await captureInChild(baseline, run); const after = await captureInChild(root, run);
  before.push(await captureKilledChild(baseline, run)); after.push(await captureKilledChild(root, run));
  const surfaceBefore = await captureSurfacesInChild(baseline, run); const surfaceAfter = await captureSurfacesInChild(root, run);
  const surfaceComparisons = surfaceBefore.map((capture, index) => { const diffs = semanticDiff(capture.semantics, surfaceAfter[index]!.semantics); return { id: capture.id, scope: capture.scope, verdict: diffs.length ? "REGRESSION" : "PASS", diffs }; });
  const comparisons = before.map((capture, index) => ({ id: capture.id, ...compareFixture(capture, after[index]!) }));
  const hash = (input: string) => createHash("sha256").update(input).digest("hex");
  const harnessFiles = ["scripts/inference-offline-report.ts", "tests/helpers/inference-recorder.ts", "tests/helpers/inference-diff.ts", "tests/helpers/inference-websocket-fixture.ts", "tests/helpers/dispatch-surface-fixtures.ts", "tests/helpers/cursor-dispatch-fixture.ts", "tests/fixtures/inference-accounting/fixtures.ts"];
  const sourceDigests: Record<string, string> = {};
  for (const arm of [{ name: "baseline", dir: baseline }, { name: "current", dir: root }]) {
    const digest = createHash("sha256"); const paths = [...new Bun.Glob("src/**/*.{ts,mjs}").scanSync({ cwd: arm.dir })].sort();
    for (const path of paths) { digest.update(path); digest.update(await readFile(join(arm.dir, path))); }
    sourceDigests[arm.name] = digest.digest("hex");
  }
  const native = await captureNativeInChild(baseline, root, run);
  const manifest = { schemaVersion: 1, sourceDigests, baselineRevision: BASELINE_REVISION,
    currentRevision: await command(["git", "rev-parse", "HEAD"], root), currentWorktreeDirty: Boolean(await command(["git", "status", "--porcelain"], root)),
    harnessSha256: hash((await Promise.all(harnessFiles.map(path => readFile(join(root, path), "utf8")))).join("\n")),
    binary: { name: "bun", version: Bun.version, sha256: createHash("sha256").update(await readFile(process.execPath)).digest("hex") },
    fixtures: [...after, ...surfaceAfter].map(f => f.id), seed: "fixed-no-random-fixture-values", provenance: "executed_responses_adapter_and_shared_http_retry",
    transport: "synthetic-loopback-http", native,
    bounds: { paidSends: 0, childTimeoutMs: 20000, maxOutputBytes: 2097152, redirects: "rejected", environment: "allowlisted-disposable", externalTools: "not_loaded" },
    startedAt, endedAt: new Date().toISOString(), normalizations: wireNormalizations,
  };
  const results = { protocolScope: "adapter_wire_shared_retry_routed_compact_process_kill_and_native_capture_replay", protocolDispatch: [...comparisons, ...surfaceComparisons].every(c => c.verdict === "PASS") && native.verdict !== "REGRESSION" ? "PASS" : "REGRESSION",
    tokenCost: "UNAVAILABLE", debit: "UNAVAILABLE", comparisons, native, surfaceComparisons, surfaceArms: { baseline: surfaceBefore, current: surfaceAfter },
    arms: { direct, baseline: before, current: after },
    baselineCharacterization: direct.map((capture, index) => ({ id: capture.id, differences: compareFixture(capture, before[index]!).diffs })),
    accounting: { verdict: after.every(c => c.telemetry.available && c.telemetry.events.filter((event: DispatchEvent) => event.kind === "start").length === c.sends) ? "PASS" : "UNAVAILABLE", scope: "executed_adapter_compact_ws_and_process_kill_dispatch_counts", reason: "expected_new_telemetry_separate_from_wire; manual_body_consumers_and_process_kill_leave_completion_unknown", events: [...after, ...surfaceAfter].reduce((sum, c) => sum + c.telemetry.events.length, 0) },
    unsupported: { desktopNativeDefault: "UNAVAILABLE" },
    limitations: ["Executed adapter, shared retry, routed compact handler and process-kill paths are compared. Native custom HTTP capture is replayed through the pinned/current adapters in memory.",
      "Reset is injected after real loopback recorder arrival at the fetch seam. Synthetic Responses WebSocket reconnect exercises full server ingress; Cursor precommit reconnect separately exercises HTTP/2. Process-kill executes an OS-terminated reader.",
      "Existing baseline transformations and retry behavior are characterization, not policy fixes.", "Synthetic token values establish neither token cost nor account debit."],
  };
  await Bun.write(join(run, "run-manifest.json"), JSON.stringify(manifest, null, 2));
  await Bun.write(join(run, "dispatch-events.jsonl"), [...after, ...surfaceAfter].flatMap(c => c.telemetry.events).map(event => JSON.stringify(event)).join("\n") + "\n");
  await Bun.write(join(run, "results.json"), JSON.stringify(results, null, 2));
  await Bun.write(join(run, "report.md"), `# Offline inference comparison\n\nProtocol/dispatch: ${results.protocolDispatch}\n\nToken cost: UNAVAILABLE. Debit: UNAVAILABLE. Native capture/replay: ${native.verdict}. Native-default: UNAVAILABLE.\n\n${results.limitations.join("\n\n")}\n\n| Fixture | Baseline sends | Current sends | Verdict |\n|---|---:|---:|---|\n${comparisons.map((c, i) => `| ${c.id} | ${before[i]!.sends} | ${after[i]!.sends} | ${c.verdict} |`).join("\n")}\n`);
  return run;
}
if (import.meta.main) {
  if (process.argv[2] === "--surfaces" && process.argv.length === 4) {
    console.warn = () => {}; console.log = () => {}; console.info = () => {}; process.stdout.write(JSON.stringify(await runSurfaceCaptures(process.argv[3]!)));
  } else if (process.argv[2] === "--native" && process.argv.length === 6) {
    console.warn = () => {}; console.log(JSON.stringify(await probeNativeCapture(process.argv[5]!, process.argv[3]!, process.argv[4]!)));
  } else if (process.argv[2] === "--kill" && process.argv.length === 5) {
    await runKillCaptureChild(process.argv[3]!, process.argv[4]!);
  } else if (["--capture", "--direct"].includes(process.argv[2] ?? "") && process.argv.length === 4) {
    console.warn = () => {}; console.log = () => {}; console.info = () => {};
    const rows = await runAdapterCapture(process.argv[3]!, process.argv[2] === "--direct");
    if (process.argv[2] !== "--direct") { rows.push(await runCompactCapture(process.argv[3]!)); rows.push(await runWebSocketReconnectFixture(process.argv[3]!)); }
    process.stdout.write(JSON.stringify(rows));
  } else if (process.argv.length === 2) console.log(await writeOfflineReport());
  else throw new Error("Usage: bun scripts/inference-offline-report.ts");
}
