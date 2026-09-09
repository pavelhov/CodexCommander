import { PilotBudget, type PilotIdentity, type PilotManifest, type PilotUsage } from "./inference-pilot-budget";

/** Exercises reservations at a real loopback HTTP boundary. It cannot launch Codex,
 * load credentials, or contact a provider. Synthetic rates are never live admission.
 */
export async function runPilotDryRun(manifest: PilotManifest, observed: PilotIdentity,
  fault: "none" | "retry" | "missing-usage" = "none") {
  const budget = new PilotBudget(manifest, observed);
  let upstreamSends = 0;
  let active: ReturnType<PilotBudget["beginGeneration"]> | undefined;
  let requestsInGeneration = 0;
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    upstreamSends++;
    return Response.json({ httpStatus: 200, outcome: "completed", inputTokens: 1, outputTokens: 1,
      completeness: fault === "missing-usage" ? "unknown" : "complete" } satisfies PilotUsage);
  } });
  const relay = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/responses" || !active) {
      budget.close();
      return new Response(null, { status: 409 });
    }
    const generation = active;
    const kind = requestsInGeneration++ === 0 ? "initial" : "retry";
    try {
      const usage = await budget.dispatch(generation, kind, observed, async signal => {
        const response = await fetch(`http://127.0.0.1:${upstream.port}/responses`, { method: "POST", signal });
        return await response.json() as PilotUsage;
      });
      return Response.json(usage);
    } catch {
      return new Response(null, { status: 409 });
    }
  } });
  try {
    for (const arm of ["direct", "commander"] as const) {
      for (let turn = 0; turn < 3; turn++) {
        active = budget.beginGeneration(arm, observed);
        requestsInGeneration = 0;
        const send = () => fetch(`http://127.0.0.1:${relay.port}/v1/responses`, { method: "POST", signal: budget.signal });
        const response = await send();
        await response.arrayBuffer();
        if (!response.ok) throw new Error("dry_run_refused");
        if (fault === "retry") { const retry = await send(); await retry.arrayBuffer(); }
        budget.endGeneration(active);
        active = undefined;
      }
    }
    return { verdict: "PASS" as const, evidence: "synthetic_loopback_budget_boundary" as const,
      liveAdmission: "UNAVAILABLE" as const, upstreamSends, ...budget.snapshot() };
  } catch {
    return { verdict: "STOPPED" as const, evidence: "synthetic_loopback_budget_boundary" as const,
      liveAdmission: "UNAVAILABLE" as const, upstreamSends, ...budget.snapshot() };
  } finally {
    budget.close();
    relay.stop(true);
    upstream.stop(true);
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--manifest") {
    console.error("Usage: bun scripts/inference-pilot-dry-run.ts --manifest <local-manifest.json> (loopback only)");
    process.exitCode = 2;
  } else {
    try {
      const manifest = await Bun.file(args[1]!).json() as PilotManifest;
      // This exercises a supplied fixture identity; it does not attest a running client.
      const result = await runPilotDryRun(manifest, manifest.identity);
      console.log(JSON.stringify(result, null, 2));
      if (result.verdict !== "PASS") process.exitCode = 1;
    } catch {
      console.error("Dry-run admission refused: manifest, qualification, bounds, or rate evidence is invalid.");
      process.exitCode = 1;
    }
  }
}
