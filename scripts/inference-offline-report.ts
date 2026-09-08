import type { DispatchEvent } from "../src/usage/dispatch";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { BASELINE_REVISION, boundedChildText, isolatedEnvironment, probeNativeCapture, runAdapterCapture, type FixtureCapture } from "../tests/helpers/inference-recorder";
import { compareFixture, wireNormalizations } from "../tests/helpers/inference-diff";
import { fixtures } from "../tests/fixtures/inference-accounting/fixtures";

const root = resolve(import.meta.dir, "..");
const script = resolve(import.meta.path);
export async function captureInChild(source: string, scratch: string, direct = false): Promise<FixtureCapture[]> {
  const home = await mkdtemp(join(scratch, "child-"));
  try {
    await Promise.all(["tmp", "codex", "commander", "config"].map(name => mkdir(join(home, name)))); await Bun.write(join(home, "bunfig.toml"), "");
    const child = Bun.spawn([process.execPath, "--no-env-file", `--config=${join(home, "bunfig.toml")}`, script, direct ? "--direct" : "--capture", source], {
      cwd: home, env: isolatedEnvironment(home), stdout: "pipe", stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill(), 20_000);
    try {
      const [output, errors, code] = await Promise.all([boundedChildText(child.stdout, 2097152, () => child.kill()), boundedChildText(child.stderr, 65536, () => child.kill()), child.exited]);
      if (code !== 0 || output.length > 2 * 1024 * 1024 || errors.length > 64 * 1024) throw new Error("isolated capture failed");
      return JSON.parse(output) as FixtureCapture[];
    } finally { clearTimeout(timer); }
  } finally { await rm(home, { recursive: true, force: true }); }
}
async function command(args: string[], cwd: string): Promise<string> {
  const child = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  const [output, , code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error("baseline provenance command failed");
  return output.trim();
}
export async function writeOfflineReport(outputRoot = join(root, ".tmp/credit-audit/deep/offline")) {
  const run = await mkdtemp(join(await mkdir(outputRoot, { recursive: true }).then(() => outputRoot), "run-"));
  const baseline = join(run, "baseline-source"); await mkdir(baseline);
  await command(["git", "archive", "--format=tar", `--output=${join(run, "baseline.tar")}`, BASELINE_REVISION], root);
  await command(["tar", "-xf", join(run, "baseline.tar"), "-C", baseline], root);
  const startedAt = new Date().toISOString();
  const direct = await captureInChild(root, run, true);
  const before = await captureInChild(baseline, run); const after = await captureInChild(root, run);
  const comparisons = before.map((capture, index) => ({ id: capture.id, ...compareFixture(capture, after[index]!) }));
  const hash = (input: string) => createHash("sha256").update(input).digest("hex");
  const harnessFiles = ["scripts/inference-offline-report.ts", "tests/helpers/inference-recorder.ts", "tests/helpers/inference-diff.ts", "tests/fixtures/inference-accounting/fixtures.ts"];
  const sourceDigests: Record<string, string> = {};
  for (const arm of [{ name: "baseline", dir: baseline }, { name: "current", dir: root }]) {
    const digest = createHash("sha256"); const paths = [...new Bun.Glob("src/**/*.{ts,mjs}").scanSync({ cwd: arm.dir })].sort();
    for (const path of paths) { digest.update(path); digest.update(await readFile(join(arm.dir, path))); }
    sourceDigests[arm.name] = digest.digest("hex");
  }
  const native = await probeNativeCapture(run);
  const manifest = { schemaVersion: 1, sourceDigests, baselineRevision: BASELINE_REVISION,
    currentRevision: await command(["git", "rev-parse", "HEAD"], root), currentWorktreeDirty: Boolean(await command(["git", "status", "--porcelain"], root)),
    harnessSha256: hash((await Promise.all(harnessFiles.map(path => readFile(join(root, path), "utf8")))).join("\n")),
    binary: { name: "bun", version: Bun.version, sha256: createHash("sha256").update(await readFile(process.execPath)).digest("hex") },
    fixtures: fixtures.map(f => f.id), seed: "fixed-no-random-fixture-values", provenance: "executed_responses_adapter_and_shared_http_retry",
    transport: "synthetic-loopback-http", native,
    bounds: { paidSends: 0, childTimeoutMs: 20000, maxOutputBytes: 2097152, redirects: "rejected", environment: "allowlisted-disposable", externalTools: "not_loaded" },
    startedAt, endedAt: new Date().toISOString(), normalizations: wireNormalizations,
  };
  const results = { protocolScope: "responses_adapter_wire_and_shared_http_retry_dispatches", protocolDispatch: comparisons.every(c => c.verdict === "PASS") ? "PASS" : "REGRESSION",
    tokenCost: "UNAVAILABLE", debit: "UNAVAILABLE", comparisons,
    arms: { direct, baseline: before, current: after },
    baselineCharacterization: direct.map((capture, index) => ({ id: capture.id, differences: compareFixture(capture, before[index]!).diffs })),
    accounting: { verdict: after.every(c => c.telemetry.available && c.telemetry.events.filter((event: DispatchEvent) => event.kind === "start").length === c.sends) ? "PASS" : "UNAVAILABLE", scope: "shared_http_dispatch_counts", reason: "expected_new_telemetry_separate_from_wire; headers_and_manual_body_consumer_leave_2xx_protocol_completion_unknown", events: after.reduce((sum, c) => sum + c.telemetry.events.length, 0) },
    unsupported: { native: "UNAVAILABLE", websocketReconnect: "UNAVAILABLE", processKill: "UNAVAILABLE", compact: "UNAVAILABLE", sidecar: "UNAVAILABLE" },
    limitations: ["Only executed adapter and shared retry leaves are compared; no native client or full proxy server was launched.",
      "Reset is injected after real loopback recorder arrival at the fetch seam. Native reconnect and process-kill behavior are unavailable.",
      "Existing baseline transformations and retry behavior are characterization, not policy fixes.", "Synthetic token values establish neither token cost nor account debit."],
  };
  await Bun.write(join(run, "run-manifest.json"), JSON.stringify(manifest, null, 2));
  await Bun.write(join(run, "dispatch-events.jsonl"), after.flatMap(c => c.telemetry.events).map(event => JSON.stringify(event)).join("\n") + "\n");
  await Bun.write(join(run, "results.json"), JSON.stringify(results, null, 2));
  await Bun.write(join(run, "report.md"), `# Offline inference comparison\n\nProtocol/dispatch: ${results.protocolDispatch}\n\nToken cost: UNAVAILABLE. Debit: UNAVAILABLE. Native capture: UNAVAILABLE.\n\n${results.limitations.join("\n\n")}\n\n| Fixture | Baseline sends | Current sends | Verdict |\n|---|---:|---:|---|\n${comparisons.map((c, i) => `| ${c.id} | ${before[i]!.sends} | ${after[i]!.sends} | ${c.verdict} |`).join("\n")}\n`);
  return run;
}
if (import.meta.main) {
  if (["--capture", "--direct"].includes(process.argv[2] ?? "") && process.argv.length === 4) {
    console.warn = () => {}; console.log(JSON.stringify(await runAdapterCapture(process.argv[3]!, process.argv[2] === "--direct")));
  } else if (process.argv.length === 2) console.log(await writeOfflineReport());
  else throw new Error("Usage: bun scripts/inference-offline-report.ts");
}
