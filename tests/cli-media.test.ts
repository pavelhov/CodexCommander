import { describe, expect, mock, test } from "bun:test";

import {
  handleMediaCommand,
  parseMediaArgs,
  type MediaCommandService,
  type MediaCommandStatus,
} from "../src/cli/media-command";
import type { AttestedLiveManagementProxy } from "../src/server/proxy-liveness";

const target: AttestedLiveManagementProxy = {
  pid: 123,
  port: 10100,
  hostname: "127.0.0.1",
  source: "runtime",
  baseUrl: "http://127.0.0.1:10100",
  lifecycleLockLeaseV1: true,
  runtimeVersion: "1.0.0",
  lifecycleCompatibilityGeneration: 1,
  runtimeRecordIdentity: "opaque-a",
};

const safeStatus: MediaCommandStatus = {
  revision: 7,
  source: "subscription_oauth",
  bindingReady: true,
  imageModel: "grok-imagine-image-2.0",
  videoModel: "grok-imagine-video-1.5",
  videoDurationSeconds: 1,
  videoResolution: "1080p",
  apiKeyFallbackDisabled: true,
  billingAttribution: "unknown",
  ambiguousSubmissionRisk: true,
  releaseStatus: "feasibility_only",
  steps: { image: "pending", video: "pending" },
};

function fixture(overrides: Partial<{
  status: MediaCommandStatus;
  confirm: boolean;
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  attest: (expectedPid?: number) => Promise<AttestedLiveManagementProxy | null>;
}> = {}) {
  const output: string[] = [];
  const errors: string[] = [];
  const probe = mock(async () => ({ ...safeStatus, steps: { image: "completed" as const, video: "accepted" as const } }));
  const acknowledge = mock(async () => safeStatus);
  const status = mock(async () => overrides.status ?? safeStatus);
  const service: MediaCommandService = { status, probe, acknowledge };
  const createService = mock((_attested: AttestedLiveManagementProxy) => service);
  const attest = mock(overrides.attest ?? (async () => target));
  const confirm = mock(async () => overrides.confirm ?? true);
  return {
    output,
    errors,
    probe,
    acknowledge,
    status,
    createService,
    attest,
    confirm,
    deps: {
      attest,
      createService,
      confirm,
      stdinIsTTY: overrides.stdinIsTTY ?? true,
      stdoutIsTTY: overrides.stdoutIsTTY ?? true,
      out: (line: string) => output.push(line),
      error: (line: string) => errors.push(line),
    },
  };
}

describe("ccx media safe command boundary", () => {
  test("parser rejects automation and caller-selected paid-operation fields", () => {
    expect(() => parseMediaArgs(["probe", "--yes"])).toThrow();
    expect(() => parseMediaArgs(["probe", "--prompt", "secret"])).toThrow();
    expect(() => parseMediaArgs(["probe", "--model", "other"])).toThrow();
    expect(parseMediaArgs([])).toEqual({ command: "status", json: false });
  });

  test("removed paid probe command reaches no service or mutation", async () => {
    const f = fixture();
    expect(await handleMediaCommand(["probe", "--yes"], f.deps)).toBe(2);
    expect(f.attest).toHaveBeenCalledTimes(0);
    expect(f.createService).toHaveBeenCalledTimes(0);
    expect(await handleMediaCommand(["probe"], f.deps)).toBe(2);
    expect(f.createService).toHaveBeenCalledTimes(0);
    expect(f.probe).toHaveBeenCalledTimes(0);
  });

  test("outcome-unknown acknowledgement remains available after the selected source changes", async () => {
    const changedSource = {
      ...safeStatus,
      source: "api_key" as const,
      bindingReady: false,
      operationId: "probe-operation",
      steps: { image: "outcome_unknown" as const, video: "pending" as const },
    };
    const f = fixture({ status: changedSource });
    let reads = 0;
    const probeOperation = mock(async () => ({
      id: "probe-operation",
      revision: 7,
      steps: changedSource.steps,
    }));
    f.deps.createService = () => ({
      status: async () => reads++ === 0
        ? changedSource
        : { ...safeStatus, revision: 1, operationId: "new-credential-probe" },
      probe: f.probe,
      acknowledge: f.acknowledge,
      probeOperation,
    });
    expect(await handleMediaCommand(["acknowledge", "probe-operation", "--revision", "7"], f.deps)).toBe(0);
    expect(probeOperation).toHaveBeenCalledWith("probe-operation");
    expect(f.acknowledge).toHaveBeenCalledWith({
      action: "acknowledge",
      operationId: "probe-operation",
      expectedRevision: 7,
      confirmation: true,
    });
  });


  test("status output allowlists safe fields instead of serializing arbitrary service data", async () => {
    const malicious = {
      ...safeStatus,
      bearer: "secret-bearer",
      slotRef: "private-slot",
      identityDigest: "private-digest",
      signedUrl: "https://signed.invalid/private",
      path: "/private/file",
      requestId: "upstream-id",
      prompt: "private prompt",
    } as MediaCommandStatus;
    const f = fixture({ status: malicious });
    expect(await handleMediaCommand(["status", "--json"], f.deps)).toBe(0);
    const serialized = f.output.join("\n");
    for (const forbidden of ["secret-bearer", "private-slot", "private-digest", "signed.invalid", "/private/file", "upstream-id", "private prompt"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  test("does not reflect untrusted runtime errors or caller-looking model fields", async () => {
    let f = fixture();
    f.deps.createService = () => ({
      status: async () => { throw new Error("secret-bearer /private/path signed.invalid"); },
      probe: f.probe,
      acknowledge: f.acknowledge,
    });
    expect(await handleMediaCommand(["status"], f.deps)).toBe(1);
    expect(f.errors.join("\n")).not.toContain("secret-bearer");
    expect(f.errors.join("\n")).not.toContain("/private/path");
    expect(f.errors.join("\n")).not.toContain("signed.invalid");

    f = fixture({ status: { ...safeStatus, imageModel: "secret-bearer" } });
    expect(await handleMediaCommand(["status"], f.deps)).toBe(1);
    expect(f.output.join("\n")).not.toContain("secret-bearer");
    expect(f.errors.join("\n")).not.toContain("secret-bearer");
  });

  test("settings require two TTYs, exact confirmation, and runtime re-attestation", async () => {
    expect(parseMediaArgs(["settings", "--images", "on", "--videos", "off", "--source", "api_key"]))
      .toEqual({
        command: "settings",
        patch: { imagesEnabled: true, videosEnabled: false, authSource: "api_key" },
      });
    expect(parseMediaArgs(["jobs", "wait", "opaque-job", "--revision", "3", "--timeout", "9"]))
      .toEqual({ command: "wait", jobId: "opaque-job", revision: 3, timeoutMs: 9_000 });

    const f = fixture({ stdinIsTTY: false, stdoutIsTTY: false });
    const settings = mock(async () => ({ ...safeStatus, source: "api_key" as const }));
    f.deps.createService = () => ({
      status: f.status,
      probe: f.probe,
      acknowledge: f.acknowledge,
      settings,
      jobs: async () => [],
    });
    expect(await handleMediaCommand(["settings", "--images", "on"], f.deps)).toBe(1);
    expect(settings).toHaveBeenCalledTimes(0);
    expect(f.confirm).toHaveBeenCalledTimes(0);

    const declined = fixture({ confirm: false });
    const declinedSettings = mock(async () => safeStatus);
    declined.deps.createService = () => ({
      status: declined.status,
      probe: declined.probe,
      acknowledge: declined.acknowledge,
      settings: declinedSettings,
    });
    expect(await handleMediaCommand(["settings", "--videos", "on"], declined.deps)).toBe(1);
    expect(declined.confirm).toHaveBeenCalledWith("Apply media settings: videos on?");
    expect(declinedSettings).toHaveBeenCalledTimes(0);

    const confirmed = fixture();
    const confirmedSettings = mock(async () => ({ ...safeStatus, source: "api_key" as const }));
    confirmed.deps.createService = () => ({
      status: confirmed.status,
      probe: confirmed.probe,
      acknowledge: confirmed.acknowledge,
      settings: confirmedSettings,
    });
    expect(await handleMediaCommand([
      "settings", "--images", "on", "--videos", "off", "--source", "api_key",
    ], confirmed.deps)).toBe(0);
    expect(confirmed.confirm).toHaveBeenCalledWith(
      "Apply media settings: images on, videos off, source api_key?",
    );
    expect(confirmed.attest).toHaveBeenCalledTimes(2);
    expect(confirmedSettings).toHaveBeenCalledWith(
      { imagesEnabled: true, videosEnabled: false, authSource: "api_key" },
      7,
    );
  });

  test("read-only jobs remain available without TTY prompts and JSON has one document", async () => {
    const f = fixture({ stdinIsTTY: false, stdoutIsTTY: false });
    const jobs = [{
      id: "opaque-job",
      revision: 8,
      state: "polling",
      phase: "progress" as const,
      action: "wait" as const,
      reason: "generating",
      createdAt: 1,
      updatedAt: 2,
    }];
    f.deps.createService = () => ({
      status: f.status,
      probe: f.probe,
      acknowledge: f.acknowledge,
      jobs: async () => jobs,
    });
    expect(await handleMediaCommand(["jobs", "--json"], f.deps)).toBe(0);
    expect(JSON.parse(f.output.join("\n"))).toEqual(jobs);

    f.output.length = 0;
    expect(await handleMediaCommand(["jobs"], f.deps)).toBe(0);
    expect(f.output.join("\n")).toContain("Media source: subscription_oauth");
    expect(f.output.join("\n")).toContain("opaque-job  polling  rev:8  wait");
  });

  test("job wait has stable completed, human-action, terminal, and timeout outcomes", async () => {
    const state = (phase: "completed" | "human_action_required" | "terminal" | "progress") => ({
      id: "opaque-job",
      revision: 8,
      state: phase === "completed" ? "completed" : phase === "progress" ? "polling" : "failed",
      phase,
      action: phase === "completed" ? "open" as const : phase === "progress" ? "wait" as const : phase === "human_action_required" ? "acknowledge" as const : "none" as const,
      reason: "safe_reason",
      createdAt: 1,
      updatedAt: 2,
    });
    for (const [phase, expected] of [["completed", 0], ["human_action_required", 6], ["terminal", 7], ["progress", 8]] as const) {
      const f = fixture({ stdinIsTTY: false, stdoutIsTTY: false });
      f.deps.createService = () => ({
        status: f.status,
        probe: f.probe,
        acknowledge: f.acknowledge,
        waitJob: async () => state(phase),
      });
      expect(await handleMediaCommand(["jobs", "wait", "opaque-job", "--revision", "7", "--timeout", "1"], f.deps)).toBe(expected);
      expect(f.confirm).toHaveBeenCalledTimes(0);
    }
  });

  test("HTTP job wait follows progress revisions until completion", async () => {
    const progress = (revision: number) => ({
      id: "opaque-job",
      revision,
      state: "polling",
      phase: "progress",
      action: "wait",
      reason: "generating",
      createdAt: 1,
      updatedAt: revision,
    });
    const completed = {
      ...progress(10),
      state: "completed",
      phase: "completed",
      action: "open",
      reason: "artifact_ready",
    };
    const jobs = [progress(8), progress(9), completed];
    let jobReads = 0;
    const output: string[] = [];
    const resource = {
      revision: 7,
      settings: { imagesEnabled: false, videosEnabled: true, authSource: "subscription_oauth" },
      readiness: { credential: { state: "ready" } },
      sourceFallback: "disabled",
      probe: null,
    };
    const fetchImpl = mock(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/api/media/jobs/")) {
        const job = jobs[Math.min(jobReads, jobs.length - 1)];
        jobReads += 1;
        return Response.json({ job });
      }
      return Response.json(resource);
    });

    expect(await handleMediaCommand(["jobs", "wait", "opaque-job", "--revision", "7", "--timeout", "2"], {
      attest: async () => target,
      fetchImpl: fetchImpl as typeof fetch,
      stdinIsTTY: false,
      stdoutIsTTY: false,
      out: line => output.push(line),
    })).toBe(0);
    expect(jobReads).toBe(3);
    expect(output.at(-1)).toContain("completed");
  });

  test("confirmed job actions re-read the exact job instead of relying on the bounded first page", async () => {
    const f = fixture();
    const exactJob = {
      id: "opaque-job",
      revision: 11,
      state: "completed",
      phase: "completed" as const,
      action: "open" as const,
      reason: "artifact_ready",
      createdAt: 1,
      updatedAt: 2,
    };
    const job = mock(async () => exactJob);
    const jobs = mock(async () => []);
    const actOnJob = mock(async () => exactJob);
    f.deps.createService = () => ({
      status: f.status,
      probe: f.probe,
      acknowledge: f.acknowledge,
      job,
      jobs,
      actOnJob,
    });
    expect(await handleMediaCommand(["open", "opaque-job", "--revision", "11"], f.deps)).toBe(0);
    expect(job).toHaveBeenCalledWith("opaque-job");
    expect(jobs).toHaveBeenCalledTimes(0);
    expect(actOnJob).toHaveBeenCalledWith("open", "opaque-job", 11);
  });

  test("recovery mutation requires two TTYs, confirmation, and exact runtime re-attestation", async () => {
    expect(parseMediaArgs(["recovery", "reset", "recovery-id", "--revision", "2"]))
      .toEqual({ command: "recovery-action", action: "quarantine_reset", id: "recovery-id", revision: 2 });
    expect(() => parseMediaArgs(["recovery", "reset", "recovery-id", "--revision", "2", "--yes"])).toThrow();

    let f = fixture({ stdinIsTTY: false });
    const recover = mock(async () => null);
    f.deps.createService = () => ({ status: f.status, probe: f.probe, acknowledge: f.acknowledge, recover });
    expect(await handleMediaCommand(["recovery", "reset", "recovery-id", "--revision", "2"], f.deps)).toBe(1);
    expect(recover).toHaveBeenCalledTimes(0);

    f = fixture();
    const applied = mock(async () => ({
      id: "recovery-id", revision: 3, cause: "old_schema", readOnly: false,
      acknowledgementRequired: true, restartRequired: true,
    }));
    const recovery = mock(async () => ({
      id: "recovery-id", revision: 2, cause: "old_schema", readOnly: false,
      acknowledgementRequired: false, restartRequired: true,
    }));
    f.deps.createService = () => ({ status: f.status, probe: f.probe, acknowledge: f.acknowledge, recovery, recover: applied });
    expect(await handleMediaCommand(["recovery", "reset", "recovery-id", "--revision", "2"], f.deps)).toBe(0);
    expect(f.attest).toHaveBeenCalledTimes(2);
    expect(recovery).toHaveBeenCalledTimes(1);
    expect(applied).toHaveBeenCalledWith("quarantine_reset", "recovery-id", 2);
  });
});
