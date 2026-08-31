import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ProviderAdapter } from "../../src/adapters/base";
import { MediaRuntime, type ModelVideoRuntime } from "../../src/images/media-runtime";
import type { VideoBridgePlan } from "../../src/images/types";
import { openVideoJobStore } from "../../src/images/video-job-store";
import { runResponsesAuxiliaryLoop } from "../../src/responses/auxiliary";
import type { AdapterEvent, CodexCommanderParsedRequest } from "../../src/types";
import { createTestTranslatorBudget } from "../helpers/translator-budget";

const roots: string[] = [];
const videoPlan = {
  auth: {
    authSource: "api_key",
    providerKind: "canonical",
    slotRef: "media-slot:private-sentinel",
    identityDigest: `sha256:${"b".repeat(64)}`,
  },
  model: "private-video-model",
  toolNames: new Set(["video_gen"]),
} as VideoBridgePlan;

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

function parsedRequest(): CodexCommanderParsedRequest {
  return {
    modelId: "test-model",
    context: { messages: [], tools: [] },
    stream: true,
    options: {},
  } as CodexCommanderParsedRequest;
}

async function providerVisibleVideoResult(runtime: ModelVideoRuntime): Promise<Record<string, unknown>> {
  const streams: AdapterEvent[][] = [
    [
      { type: "tool_call_start", id: "video_1", name: "video_gen" },
      { type: "tool_call_delta", arguments: '{"prompt":"private prompt sentinel"}' },
      { type: "tool_call_end" },
      { type: "done" },
    ],
    [{ type: "text_delta", text: "final response" }, { type: "done" }],
  ];
  const requestContexts: string[] = [];
  const adapter: ProviderAdapter = {
    name: "test",
    buildRequest(parsed) {
      requestContexts.push(JSON.stringify(parsed.context.messages));
      return { url: "https://model.invalid/v1/chat", method: "POST", headers: {}, body: "{}" };
    },
    fetchResponse: async () => new Response("{}", { status: 200 }),
    parseStream: async function* (): AsyncGenerator<AdapterEvent> {
      for (const event of streams.shift() ?? []) yield event;
    },
  };

  const response = await runResponsesAuxiliaryLoop({
    parsed: parsedRequest(),
    adapter,
    incomingMeta: { headers: new Headers(), translatorBudget: createTestTranslatorBudget() },
    videoPlan,
    videoRuntime: runtime,
    videoMaxRounds: 1,
  });
  expect(await response.text()).toContain("final response");

  const messages = JSON.parse(requestContexts.at(-1) ?? "[]") as Array<{
    role?: string;
    toolCallId?: string;
    content?: string;
  }>;
  const content = messages.find(message => message.role === "toolResult" && message.toolCallId === "video_1")?.content;
  expect(content).toBeString();
  return JSON.parse(content ?? "{}") as Record<string, unknown>;
}

function busyRuntime(jobId?: string): ModelVideoRuntime {
  return {
    async submitVideo() {
      return {
        kind: "busy",
        reservationId: "private-probe-operation-id",
        ...(jobId ? {
          job: {
            id: jobId,
            revision: 3,
            state: "accepted",
            deadlineAt: Date.now() + 60_000,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        } : {}),
      };
    },
    startVideoJob() { throw new Error("busy jobs must not start"); },
    getPublicVideoJob() { return null; },
    async waitForVideoUpdate() { return { kind: "missing" }; },
  };
}

describe("provider-visible auxiliary video recovery results", () => {
  test("capability-probe contention stays busy without exposing the probe operation id", async () => {
    expect(await providerVisibleVideoResult(busyRuntime())).toEqual({
      ok: false,
      status: "busy",
    });
  });

  test("video-job contention exposes only the actual bounded local job id", async () => {
    expect(await providerVisibleVideoResult(busyRuntime("actual-video-job-id"))).toEqual({
      ok: false,
      status: "busy",
      jobId: "actual-video-job-id",
    });
  });

  test("ambiguous paid submission keeps only status and the durable local recovery id", async () => {
    const root = await mkdtemp(join(tmpdir(), "ccx-auxiliary-video-recovery-"));
    roots.push(root);
    const store = openVideoJobStore({ path: join(root, "media-journal.sqlite") });
    const runtime = new MediaRuntime(store, {
      submitVideoJob: async () => {
        throw new Error(
          "https://provider.invalid/result?token=must-not-leak /private/local/video.mp4 private-artifact-id",
        );
      },
    });
    try {
      const payload = await providerVisibleVideoResult(runtime);
      const job = store.listVideoJobs()[0];
      expect(job?.state).toBe("outcome_unknown");
      expect(payload).toEqual({
        ok: false,
        status: "submission_outcome_unknown",
        jobId: job?.id,
      });
      expect(JSON.stringify(payload)).not.toContain("provider.invalid");
      expect(JSON.stringify(payload)).not.toContain("must-not-leak");
      expect(JSON.stringify(payload)).not.toContain("/private/local");
      expect(JSON.stringify(payload)).not.toContain("private-artifact-id");
      expect(JSON.stringify(payload)).not.toContain("private prompt sentinel");
      expect(JSON.stringify(payload)).not.toContain("private-video-model");
      expect(JSON.stringify(payload)).not.toContain("media-slot:private-sentinel");
    } finally {
      await runtime.shutdown();
    }
  });
});
