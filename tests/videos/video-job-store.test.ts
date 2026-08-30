import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
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
});
