/**
 * /api/subagent-model-fallback atomic validation (PR #391).
 * Invalid chain entries must 400 without mutating the previous config.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleManagementAPI } from "../src/server/management-api";
import type { CodexCommanderConfig } from "../src/types";

const savedHome = process.env.CODEXCOMMANDER_HOME;
let tempHome: string | null = null;

afterEach(() => {
  if (savedHome === undefined) delete process.env.CODEXCOMMANDER_HOME;
  else process.env.CODEXCOMMANDER_HOME = savedHome;
  if (tempHome) {
    rmSync(tempHome, { recursive: true, force: true });
    tempHome = null;
  }
});

function isolatedHome(): void {
  tempHome = mkdtempSync(join(tmpdir(), "ccx-subagent-fallback-api-"));
  process.env.CODEXCOMMANDER_HOME = tempHome;
}

function makeConfig(overrides: Partial<CodexCommanderConfig> = {}): CodexCommanderConfig {
  return {
    port: 10100,
    multiAgentGuidanceEnabled: true,
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
      },
    },
    defaultProvider: "openai",
    subagentModelFallback: ["gpt-5.6-sol", "kimi/k3"],
    ...overrides,
  } as CodexCommanderConfig;
}

async function put(config: CodexCommanderConfig, body: unknown): Promise<Response> {
  const req = new Request("http://localhost/api/subagent-model-fallback", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const res = await handleManagementAPI(req, new URL(req.url), config);
  expect(res).not.toBeNull();
  return res!;
}

describe("/api/subagent-model-fallback atomic validation", () => {
  test("rejects one invalid entry with 400 and leaves previous config unchanged", async () => {
    isolatedHome();
    const previous = ["gpt-5.6-sol", "kimi/k3"];
    const config = makeConfig({ subagentModelFallback: [...previous] });

    const res = await put(config, {
      models: ["gpt-5.6-sol", 42, "alibaba-token-plan/qwen3.8-max"],
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string; index: number; value: unknown };
    expect(body.error).toBe("models[1] must be a non-empty string");
    expect(body.index).toBe(1);
    expect(body.value).toBe(42);
    expect(config.subagentModelFallback).toEqual(previous);
  });

  test("rejects empty-string entries without truncating the chain", async () => {
    isolatedHome();
    const previous = ["gpt-5.6-sol", "kimi/k3"];
    const config = makeConfig({ subagentModelFallback: [...previous] });

    const res = await put(config, {
      models: ["gpt-5.6-sol", "   ", "kimi/k3"],
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string; index: number };
    expect(body.error).toBe("models[1] must be a non-empty string");
    expect(body.index).toBe(1);
    expect(config.subagentModelFallback).toEqual(previous);
  });

  test("rejects an old raw nested selector without mutating the chain", async () => {
    isolatedHome();
    const previous = ["gpt-5.6-sol", "kimi/k3"];
    const config = makeConfig({ subagentModelFallback: [...previous] });

    const res = await put(config, { models: ["openrouter/anthropic/claude-sonnet-5"] });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "models[0] must be a canonical selector", index: 0 });
    expect(config.subagentModelFallback).toEqual(previous);
  });

  test("accepts a fully valid chain after validation", async () => {
    isolatedHome();
    const config = makeConfig();
    const next = ["gpt-5.6-sol", "alibaba-token-plan/qwen3.8-max"];
    const res = await put(config, { models: next });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, models: next });
    expect(config.subagentModelFallback).toEqual(next);
  });
});
import { ManagementRequest as Request } from "./helpers/management-auth";
