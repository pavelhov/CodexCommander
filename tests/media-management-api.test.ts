import { describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";

import type { PublicVideoJob, VideoJobState } from "../src/images/video-job-store";
import type { CapabilityProbeStatus } from "../src/images/capability-probe";
import {
  createMediaActionAttestationProof,
  MEDIA_ACTION_ATTESTATION_MAX_AGE_MS,
  type MediaActionAttestationInput,
  verifyMediaActionAttestationProof,
} from "../src/lib/media-action-attestation";
import { createLocalAttestationSecret } from "../src/lib/local-management-attestation";
import { handleManagementAPI } from "../src/server/management-api";
import {
  publicMediaJobStatus,
  publicMediaProbeStatus,
  spawnMediaArtifactOpener,
  type MediaManagementRuntime,
} from "../src/server/management/media-routes";
import type { CodexCommanderConfig } from "../src/types";

function config(): CodexCommanderConfig {
  return {
    port: 10100,
    hostname: "127.0.0.1",
    defaultProvider: "xai",
    providers: {
      xai: {
        adapter: "openai-chat",
        baseUrl: "https://api.x.ai/v1",
        authMode: "oauth",
        apiKey: "private-key-material",
        apiKeyPool: [{ id: "private-key-id", key: "private-key-material" }],
      },
    },
    images: { bridgeEnabled: false, videoBridgeEnabled: false, authSource: "api_key" },
  } as CodexCommanderConfig;
}

function job(state: VideoJobState, index = 0): PublicVideoJob {
  return {
    id: `job-${index}`,
    revision: index,
    state,
    deadlineAt: 9_999_999,
    ...(state === "completed" ? { artifactId: `artifact-${index}.mp4` } : {}),
    ...(state === "outcome_unknown" ? { safeError: "ambiguous_submission" as const } : {}),
    createdAt: 100 + index,
    updatedAt: 200 + index,
    // Deliberately hostile private-looking additions prove the allowlist projection.
    requestId: "provider-request-private",
    bindingDigest: "private-digest",
    signedUrl: "https://signed.invalid/private",
    path: "/private/artifact",
    prompt: "private prompt",
  } as PublicVideoJob;
}

async function request(
  cfg: CodexCommanderConfig,
  runtime: MediaManagementRuntime | undefined,
  path: string,
  init: RequestInit = {},
  principal: "admin-token" | "confirmed-gui-session" = "admin-token",
) {
  const headers = new Headers(init.headers);
  headers.set("Host", "127.0.0.1:10100");
  const req = new Request(`http://127.0.0.1:10100${path}`, { ...init, headers });
  return handleManagementAPI(req, new URL(req.url), cfg, {
    mediaManagement: runtime,
    saveConfigPreservingClaudeCode: () => {},
  }, principal);
}

describe("media management resource", () => {
  test("GET is bounded, paginated, no-store, and privacy allowlisted", async () => {
    const jobs = Array.from({ length: 30 }, (_, index) => job(index === 0 ? "completed" : "polling", index));
    const runtime: MediaManagementRuntime = {
      state: "ready",
      listJobs: () => jobs,
      getJob: id => jobs.find(candidate => candidate.id === id) ?? null,
    };
    const response = (await request(config(), runtime, "/api/media?limit=10&cursor=5"))!;
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const value = await response.json() as { jobs: unknown[]; page: { nextCursor: string | null } };
    expect(value.jobs).toHaveLength(10);
    expect(value.page.nextCursor).toBe("15");
    const serialized = JSON.stringify(value);
    for (const forbidden of [
      "private-key-material", "private-key-id", "provider-request-private", "private-digest",
      "signed.invalid", "/private/artifact", "private prompt", "artifact-0.mp4",
    ]) expect(serialized).not.toContain(forbidden);

    const probe = publicMediaProbeStatus({
      id: "probe-operation",
      revision: 3,
      source: "subscription_oauth",
      imageModel: "grok-imagine-image-2.0",
      videoModel: "grok-imagine-video-1.5",
      videoDurationSeconds: 1,
      videoResolution: "1080p",
      apiKeyFallbackDisabled: true,
      billingAttribution: "unknown",
      releaseStatus: "feasibility_only",
      contractRevision: "private-contract",
      probeVersion: 1,
      confirmationRevision: 9,
      createdAt: 1,
      updatedAt: 2,
      steps: {
        image: { kind: "image", revision: 4, state: "completed", dispatchCertainty: "completed", artifactId: "private-image.png", artifactExpiresAt: 5, confirmationRevision: 9, verifiedAt: 2, updatedAt: 2 },
        video: { kind: "video", revision: 2, state: "accepted", dispatchCertainty: "accepted", videoJobId: "private-video-job", confirmationRevision: 9, updatedAt: 2 },
      },
    } satisfies CapabilityProbeStatus);
    const safeProbe = JSON.stringify(probe);
    for (const forbidden of ["private-image.png", "private-video-job", "private-contract", "artifactExpiresAt", "confirmationRevision"]) {
      expect(safeProbe).not.toContain(forbidden);
    }

    expect((await request(config(), runtime, "/api/media?limit=101"))!.status).toBe(400);
    expect((await request(config(), runtime, "/api/media?unknown=1"))!.status).toBe(400);
    const exact = (await request(config(), runtime, "/api/media/jobs/job-29"))!;
    expect(exact.status).toBe(200);
    expect(await exact.json()).toMatchObject({ job: { id: "job-29", state: "polling" } });
    expect((await request(config(), runtime, "/api/media/jobs/job-29?extra=1"))!.status).toBe(400);
  });

  test("strict revisioned PATCH keeps image, video, source, and chat auth independent", async () => {
    const cfg = config();
    const settingsApplied = mock(() => {});
    const runtime: MediaManagementRuntime = { state: "ready", settingsApplied };
    const initial = (await (await request(cfg, runtime, "/api/media"))!.json()) as { revision: number };
    const unknown = await request(cfg, runtime, "/api/media", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: initial.revision, imagesEnabled: true, extra: true }),
    });
    expect(unknown!.status).toBe(400);

    const rawAdmin = await request(cfg, runtime, "/api/media", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: initial.revision, videosEnabled: true }),
    });
    expect(rawAdmin!.status).toBe(403);
    expect(settingsApplied).toHaveBeenCalledTimes(0);

    const credentialMutation = await request(cfg, runtime, "/api/media", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: initial.revision, videosEnabled: true, apiKey: "caller-secret" }),
    }, "confirmed-gui-session");
    expect(credentialMutation!.status).toBe(400);
    expect(JSON.stringify(cfg)).not.toContain("caller-secret");

    const applied = await request(cfg, runtime, "/api/media", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: initial.revision, videosEnabled: true }),
    }, "confirmed-gui-session");
    expect(applied!.status).toBe(200);
    const body = await applied!.json() as { settings: Record<string, unknown>; revision: number };
    expect(body.settings).toEqual({ imagesEnabled: false, videosEnabled: true, authSource: "api_key" });
    expect(cfg.providers.xai!.authMode).toBe("oauth");
    expect(settingsApplied).toHaveBeenCalledTimes(1);
    expect(settingsApplied).toHaveBeenCalledWith(cfg);

    const stale = await request(cfg, runtime, "/api/media", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: initial.revision, authSource: "subscription_oauth" }),
    }, "confirmed-gui-session");
    expect(stale!.status).toBe(409);
    expect(cfg.images!.authSource).toBe("api_key");

    const source = await request(cfg, runtime, "/api/media", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: body.revision, authSource: "subscription_oauth" }),
    }, "confirmed-gui-session");
    expect(source!.status).toBe(200);
    expect(cfg.images).toMatchObject({ bridgeEnabled: false, videoBridgeEnabled: true, authSource: "subscription_oauth" });
    expect(cfg.providers.xai!.authMode).toBe("oauth");
    expect(settingsApplied).toHaveBeenCalledTimes(2);
  });

  test("interactive CLI settings proof is exact-body bound and single-use", async () => {
    const secret = createLocalAttestationSecret();
    const pid = 4_321;
    const port = 10_100;
    const now = 2_000_000_000_000;
    const consumed = new Set<string>();
    const cfg = config();
    const runtime: MediaManagementRuntime = {
      state: "ready",
      authorizeInteractiveCliAction: (input, proof) => {
        if (consumed.has(input.nonce) || !verifyMediaActionAttestationProof(secret, input, pid, port, proof, now)) return false;
        consumed.add(input.nonce);
        return true;
      },
    };
    const initial = (await (await request(cfg, runtime, "/api/media"))!.json()) as { revision: number };
    const envelope = {
      action: "settings",
      target: "settings",
      id: "media-settings",
      expectedRevision: initial.revision,
      imagesEnabled: true,
      videosEnabled: false,
      authSource: "api_key",
      confirmation: true,
      caller: "interactive_cli",
      nonce: "s".repeat(43),
      issuedAt: now,
    } satisfies MediaActionAttestationInput;
    const send = (body: MediaActionAttestationInput, proof: string | null) => request(cfg, runtime, "/api/media", {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        ...(proof ? { "x-codexcommander-media-action-proof": proof } : {}),
      },
      body: JSON.stringify(body),
    });

    expect((await send(envelope, null))!.status).toBe(403);
    const changedBody = { ...envelope, videosEnabled: true };
    const changedProof = createMediaActionAttestationProof(secret, changedBody, pid, port);
    expect((await send(envelope, changedProof))!.status).toBe(403);
    const proof = createMediaActionAttestationProof(secret, envelope, pid, port);
    expect((await send(envelope, proof))!.status).toBe(200);
    expect(cfg.images).toMatchObject({ bridgeEnabled: true, videoBridgeEnabled: false, authSource: "api_key" });
    expect((await send(envelope, proof))!.status).toBe(403);
  });

  test("artifact opener uses fixed executables and a scrubbed Linux desktop environment", async () => {
    const sourceEnv = {
      PATH: "/hostile-bin",
      BROWSER: "credential-stealing-browser",
      XAI_API_KEY: "xai-provider-secret",
      OPENAI_API_KEY: "openai-provider-secret",
      AWS_SECRET_ACCESS_KEY: "cloud-secret",
      HOME: "/home/media-user",
      DISPLAY: ":99",
      WAYLAND_DISPLAY: "wayland-0",
      XDG_RUNTIME_DIR: "/run/user/1234",
      XDG_CURRENT_DESKTOP: "GNOME",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1234/bus",
      XAUTHORITY: "/run/user/1234/xauthority",
    };
    for (const [platform, expectedCommand, expectedRevealArgs] of [
      ["darwin", "/usr/bin/open", ["-R", "/private/artifact.mp4"]],
      ["linux", "/usr/bin/xdg-open", ["/private"]],
      ["win32", "C:\\Windows\\explorer.exe", ["/select,", "/private/artifact.mp4"]],
    ] as const) {
      let captured: { command: string; args: string[]; env: Record<string, string> } | undefined;
      const result = await spawnMediaArtifactOpener("/private/artifact.mp4", true, {
        platform,
        sourceEnv,
        spawnImpl: (command, args, options) => {
          captured = { command, args, env: options.env };
          const child = Object.assign(new EventEmitter(), {
            kill: () => true,
            unref: () => child,
          });
          queueMicrotask(() => child.emit("exit", 0, null));
          return child;
        },
      });
      expect(result).toBe(true);
      expect(captured?.command).toBe(expectedCommand);
      expect(captured?.command).not.toContain("hostile-bin");
      expect(JSON.stringify(captured?.env)).not.toContain("secret");
      expect(captured?.env.BROWSER).toBeUndefined();
      expect(captured?.env.XAI_API_KEY).toBeUndefined();
      expect(captured?.env.OPENAI_API_KEY).toBeUndefined();
      expect(captured?.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
      expect(captured?.env).toEqual(platform === "linux"
        ? {
            PATH: "/usr/bin:/bin",
            DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1234/bus",
            DISPLAY: ":99",
            HOME: "/home/media-user",
            WAYLAND_DISPLAY: "wayland-0",
            XAUTHORITY: "/run/user/1234/xauthority",
            XDG_CURRENT_DESKTOP: "GNOME",
            XDG_RUNTIME_DIR: "/run/user/1234",
          }
        : platform === "win32"
          ? { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows" }
          : {});
      expect(captured?.args).toEqual(expectedRevealArgs);
    }
  });

  test("artifact opener succeeds only after exit zero and bounds failed helpers", async () => {
    const resultFor = async (outcome: "zero" | "nonzero" | "signal" | "error") =>
      spawnMediaArtifactOpener("/private/artifact.mp4", false, {
        platform: "linux",
        sourceEnv: {},
        spawnImpl: () => {
          const child = Object.assign(new EventEmitter(), {
            kill: () => true,
            unref: () => child,
          });
          queueMicrotask(() => {
            if (outcome === "error") child.emit("error", new Error("controlled opener failure"));
            else if (outcome === "zero") child.emit("exit", 0, null);
            else if (outcome === "nonzero") child.emit("exit", 7, null);
            else child.emit("exit", null, "SIGTERM");
          });
          return child;
        },
      });

    expect(await resultFor("zero")).toBe(true);
    expect(await resultFor("nonzero")).toBe(false);
    expect(await resultFor("signal")).toBe(false);
    expect(await resultFor("error")).toBe(false);
    expect(await spawnMediaArtifactOpener("/private/artifact.mp4", false, {
      platform: "linux",
      sourceEnv: {},
      spawnImpl: () => { throw new Error("controlled synchronous spawn failure"); },
    })).toBe(false);

    const kill = mock(() => true);
    const unref = mock(() => undefined);
    expect(await spawnMediaArtifactOpener("/private/artifact.mp4", false, {
      platform: "linux",
      sourceEnv: {},
      timeoutMs: 5,
      spawnImpl: () => Object.assign(new EventEmitter(), { kill, unref }),
    })).toBe(false);
    expect(kill).toHaveBeenCalledTimes(1);
    expect(unref).toHaveBeenCalledTimes(1);
  });

  test("human action envelope principal-matches, CAS rechecks, and never accepts paths", async () => {
    let current = job("completed", 3);
    const launchArtifact = mock(async () => true);
    const acknowledgeJob = mock((id: string, expectedRevision: number) => {
      if (id !== current.id || expectedRevision !== current.revision || current.state !== "outcome_unknown") return null;
      current = { ...current, revision: current.revision + 1, state: "acknowledged" };
      return current;
    });
    const runtime: MediaManagementRuntime = {
      state: "ready",
      listJobs: () => [current],
      getJob: id => id === current.id ? current : null,
      acknowledgeJob,
      launchArtifact,
      authorizeInteractiveCliAction: (_input, proof) => proof === "proof",
    };
    const openBody = { action: "open", target: "job", id: current.id, expectedRevision: current.revision, confirmation: true, caller: "confirmed_gui" };
    expect((await request(config(), runtime, "/api/media/actions", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(openBody),
    }, "admin-token"))!.status).toBe(403);
    expect(launchArtifact).toHaveBeenCalledTimes(0);

    const withPath = { ...openBody, path: "/caller/path" };
    expect((await request(config(), runtime, "/api/media/actions", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(withPath),
    }, "confirmed-gui-session"))!.status).toBe(400);
    expect((await request(config(), runtime, "/api/media/actions", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...openBody, target: "recovery" }),
    }, "confirmed-gui-session"))!.status).toBe(400);

    const opened = await request(config(), runtime, "/api/media/actions", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(openBody),
    }, "confirmed-gui-session");
    expect(opened!.status).toBe(200);
    expect(launchArtifact).toHaveBeenCalledWith("artifact-3.mp4", false);
    expect(JSON.stringify(await opened!.json())).not.toContain("artifact-3.mp4");

    current = job("outcome_unknown", 4);
    const nonce = "a".repeat(43);
    const missingConfirm = { action: "acknowledge", target: "job", id: current.id, expectedRevision: current.revision, caller: "interactive_cli", nonce };
    expect((await request(config(), runtime, "/api/media/actions", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(missingConfirm),
    }))!.status).toBe(400);
    const ack = { ...missingConfirm, confirmation: true, issuedAt: Date.now() };
    expect((await request(config(), runtime, "/api/media/actions", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(ack),
    }))!.status).toBe(403);
    expect(acknowledgeJob).toHaveBeenCalledTimes(0);
    expect((await request(config(), runtime, "/api/media/actions", {
      method: "POST", headers: { "content-type": "application/json", "x-codexcommander-media-action-proof": "proof" }, body: JSON.stringify(ack),
    }))!.status).toBe(200);
    expect((await request(config(), runtime, "/api/media/actions", {
      method: "POST", headers: { "content-type": "application/json", "x-codexcommander-media-action-proof": "proof" }, body: JSON.stringify(ack),
    }))!.status).toBe(409);
  });

  test("interactive CLI proof is fresh, exact-body/runtime bound, and single-use before mutation", async () => {
    const secret = createLocalAttestationSecret();
    const pid = 4_321;
    const port = 10_100;
    const now = 2_000_000_000_000;
    const consumed = new Set<string>();
    let current = job("outcome_unknown", 5);
    const acknowledgeJob = mock((id: string, expectedRevision: number) => {
      if (id !== current.id || expectedRevision !== current.revision || current.state !== "outcome_unknown") return null;
      current = { ...current, revision: current.revision + 1, state: "acknowledged" };
      return current;
    });
    const runtime: MediaManagementRuntime = {
      state: "ready",
      acknowledgeJob,
      authorizeInteractiveCliAction: (input, proof) => {
        if (consumed.has(input.nonce) || !verifyMediaActionAttestationProof(secret, input, pid, port, proof, now)) return false;
        consumed.add(input.nonce);
        return true;
      },
    };
    const envelope = (nonce: string, issuedAt = now): MediaActionAttestationInput => ({
      action: "acknowledge",
      target: "job",
      id: current.id,
      expectedRevision: current.revision,
      confirmation: true,
      caller: "interactive_cli",
      nonce,
      issuedAt,
    });
    const send = async (body: MediaActionAttestationInput, proof?: string | null) => request(config(), runtime, "/api/media/actions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(proof ? { "x-codexcommander-media-action-proof": proof } : {}),
      },
      body: JSON.stringify(body),
    });

    const missing = envelope("a".repeat(43));
    expect((await send(missing))!.status).toBe(403);
    const forged = envelope("b".repeat(43));
    expect((await send(forged, "z".repeat(43)))!.status).toBe(403);
    const stale = envelope("c".repeat(43), now - MEDIA_ACTION_ATTESTATION_MAX_AGE_MS - 1);
    expect((await send(stale, createMediaActionAttestationProof(secret, stale, pid, port)))!.status).toBe(403);
    const mismatched = envelope("d".repeat(43));
    const differentBody = { ...mismatched, expectedRevision: mismatched.expectedRevision + 1 };
    expect((await send(mismatched, createMediaActionAttestationProof(secret, differentBody, pid, port)))!.status).toBe(403);
    const wrongRuntime = envelope("e".repeat(43));
    expect((await send(wrongRuntime, createMediaActionAttestationProof(secret, wrongRuntime, pid, port + 1)))!.status).toBe(403);
    expect(acknowledgeJob).toHaveBeenCalledTimes(0);

    const valid = envelope("f".repeat(43));
    const validProof = createMediaActionAttestationProof(secret, valid, pid, port);
    expect((await send(valid, validProof))!.status).toBe(200);
    expect(acknowledgeJob).toHaveBeenCalledTimes(1);
    expect((await send(valid, validProof))!.status).toBe(403);
    expect(acknowledgeJob).toHaveBeenCalledTimes(1);
  });

  test("ordinary readiness reads do not create or dispatch a probe, while legacy acknowledgement remains recoverable", async () => {
    const probeStatus = {
      id: "probe-operation",
      revision: 3,
      source: "subscription_oauth",
      imageModel: "grok-imagine-image-2.0",
      videoModel: "grok-imagine-video-1.5",
      videoDurationSeconds: 1,
      videoResolution: "1080p",
      apiKeyFallbackDisabled: true,
      billingAttribution: "unknown",
      releaseStatus: "feasibility_only",
      contractRevision: "xai-imagine-rest-v1",
      probeVersion: 1,
      createdAt: 1,
      updatedAt: 2,
      steps: {
        image: { kind: "image", revision: 1, state: "outcome_unknown", dispatchCertainty: "outcome_unknown", safeError: "ambiguous_submission", updatedAt: 2 },
        video: { kind: "video", revision: 0, state: "pending", dispatchCertainty: "not_dispatched", updatedAt: 1 },
      },
    } satisfies CapabilityProbeStatus;
    const prepare = mock(() => probeStatus);
    const run = mock(async () => probeStatus);
    const acknowledge = mock(() => ({
      ...probeStatus,
      revision: 4,
      steps: { ...probeStatus.steps, image: { ...probeStatus.steps.image, state: "acknowledged" as const } },
    }));
    const runtime: MediaManagementRuntime = {
      state: "ready",
      probe: { prepare, run, acknowledge } as unknown as NonNullable<MediaManagementRuntime["probe"]>,
      probeStatus: () => probeStatus,
      getProbeStatus: id => id === probeStatus.id ? probeStatus : null,
      probePreflightApproved: () => false,
    };
    const cfg = config();
    cfg.images!.authSource = "api_key";
    const read = (await request(cfg, runtime, "/api/media"))!;
    const resource = await read.json() as { probe: unknown; readiness: { facts: Record<string, unknown> } };
    expect(resource.probe).toBeNull();
    expect(resource.readiness.facts).toMatchObject({
      modelAccess: { image: { state: "unknown" }, video: { state: "unknown" } },
      billing: { state: "unknown" },
      quota: { state: "unknown", nextRequestAdmission: "unknown" },
      recoveryAdmission: { state: "admitted" },
    });
    // These are the two paths that respectively create a journal record and
    // dispatch image/video work. A readiness GET must never reach either.
    expect(prepare).toHaveBeenCalledTimes(0);
    expect(run).toHaveBeenCalledTimes(0);
    const exact = (await request(cfg, runtime, "/api/media/probes/probe-operation"))!;
    expect(exact.headers.get("cache-control")).toBe("no-store");
    expect(await exact.json()).toMatchObject({ probe: { id: "probe-operation", revision: 3 } });

    const probeBody = { action: "probe", target: "probe", id: "probe-operation", expectedRevision: 3, confirmation: true, caller: "confirmed_gui" };
    expect((await request(cfg, runtime, "/api/media/actions", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(probeBody),
    }, "confirmed-gui-session"))!.status).toBe(400);
    expect(prepare).toHaveBeenCalledTimes(0);
    expect(run).toHaveBeenCalledTimes(0);

    const acknowledgeBody = { action: "acknowledge", target: "probe", step: "image", id: "probe-operation", expectedRevision: 3, confirmation: true, caller: "confirmed_gui" };
    expect((await request(cfg, runtime, "/api/media/actions", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(acknowledgeBody),
    }, "confirmed-gui-session"))!.status).toBe(200);
    expect(acknowledge).toHaveBeenCalledTimes(1);
  });

  test("readiness separates local credentials from unknown provider access and invalidates a source switch", async () => {
    const cfg = config();
    cfg.images = { bridgeEnabled: true, videoBridgeEnabled: true, authSource: "api_key" };
    const apiKeyRead = await (await request(cfg, { state: "ready" }, "/api/media"))!.json() as {
      readiness: { facts: Record<string, unknown> };
    };
    expect(apiKeyRead.readiness.facts).toMatchObject({
      credentialAvailability: { source: "api_key", state: "available", observedAt: expect.any(Number) },
      modelAccess: { image: { state: "unknown" }, video: { state: "unknown" } },
      billing: { state: "unknown" },
      quota: { state: "unknown", nextRequestAdmission: "unknown" },
      freshness: { state: "current", lastObservedAt: expect.any(Number) },
    });

    cfg.images.authSource = "subscription_oauth";
    const oauthRead = await (await request(cfg, { state: "ready" }, "/api/media"))!.json() as {
      readiness: { facts: Record<string, unknown> };
    };
    expect(oauthRead.readiness.facts).toMatchObject({
      credentialAvailability: { source: "subscription_oauth", state: "unavailable", observedAt: null },
      freshness: { state: "not_observed", lastObservedAt: null },
    });
  });

  test("recovery projection advertises only actions that can currently succeed", async () => {
    const blocked = async (runtime: MediaManagementRuntime) => {
      const response = (await request(config(), runtime, "/api/media"))!;
      return (await response.json() as { recovery: { action: string } }).recovery.action;
    };
    expect(await blocked({
      state: "recovery_blocked",
      recovery: { id: "media-journal", revision: 0, cause: "future_schema", readOnly: true },
    })).toBe("upgrade");
    expect(await blocked({
      state: "recovery_blocked",
      recovery: { id: "media-journal", revision: 0, cause: "unsafe", readOnly: true },
    })).toBe("manual_recovery");
    expect(await blocked({
      state: "recovery_blocked",
      recovery: { id: "recovery-fence", revision: 0, cause: "corrupt", readOnly: false, acknowledgementRequired: true },
    })).toBe("acknowledge");
  });

  test("every durable job state has stable public interaction semantics", () => {
    const states: VideoJobState[] = [
      "queued", "submitting", "accepted", "polling", "needs_auth", "downloading",
      "download_failed", "outcome_unknown", "completed", "artifact_pruned", "failed",
      "expired", "cancelled", "acknowledged",
    ];
    const mapped = Object.fromEntries(states.map((state, index) => [state, publicMediaJobStatus(job(state, index))]));
    for (const state of ["queued", "submitting", "accepted", "polling", "downloading"]) {
      expect(mapped[state]).toMatchObject({ phase: "progress", action: "wait" });
    }
    expect(mapped.needs_auth).toMatchObject({ phase: "human_action_required", action: "recover_auth" });
    expect(mapped.download_failed).toMatchObject({ phase: "progress", action: "wait", reason: "credentialless_download_retry" });
    expect(mapped.outcome_unknown).toMatchObject({ phase: "human_action_required", action: "acknowledge" });
    expect(mapped.completed).toMatchObject({ phase: "completed", action: "open" });
    for (const state of ["artifact_pruned", "failed", "expired", "cancelled", "acknowledged"]) {
      expect(mapped[state]).toMatchObject({ phase: "terminal", action: "none" });
    }
  });
});
