import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

import { openVideoJobStore } from "../../src/images/video-job-store";
import type { MediaCredentialBinding } from "../../src/images/types";

const roots: string[] = [];
const binding: MediaCredentialBinding = {
  authSource: "subscription_oauth",
  providerKind: "canonical",
  slotRef: "media-slot:test-opaque",
  identityDigest: `sha256:${"a".repeat(64)}`,
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ccx-media-store-"));
  roots.push(root);
  return { root, path: join(root, "private", "media-journal.sqlite") };
}

describe("video job journal", () => {
  test("is owner-only, versioned, synchronous FULL, prompt-free, and revision-CAS guarded", async () => {
    const f = await fixture();
    const store = openVideoJobStore({ path: f.path, now: () => 1_000 });
    const reserved = store.reserveVideoJob({ binding, deadlineAt: 61_000 });
    expect(reserved.kind).toBe("created");
    if (reserved.kind !== "created") throw new Error("expected reservation");
    expect(reserved.job.state).toBe("queued");

    const fenced = store.fenceVideoSubmission(reserved.job.id, reserved.job.revision);
    expect(fenced.kind).toBe("updated");
    if (fenced.kind !== "updated") throw new Error("expected fence");
    const accepted = store.commitVideoAccepted(fenced.job.id, fenced.job.revision, "upstream-private-id");
    expect(accepted.kind).toBe("updated");
    if (accepted.kind !== "updated") throw new Error("expected accepted commit");
    expect(accepted.job.state).toBe("accepted");

    const stale = store.transitionVideoJob({
      id: accepted.job.id,
      expectedRevision: fenced.job.revision,
      from: ["accepted"],
      to: "polling",
    });
    expect(stale.kind).toBe("conflict");
    expect(store.publicVideoJob(accepted.job.id)).not.toHaveProperty("requestId");
    expect(store.publicVideoJob(accepted.job.id)).not.toHaveProperty("binding");
    store.close();

    if (process.platform !== "win32") {
      expect((await stat(f.path)).mode & 0o777).toBe(0o600);
      expect((await stat(join(f.root, "private"))).mode & 0o777).toBe(0o700);
    }
    const db = new Database(f.path, { readonly: true });
    expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(1);
    expect(db.query<{ synchronous: number }, []>("PRAGMA synchronous").get()?.synchronous).toBe(2);
    const columns = db.query<{ name: string }, []>("PRAGMA table_info(video_jobs)").all().map(row => row.name);
    expect(columns).not.toContain("prompt");
    expect(columns).not.toContain("url");
    expect(columns).not.toContain("provider_body");
    db.close();
  });

  test("startup converts a leftover submitting fence to outcome_unknown and holds admission until CAS acknowledgement", async () => {
    const f = await fixture();
    let store = openVideoJobStore({ path: f.path, now: () => 1_000 });
    const reserved = store.reserveVideoJob({ binding, deadlineAt: 61_000 });
    if (reserved.kind !== "created") throw new Error("expected reservation");
    const fenced = store.fenceVideoSubmission(reserved.job.id, reserved.job.revision);
    if (fenced.kind !== "updated") throw new Error("expected fence");
    store.close();

    store = openVideoJobStore({ path: f.path, now: () => 2_000 });
    const recovered = store.recoverStartup();
    expect(recovered.outcomeUnknown).toEqual([reserved.job.id]);
    const unknown = store.getVideoJob(reserved.job.id);
    expect(unknown?.state).toBe("outcome_unknown");
    const blocked = store.reserveVideoJob({ binding, deadlineAt: 62_000 });
    expect(blocked.kind).toBe("busy");

    const stale = store.acknowledgeVideoOutcomeUnknown(reserved.job.id, fenced.job.revision);
    expect(stale.kind).toBe("conflict");
    const acknowledged = store.acknowledgeVideoOutcomeUnknown(reserved.job.id, unknown!.revision);
    expect(acknowledged.kind).toBe("updated");
    const next = store.reserveVideoJob({ binding, deadlineAt: 62_000 });
    expect(next.kind).toBe("created");
    store.close();
  });

  test("rejects a concurrent recovery owner and admits the same path after close", async () => {
    const f = await fixture();
    const first = openVideoJobStore({ path: f.path, now: () => 1_000 });
    expect(() => openVideoJobStore({ path: f.path, now: () => 1_000 })).toThrow("media journal is busy");
    first.close();
    const successor = openVideoJobStore({ path: f.path, now: () => 2_000 });
    successor.close();
  });

  test("rejects an overlapping recovery owner in another process", async () => {
    const f = await fixture();
    const first = openVideoJobStore({ path: f.path, now: () => 1_000 });
    const moduleUrl = pathToFileURL(join(import.meta.dir, "../../src/images/video-job-store.ts")).href;
    const script = `
      import { openVideoJobStore } from ${JSON.stringify(moduleUrl)};
      try {
        const store = openVideoJobStore({ path: ${JSON.stringify(f.path)} });
        store.close();
        process.stdout.write("opened");
      } catch (error) {
        process.stdout.write(error instanceof Error ? error.message : String(error));
      }
    `;
    const child = Bun.spawn({
      cmd: [process.execPath, "-e", script],
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });
    const output = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    expect(await child.exited).toBe(0);
    expect(stderr).toBe("");
    expect(output).toContain("media journal is busy");
    first.close();
  });

  test.each(["accepted", "needs_auth", "downloading", "download_failed"] as const)(
    "startup expires overdue %s work under its original absolute deadline",
    async state => {
      const f = await fixture();
      let store = openVideoJobStore({ path: f.path, now: () => 1_000 });
      const reservation = store.reserveVideoJob({ binding, deadlineAt: 2_000 });
      if (reservation.kind !== "created") throw new Error("expected reservation");
      const fenced = store.fenceVideoSubmission(reservation.job.id, reservation.job.revision);
      if (fenced.kind !== "updated") throw new Error("expected fence");
      const accepted = store.commitVideoAccepted(fenced.job.id, fenced.job.revision, "accepted-id");
      if (accepted.kind !== "updated") throw new Error("expected accepted");
      let current = accepted.job;
      if (state !== "accepted") {
        const polling = store.transitionVideoJob({ id: current.id, expectedRevision: current.revision, from: ["accepted"], to: "polling" });
        if (polling.kind !== "updated") throw new Error("expected polling");
        current = polling.job;
        if (state !== "downloading") {
          const target = store.transitionVideoJob({
            id: current.id,
            expectedRevision: current.revision,
            from: ["polling"],
            to: state,
            safeError: state === "needs_auth" ? "needs_auth" : "download_rejected",
          });
          if (target.kind !== "updated") throw new Error("expected target state");
          current = target.job;
        } else {
          const downloading = store.transitionVideoJob({ id: current.id, expectedRevision: current.revision, from: ["polling"], to: "downloading" });
          if (downloading.kind !== "updated") throw new Error("expected downloading");
        }
      }
      store.close();

      store = openVideoJobStore({ path: f.path, now: () => 2_001 });
      const recovered = store.recoverStartup();
      expect(recovered.pollable).toEqual([]);
      expect(store.getVideoJob(reservation.job.id)).toMatchObject({ state: "expired", deadlineAt: 2_000, safeError: "timeout" });
      expect(store.reserveVideoJob({ binding, deadlineAt: 5_000 }).kind).toBe("created");
      store.close();
    },
  );

  test.each(["queued", "submitting", "accepted", "polling", "needs_auth", "downloading", "download_failed", "outcome_unknown"] as const)(
    "holds one binding admission throughout %s",
    async targetState => {
      const f = await fixture();
      const store = openVideoJobStore({ path: f.path, now: () => 1_000 });
      const reservation = store.reserveVideoJob({ binding, deadlineAt: 61_000 });
      if (reservation.kind !== "created") throw new Error("expected reservation");
      let current = reservation.job;
      if (targetState !== "queued") {
        const fenced = store.fenceVideoSubmission(current.id, current.revision);
        if (fenced.kind !== "updated") throw new Error("expected fence");
        current = fenced.job;
      }
      if (!["queued", "submitting", "outcome_unknown"].includes(targetState)) {
        const accepted = store.commitVideoAccepted(current.id, current.revision, "accepted-id");
        if (accepted.kind !== "updated") throw new Error("expected accepted");
        current = accepted.job;
      }
      if (["polling", "needs_auth", "downloading", "download_failed"].includes(targetState)) {
        const polling = store.transitionVideoJob({ id: current.id, expectedRevision: current.revision, from: ["accepted"], to: "polling" });
        if (polling.kind !== "updated") throw new Error("expected polling");
        current = polling.job;
      }
      if (targetState === "needs_auth" || targetState === "downloading" || targetState === "download_failed") {
        const target = store.transitionVideoJob({
          id: current.id,
          expectedRevision: current.revision,
          from: ["polling"],
          to: targetState,
          ...(targetState === "needs_auth" ? { safeError: "needs_auth" as const } : {}),
          ...(targetState === "download_failed" ? { safeError: "download_rejected" as const } : {}),
        });
        if (target.kind !== "updated") throw new Error("expected target");
        current = target.job;
      } else if (targetState === "outcome_unknown") {
        const unknown = store.transitionVideoJob({
          id: current.id,
          expectedRevision: current.revision,
          from: ["submitting"],
          to: "outcome_unknown",
          safeError: "ambiguous_submission",
        });
        if (unknown.kind !== "updated") throw new Error("expected unknown");
        current = unknown.job;
      }
      expect(current.state).toBe(targetState);
      expect(store.reserveVideoJob({ binding, deadlineAt: 61_000 })).toEqual({
        kind: "busy",
        reservationId: current.id,
      });

      const released = targetState === "outcome_unknown"
        ? store.acknowledgeVideoOutcomeUnknown(current.id, current.revision)
        : store.transitionVideoJob({
            id: current.id,
            expectedRevision: current.revision,
            from: [targetState],
            to: targetState === "downloading" ? "completed"
              : targetState === "queued" || targetState === "accepted" || targetState === "polling" || targetState === "needs_auth"
                ? "cancelled"
                : targetState === "submitting" ? "failed" : "expired",
            ...(targetState === "downloading" ? { artifactId: "vid-complete.mp4" } : {}),
          });
      expect(released.kind).toBe("updated");
      expect(store.reserveVideoJob({ binding, deadlineAt: 61_000 }).kind).toBe("created");
      store.close();
    },
  );
});
