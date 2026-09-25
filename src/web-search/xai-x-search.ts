import type { DispatchAttempt } from "../usage/dispatch";
import { dispatchHttpFetch, cleanupResponseDispatch, observeDispatch, responseDispatch } from "../usage/dispatch-http";
import { sidecarDispatch } from "../usage/dispatch-sidecar";
import type { CodexCommanderConfig, CodexCommanderParsedRequest, CodexCommanderProviderConfig, CodexCommanderTool } from "../types";
import { getProviderRegistryEntry } from "../providers/registry";
import { signalWithTimeout } from "../lib/abort";
import { sidecarEnter } from "../lib/sidecar-tracker";
import { fetchWithResetRetry } from "../lib/upstream-retry";
import { readBoundedResponseBody } from "../lib/bounded-body";
import type { WebSearchSource } from "./parse";
import type { SidecarOutcome } from "./executor";

/** The function name the routed Grok model sees + the name the web-search loop intercepts. */
export const X_SEARCH_TOOL_NAME = "x_search";

/** Upper bound xAI documents for allowed_x_handles / excluded_x_handles. */
const MAX_HANDLES = 20;
/** X handle charset (1-15 word characters). Anything else is dropped before it reaches xAI. */
const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;
/** ISO-8601 calendar date. */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Cap on the buffered X-search response body (answers are short; this bounds abuse). */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_QUERY_CHARS = 1000;
/** Default per-search deadline when no web-search sidecar timeout is configured. */
export const DEFAULT_X_SEARCH_TIMEOUT_MS = 90_000;

const X_SEARCH_INSTRUCTION =
  "You are an X (Twitter) research assistant. Use the x_search tool to find posts relevant to the " +
  "user's query, then reply with a concise, factual summary. Attribute each claim to its author " +
  "handle and post date, distinguish first-hand reports from commentary, and never invent posts. " +
  "End with a `Sources:` section listing each post URL you used on its own line.";

/** Validated x_search arguments requested by the routed model. */
export interface XSearchArgs {
  query: string;
  allowedHandles?: string[];
  excludedHandles?: string[];
  fromDate?: string;
  toDate?: string;
}

/** Everything the loop needs to run an X search on the routed xAI transport. */
export interface XaiXSearchSidecar {
  /** The resolved xAI transport (OAuth CLI proxy or api.x.ai) with its bearer already in `apiKey`. */
  provider: CodexCommanderProviderConfig & { fetch?: typeof globalThis.fetch };
  /** Model that runs the hosted x_search (the routed Grok model). */
  model: string;
  timeoutMs: number;
}

function isRec(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Whether the xAI registry marks this model as able to run the hosted x_search tool. */
export function isXSearchModel(providerName: string, modelId: string): boolean {
  if (providerName !== "xai") return false;
  return getProviderRegistryEntry("xai")?.xSearchModels?.includes(modelId) === true;
}

/**
 * Decide whether this routed turn gets the synthetic x_search tool. Eligible only for the xAI
 * provider on a registry-listed model with a usable bearer, when not disabled by
 * `webSearchSidecar.xSearch: false`, and when the client does not already define its own top-level
 * `x_search` function. Everything else returns undefined and keeps its existing path.
 */
export function planXaiXSearch(
  config: CodexCommanderConfig,
  parsed: CodexCommanderParsedRequest,
  providerName: string,
  provider: CodexCommanderProviderConfig & { fetch?: typeof globalThis.fetch },
  modelId: string,
): XaiXSearchSidecar | undefined {
  const cfg = config.webSearchSidecar ?? {};
  if (cfg.xSearch === false) return undefined;
  if (!isXSearchModel(providerName, modelId)) return undefined;
  if (typeof provider.apiKey !== "string" || provider.apiKey.length === 0) return undefined;
  if ((parsed.context.tools ?? []).some(t => !t.namespace && t.name === X_SEARCH_TOOL_NAME)) return undefined;
  return { provider, model: modelId, timeoutMs: Math.max(cfg.timeoutMs ?? 0, DEFAULT_X_SEARCH_TIMEOUT_MS) };
}

/** The synthetic function tool the Grok model calls when a task needs live X research. */
export function buildXSearchTool(): CodexCommanderTool {
  return {
    name: X_SEARCH_TOOL_NAME,
    description:
      "Search live posts on X (Twitter) through xAI. Use it only when the task needs X research: what " +
      "people are posting, a specific account's posts, reactions, or very recent announcements on X. " +
      "Returns a summary with direct post links. xAI bills each call per post and profile fetched.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look for on X: keywords or a focused question." },
        allowed_x_handles: {
          type: "array", items: { type: "string" }, maxItems: MAX_HANDLES,
          description: "Optional: only search posts from these handles (without @). Do not combine with excluded_x_handles.",
        },
        excluded_x_handles: {
          type: "array", items: { type: "string" }, maxItems: MAX_HANDLES,
          description: "Optional: skip posts from these handles (without @).",
        },
        from_date: { type: "string", description: "Optional start date, YYYY-MM-DD." },
        to_date: { type: "string", description: "Optional end date, YYYY-MM-DD." },
      },
      required: ["query"],
    },
    webSearch: true,
    xSearch: true,
  };
}

function normalizeHandles(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") continue;
    const h = raw.trim().replace(/^@/, "");
    if (HANDLE_RE.test(h) && !out.includes(h)) out.push(h);
    if (out.length >= MAX_HANDLES) break;
  }
  return out.length > 0 ? out : undefined;
}

/** Parse and validate the model's raw x_search JSON arguments. Malformed input yields an empty query. */
export function parseXSearchArgs(argsBuf: string): XSearchArgs {
  let o: unknown;
  try { o = JSON.parse(argsBuf || "{}"); } catch { return { query: "" }; }
  if (!isRec(o)) return { query: "" };
  const query = typeof o.query === "string" ? o.query.trim().slice(0, MAX_QUERY_CHARS) : "";
  const args: XSearchArgs = { query };
  const allowed = normalizeHandles(o.allowed_x_handles);
  const excluded = normalizeHandles(o.excluded_x_handles);
  // xAI rejects both lists together; the allow-list is the stronger intent.
  if (allowed) args.allowedHandles = allowed;
  else if (excluded) args.excludedHandles = excluded;
  if (typeof o.from_date === "string" && DATE_RE.test(o.from_date)) args.fromDate = o.from_date;
  if (typeof o.to_date === "string" && DATE_RE.test(o.to_date)) args.toDate = o.to_date;
  return args;
}

/** Canonical replay arguments for the assistant tool call (only validated fields survive). */
export function xSearchCallArguments(args: XSearchArgs): Record<string, unknown> {
  return {
    query: args.query,
    ...(args.allowedHandles ? { allowed_x_handles: args.allowedHandles } : {}),
    ...(args.excludedHandles ? { excluded_x_handles: args.excludedHandles } : {}),
    ...(args.fromDate ? { from_date: args.fromDate } : {}),
    ...(args.toDate ? { to_date: args.toDate } : {}),
  };
}

/** The hosted tool object sent to xAI /v1/responses for these arguments. */
export function xSearchHostedTool(args: XSearchArgs): Record<string, unknown> {
  const { query: _query, ...rest } = xSearchCallArguments(args);
  return { type: "x_search", ...rest };
}

/**
 * Fold a non-streaming xAI Responses body into answer text + deduplicated url_citation sources.
 * xAI's own search steps arrive as `custom_tool_call` items (x_keyword_search / x_user_search);
 * they are server-executed and intentionally ignored so Codex never sees them as client tool calls.
 */
export function parseXSearchResponse(body: unknown): SidecarOutcome {
  const sources: WebSearchSource[] = [];
  const seen = new Set<string>();
  const textParts: string[] = [];
  const addSource = (url: string, title?: string): void => {
    if (!/^https?:\/\//i.test(url) || seen.has(url)) return;
    seen.add(url);
    sources.push(title ? { url, title } : { url });
  };
  const output = isRec(body) && Array.isArray(body.output) ? body.output : [];
  for (const item of output) {
    if (!isRec(item) || item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (!isRec(part) || part.type !== "output_text" || typeof part.text !== "string") continue;
      textParts.push(part.text);
      if (!Array.isArray(part.annotations)) continue;
      for (const ann of part.annotations) {
        if (!isRec(ann) || ann.type !== "url_citation" || typeof ann.url !== "string") continue;
        // xAI titles citations with their ordinal ("1"); that carries no information.
        const title = typeof ann.title === "string" && ann.title.length > 0 && !/^\d+$/.test(ann.title) ? ann.title : undefined;
        addSource(ann.url, title);
      }
    }
  }
  // xAI also returns sources at response.citations. Keep X links even when inline annotations
  // contain unrelated URLs; addSource deduplicates links present in both places.
  if (isRec(body) && Array.isArray(body.citations)) {
    for (const citation of body.citations) {
      if (typeof citation !== "string") continue;
      try {
        const url = new URL(citation);
        if (["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(url.hostname.toLowerCase())) {
          addSource(citation);
        }
      } catch { /* Ignore malformed source URLs. */ }
    }
  }
  const trimmed = textParts.join("").trim();
  if (trimmed.length === 0) return { text: "", sources, error: "x_search produced no answer" };
  return { text: trimmed, sources };
}

function statusMessage(status: number): string {
  if (status === 401 || status === 403) return `xAI rejected the X search request (HTTP ${status}); check the xAI login or API key and X search access`;
  if (status === 429) return "xAI rate-limited the X search request (HTTP 429)";
  if (status >= 500) return `xAI X search is temporarily unavailable (HTTP ${status})`;
  return `xAI X search request failed (HTTP ${status})`;
}

/**
 * Execute ONE X search through xAI's `/v1/responses` with the hosted `x_search` tool, on the same
 * transport and credential as the routed Grok turn. Never throws; returns `{error}` so the loop
 * injects a graceful tool result. Upstream bodies, the query, and credentials are never logged or
 * echoed in errors; only the HTTP status and aggregate usage counts are logged.
 */
export async function runXaiXSearch(
  args: XSearchArgs,
  sidecar: XaiXSearchSidecar,
  abortSignal?: AbortSignal,
  dispatchParent?: DispatchAttempt,
): Promise<SidecarOutcome> {
  const { provider } = sidecar;
  const url = `${provider.baseUrl.replace(/\/+$/, "")}/responses`;
  const headers: Record<string, string> = {
    ...(provider.headers ?? {}),
    "Content-Type": "application/json",
    "Accept": "application/json",
    "Authorization": `Bearer ${provider.apiKey ?? ""}`,
  };
  const body = {
    model: sidecar.model,
    instructions: X_SEARCH_INSTRUCTION,
    input: [{ role: "user", content: args.query }],
    tools: [xSearchHostedTool(args)],
    reasoning: { effort: "low" },
    store: false,
    stream: false,
  };

  const linkedSignal = signalWithTimeout(sidecar.timeoutMs, abortSignal);
  const sidecarExit = sidecarEnter("x-search");
  const t0 = Date.now();
  const dispatch = sidecarDispatch(dispatchParent, "responses", abortSignal, "web_search");
  const executor = provider.fetch ?? globalThis.fetch;
  let observedResponse: Response | undefined;
  try {
    const res = await fetchWithResetRetry(
      () => dispatchHttpFetch(executor, url, { method: "POST", headers, body: JSON.stringify(body), signal: linkedSignal.signal }, dispatch),
      { abortSignal: linkedSignal.signal, label: "x-search-sidecar-xai" },
    );
    observedResponse = res;
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      console.warn(`[x-search] xAI HTTP ${res.status} (${Date.now() - t0}ms)`);
      return { text: "", sources: [], error: statusMessage(res.status) };
    }
    const bounded = await readBoundedResponseBody(res, {
      signal: linkedSignal.signal,
      maxBytes: MAX_RESPONSE_BYTES,
      totalTimeoutMs: sidecar.timeoutMs,
      inactivityTimeoutMs: sidecar.timeoutMs,
    });
    if (bounded.oversized) return { text: "", sources: [], error: "xAI X search response was too large" };
    if (bounded.timedOut) return { text: "", sources: [], error: "xAI X search timed out" };
    const raw = bounded.text;
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch {
      return { text: "", sources: [], error: "xAI X search returned an unreadable response" };
    }
    const usage = isRec(parsed) && isRec(parsed.usage) && isRec(parsed.usage.server_side_tool_usage_details)
      ? parsed.usage.server_side_tool_usage_details : undefined;
    if (usage) {
      const n = (k: string): number => (typeof usage[k] === "number" ? usage[k] as number : 0);
      console.warn(`[x-search] done: ${n("x_search_calls")} searches, ${n("x_posts_fetched")} posts, ${n("x_users_fetched")} profiles (${Date.now() - t0}ms)`);
    }
    return parseXSearchResponse(parsed);
  } catch (e) {
    if (abortSignal?.aborted) return { text: "", sources: [], error: "X search cancelled" };
    const reason: unknown = linkedSignal.signal.reason;
    const timedOut = (e instanceof Error && e.name === "TimeoutError")
      || (reason instanceof Error && reason.name === "TimeoutError");
    console.warn(`[x-search] xAI ${timedOut ? "timeout" : "connect_error"} (${Date.now() - t0}ms)`);
    return { text: "", sources: [], error: timedOut ? "xAI X search timed out" : "xAI X search could not connect" };
  } finally {
    if (observedResponse) {
      observeDispatch(() => responseDispatch(observedResponse!)?.terminal("unknown"));
      cleanupResponseDispatch(observedResponse);
    }
    sidecarExit();
    linkedSignal.cleanup();
  }
}
