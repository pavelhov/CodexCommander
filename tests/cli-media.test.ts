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

  test("invalid arguments and failed attestation reach no service or mutation", async () => {
    let f = fixture();
    expect(await handleMediaCommand(["probe", "--yes"], f.deps)).toBe(2);
    expect(f.attest).toHaveBeenCalledTimes(0);
    expect(f.createService).toHaveBeenCalledTimes(0);

    f = fixture({ attest: async () => null });
    expect(await handleMediaCommand(["probe"], f.deps)).toBe(1);
    expect(f.createService).toHaveBeenCalledTimes(0);
    expect(f.probe).toHaveBeenCalledTimes(0);
  });

  test("noninteractive or declined confirmation performs zero mutation", async () => {
    let f = fixture({ stdinIsTTY: false });
    expect(await handleMediaCommand(["probe"], f.deps)).toBe(1);
    expect(f.probe).toHaveBeenCalledTimes(0);

    f = fixture({ status: { ...safeStatus, source: "api_key" } });
    expect(await handleMediaCommand(["probe"], f.deps)).toBe(1);
    expect(f.confirm).toHaveBeenCalledTimes(0);
    expect(f.probe).toHaveBeenCalledTimes(0);

    f = fixture({ confirm: false });
    expect(await handleMediaCommand(["probe"], f.deps)).toBe(1);
    expect(f.confirm).toHaveBeenCalledTimes(1);
    expect(f.probe).toHaveBeenCalledTimes(0);
  });

  test("accepted confirmation re-attests the exact runtime and mutates once with fixed fields", async () => {
    const f = fixture();
    expect(await handleMediaCommand(["probe"], f.deps)).toBe(0);
    expect(f.attest).toHaveBeenCalledTimes(2);
    expect(f.probe).toHaveBeenCalledTimes(1);
    expect(f.probe.mock.calls[0]?.[0]).toEqual({
      action: "probe",
      expectedRevision: 7,
      confirmation: true,
    });
    expect(f.output.join("\n")).toContain("billing attribution: unknown");
    expect(f.output.join("\n")).toContain("not packaged verification");
  });

  test("runtime rotation during confirmation aborts without mutation", async () => {
    let calls = 0;
    const f = fixture({
      attest: async () => {
        calls += 1;
        return calls === 1 ? target : { ...target, runtimeRecordIdentity: "opaque-b" };
      },
    });
    expect(await handleMediaCommand(["probe"], f.deps)).toBe(5);
    expect(f.probe).toHaveBeenCalledTimes(0);
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
});
