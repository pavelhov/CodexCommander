import {
  attestLiveManagementProxy,
  sameAttestedRuntimeTarget,
  type AttestedLiveManagementProxy,
} from "../server/proxy-liveness";
import { interactiveConfirm } from "./interactive-confirm";
import { CliUsageError, RuntimeApiError } from "./runtime-api";

export const MEDIA_USAGE = `Usage:
  ccx media [status] [--json]
  ccx media probe
  ccx media acknowledge <opaque-operation-id> --revision <nonnegative-integer>`;

export type MediaCommandStepState =
  | "pending"
  | "submitting"
  | "accepted"
  | "completed"
  | "failed"
  | "outcome_unknown"
  | "acknowledged";

export interface MediaCommandStatus {
  revision: number;
  source: "subscription_oauth" | "api_key" | null;
  bindingReady: boolean;
  imageModel: string;
  videoModel: string;
  videoDurationSeconds: 1;
  videoResolution: "1080p";
  apiKeyFallbackDisabled: boolean;
  billingAttribution: "unknown";
  ambiguousSubmissionRisk: boolean;
  releaseStatus: "feasibility_only";
  steps: { image: MediaCommandStepState; video: MediaCommandStepState };
}

export interface MediaCommandService {
  status(): Promise<MediaCommandStatus>;
  probe(input: {
    action: "probe";
    expectedRevision: number;
    confirmation: true;
  }): Promise<MediaCommandStatus>;
  acknowledge(input: {
    action: "acknowledge";
    operationId: string;
    expectedRevision: number;
    confirmation: true;
  }): Promise<MediaCommandStatus>;
}

export type ParsedMediaCommand =
  | { command: "status"; json: boolean }
  | { command: "probe" }
  | { command: "acknowledge"; operationId: string; revision: number };

export interface MediaCommandDeps {
  attest?: (expectedPid?: number) => Promise<AttestedLiveManagementProxy | null>;
  sameTarget?: (expected: AttestedLiveManagementProxy, current: AttestedLiveManagementProxy) => boolean;
  createService?: (target: AttestedLiveManagementProxy) => MediaCommandService;
  confirm?: (question: string) => Promise<boolean>;
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
  out?: (line: string) => void;
  error?: (line: string) => void;
}

const STEP_STATES: readonly MediaCommandStepState[] = [
  "pending", "submitting", "accepted", "completed", "failed", "outcome_unknown", "acknowledged",
];
const FIXED_IMAGE_MODEL = "grok-imagine-image-2.0";
const FIXED_VIDEO_MODEL = "grok-imagine-video-1.5";
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function usage(message: string): never {
  throw new CliUsageError(message, MEDIA_USAGE);
}

export function parseMediaArgs(argv: string[]): ParsedMediaCommand {
  const args = [...argv];
  const command = args.shift() ?? "status";
  if (args.includes("--yes")) usage("--yes is not supported for human-only media actions");
  if (command === "status") {
    let json = false;
    if (args[0] === "--json") {
      json = true;
      args.shift();
    }
    if (args.length > 0) usage("Unexpected media status arguments");
    return { command: "status", json };
  }
  if (command === "probe") {
    if (args.length > 0) usage("The capability probe uses fixed server-owned operations and accepts no overrides");
    return { command: "probe" };
  }
  if (command === "ack" || command === "acknowledge") {
    const operationId = args.shift();
    if (!operationId || !OPAQUE_ID.test(operationId)) usage("acknowledge requires one opaque operation id");
    if (args.shift() !== "--revision") usage("acknowledge requires --revision");
    const rawRevision = args.shift();
    if (!rawRevision || !/^\d+$/.test(rawRevision)) usage("--revision must be a nonnegative integer");
    const revision = Number(rawRevision);
    if (!Number.isSafeInteger(revision)) usage("--revision is outside the supported range");
    if (args.length > 0) usage("Unexpected media acknowledge arguments");
    return { command: "acknowledge", operationId, revision };
  }
  usage("Unknown media command");
}

function safeText(value: unknown, max = 128): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > max
    || value.trim() !== value
    || /[\x00-\x1f\x7f]/.test(value)
  ) throw new RuntimeApiError("The media runtime returned an invalid safe status.", 502, null);
  return value;
}

/** Explicit allowlist: arbitrary server fields are never reflected to the terminal. */
function safeStatus(value: MediaCommandStatus): MediaCommandStatus {
  const record = value as unknown as Record<string, unknown>;
  const steps = record.steps as Record<string, unknown> | undefined;
  const imageStep = steps?.image;
  const videoStep = steps?.video;
  if (
    !Number.isSafeInteger(record.revision) || (record.revision as number) < 0
    || (record.source !== null && record.source !== "subscription_oauth" && record.source !== "api_key")
    || typeof record.bindingReady !== "boolean"
    || record.imageModel !== FIXED_IMAGE_MODEL
    || record.videoModel !== FIXED_VIDEO_MODEL
    || record.videoDurationSeconds !== 1
    || record.videoResolution !== "1080p"
    || typeof record.apiKeyFallbackDisabled !== "boolean"
    || record.billingAttribution !== "unknown"
    || typeof record.ambiguousSubmissionRisk !== "boolean"
    || record.releaseStatus !== "feasibility_only"
    || typeof imageStep !== "string" || !STEP_STATES.includes(imageStep as MediaCommandStepState)
    || typeof videoStep !== "string" || !STEP_STATES.includes(videoStep as MediaCommandStepState)
  ) throw new RuntimeApiError("The media runtime returned an invalid safe status.", 502, null);
  return {
    revision: record.revision as number,
    source: record.source as MediaCommandStatus["source"],
    bindingReady: record.bindingReady as boolean,
    imageModel: safeText(record.imageModel),
    videoModel: safeText(record.videoModel),
    videoDurationSeconds: 1,
    videoResolution: "1080p",
    apiKeyFallbackDisabled: record.apiKeyFallbackDisabled as boolean,
    billingAttribution: "unknown",
    ambiguousSubmissionRisk: record.ambiguousSubmissionRisk as boolean,
    releaseStatus: "feasibility_only",
    steps: { image: imageStep as MediaCommandStepState, video: videoStep as MediaCommandStepState },
  };
}

function unavailableService(): MediaCommandService {
  const unavailable = async (): Promise<never> => {
    throw new RuntimeApiError(
      "The attested media runtime resource is unavailable in this build; no paid action was attempted.",
      503,
      null,
    );
  };
  return { status: unavailable, probe: unavailable, acknowledge: unavailable };
}

function printStatus(value: MediaCommandStatus, out: (line: string) => void, json: boolean): void {
  const projected = safeStatus(value);
  if (json) {
    out(JSON.stringify(projected, null, 2));
    return;
  }
  out(`Media source: ${projected.source ?? "not configured"}`);
  out(`Binding readiness: ${projected.bindingReady ? "ready" : "blocked"}`);
  out(`Fixed image operation: ${projected.imageModel}`);
  out(`Fixed video operation: ${projected.videoModel}, 1 second, 1080p`);
  out(`API-key fallback: ${projected.apiKeyFallbackDisabled ? "disabled" : "not proven disabled"}`);
  out("Capability only; billing attribution: unknown");
  out(`Ambiguous-submit risk: ${projected.ambiguousSubmissionRisk ? "may consume quota without a result" : "not acknowledged"}`);
  out("Release status: feasibility only; this is not packaged verification");
  out(`Image step: ${projected.steps.image}`);
  out(`Video step: ${projected.steps.video}`);
}

function errorExit(error: unknown, write: (line: string) => void): number {
  if (error instanceof CliUsageError) {
    write(`Error: ${error.message}`);
    if (error.usage) write(error.usage);
    return 2;
  }
  if (error instanceof RuntimeApiError) {
    write("Error: Media command refused safely; no paid action was attempted.");
    return error.status === 404 ? 4 : error.status === 409 ? 5 : 1;
  }
  write("Error: Media command failed safely; no paid action was attempted.");
  return 1;
}

export async function handleMediaCommand(argv: string[], deps: MediaCommandDeps = {}): Promise<number> {
  const out = deps.out ?? (line => console.log(line));
  const writeError = deps.error ?? (line => console.error(line));
  let parsed: ParsedMediaCommand;
  try {
    parsed = parseMediaArgs(argv);
  } catch (error) {
    return errorExit(error, writeError);
  }
  const attest = deps.attest ?? (expectedPid => attestLiveManagementProxy(
    expectedPid === undefined ? {} : { expectedPid },
  ));
  const sameTarget = deps.sameTarget ?? sameAttestedRuntimeTarget;
  const createService = deps.createService ?? (() => unavailableService());
  const confirm = deps.confirm ?? (question => interactiveConfirm({ question, defaultYes: false }));
  const stdinIsTTY = deps.stdinIsTTY ?? process.stdin.isTTY === true;
  const stdoutIsTTY = deps.stdoutIsTTY ?? process.stdout.isTTY === true;

  try {
    const initial = await attest();
    if (!initial) {
      throw new RuntimeApiError(
        "Media command refused: the live runtime could not be authenticated.",
        503,
        null,
      );
    }
    const service = createService(initial);
    const preview = safeStatus(await service.status());
    printStatus(preview, out, parsed.command === "status" && parsed.json);
    if (parsed.command === "status") return 0;
    if (preview.source !== "subscription_oauth" || !preview.bindingReady || !preview.apiKeyFallbackDisabled) {
      throw new RuntimeApiError("Media OAuth binding is not ready.", 403, null);
    }
    if (!stdinIsTTY || !stdoutIsTTY) {
      throw new RuntimeApiError("Media paid/recovery actions require an interactive terminal.", 403, null);
    }
    const question = parsed.command === "probe"
      ? "Run exactly one fixed image and one one-second 1080p video capability probe?"
      : `Acknowledge outcome-unknown media operation ${parsed.operationId}?`;
    if (!await confirm(question)) {
      writeError("Media action declined; no mutation or paid request was attempted.");
      return 1;
    }
    // Consent is bound to the runtime that rendered the preview. Re-prove it after the prompt.
    const fresh = await attest(initial.pid);
    if (!fresh || !sameTarget(initial, fresh)) {
      throw new RuntimeApiError("Media action refused because the attested runtime changed during confirmation.", 409, null);
    }
    const freshService = createService(fresh);
    const result = parsed.command === "probe"
      ? await freshService.probe({ action: "probe", expectedRevision: preview.revision, confirmation: true })
      : await freshService.acknowledge({
          action: "acknowledge",
          operationId: parsed.operationId,
          expectedRevision: parsed.revision,
          confirmation: true,
        });
    printStatus(safeStatus(result), out, false);
    return 0;
  } catch (error) {
    return errorExit(error, writeError);
  }
}
