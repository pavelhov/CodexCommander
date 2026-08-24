import type {
  CodexDelegationMutationOutcome,
  CodexDelegationStatus,
  DelegationArtifactStatus,
} from "../../codex/delegation-installer";
import { jsonResponse } from "../auth-cors";
import { managementBodyTooLargeResponse, readManagementJsonBody } from "./body";
import type { ManagementContext } from "./context";
import { isPlainRecord } from "./shared";

const SKILL_DISPLAY_PATH = "$HOME/.agents/skills/codexcommander-delegation/SKILL.md" as const;
const AGENTS_DISPLAY_PATH = "$CODEX_HOME/AGENTS.md" as const;

function noStore(response: Response): Response {
  response.headers.set("Cache-Control", "no-store");
  return response;
}

function response(ctx: ManagementContext, data: unknown, status = 200): Response {
  return noStore(jsonResponse(data, status, ctx.req, ctx.config));
}

/**
 * The installer is permitted to inspect user-owned files. Its API projection
 * is not: paths remain symbolic and refusal detail is a fixed reason code.
 */
function projectArtifact(
  artifact: DelegationArtifactStatus,
  displayPath: DelegationArtifactStatus["displayPath"],
): DelegationArtifactStatus {
  const reason = artifact.state === "foreign" ? "ownership_conflict"
    : artifact.state === "unsafe" ? "unsafe_path"
    : undefined;
  return { state: artifact.state, displayPath, ...(reason ? { reason } : {}) };
}

function projectStatus(status: CodexDelegationStatus): CodexDelegationStatus {
  return {
    schemaVersion: 1,
    state: status.state,
    installedMode: status.installedMode,
    artifacts: {
      skill: projectArtifact(status.artifacts.skill, SKILL_DISPLAY_PATH),
      agentsPolicy: projectArtifact(status.artifacts.agentsPolicy, AGENTS_DISPLAY_PATH),
    },
    override: { state: status.override.state },
    activation: status.activation,
    // These values are rendered from the bundled templates by Task 2; they do
    // not reflect any AGENTS file content that was inspected on disk.
    previews: status.previews,
    copyPrompts: status.copyPrompts,
  };
}

async function inspector(ctx: ManagementContext): Promise<typeof import("../../codex/delegation-installer").inspectCodexDelegation> {
  if (ctx.deps.inspectCodexDelegation) return ctx.deps.inspectCodexDelegation;
  return (await import("../../codex/delegation-installer")).inspectCodexDelegation;
}

async function mutator(ctx: ManagementContext): Promise<typeof import("../../codex/delegation-installer").mutateCodexDelegation> {
  if (ctx.deps.mutateCodexDelegation) return ctx.deps.mutateCodexDelegation;
  return (await import("../../codex/delegation-installer")).mutateCodexDelegation;
}

function outcomeResponse(ctx: ManagementContext, outcome: CodexDelegationMutationOutcome): Response {
  const status = projectStatus(outcome.status);
  if (outcome.ok) return response(ctx, { ok: true, changed: outcome.changed, status });

  if (outcome.reason === "mutation_busy") {
    const busy = response(ctx, {
      ok: false,
      changed: false,
      reason: "mutation_busy",
      status,
    }, 503);
    busy.headers.set("Retry-After", "1");
    return busy;
  }
  const statusCode = outcome.reason === "partial_write" || outcome.reason === "write_failed" ? 500 : 409;
  return response(ctx, {
    ok: false,
    changed: outcome.changed,
    reason: outcome.reason,
    status,
  }, statusCode);
}

async function hasDeleteBody(ctx: ManagementContext): Promise<boolean | Response> {
  if (ctx.req.body === null) return false;
  try {
    await readManagementJsonBody(ctx.req);
  } catch (error) {
    const tooLarge = managementBodyTooLargeResponse(error, ctx.req, ctx.config);
    if (tooLarge) return noStore(tooLarge);
  }
  return true;
}

export async function handleDelegationRoutes(ctx: ManagementContext): Promise<Response | null> {
  if (ctx.url.pathname !== "/api/codex-delegation") return null;

  if (ctx.req.method === "GET") {
    try {
      return response(ctx, projectStatus((await inspector(ctx))()));
    } catch {
      return response(ctx, { error: "Codex delegation inspection failed.", reason: "unsafe_path" }, 500);
    }
  }

  if (ctx.req.method !== "PUT" && ctx.req.method !== "DELETE") return null;
  // This check intentionally precedes body consumption: raw-admin callers and
  // direct-dispatch fixtures are not allowed to probe or mutate user policy.
  if (ctx.principal !== "confirmed-gui-session") {
    return response(ctx, { error: "Codex delegation changes require a confirmed dashboard launch." }, 403);
  }

  let mutation: Parameters<Awaited<ReturnType<typeof mutator>>>[0];
  if (ctx.req.method === "PUT") {
    let raw: unknown;
    try {
      raw = await readManagementJsonBody(ctx.req);
    } catch (error) {
      const tooLarge = managementBodyTooLargeResponse(error, ctx.req, ctx.config);
      if (tooLarge) return noStore(tooLarge);
      return response(ctx, { error: "invalid JSON body" }, 400);
    }
    if (!isPlainRecord(raw) || Object.keys(raw).length !== 1 || Object.keys(raw)[0] !== "mode") {
      return response(ctx, { error: "body must contain only mode" }, 400);
    }
    if (raw.mode !== "balanced" && raw.mode !== "orchestrator") {
      return response(ctx, { error: "mode must be balanced or orchestrator" }, 400);
    }
    mutation = { action: "install", mode: raw.mode };
  } else {
    try {
      const body = await hasDeleteBody(ctx);
      if (body instanceof Response) return body;
      if (body) return response(ctx, { error: "DELETE does not accept a request body" }, 400);
    } catch {
      return response(ctx, { error: "DELETE does not accept a request body" }, 400);
    }
    mutation = { action: "uninstall" };
  }

  try {
    return outcomeResponse(ctx, (await mutator(ctx))(mutation));
  } catch {
    return response(ctx, { error: "Codex delegation mutation failed.", changed: false, reason: "write_failed" }, 500);
  }
}
