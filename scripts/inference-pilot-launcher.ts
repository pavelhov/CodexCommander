import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { boundedChildText, isolatedEnvironment, interruptCaptureChild, settleCaptureChild } from "../tests/helpers/inference-recorder";
import { canonicalRecorderFetch } from "../tests/helpers/inference-http-qualification";
import { fakeChatGptJwt } from "../tests/helpers/fake-chatgpt-jwt";
import { nativeSuccessSSE } from "../tests/fixtures/inference-accounting/fixtures";
import { createPilotRelay, PILOT_UPSTREAM, type PilotRelayTarget, type PilotTokenObservation } from "./inference-pilot-relay";
import type { PilotManifest } from "./inference-pilot-budget";
const BINARY = "/Applications/ChatGPT.app/Contents/Resources/codex";
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const disabled = ["shell_tool", "unified_exec", "shell_snapshot", "code_mode_host", "apps", "browser_use", "browser_use_external", "computer_use", "hooks", "image_generation", "in_app_browser", "in_app_chat", "in_app_local_automation", "plugins", "remote_plugin", "multi_agent", "multi_agent_v2", "skill_mcp_dependency_install", "skill_search", "sleep_tool", "view_image", "workspace_dependencies"];
const config = { model: "gpt-5.4", effort: "low", tier: "default", prompt: "Reply with exactly OK. Do not call tools.", disabled,
    provider: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward", codexAccountMode: "direct" },
    buffering: "terminal-bounded-sse", transport: "custom-provider-http", order: ["direct", "commander", "commander", "direct", "direct", "commander"] } as const;
interface RuntimeIdentity {
    clientSha256: string;
    runtimeSourceSha256: string;
    configSha256: string;
    catalogSha256: string;
}
export interface PilotResult {
    schemaVersion: 1;
    verdict: "PASS" | "STOPPED" | "UNAVAILABLE";
    evidence: "installed-client-loopback" | "live-http";
    identity?: RuntimeIdentity;
    dispatches: number;
    arms: {
        direct: number;
        commander: number;
    };
    clientExitCodes: number[];
    containmentVerified: boolean;
    liveAdmission: "UNAVAILABLE" | "EXECUTED";
    debitParity: "UNAVAILABLE";
    commanderCanonicalSends?: number;
    reason?: string;
    usage?: PilotTokenObservation[];
}
const unavailable = (reason: string): PilotResult => ({ schemaVersion: 1, verdict: "UNAVAILABLE", evidence: "installed-client-loopback",
    dispatches: 0, arms: { direct: 0, commander: 0 }, clientExitCodes: [], containmentVerified: false, liveAdmission: "UNAVAILABLE", debitParity: "UNAVAILABLE", reason });
async function sourceHash(root: string) {
    const digest = createHash("sha256");
    // Includes the launcher, its budget/relay, fixtures and child helpers, not only production runtime.
    for (const pattern of ["src/**/*.{ts,mjs}", "scripts/inference-pilot-*.ts", "tests/helpers/inference-*.ts", "tests/helpers/fake-chatgpt-jwt.ts", "tests/fixtures/inference-accounting/fixtures.ts"])
        for (const path of [...new Bun.Glob(pattern).scanSync({ cwd: root })].sort()) {
            digest.update(path);
            digest.update(await readFile(join(root, path)));
        }
    digest.update(await readFile(join(root, "bun.lock")));
    digest.update(await readFile(process.execPath));
    return digest.digest("hex");
}
async function runChild(args: string[], home: string, profile: string, timeout: number, limit = 65536, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const child = Bun.spawn(["/usr/bin/sandbox-exec", "-p", profile, ...args], { cwd: home, env: isolatedEnvironment(home), detached: true, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const stop = () => interruptCaptureChild(child, true);
    signal?.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(stop, timeout);
    try {
        const [output, , code] = await Promise.all([boundedChildText(child.stdout, limit, stop), boundedChildText(child.stderr, 65536, stop), child.exited]);
        return { output, code };
    }
    finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", stop);
        await settleCaptureChild(child, true);
    }
}
export interface LivePilotFiles {
    manifest: string;
    qualification: string;
    credentials: string;
    rateSource: string;
}
async function jsonFile(path: string, privateFile = false) {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > 1024 * 1024 || (privateFile && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())))
            throw new Error("pilot_evidence_file_rejected");
        const bytes = await handle.readFile();
        if (bytes.length > 1024 * 1024)
            throw new Error("pilot_evidence_file_rejected");
        return { bytes, value: JSON.parse(bytes.toString("utf8")) };
    }
    finally {
        await handle.close();
    }
}
async function credentials(path: string) {
    const { value } = await jsonFile(path, true);
    if (typeof value.accessToken !== "string" || typeof value.accountId !== "string" || !value.accountId || /[\s\r\n]/.test(value.accountId))
        throw new Error("pilot_credentials_rejected");
    const pieces = value.accessToken.split(".");
    if (pieces.length !== 3)
        throw new Error("pilot_credentials_rejected");
    const claims = JSON.parse(Buffer.from(pieces[1], "base64url").toString("utf8"));
    if (!Number.isFinite(claims.exp) || claims.exp * 1000 <= Date.now() + 600000
        || claims["https://api.openai.com/auth"]?.chatgpt_account_id !== value.accountId)
        throw new Error("pilot_credentials_expired_or_mismatched");
    // Local consistency only. JWT signature and backend acceptance are not attested.
    return { authorization: `Bearer ${value.accessToken}`, accountHeader: value.accountId,
        generation: hash(JSON.stringify([value.accessToken, value.accountId])) };
}
/** Explicit live entry only. Never discovers credentials or edits existing profiles.
 * Rate provenance is operator-supplied evidence, not an OpenAI billing attestation.
 */
export async function runLivePilot(root: string, files: LivePilotFiles): Promise<PilotResult> {
    if (process.platform !== "darwin" || !await Bun.file(BINARY).exists())
        return unavailable("pilot_containment_or_client_unavailable");
    const home = await mkdtemp(join(tmpdir(), "ccx-pilot-"));
    try {
        const current = await prepare(root, home);
        const manifest = (await jsonFile(files.manifest)).value as PilotManifest;
        const qualification = await jsonFile(files.qualification);
        const q = qualification.value as PilotResult;
        const rates = await jsonFile(files.rateSource);
        const auth = await credentials(files.credentials);
        if (q.schemaVersion !== 1 || q.verdict !== "PASS" || q.evidence !== "installed-client-loopback" || !q.containmentVerified
            || q.dispatches !== 6 || q.commanderCanonicalSends !== 3 || q.arms?.direct !== 3 || q.arms?.commander !== 3
            || q.clientExitCodes?.length !== 6 || q.clientExitCodes.some(code => code !== 0))
            throw new Error("pilot_qualification_rejected");
        for (const key of ["clientSha256", "runtimeSourceSha256", "configSha256", "catalogSha256"] as const)
            if (q.identity?.[key] !== current[key] || manifest.identity?.[key] !== current[key])
                throw new Error("pilot_identity_changed");
        if (manifest.identity.qualificationSha256 !== hash(qualification.bytes) || manifest.identity.accountGeneration !== auth.generation
            || manifest.identity.accountAlias !== "isolated" || manifest.identity.model !== config.model || manifest.identity.effort !== config.effort
            || manifest.identity.tier !== config.tier || manifest.rates.sourceSha256 !== hash(rates.bytes))
            throw new Error("pilot_evidence_mismatch");
        for (const key of ["unit", "inputPerMillion", "outputPerMillion", "model", "tier", "verifiedAt"] as const)
            if (manifest.rates[key] !== rates.value[key])
                throw new Error("pilot_rates_mismatch");
        const observeIdentity = async () => {
            const [refreshed, rateFile, binary, runtimeSourceSha256, catalog] = await Promise.all([
                credentials(files.credentials), jsonFile(files.rateSource), readFile(BINARY), sourceHash(root), readFile(join(home, "catalog.json")),
            ]);
            if (hash(rateFile.bytes) !== manifest.rates.sourceSha256)
                throw new Error("pilot_rates_changed");
            return { ...manifest.identity, clientSha256: hash(binary), runtimeSourceSha256,
                catalogSha256: hash(catalog), accountGeneration: refreshed.generation };
        };
        return await execute(root, home, manifest, { url: PILOT_UPSTREAM, ...auth, observeIdentity });
    }
    catch (error) {
        const allowed = ["pilot_credentials_rejected", "pilot_credentials_expired_or_mismatched", "pilot_qualification_rejected", "pilot_identity_changed", "pilot_evidence_mismatch", "pilot_rates_mismatch", "pilot_evidence_file_rejected"];
        return unavailable(allowed.includes((error as Error).message) ? (error as Error).message : "pilot_live_admission_refused");
    }
    finally {
        await rm(home, { recursive: true, force: true });
    }
}
async function prepare(root: string, home: string) {
    await Promise.all(["tmp", "codex", "commander", "config"].map(name => mkdir(join(home, name), { recursive: true })));
    await Bun.write(join(home, "bunfig.toml"), "");
    const catalog = await runChild([BINARY, "debug", "models", "--bundled"], home, "(version 1) (allow default) (deny network*)", 10000, 8 * 1024 * 1024);
    if (catalog.code !== 0)
        throw new Error("pilot_catalog_unavailable");
    const value = JSON.parse(catalog.output);
    if (!Array.isArray(value.models) || !value.models.some((m: {
        slug?: string;
    }) => m.slug === config.model))
        throw new Error("pilot_model_unavailable");
    await Bun.write(join(home, "catalog.json"), catalog.output);
    return { clientSha256: hash(await readFile(BINARY)), runtimeSourceSha256: await sourceHash(root), configSha256: hash(JSON.stringify(config)), catalogSha256: hash(catalog.output) };
}
function fixtureManifest(identity: RuntimeIdentity): PilotManifest {
    const sha = hash("synthetic-pilot-only");
    return { schemaVersion: 1, identity: { ...identity, qualificationSha256: sha, accountAlias: "fixture", accountGeneration: sha,
            model: config.model, effort: config.effort, tier: config.tier, transport: "http" },
        qualification: { verdict: "PASS", actualClientFullIngress: true, requiredScenariosComplete: true, dispatchComplete: true },
        bounds: { generationStarts: 6, dispatches: 6, wallTimeMs: 120000, inputTokensPerSend: 100000, outputTokensPerSend: 1000, estimatedCredits: 1 },
        rates: { unit: "subscription-credits", inputPerMillion: 1, outputPerMillion: 1, model: config.model, tier: config.tier, sourceSha256: sha, verifiedAt: Date.now() } };
}
async function execute(root: string, home: string, manifest: PilotManifest, target: Omit<PilotRelayTarget, "clientAuthorization">): Promise<PilotResult> {
    const clientToken = fakeChatGptJwt({ chatgpt_account_id: "fixture-pilot", nonce: randomUUID() });
    const relay = createPilotRelay(manifest, manifest.identity, { ...target, clientAuthorization: `Bearer ${clientToken}` });
    const { clientSha256, runtimeSourceSha256, configSha256, catalogSha256 } = manifest.identity;
    const identity = { clientSha256, runtimeSourceSha256, configSha256, catalogSha256 };
    const evidence = target.allowLoopback ? "installed-client-loopback" : "live-http";
    let blockedRequests = 0;
    const blocked = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { blockedRequests++; return new Response(null); } });
    const codes: number[] = [];
    let canonicalSends = 0;
    let contained = false;
    try {
        for (const arm of config.order) {
            // Reserve a loopback port for the child ingress. No real credentials enter the child.
            const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
            const port = reservation.port!;
            reservation.stop(true);
            const relayPort = new URL(relay.url).port;
            const profile = `(version 1) (allow default) (deny network*) (allow network-bind (local ip "localhost:*")) (allow network-inbound (local ip "localhost:${port}")) (allow network-outbound (remote tcp "localhost:${relayPort}") (remote tcp "localhost:${port}"))`;
            await rm(join(home, "codex"), { recursive: true, force: true });
            await mkdir(join(home, "codex"));
            relay.begin(arm);
            const spec = { root, arm, relay: relay.url, port, blockedPort: blocked.port, clientToken };
            await Bun.write(join(home, "child.json"), JSON.stringify(spec));
            const result = await runChild([process.execPath, "--no-env-file", `--config=${join(home, "bunfig.toml")}`, resolve(import.meta.path), "--child", join(home, "child.json")], home, profile, Math.min(manifest.bounds.wallTimeMs, 30000), 65536, relay.signal);
            const child = JSON.parse(result.output);
            codes.push(child.clientExitCode ?? result.code);
            if (result.code !== 0 || child.clientExitCode !== 0 || child.containmentVerified !== true || blockedRequests !== 0
                || child.canonicalSends !== (arm === "commander" ? 1 : 0))
                throw new Error("pilot_child_incomplete");
            canonicalSends += child.canonicalSends;
            contained = true;
            relay.end();
        }
        const snapshot = relay.snapshot();
        return { schemaVersion: 1, verdict: snapshot.dispatches === 6 ? "PASS" : "STOPPED", evidence, identity,
            dispatches: snapshot.dispatches, arms: snapshot.arms, usage: snapshot.usage, clientExitCodes: codes, containmentVerified: contained, commanderCanonicalSends: canonicalSends, liveAdmission: evidence === "live-http" ? "EXECUTED" : "UNAVAILABLE", debitParity: "UNAVAILABLE" };
    }
    catch {
        const snapshot = relay.snapshot();
        return { schemaVersion: 1, verdict: "STOPPED", evidence, identity,
            dispatches: snapshot.dispatches, arms: snapshot.arms, usage: snapshot.usage, clientExitCodes: codes, containmentVerified: contained, liveAdmission: evidence === "live-http" && snapshot.dispatches > 0 ? "EXECUTED" : "UNAVAILABLE", debitParity: "UNAVAILABLE", reason: snapshot.refusal ?? snapshot.reason ?? "pilot_child_incomplete" };
    }
    finally {
        relay.close();
        blocked.stop(true);
    }
}
export async function runOfflinePilot(root: string): Promise<PilotResult> {
    if (process.platform !== "darwin" || !await Bun.file(BINARY).exists() || !await Bun.file("/usr/bin/sandbox-exec").exists())
        return unavailable("pilot_containment_or_client_unavailable");
    const home = await mkdtemp(join(tmpdir(), "ccx-pilot-"));
    let server: ReturnType<typeof Bun.serve> | undefined;
    try {
        const identity = await prepare(root, home);
        server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(nativeSuccessSSE, { headers: { "content-type": "text/event-stream" } }) });
        return await execute(root, home, fixtureManifest(identity), { url: `http://127.0.0.1:${server.port}/responses`, authorization: "Bearer fixture", allowLoopback: true });
    }
    catch {
        return unavailable("pilot_preparation_failed");
    }
    finally {
        server?.stop(true);
        await rm(home, { recursive: true, force: true });
    }
}
async function clientChild(specPath: string) {
    const spec = JSON.parse(await readFile(specPath, "utf8"));
    const home = process.env.HOME!;
    // Verify the OS rejects a real TCP attempt before any inference request.
    try {
        await fetch(`http://127.0.0.1:${spec.blockedPort}`, { proxy: null } as RequestInit);
        throw new Error("pilot_egress_allowed");
    }
    catch (error) {
        if ((error as Error).message === "pilot_egress_allowed")
            throw error;
    }
    const relayOrigin = new URL(spec.relay).origin;
    const commanderOrigin = `http://127.0.0.1:${spec.port}`;
    const original = globalThis.fetch;
    let canonicalSends = 0;
    globalThis.fetch = canonicalRecorderFetch(relayOrigin, new Set([relayOrigin, commanderOrigin]), original, () => canonicalSends++);
    let server: ReturnType<typeof Bun.serve> | undefined;
    try {
        if (spec.arm === "commander") {
            const settings = await import(join(spec.root, "src/config.ts"));
            settings.saveConfig({ port: spec.port, hostname: "127.0.0.1", multiAgentGuidanceEnabled: false, defaultProvider: "openai", providers: { openai: config.provider } });
            const runtime = await import(join(spec.root, "src/server/index.ts"));
            const serve = Bun.serve;
            (Bun as any).serve = (options: any) => serve({ ...options, fetch(request: Request, context: unknown) {
                if (request.headers.get("authorization") !== `Bearer ${spec.clientToken}`) return new Response(null, { status: 401 });
                return options.fetch(request, context);
            } });
            try { server = runtime.startServer(spec.port, { managementAuthState: { available: false, reason: "isolated pilot" } }); }
            finally { Bun.serve = serve; }
            const unauthorized = await original(`${commanderOrigin}/v1/responses`, { method: "POST", body: "{}", proxy: null } as RequestInit);
            if (unauthorized.status !== 401) throw new Error("pilot_ingress_unprotected");
            await unauthorized.arrayBuffer();
        }
        const origin = spec.arm === "direct" ? relayOrigin : `${commanderOrigin}/v1`;
        const args = [BINARY, "exec", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", "--json", "-s", "read-only", "-C", home,
            ...disabled.flatMap(feature => ["--disable", feature]), "--enable", "skip_host_skill_discovery", "-c", 'web_search="disabled"',
            "-c", `model=${JSON.stringify(config.model)}`, "-c", `model_reasoning_effort=${JSON.stringify(config.effort)}`,
            "-c", `model_catalog_json=${JSON.stringify(join(home, "catalog.json"))}`, "-c", 'model_provider="pilot"', "-c", 'model_providers.pilot.name="Isolated HTTP pilot"',
            "-c", `model_providers.pilot.base_url=${JSON.stringify(origin)}`, "-c", 'model_providers.pilot.env_key="PILOT_FIXTURE_TOKEN"',
            "-c", 'model_providers.pilot.wire_api="responses"', "-c", "model_providers.pilot.requires_openai_auth=false", "-c", "model_providers.pilot.supports_websockets=false",
            "-c", "model_providers.pilot.request_max_retries=0", "-c", "model_providers.pilot.stream_max_retries=0", config.prompt];
        const child = Bun.spawn(args, { cwd: home, env: { ...isolatedEnvironment(home), PILOT_FIXTURE_TOKEN: spec.clientToken }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
        const stop = () => interruptCaptureChild(child);
        const timer = setTimeout(stop, 25000);
        try {
            const [, , code] = await Promise.all([boundedChildText(child.stdout, 65536, stop), boundedChildText(child.stderr, 65536, stop), child.exited]);
            return { clientExitCode: code, containmentVerified: true, canonicalSends };
        }
        finally {
            clearTimeout(timer);
            await settleCaptureChild(child);
        }
    }
    finally {
        await server?.stop(true);
        globalThis.fetch = original;
    }
}
if (import.meta.main) {
    const args = process.argv.slice(2);
    if (args[0] === "--child" && args.length === 2) {
        console.log = console.error = console.warn = console.info = () => { };
        try {
            process.stdout.write(JSON.stringify(await clientChild(args[1]!)));
        }
        catch {
            process.stdout.write(JSON.stringify({ clientExitCode: -1, containmentVerified: false }));
            process.exitCode = 1;
        }
    }
    else if (args.length === 1 && args[0] === "--offline") {
        const result = await runOfflinePilot(resolve(import.meta.dir, ".."));
        console.log(JSON.stringify(result, null, 2));
        if (result.verdict !== "PASS")
            process.exitCode = 1;
    }
    else if (args.length === 9 && args[0] === "--execute-live" && args[1] === "--manifest" && args[3] === "--qualification"
        && args[5] === "--credentials" && args[7] === "--rate-source") {
        const result = await runLivePilot(resolve(import.meta.dir, ".."), { manifest: args[2]!, qualification: args[4]!, credentials: args[6]!, rateSource: args[8]! });
        console.log(JSON.stringify(result, null, 2));
        if (result.verdict !== "PASS")
            process.exitCode = 1;
    }
    else {
        console.error("Usage: --offline, or --execute-live --manifest <file> --qualification <file> --credentials <private-file> --rate-source <file>. Live mode spends subscription usage.");
        process.exitCode = 2;
    }
}
