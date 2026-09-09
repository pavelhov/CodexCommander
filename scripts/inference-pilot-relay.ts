import { PilotBudget, type PilotArm, type PilotIdentity, type PilotManifest, type PilotUsage } from "./inference-pilot-budget";
export const PILOT_UPSTREAM = "https://chatgpt.com/backend-api/codex/responses";
const MAX_REQUEST = 1024 * 1024;
const MAX_RESPONSE = 4 * 1024 * 1024;
export interface PilotTokenObservation {
    arm: PilotArm;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number | null;
    reasoningOutputTokens: number | null;
}
function optionalTokens(value: unknown, total: number): number | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > total) throw new Error("pilot_usage_rejected");
    return value;
}
// Client tool schemas may remain even with optional integrations disabled. Hosted
// tools are never admitted; any returned client tool call is rejected before delivery.
function clientTool(tool: any, depth = 0): boolean {
    if (!tool || depth > 2)
        return false;
    if (tool.type === "function" || tool.type === "custom")
        return true;
    return tool.type === "namespace" && Array.isArray(tool.tools) && tool.tools.every((item: any) => clientTool(item, depth + 1));
}
async function boundedBytes(stream: ReadableStream<Uint8Array> | null, signal: AbortSignal): Promise<Uint8Array> {
    if (!stream)
        throw new Error("pilot_empty_request");
    const reader = stream.getReader();
    const cancel = () => { void reader.cancel().catch(() => { }); };
    signal.addEventListener("abort", cancel, { once: true });
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        while (true) {
            signal.throwIfAborted();
            const chunk = await reader.read();
            if (chunk.done)
                break;
            size += chunk.value.byteLength;
            if (size > MAX_REQUEST)
                throw new Error("pilot_request_size");
            chunks.push(chunk.value);
        }
        signal.throwIfAborted();
        return Buffer.concat(chunks);
    }
    finally {
        signal.removeEventListener("abort", cancel);
        await reader.cancel().catch(() => { });
        reader.releaseLock();
    }
}
/** The bounded text-only pilot buffers each SSE response until its terminal event.
 * Both arms use this identical boundary; it is not streaming-latency qualification.
 * Payloads stay in memory and are never included in receipts or errors.
 */
async function terminalResponse(response: Response, signal: AbortSignal): Promise<{
    bytes: Uint8Array;
    usage: PilotUsage;
    cachedInputTokens: number | null;
    reasoningOutputTokens: number | null;
}> {
    if (!response.ok || !response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
        await response.body?.cancel();
        throw new Error("pilot_response_rejected");
    }
    const reader = response.body.getReader();
    const cancel = () => { void reader.cancel().catch(() => { }); };
    signal.addEventListener("abort", cancel, { once: true });
    const chunks: Uint8Array[] = [];
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    let pending = "", size = 0, consumedBytes = 0;
    try {
        while (true) {
            signal.throwIfAborted();
            const chunk = await reader.read();
            if (chunk.done)
                throw new Error("pilot_terminal_missing");
            size += chunk.value.byteLength;
            if (size > MAX_RESPONSE)
                throw new Error("pilot_response_size");
            chunks.push(chunk.value);
            pending += decoder.decode(chunk.value, { stream: true });
            let match: RegExpExecArray | null;
            while ((match = /\r?\n\r?\n/.exec(pending))) {
                const event = pending.slice(0, match.index);
                pending = pending.slice(match.index + match[0].length);
                consumedBytes += Buffer.byteLength(event + match[0]);
                if (event.includes("\uFEFF")) throw new Error("pilot_response_rejected");
                const data = event.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
                if (!data || data === "[DONE]")
                    continue;
                const value = JSON.parse(data);
                if ((typeof value.type === "string" && /(?:function_call|custom_tool_call)/.test(value.type))
                    || (value.item && !["message", "reasoning"].includes(value.item.type))) throw new Error("pilot_output_rejected");
                if (["response.failed", "response.incomplete", "error"].includes(value.type))
                    throw new Error("pilot_terminal_failed");
                if (value.type !== "response.completed")
                    continue;
                const r = value.response;
                if (r?.status !== "completed" || !Array.isArray(r.output)
                    || r.output.some((item: {
                        type?: string;
                    }) => !["message", "reasoning"].includes(item?.type ?? "")))
                    throw new Error("pilot_output_rejected");
                return { bytes: Buffer.concat(chunks).subarray(0, consumedBytes),
                    cachedInputTokens: optionalTokens(r.usage?.input_tokens_details?.cached_tokens, r.usage?.input_tokens),
                    reasoningOutputTokens: optionalTokens(r.usage?.output_tokens_details?.reasoning_tokens, r.usage?.output_tokens),
                    usage: { httpStatus: response.status, outcome: "completed",
                        inputTokens: r.usage?.input_tokens, outputTokens: r.usage?.output_tokens,
                        completeness: r.usage ? "complete" : "unknown" } };
            }
        }
    }
    finally {
        signal.removeEventListener("abort", cancel);
        await reader.cancel().catch(() => { });
        reader.releaseLock();
    }
}
export interface PilotRelayTarget {
    url: string;
    authorization: string;
    clientAuthorization: string;
    accountHeader?: string;
    /** Test-only loopback destinations never qualify as live evidence. */
    allowLoopback?: boolean;
    /** Re-observe frozen files/account generation before every physical send. */
    observeIdentity?: () => Promise<PilotIdentity>;
}
export function createPilotRelay(manifest: PilotManifest, observed: PilotIdentity, target: PilotRelayTarget) {
    const destination = new URL(target.url);
    const loopback = target.allowLoopback === true && destination.protocol === "http:" && destination.hostname === "127.0.0.1"
        && destination.pathname === "/responses" && !destination.search && !destination.hash && !destination.username && !destination.password;
    if (!loopback && target.url !== PILOT_UPSTREAM)
        throw new Error("pilot_destination_rejected");
    if (!/^Bearer [^\s]+$/.test(target.authorization) || !/^Bearer [^\s]+$/.test(target.clientAuthorization) || /[\r\n]/.test(target.accountHeader ?? ""))
        throw new Error("pilot_auth_rejected");
    const budget = new PilotBudget(manifest, observed);
    let generation: ReturnType<PilotBudget["beginGeneration"]> | undefined;
    let claimed = false;
    let refusal: string | undefined;
    const usage: PilotTokenObservation[] = [];
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
            if (request.headers.get("authorization") !== target.clientAuthorization) return new Response(null, { status: 401 });
            const abort = () => budget.close();
            request.signal.addEventListener("abort", abort, { once: true });
            try {
                if (request.signal.aborted || request.method !== "POST" || new URL(request.url).pathname !== "/responses"
                    || new URL(request.url).search || !generation || claimed)
                    throw new Error("pilot_request_rejected");
                claimed = true;
                const current = generation;
                const bytes = await boundedBytes(request.body, budget.signal);
                const body = JSON.parse(new TextDecoder().decode(bytes));
                if (body.model !== manifest.identity.model)
                    throw new Error("pilot_model_rejected");
                if (body.reasoning?.effort !== manifest.identity.effort)
                    throw new Error("pilot_effort_rejected");
                if ((body.service_tier ?? "default") !== manifest.identity.tier)
                    throw new Error("pilot_tier_rejected");
                if (body.tools !== undefined && (!Array.isArray(body.tools) || !body.tools.every((tool: any) => clientTool(tool))))
                    throw new Error("pilot_tools_rejected");
                if (body.stream !== true || body.previous_response_id || !Array.isArray(body.input)
                    || body.input.some((item: any) => ![undefined, "message"].includes(item.type)
                        || !["user", "developer", "system"].includes(item.role)
                        || !(typeof item.content === "string" || (Array.isArray(item.content)
                            && item.content.every((part: any) => part?.type === "input_text" && typeof part.text === "string")))))
                    throw new Error("pilot_body_rejected");
                const headers = new Headers();
                for (const key of ["content-type", "accept", "user-agent", "originator", "openai-beta", "version", "session_id", "conversation_id", "x-codex-turn-metadata", "x-codex-thread-id"]) {
                    const value = request.headers.get(key);
                    if (value !== null)
                        headers.set(key, value);
                }
                headers.set("authorization", target.authorization);
                if (target.accountHeader)
                    headers.set("chatgpt-account-id", target.accountHeader);
                let output: Uint8Array | undefined;
                let cachedInputTokens: number | null = null, reasoningOutputTokens: number | null = null;
                const result = await budget.dispatch(current, "initial", await target.observeIdentity?.() ?? observed, async (signal) => {
                    const response = await fetch(target.url, { method: "POST", headers, body: bytes, signal, redirect: "manual", proxy: null } as RequestInit);
                    const terminal = await terminalResponse(response, signal);
                    output = terminal.bytes;
                    cachedInputTokens = terminal.cachedInputTokens;
                    reasoningOutputTokens = terminal.reasoningOutputTokens;
                    return terminal.usage;
                });
                usage.push({ arm: current.arm, inputTokens: result.inputTokens, outputTokens: result.outputTokens, cachedInputTokens, reasoningOutputTokens });
                return new Response(output ? new Uint8Array(output).buffer : null, { headers: { "content-type": "text/event-stream" } });
            }
            catch (error) {
                refusal = ["pilot_request_rejected", "pilot_body_rejected", "pilot_model_rejected", "pilot_effort_rejected", "pilot_tier_rejected", "pilot_tools_rejected"].includes((error as Error).message) ? (error as Error).message : "pilot_forwarding_stopped";
                budget.close();
                return new Response(null, { status: 409 });
            }
            finally {
                request.signal.removeEventListener("abort", abort);
            }
        } });
    return {
        url: `http://127.0.0.1:${server.port}/responses`, signal: budget.signal,
        begin(arm: PilotArm) { generation = budget.beginGeneration(arm, observed); claimed = false; },
        end() { if (!generation)
            throw new Error("pilot_no_generation"); budget.endGeneration(generation); generation = undefined; },
        snapshot() { return { ...budget.snapshot(), refusal, usage: structuredClone(usage) }; },
        close() { budget.close(); server.stop(true); },
    };
}
