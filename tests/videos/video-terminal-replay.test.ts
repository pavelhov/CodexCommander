import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ProviderAdapter } from "../../src/adapters/base";
import type { ModelVideoRuntime } from "../../src/images/media-runtime";
import type { VideoBridgePlan } from "../../src/images/types";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import { runResponsesAuxiliaryLoop } from "../../src/responses/auxiliary";
import type { AdapterEvent, CodexCommanderParsedRequest } from "../../src/types";

const TEST_HOME = join(import.meta.dir, ".tmp-video-terminal-replay");
const ARTIFACT_ID = "terminal-replay.mp4";
const ARTIFACT_PATH = join(TEST_HOME, "artifacts", ARTIFACT_ID);
const previousHome = process.env.CODEXCOMMANDER_HOME;

const videoPlan: VideoBridgePlan = {
  auth: {
    authSource: "api_key",
    providerKind: "canonical",
    slotRef: "media-slot:terminal-replay",
    identityDigest: `sha256:${"a".repeat(64)}`,
  },
  model: "private-video-model",
  toolNames: new Set(["video_gen"]),
};

beforeAll(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
  mkdirSync(join(TEST_HOME, "artifacts"), { recursive: true });
  chmodSync(TEST_HOME, 0o700);
  process.env.CODEXCOMMANDER_HOME = TEST_HOME;
});

beforeEach(() => {
  mkdirSync(join(TEST_HOME, "artifacts"), { recursive: true });
  writeFileSync(ARTIFACT_PATH, "video");
});

afterAll(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.CODEXCOMMANDER_HOME;
  else process.env.CODEXCOMMANDER_HOME = previousHome;
});

function parsedRequest(): CodexCommanderParsedRequest {
  return {
    modelId: "fixture-model",
    context: { messages: [], tools: [] },
    stream: true,
    options: {},
  } as CodexCommanderParsedRequest;
}

function videoCallEvents(): AdapterEvent[] {
  return [
    { type: "tool_call_start", id: "video_terminal", name: "video_gen" },
    { type: "tool_call_delta", arguments: '{"prompt":"private terminal replay prompt"}' },
    { type: "tool_call_end" },
    { type: "done" },
  ];
}

function adapterFor(
  streams: AdapterEvent[][],
  builtContexts: string[],
  onBuild?: (iteration: number) => void,
): ProviderAdapter {
  let iteration = 0;
  return {
    name: "terminal-replay-fixture",
    buildRequest(parsed) {
      iteration += 1;
      onBuild?.(iteration);
      builtContexts.push(JSON.stringify(parsed.context.messages));
      return { url: "https://model.invalid/v1/chat", method: "POST", headers: {}, body: "{}" };
    },
    async fetchResponse() {
      return new Response("{}", { status: 200 });
    },
    async *parseStream() {
      for (const event of streams.shift() ?? []) yield event;
    },
  };
}

async function runReplay(
  runtime: ModelVideoRuntime,
  onBuild?: (iteration: number) => void,
): Promise<{ text: string; output: Record<string, unknown> }> {
  const builtContexts: string[] = [];
  const budget = createTranslatorBudget();
  try {
    const response = await runResponsesAuxiliaryLoop({
      parsed: parsedRequest(),
      adapter: adapterFor([
        videoCallEvents(),
        [{ type: "text_delta", text: "terminal replay handled" }, { type: "done" }],
      ], builtContexts, onBuild),
      incomingMeta: { headers: new Headers(), translatorBudget: budget },
      videoPlan,
      videoRuntime: runtime,
      videoMaxRounds: 1,
    });
    const text = await response.text();
    const replay = JSON.parse(builtContexts.at(-1) ?? "[]") as Array<{
      toolCallId?: string;
      content?: string;
    }>;
    const rawOutput = replay.find(message => message.toolCallId === "video_terminal")?.content ?? "{}";
    return { text, output: JSON.parse(rawOutput) as Record<string, unknown> };
  } finally {
    budget.dispose();
  }
}

describe("generic Responses terminal video replay", () => {
  test("completed replay leases the artifact before a retention race and emits no progress", async () => {
    const now = Date.now();
    const events: string[] = [];
    let leaseActive = false;
    const runtime: ModelVideoRuntime = {
      async submitVideo() {
        events.push("submit");
        return {
          kind: "replay",
          job: {
            id: "job_completed_replay",
            revision: 4,
            state: "completed",
            deadlineAt: now + 60_000,
            artifactId: ARTIFACT_ID,
            createdAt: now,
            updatedAt: now,
          },
        };
      },
      startVideoJob() {
        events.push("start");
        // Models the concurrent sweep exposed by the old bogus progress yield.
        if (!leaseActive) rmSync(ARTIFACT_PATH, { force: true });
      },
      getPublicVideoJob() { return null; },
      async waitForVideoUpdate() { throw new Error("terminal replay must not wait"); },
      acquireArtifactDeliveryLease(id) {
        expect(id).toBe(ARTIFACT_ID);
        expect(existsSync(ARTIFACT_PATH)).toBe(true);
        events.push("lease");
        leaseActive = true;
        return () => {
          events.push("release");
          leaseActive = false;
        };
      },
    };

    const { text, output } = await runReplay(runtime, iteration => {
      if (iteration !== 2) return;
      events.push("replay-build");
      expect(leaseActive).toBe(true);
      expect(existsSync(ARTIFACT_PATH)).toBe(true);
    });

    expect(output).toEqual({
      ok: true,
      status: "completed",
      artifacts: [`/v1/codexcommander/artifacts/${ARTIFACT_ID}`],
      markdown: `[Open video](/v1/codexcommander/artifacts/${ARTIFACT_ID})`,
    });
    expect(text).toContain("terminal replay handled");
    expect(text).not.toContain("Video accepted");
    expect(events).toEqual(["submit", "lease", "replay-build", "release"]);
    expect(leaseActive).toBe(false);
  });

  test.each(["failed", "artifact_pruned", "acknowledged"] as const)(
    "%s replay returns a terminal failure without start, wait, progress, or lease",
    async state => {
      const now = Date.now();
      let starts = 0;
      let waits = 0;
      let leases = 0;
      const runtime: ModelVideoRuntime = {
        async submitVideo() {
          return {
            kind: "replay",
            job: {
              id: `job_${state}`,
              revision: 3,
              state,
              deadlineAt: now + 60_000,
              ...(state === "artifact_pruned" ? { artifactId: ARTIFACT_ID } : {}),
              createdAt: now,
              updatedAt: now,
            },
          };
        },
        startVideoJob() { starts += 1; },
        getPublicVideoJob() { return null; },
        async waitForVideoUpdate() {
          waits += 1;
          return { kind: "missing" };
        },
        acquireArtifactDeliveryLease() {
          leases += 1;
          return () => {};
        },
      };

      const { text, output } = await runReplay(runtime);
      expect(output).toEqual(state === "artifact_pruned"
        ? { ok: false, status: "artifact_unavailable" }
        : { ok: false, status: "failed", jobId: `job_${state}` });
      expect(text).not.toContain("Video accepted");
      expect(starts).toBe(0);
      expect(waits).toBe(0);
      expect(leases).toBe(0);
    },
  );
});
