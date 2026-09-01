import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { MediaRuntime } from "../../src/images/media-runtime";
import { mediaError } from "../../src/images/media-errors";
import { openVideoJobStore } from "../../src/images/video-job-store";
import type { MediaCredentialBinding } from "../../src/images/types";

const roots: string[] = [];
const binding: MediaCredentialBinding = {
  authSource: "subscription_oauth",
  providerKind: "canonical",
  slotRef: "media-slot:test-opaque",
  identityDigest: `sha256:${"b".repeat(64)}`,
};
const request = {
  prompt: "ephemeral test prompt",
  model: "grok-imagine-video-1.5",
  duration: 1,
  resolution: "1080p",
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ccx-media-crash-"));
  roots.push(root);
  return join(root, "private", "journal.sqlite");
}

describe("video runtime crash seams", () => {
  test("a crash before the durable submission fence is cancelled on restart with zero POST", async () => {
    const path = await fixture();
    const operationKey = `hmac-sha256:${"1".repeat(64)}`;
    const requestSemanticsDigest = `hmac-sha256:${"2".repeat(64)}`;
    const submit = mock(async () => ({ requestId: "private-upstream-id" }));
    let store = openVideoJobStore({ path, now: () => 1_000 });
    let runtime = new MediaRuntime(store, {
      now: () => 1_000,
      submitVideoJob: submit,
      crashSeam(name) {
        if (name === "before_fence") throw new Error("simulated process loss");
      },
    });
    await expect(runtime.submitVideo({
      binding,
      deadlineAt: 61_000,
      request,
      operationKey,
      requestSemanticsDigest,
    })).rejects.toThrow("simulated");
    expect(submit).toHaveBeenCalledTimes(0);
    store.close();

    store = openVideoJobStore({ path, now: () => 2_000 });
    runtime = new MediaRuntime(store, { now: () => 2_000, submitVideoJob: submit });
    const recovered = await runtime.recoverOnStartup();
    expect(recovered).toEqual([]);
    expect(submit).toHaveBeenCalledTimes(0);
    expect(store.listVideoJobs()[0]?.state).toBe("cancelled");
    expect(store.listVideoJobs()[0]?.operationKey).toBeUndefined();
    const retried = store.reserveVideoJob({
      binding,
      deadlineAt: 62_000,
      operationKey,
      requestSemanticsDigest,
    });
    expect(retried.kind).toBe("created");
    if (retried.kind !== "created") throw new Error("expected exact pre-dispatch retry admission");
    expect(retried.job.id).not.toBe(store.listVideoJobs()[0]?.id);
    store.close();
  });

  test.each(["after_fence", "after_request_id"] as const)("%s restarts to outcome_unknown with zero duplicate POST", async seam => {
    const path = await fixture();
    const submit = mock(async () => ({ requestId: "private-upstream-id" }));
    let store = openVideoJobStore({ path, now: () => 1_000 });
    let runtime = new MediaRuntime(store, {
      now: () => 1_000,
      submitVideoJob: submit,
      crashSeam(name) {
        if (name === seam) throw new Error("simulated process loss");
      },
    });
    await expect(runtime.submitVideo({ binding, deadlineAt: 61_000, request })).rejects.toThrow("simulated");
    expect(submit).toHaveBeenCalledTimes(seam === "after_fence" ? 0 : 1);
    store.close();

    store = openVideoJobStore({ path, now: () => 2_000 });
    runtime = new MediaRuntime(store, { now: () => 2_000, submitVideoJob: submit });
    await runtime.recoverOnStartup();
    expect(submit).toHaveBeenCalledTimes(seam === "after_fence" ? 0 : 1);
    expect(store.listVideoJobs()[0]?.state).toBe("outcome_unknown");
    store.close();
  });

  test("a crash after accepted commit recovers by GET polling and never resubmits", async () => {
    const path = await fixture();
    const submit = mock(async () => ({ requestId: "private-upstream-id" }));
    const poll = mock(async () => ({ status: "processing" as const }));
    let store = openVideoJobStore({ path, now: () => 1_000 });
    let runtime = new MediaRuntime(store, {
      now: () => 1_000,
      submitVideoJob: submit,
      pollVideoJob: poll,
      crashSeam(name) {
        if (name === "after_accepted_commit") throw new Error("simulated process loss");
      },
    });
    await expect(runtime.submitVideo({ binding, deadlineAt: 61_000, request })).rejects.toThrow("simulated");
    store.close();

    store = openVideoJobStore({ path, now: () => 2_000 });
    runtime = new MediaRuntime(store, { now: () => 2_000, submitVideoJob: submit, pollVideoJob: poll });
    await runtime.recoverOnStartup();
    expect(submit).toHaveBeenCalledTimes(1);
    expect(poll).toHaveBeenCalledTimes(1);
    expect(store.listVideoJobs()[0]?.state).toBe("accepted");
    expect(JSON.stringify(store.publicVideoJob(store.listVideoJobs()[0]!.id))).not.toContain("private-upstream-id");
    store.close();
  });

  test("an ambiguous failure during POST is durable outcome_unknown and restart never retries POST", async () => {
    const path = await fixture();
    const submit = mock(async () => {
      throw mediaError({
        code: "ambiguous_submission",
        phase: "submit",
        certainty: "ambiguous",
        reason: "network",
      });
    });
    let store = openVideoJobStore({ path, now: () => 1_000 });
    let runtime = new MediaRuntime(store, { now: () => 1_000, submitVideoJob: submit });
    await expect(runtime.submitVideo({ binding, deadlineAt: 61_000, request })).rejects.toMatchObject({
      code: "ambiguous_submission",
    });
    expect(store.listVideoJobs()[0]?.state).toBe("outcome_unknown");
    store.close();

    store = openVideoJobStore({ path, now: () => 2_000 });
    runtime = new MediaRuntime(store, { now: () => 2_000, submitVideoJob: submit });
    await runtime.recoverOnStartup();
    expect(submit).toHaveBeenCalledTimes(1);
    expect(store.listVideoJobs()[0]?.state).toBe("outcome_unknown");
    store.close();
  });
});
