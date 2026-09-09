import { expect, test } from "bun:test";
import { runOfflinePilot, runLivePilot } from "../../scripts/inference-pilot-launcher";
test("installed client uses contained direct and full Commander paths through one bounded relay", async () => {
    const result = await runOfflinePilot(process.cwd());
    if (process.platform !== "darwin" || !await Bun.file("/Applications/ChatGPT.app/Contents/Resources/codex").exists()) {
        expect(result.verdict).toBe("UNAVAILABLE");
        return;
    }
    expect(result.verdict).toBe("PASS");
    expect(result.dispatches).toBe(6);
    expect(result.arms).toEqual({ direct: 3, commander: 3 });
    expect(result.clientExitCodes).toEqual([0, 0, 0, 0, 0, 0]);
    expect(result.containmentVerified).toBe(true);
    expect(result.liveAdmission).toBe("UNAVAILABLE");
}, 120000);
test("live entry refuses missing evidence without discovering active credentials", async () => {
    const result = await runLivePilot(process.cwd(), { manifest: "/nonexistent/pilot-manifest", qualification: "/nonexistent/pilot-report", credentials: "/nonexistent/pilot-auth", rateSource: "/nonexistent/pilot-rates" });
    expect(result.verdict).toBe("UNAVAILABLE");
    expect(result.dispatches).toBe(0);
});

// Exercises the live admission/dispatch path with the canonical HTTPS send intercepted
// in this test process. The sandboxed children can only reach the loopback relay.
test("live admission binds private evidence and reaches exactly six intercepted sends", async () => {
    if (process.platform !== "darwin" || !await Bun.file("/Applications/ChatGPT.app/Contents/Resources/codex").exists()) return;
    const { createHash } = await import("node:crypto");
    const { mkdtemp, rm, chmod } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { fakeChatGptJwt } = await import("../helpers/fake-chatgpt-jwt");
    const { nativeSuccessSSE } = await import("../fixtures/inference-accounting/fixtures");
    const sha = (v: string) => createHash("sha256").update(v).digest("hex");
    const home = await mkdtemp(join(tmpdir(), "pilot-admission-test-"));
    const original = globalThis.fetch;
    let sends = 0;
    try {
        const qualification = await runOfflinePilot(process.cwd());
        expect(qualification.verdict).toBe("PASS");
        const qualificationText = JSON.stringify(qualification);
        const rates = { unit: "subscription-credits", inputPerMillion: 1, outputPerMillion: 1, model: "gpt-5.4", tier: "default", verifiedAt: Date.now() };
        const rateText = JSON.stringify(rates);
        const accountId = "fixture-pilot-live";
        const accessToken = fakeChatGptJwt({ chatgpt_account_id: accountId });
        const claims = JSON.parse(Buffer.from(accessToken.split(".")[1]!, "base64url").toString());
        claims["https://api.openai.com/auth"] = { chatgpt_account_id: accountId };
        claims.exp = Math.floor(Date.now() / 1000) + 3600;
        const credential = `${accessToken.split(".")[0]}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${accessToken.split(".")[2]}`;
        const manifest = { schemaVersion: 1, identity: { ...qualification.identity, qualificationSha256: sha(qualificationText), accountAlias: "isolated", accountGeneration: sha(JSON.stringify([credential, accountId])), model: "gpt-5.4", effort: "low", tier: "default", transport: "http" }, qualification: { verdict: "PASS", actualClientFullIngress: true, requiredScenariosComplete: true, dispatchComplete: true }, bounds: { generationStarts: 6, dispatches: 6, wallTimeMs: 120000, inputTokensPerSend: 100000, outputTokensPerSend: 1000, estimatedCredits: 1 }, rates: { ...rates, sourceSha256: sha(rateText) } };
        const files = { manifest: join(home, "manifest.json"), qualification: join(home, "qualification.json"), credentials: join(home, "credentials.json"), rateSource: join(home, "rates.json") };
        await Bun.write(files.manifest, JSON.stringify(manifest));
        await Bun.write(files.qualification, qualificationText);
        await Bun.write(files.credentials, JSON.stringify({ accessToken: credential, accountId }));
        await chmod(files.credentials, 0o600);
        await Bun.write(files.rateSource, rateText);
        globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
            const url = input instanceof Request ? input.url : input.toString();
            if (url !== "https://chatgpt.com/backend-api/codex/responses") return original(input, init);
            sends++;
            expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${credential}`);
            expect(init?.redirect).toBe("manual");
            return new Response(nativeSuccessSSE, { headers: { "content-type": "text/event-stream" } });
        }) as typeof fetch;
        const result = await runLivePilot(process.cwd(), files);
        expect(result.reason).toBeUndefined();
        expect(result.verdict).toBe("PASS");
        expect(result.evidence).toBe("live-http");
        expect(result.dispatches).toBe(6);
        expect(sends).toBe(6);
        manifest.identity.clientSha256 = "0".repeat(64);
        await Bun.write(files.manifest, JSON.stringify(manifest));
        expect((await runLivePilot(process.cwd(), files)).verdict).toBe("UNAVAILABLE");
        expect(sends).toBe(6);
    } finally {
        globalThis.fetch = original;
        await rm(home, { recursive: true, force: true });
    }
}, 120000);
