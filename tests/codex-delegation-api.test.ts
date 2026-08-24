import { expect, test } from "bun:test";
import { handleManagementAPI } from "../src/server/management-api";
import type {
  CodexDelegationMutation,
  CodexDelegationMutationOutcome,
  CodexDelegationStatus,
} from "../src/codex/delegation-installer";
import { renderCodexDelegationBundle } from "../src/codex/delegation-templates";
import type { CodexCommanderConfig } from "../src/types";

const config: CodexCommanderConfig = {
  port: 10100,
  hostname: "127.0.0.1",
  defaultProvider: "test",
  providers: {
    test: {
      adapter: "openai-chat",
      baseUrl: "https://example.test/v1",
      disabled: true,
      models: ["gpt-test"],
    },
  },
};

function status(overrides: Partial<CodexDelegationStatus> = {}): CodexDelegationStatus {
  return {
    schemaVersion: 1,
    state: "not-installed",
    installedMode: null,
    artifacts: {
      skill: {
        state: "absent",
        displayPath: "$HOME/.agents/skills/codexcommander-delegation/SKILL.md",
      },
      agentsPolicy: { state: "absent", displayPath: "$CODEX_HOME/AGENTS.md" },
    },
    override: { state: "absent" },
    activation: "effective",
    previews: {
      balanced: { skillText: "managed skill", agentsBlockText: "managed AGENTS block" },
      orchestrator: { skillText: "managed skill", agentsBlockText: "managed AGENTS block" },
    },
    copyPrompts: { balanced: "managed copy prompt", orchestrator: "managed copy prompt" },
    ...overrides,
  };
}

function successStatus(): CodexDelegationMutationOutcome {
  return { ok: true, changed: true, status: status({ state: "current", installedMode: "orchestrator" }) };
}

function failure(reason: Extract<CodexDelegationMutationOutcome, { ok: false }> ["reason"], changed = false): CodexDelegationMutationOutcome {
  return { ok: false, changed, reason, status: status({ state: reason === "foreign_skill" ? "conflict" : "unsafe" }) };
}

function request(method: string, body?: unknown): Request {
  const headers = new Headers({ Host: "127.0.0.1:10100" });
  if (body !== undefined) headers.set("content-type", "application/json");
  return new Request("http://127.0.0.1:10100/api/codex-delegation", {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function streamedDelete(chunks: string[], headers: HeadersInit = {}): Request {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Request("http://127.0.0.1:10100/api/codex-delegation", {
    method: "DELETE",
    headers: { Host: "127.0.0.1:10100", ...headers },
    body,
  });
}

function bytesDelete(chunks: Uint8Array[]): Request {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Request("http://127.0.0.1:10100/api/codex-delegation", {
    method: "DELETE",
    headers: { Host: "127.0.0.1:10100" },
    body,
  });
}

async function dispatchRequest(
  req: Request,
  mutations: CodexDelegationMutation[],
  outcome: CodexDelegationMutationOutcome = successStatus(),
): Promise<Response> {
  const response = await handleManagementAPI(req, new URL(req.url), config, {
    inspectCodexDelegation: () => status(),
    mutateCodexDelegation: mutation => {
      mutations.push(mutation);
      return outcome;
    },
  }, "confirmed-gui-session");
  if (!response) throw new Error("delegation route was not registered");
  return response;
}

function makeDispatch(outcome: CodexDelegationMutationOutcome = successStatus()) {
  const mutations: CodexDelegationMutation[] = [];
  return {
    mutations,
    dispatch: async (
      method: string,
      body: unknown,
      principal?: "admin-token" | "confirmed-gui-session",
    ): Promise<Response> => {
      const req = request(method, body);
      const response = await handleManagementAPI(req, new URL(req.url), config, {
        inspectCodexDelegation: () => status(),
        mutateCodexDelegation: mutation => {
          mutations.push(mutation);
          return outcome;
        },
      }, principal);
      if (!response) throw new Error("delegation route was not registered");
      return response;
    },
  };
}

test("GET is read-only and no-store", async () => {
  const { dispatch, mutations } = makeDispatch();
  const response = await dispatch("GET", undefined, "admin-token");
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(mutations).toEqual([]);
});

test.each(["admin-token", undefined] as const)("PUT rejects %s principal", async principal => {
  const { dispatch, mutations } = makeDispatch();
  const response = await dispatch("PUT", { mode: "balanced" }, principal);
  expect(response.status).toBe(403);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(mutations).toEqual([]);
});

test("PUT rejects an unconfirmed principal before parsing its body", async () => {
  const { mutations } = makeDispatch();
  const req = new Request("http://127.0.0.1:10100/api/codex-delegation", {
    method: "PUT",
    headers: { Host: "127.0.0.1:10100", "content-type": "application/json" },
    body: "not JSON",
  });
  const response = await handleManagementAPI(req, new URL(req.url), config, {
    inspectCodexDelegation: () => status(),
    mutateCodexDelegation: mutation => {
      mutations.push(mutation);
      return successStatus();
    },
  }, "admin-token");
  expect(response?.status).toBe(403);
  expect(mutations).toEqual([]);
});

test("confirmed GUI may install an exact mode", async () => {
  const { dispatch, mutations } = makeDispatch();
  const response = await dispatch("PUT", { mode: "orchestrator" }, "confirmed-gui-session");
  expect(response.status).toBe(200);
  expect(mutations).toEqual([{ action: "install", mode: "orchestrator" }]);
});

test("confirmed GUI may uninstall without a body", async () => {
  const { dispatch, mutations } = makeDispatch();
  const response = await dispatch("DELETE", undefined, "confirmed-gui-session");
  expect(response.status).toBe(200);
  expect(mutations).toEqual([{ action: "uninstall" }]);
});

test("PUT rejects a non-exact body before mutation", async () => {
  for (const body of [null, [], {}, { mode: "unknown" }, { mode: "balanced", extra: true }]) {
    const { dispatch, mutations } = makeDispatch();
    expect((await dispatch("PUT", body, "confirmed-gui-session")).status).toBe(400);
    expect(mutations).toEqual([]);
  }
});

test("DELETE rejects a non-empty body", async () => {
  const { dispatch, mutations } = makeDispatch();
  expect((await dispatch("DELETE", {}, "confirmed-gui-session")).status).toBe(400);
  expect(mutations).toEqual([]);
});

test.each([
  ["an explicit zero-byte stream", streamedDelete([])],
  ["Content-Length: 0", new Request("http://127.0.0.1:10100/api/codex-delegation", {
    method: "DELETE",
    headers: { Host: "127.0.0.1:10100", "content-length": "0" },
  })],
  ["a chunked empty stream", streamedDelete([], { "transfer-encoding": "chunked" })],
] as const)("DELETE accepts %s", async (_name, req) => {
  const mutations: CodexDelegationMutation[] = [];
  const response = await dispatchRequest(req, mutations);
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(mutations).toEqual([{ action: "uninstall" }]);
});

test.each([
  ["JSON", streamedDelete(["{}"], { "content-type": "application/json" })],
  ["non-JSON", streamedDelete(["not JSON"], { "content-type": "text/plain" })],
] as const)("DELETE rejects non-empty %s payloads", async (_name, req) => {
  const mutations: CodexDelegationMutation[] = [];
  const response = await dispatchRequest(req, mutations);
  expect(response.status).toBe(400);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(mutations).toEqual([]);
});

test("DELETE returns no-store 413 when its streamed body exceeds the management bound", async () => {
  const mutations: CodexDelegationMutation[] = [];
  const response = await dispatchRequest(bytesDelete([new Uint8Array(4 * 1024 * 1024 + 1)]), mutations);
  expect(response.status).toBe(413);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(mutations).toEqual([]);
});

test.each([
  ["foreign_skill", 409, null],
  ["unsafe_path", 409, null],
  ["changed_during_mutation", 409, null],
  ["mutation_busy", 503, "1"],
  ["partial_write", 500, null],
] as const)("projects mutation refusal %s", async (reason, expectedStatus, retryAfter) => {
  const { dispatch } = makeDispatch(failure(reason, reason === "partial_write"));
  const response = await dispatch("PUT", { mode: "balanced" }, "confirmed-gui-session");
  expect(response.status).toBe(expectedStatus);
  expect(response.headers.get("Retry-After")).toBe(retryAfter);
  const body = await response.json() as { changed?: boolean };
  if (reason === "partial_write") expect(body.changed).toBe(true);
});

test("responses keep fixed paths and never include inspected AGENTS content", async () => {
  const rawAgents = "untrusted AGENTS content that must never be returned";
  const rawHome = "/Users/example/private-home";
  const req = request("GET");
  const response = await handleManagementAPI(req, new URL(req.url), config, {
    inspectCodexDelegation: () => status({
      artifacts: {
        skill: { state: "unsafe", displayPath: "$HOME/.agents/skills/codexcommander-delegation/SKILL.md", reason: rawHome },
        agentsPolicy: { state: "unsafe", displayPath: "$CODEX_HOME/AGENTS.md", reason: rawAgents },
      },
    }),
    mutateCodexDelegation: () => successStatus(),
  }, "admin-token");
  expect(response?.status).toBe(200);
  const text = await response?.text();
  expect(text).not.toContain(rawHome);
  expect(text).not.toContain(rawAgents);
  expect(text).toContain("$HOME/.agents/skills/codexcommander-delegation/SKILL.md");
  expect(text).toContain("$CODEX_HOME/AGENTS.md");
});

test("GET and mutation outcomes replace injected previews and prompts with canonical templates", async () => {
  const secret = "injected-secret-preview";
  const rawAgents = "injected-raw-agents";
  const rawPrompt = "injected-prompt";
  const injected = status({
    previews: {
      balanced: { skillText: secret, agentsBlockText: rawAgents },
      orchestrator: { skillText: secret, agentsBlockText: rawAgents },
    },
    copyPrompts: { balanced: rawPrompt, orchestrator: rawPrompt },
  });
  const get = request("GET");
  const getResponse = await handleManagementAPI(get, new URL(get.url), config, {
    inspectCodexDelegation: () => injected,
    mutateCodexDelegation: () => ({ ok: true, changed: true, status: injected }),
  }, "admin-token");
  const put = request("PUT", { mode: "balanced" });
  const putResponse = await handleManagementAPI(put, new URL(put.url), config, {
    inspectCodexDelegation: () => injected,
    mutateCodexDelegation: () => ({ ok: true, changed: true, status: injected }),
  }, "confirmed-gui-session");
  const canonical = renderCodexDelegationBundle("balanced");
  const canonicalOrchestrator = renderCodexDelegationBundle("orchestrator");
  for (const response of [getResponse, putResponse]) {
    expect(response?.status).toBe(200);
    const body = await response?.json() as CodexDelegationStatus | { status: CodexDelegationStatus };
    const projected = "status" in body ? body.status : body;
    const text = JSON.stringify(body);
    expect(text).not.toContain(secret);
    expect(text).not.toContain(rawAgents);
    expect(text).not.toContain(rawPrompt);
    expect(projected.previews.balanced.skillText).toBe(canonical.skillText);
    expect(projected.previews.balanced.agentsBlockText).toBe(canonical.agentsBlockText);
    expect(projected.copyPrompts.balanced).toBe(canonical.copyPrompt);
    expect(projected.previews.orchestrator.agentsBlockText).toBe(canonicalOrchestrator.agentsBlockText);
    expect(projected.copyPrompts.orchestrator).toBe(canonicalOrchestrator.copyPrompt);
  }
});
