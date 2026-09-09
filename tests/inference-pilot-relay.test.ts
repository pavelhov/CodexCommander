import { expect, test } from 'bun:test';
import { createPilotRelay } from '../scripts/inference-pilot-relay';
import type { PilotManifest } from '../scripts/inference-pilot-budget';
const sha = 'a'.repeat(64);
const manifest = (): PilotManifest => ({ schemaVersion: 1, identity: { clientSha256: sha, runtimeSourceSha256: sha, configSha256: sha, catalogSha256: sha, qualificationSha256: sha, accountAlias: 'fixture', accountGeneration: sha, model: 'fixture-model', effort: 'low', tier: 'default', transport: 'http' }, qualification: { verdict: 'PASS', actualClientFullIngress: true, requiredScenariosComplete: true, dispatchComplete: true }, bounds: { generationStarts: 6, dispatches: 6, wallTimeMs: 10000, inputTokensPerSend: 1000, outputTokensPerSend: 100, estimatedCredits: 1 }, rates: { unit: 'subscription-credits', inputPerMillion: 1, outputPerMillion: 1, model: 'fixture-model', tier: 'default', sourceSha256: sha, verifiedAt: Date.now() } });
const sse = (usage = true) => `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [], ...(usage ? { usage: { input_tokens: 3, output_tokens: 2 } } : {}) } })}\n\n`;
const body = JSON.stringify({ model: 'fixture-model', reasoning: { effort: 'low' }, stream: true, input: [{ role: 'user', content: 'Reply OK.' }], tools: [] });
test('relay preserves bytes, owns six sends across both arms, and blocks seventh', async () => {
    let sends = 0;
    const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(r) { sends++; expect(await r.text()).toBe(body); return new Response(sse(), { headers: { 'content-type': 'text/event-stream' } }); } });
    const m = manifest(), relay = createPilotRelay(m, m.identity, { url: `http://127.0.0.1:${upstream.port}/responses`, authorization: 'Bearer fixture', clientAuthorization: 'Bearer fixture-client', allowLoopback: true });
    try {
        for (const arm of ['direct', 'commander'] as const)
            for (let i = 0; i < 3; i++) {
                relay.begin(arm);
                const r = await fetch(relay.url, { method: 'POST', headers: { authorization: 'Bearer fixture-client' }, body });
                expect(r.status).toBe(200);
                expect(await r.text()).toBe(sse());
                relay.end();
            }
        expect(sends).toBe(6);
        expect(() => relay.begin('direct')).toThrow();
    }
    finally {
        relay.close();
        upstream.stop(true);
    }
});
test('redirect and missing usage stop without a second upstream send', async () => {
    for (const fault of ['redirect', 'usage', 'unsupported-model']) {
        let sends = 0;
        const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { sends++; return fault === 'unsupported-model' ? new Response('{}', { status: 400 }) : fault === 'redirect' ? new Response(null, { status: 307, headers: { location: '/again' } }) : new Response(sse(false), { headers: { 'content-type': 'text/event-stream' } }); } });
        const m = manifest(), relay = createPilotRelay(m, m.identity, { url: `http://127.0.0.1:${upstream.port}/responses`, authorization: 'Bearer fixture', clientAuthorization: 'Bearer fixture-client', allowLoopback: true });
        try {
            relay.begin('direct');
            const r = await fetch(relay.url, { method: 'POST', headers: { authorization: 'Bearer fixture-client' }, body });
            expect(r.status).toBe(409);
            expect(sends).toBe(1);
            expect(relay.snapshot().stopped).toBe(true);
            expect(relay.snapshot().upstreamStatus).toBe(fault === 'redirect' ? 307 : fault === 'unsupported-model' ? 400 : 200);
        }
        finally {
            relay.close();
            upstream.stop(true);
        }
    }
});
test('unsupported endpoint and tool schema are rejected before any physical send', async () => {
    for (const fault of ['endpoint', 'tools']) {
        let sends = 0;
        const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { sends++; return new Response(sse()); } });
        const m = manifest(), relay = createPilotRelay(m, m.identity, { url: `http://127.0.0.1:${upstream.port}/responses`, authorization: 'Bearer fixture', clientAuthorization: 'Bearer fixture-client', allowLoopback: true });
        try {
            relay.begin('direct');
            const r = await fetch(fault === 'endpoint' ? relay.url + '/compact' : relay.url, { method: 'POST', headers: { authorization: 'Bearer fixture-client' }, body: fault === 'tools' ? JSON.stringify({ ...JSON.parse(body), tools: [{ type: 'web_search' }] }) : body });
            expect(r.status).toBe(409);
            expect(sends).toBe(0);
        }
        finally {
            relay.close();
            upstream.stop(true);
        }
    }
});
test('overlapping requests and retries cannot reach upstream twice', async () => {
    let sends = 0;
    let release: () => void = () => { };
    const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch() { sends++; await new Promise<void>(r => release = r); return new Response(sse(), { headers: { 'content-type': 'text/event-stream' } }); } });
    const m = manifest(), relay = createPilotRelay(m, m.identity, { url: `http://127.0.0.1:${upstream.port}/responses`, authorization: 'Bearer fixture', clientAuthorization: 'Bearer fixture-client', allowLoopback: true });
    try {
        relay.begin('direct');
        const first = fetch(relay.url, { method: 'POST', headers: { authorization: 'Bearer fixture-client' }, body });
        for (let i = 0; i < 100 && sends === 0; i++)
            await Bun.sleep(5);
        expect(sends).toBe(1);
        const second = await fetch(relay.url, { method: 'POST', headers: { authorization: 'Bearer fixture-client' }, body });
        expect(second.status).toBe(409);
        release();
        await (await first).arrayBuffer();
        expect(sends).toBe(1);
    }
    finally {
        release();
        relay.close();
        upstream.stop(true);
    }
});
test('client cancellation aborts in-flight upstream and prevents later sends', async () => {
    let sends = 0;
    const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { sends++; return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(': waiting\n\n')); } }), { headers: { 'content-type': 'text/event-stream' } }); } });
    const m = manifest(), relay = createPilotRelay(m, m.identity, { url: `http://127.0.0.1:${upstream.port}/responses`, authorization: 'Bearer fixture', clientAuthorization: 'Bearer fixture-client', allowLoopback: true });
    try {
        relay.begin('direct');
        const controller = new AbortController();
        const pending = fetch(relay.url, { method: 'POST', headers: { authorization: 'Bearer fixture-client' }, body, signal: controller.signal }).catch(() => null);
        for (let i = 0; i < 100 && sends === 0; i++)
            await Bun.sleep(5);
        controller.abort();
        await pending;
        for (let i = 0; i < 100 && !relay.signal.aborted; i++)
            await Bun.sleep(5);
        expect(relay.signal.aborted).toBe(true);
        expect(() => relay.begin('commander')).toThrow();
        expect(sends).toBe(1);
    }
    finally {
        relay.close();
        upstream.stop(true);
    }
});
test('completed SSE closes a keepalive upstream and tool output is never delivered', async () => {
    for (const tool of [false, true]) {
        const payload = tool ? sse().replace('"output":[]', '"output":[{"type":"function_call","name":"dangerous"}]') : sse();
        const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(payload)); } }), { headers: { 'content-type': 'text/event-stream' } }); } });
        const m = manifest(), relay = createPilotRelay(m, m.identity, { url: `http://127.0.0.1:${upstream.port}/responses`, authorization: 'Bearer fixture', clientAuthorization: 'Bearer fixture-client', allowLoopback: true });
        try {
            relay.begin('direct');
            const r = await fetch(relay.url, { method: 'POST', headers: { authorization: 'Bearer fixture-client' }, body });
            expect(r.status).toBe(tool ? 409 : 200);
            expect(await r.text()).toBe(tool ? '' : payload);
        }
        finally {
            relay.close();
            upstream.stop(true);
        }
    }
});
test('changed observed identity refuses the physical send', async () => {
    let sends = 0;
    const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { sends++; return new Response(sse()); } });
    const m = manifest(), relay = createPilotRelay(m, m.identity, { url: `http://127.0.0.1:${upstream.port}/responses`, authorization: 'Bearer fixture', clientAuthorization: 'Bearer fixture-client', allowLoopback: true, observeIdentity: async () => ({ ...m.identity, accountGeneration: 'b'.repeat(64) }) });
    try {
        relay.begin('direct');
        expect((await fetch(relay.url, { method: 'POST', headers: { authorization: 'Bearer fixture-client' }, body })).status).toBe(409);
        expect(sends).toBe(0);
    }
    finally {
        relay.close();
        upstream.stop(true);
    }
});

test('early tool events are blocked even when the terminal output omits them', async () => {
    const early = `data: ${JSON.stringify({type:'response.output_item.added',item:{type:'function_call',name:'fixture'}})}\n\n`;
    const upstream = Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response(early+sse(),{headers:{'content-type':'text/event-stream'}})});
    const m=manifest(),relay=createPilotRelay(m,m.identity,{url:`http://127.0.0.1:${upstream.port}/responses`,authorization:'Bearer fixture',clientAuthorization:'Bearer fixture-client',allowLoopback:true});
    try { relay.begin('direct');const response=await fetch(relay.url,{method:'POST', headers:{authorization:'Bearer fixture-client'},body});expect(response.status).toBe(409);expect(await response.text()).toBe(''); }
    finally { relay.close();upstream.stop(true); }
});

test('unauthenticated callers cannot spend or stop the reserved generation', async () => {
    let sends = 0;
    const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { sends++; return new Response(sse(), { headers: { 'content-type': 'text/event-stream' } }); } });
    const m = manifest(), relay = createPilotRelay(m, m.identity, { url: `http://127.0.0.1:${upstream.port}/responses`, authorization: 'Bearer fixture', clientAuthorization: 'Bearer fixture-client', allowLoopback: true });
    try {
        relay.begin('direct');
        expect((await fetch(relay.url, {method:'POST',body})).status).toBe(401);
        expect(sends).toBe(0);
        expect(relay.signal.aborted).toBe(false);
        const good = await fetch(relay.url, {method:'POST',body,headers:{authorization:'Bearer fixture-client'}});
        expect(good.status).toBe(200);
        await good.arrayBuffer();
        expect(sends).toBe(1);
        relay.end();
    } finally { relay.close();upstream.stop(true); }
});

test('current client additional_tools preserves client schemas and rejects hosted tools', async () => {
    for (const hosted of [false, true]) {
        let sends = 0;
        const input = { type: 'additional_tools', id: 'fixture-tools', role: 'developer', tools: [{ type: 'namespace', name: 'functions', tools: [{ type: hosted ? 'web_search' : 'function', name: 'fixture', parameters: {} }] }] };
        const payload = JSON.stringify({ ...JSON.parse(body), input: [input, ...JSON.parse(body).input] });
        const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(r) { sends++; expect(await r.text()).toBe(payload); return new Response(sse(), { headers: { 'content-type': 'text/event-stream' } }); } });
        const m = manifest(), relay = createPilotRelay(m, m.identity, { url: `http://127.0.0.1:${upstream.port}/responses`, authorization: 'Bearer fixture', clientAuthorization: 'Bearer fixture-client', allowLoopback: true });
        try {
            relay.begin('direct');
            const response = await fetch(relay.url, { method: 'POST', headers: { authorization: 'Bearer fixture-client' }, body: payload });
            expect(response.status).toBe(hosted ? 409 : 200);
            expect(sends).toBe(hosted ? 0 : 1);
        } finally { relay.close(); upstream.stop(true); }
    }
});

test('valid SSE without Content-Type completes, invalid bytes still stop', async () => {
    for (const valid of [true, false]) {
        const original = globalThis.fetch;
        const target = 'http://127.0.0.1:1/responses';
        globalThis.fetch = ((input: any, init: any) => {
            if (String(input) !== target) return original(input, init);
            const response = new Response(new TextEncoder().encode(valid ? sse() : '{}'));
            response.headers.delete('content-type');
            return Promise.resolve(response);
        }) as typeof fetch;
        const m = manifest(), relay = createPilotRelay(m, m.identity, { url: target, authorization: 'Bearer fixture', clientAuthorization: 'Bearer fixture-client', allowLoopback: true });
        try {
            relay.begin('direct');
            const response = await fetch(relay.url, { method: 'POST', headers: { authorization: 'Bearer fixture-client' }, body });
            expect(response.status).toBe(valid ? 200 : 409);
            if (valid) {
                relay.end(); relay.begin('commander');
                const refused = await fetch(relay.url, { method: 'POST', headers: { authorization: 'Bearer fixture-client' }, body: '{}' });
                expect(refused.status).toBe(409);
                expect(relay.snapshot().upstreamStatus).toBeUndefined();
                expect(relay.snapshot().upstreamFailure).toBeUndefined();
            }
        } finally { relay.close(); globalThis.fetch = original; }
    }
});
