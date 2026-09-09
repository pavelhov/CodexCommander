import { expect, test } from "bun:test";
import { PilotBudget, type PilotManifest, type PilotIdentity } from "../scripts/inference-pilot-budget";
import { runPilotDryRun } from "../scripts/inference-pilot-dry-run";
const fingerprint = "a".repeat(64);
const identity: PilotIdentity = { clientSha256:fingerprint, runtimeSourceSha256:fingerprint, configSha256:fingerprint, catalogSha256:fingerprint, qualificationSha256:fingerprint, accountAlias:"account-a", accountGeneration:fingerprint, model:"fixture-model", effort:"low", tier:"default", transport:"http" };
function manifest(): PilotManifest { return {schemaVersion:1, identity, qualification:{verdict:"PASS",actualClientFullIngress:true,requiredScenariosComplete:true,dispatchComplete:true}, bounds:{generationStarts:6,dispatches:6,wallTimeMs:600000,inputTokensPerSend:1000,outputTokensPerSend:100,estimatedCredits:6.6}, rates:{unit:"subscription-credits",inputPerMillion:1000,outputPerMillion:1000,model:"fixture-model",tier:"default",sourceSha256:fingerprint,verifiedAt:1000}}; }
function budget() { return new PilotBudget(manifest(), identity, () => 1000); }
const complete = {httpStatus:200,outcome:"completed" as const,inputTokens:1000,outputTokens:100,completeness:"complete" as const};
test("six bounded starts across matched arms succeed and a seventh never dispatches", async () => {
 const guard=budget(); let sends=0;
 for(const arm of ["direct","commander"] as const) for(let turn=0;turn<3;turn++) {
  const generation=guard.beginGeneration(arm,identity);
  await guard.dispatch(generation,"initial",identity,async()=>{sends++;return complete;}); guard.endGeneration(generation);
 }
 expect(sends).toBe(6); expect(guard.snapshot().dispatches).toBe(6);
 expect(()=>guard.beginGeneration("direct",identity)).toThrow(); guard.close();
});
test("retry, stale identity, and incomplete usage stop before subsequent sends", async () => {
 for(const fault of ["retry","identity","usage"] as const) {
  const guard=budget();let sends=0;const generation=guard.beginGeneration("direct",identity);
  await expect(guard.dispatch(generation,fault==="retry"?"retry":"initial",fault==="identity"?{...identity,accountAlias:"account-b"}:identity,async()=>{sends++;return fault==="usage"?{...complete,completeness:"partial" as const}:complete;})).rejects.toThrow();
  expect(sends).toBe(fault==="usage"?1:0);expect(guard.signal.aborted).toBe(true);
  await expect(guard.dispatch(generation,"initial",identity,async()=>{sends++;return complete;})).rejects.toThrow();
  expect(sends).toBe(fault==="usage"?1:0);guard.close();
 }
});
test("all physical sends including compaction and sidecars spend the same reservation", async () => {
 const m=manifest();m.bounds.dispatches=2;m.bounds.estimatedCredits=2.2;
 const guard=new PilotBudget(m,identity,()=>1000);let sends=0;const generation=guard.beginGeneration("direct",identity);
 for(const kind of ["compaction","sidecar"] as const) await guard.dispatch(generation,kind,identity,async()=>{sends++;return complete;});
 await expect(guard.dispatch(generation,"initial",identity,async()=>{sends++;return complete;})).rejects.toThrow();expect(sends).toBe(2);guard.close();
});
test("admission refuses missing qualification, prices, or stale evidence", () => {
 for(const mutate of [(m:PilotManifest)=>m.qualification.verdict="UNAVAILABLE",(m:PilotManifest)=>m.qualification.actualClientFullIngress=false,(m:PilotManifest)=>m.bounds.estimatedCredits=0,(m:PilotManifest)=>m.rates.unit="api-usd" as any,(m:PilotManifest)=>m.rates.verifiedAt=-100000000]) {
  const m=manifest();mutate(m);expect(()=>new PilotBudget(m,identity,()=>1000)).toThrow();
 }
 expect(()=>new PilotBudget(manifest(),{...identity,clientSha256:"b".repeat(64)},()=>1000)).toThrow();
});
test("deadline, output bounds, and overlapping generations stop the pilot", async () => {
 let now=1000;const timed=new PilotBudget(manifest(),identity,()=>now);now+=600001;
 expect(()=>timed.beginGeneration("direct",identity)).toThrow();timed.close();
 const concurrent=budget();concurrent.beginGeneration("direct",identity);expect(()=>concurrent.beginGeneration("commander",identity)).toThrow();concurrent.close();
 const oversized=budget();const generation=oversized.beginGeneration("direct",identity);
 await expect(oversized.dispatch(generation,"initial",identity,async()=>({...complete,outputTokens:101}))).rejects.toThrow();expect(oversized.signal.aborted).toBe(true);oversized.close();
});

test("deadline aborts an actual in-flight HTTP reader", async () => {
 const server=Bun.serve({hostname:"127.0.0.1",port:0,fetch(){return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode("waiting"));}}));}});
 const m=manifest();m.bounds.wallTimeMs=250;
 m.rates.verifiedAt=Date.now();
 const guard=new PilotBudget(m,identity);let observedSignal:AbortSignal|undefined;
 try {
  const generation=guard.beginGeneration("direct",identity);
  await expect(guard.dispatch(generation,"initial",identity,async(signal)=>{
   observedSignal=signal;const response=await fetch(`http://127.0.0.1:${server.port}`,{signal});await response.text();return complete;
  })).rejects.toThrow("pilot_deadline");
  expect(observedSignal?.aborted).toBe(true);expect(guard.snapshot().dispatches).toBe(1);
 } finally {guard.close();server.stop(true);}
});


test("authentication faults and missing terminal outcomes cannot be counted as completed work", async () => {
 for(const result of [{...complete,httpStatus:401},{...complete,outcome:"unknown" as const}]) {
  const guard=budget();const generation=guard.beginGeneration("direct",identity);
  await expect(guard.dispatch(generation,"initial",identity,async()=>result)).rejects.toThrow("pilot_upstream_not_completed");
  expect(guard.signal.aborted).toBe(true);guard.close();
 }
});

test("HTTP dry-run counts six sends and blocks client retries or unknown usage at the relay", async () => {
 const current = () => { const m=manifest();m.rates.verifiedAt=Date.now();return m; };
 const result=await runPilotDryRun(current(),identity);
 expect(result.verdict).toBe("PASS");expect(result.upstreamSends).toBe(6);
 expect(result.dispatches).toBe(6);expect(result.generationStarts).toBe(6);
 expect(result.liveAdmission).toBe("UNAVAILABLE");
 for(const fault of ["retry","missing-usage"] as const) {
  const stopped=await runPilotDryRun(current(),identity,fault);
  expect(stopped.verdict).toBe("STOPPED");expect(stopped.upstreamSends).toBe(1);
  expect(stopped.stopped).toBe(true);
 }
});

test("rate evidence expiring during a pilot refuses the next physical send", async () => {
 let now=86401000;
 const m=manifest();m.rates.verifiedAt=now-86400000+100;
 const guard=new PilotBudget(m,identity,()=>now);
 const generation=guard.beginGeneration("direct",identity);
 now+=101;let sends=0;
 await expect(guard.dispatch(generation,"initial",identity,async()=>{sends++;return complete;})).rejects.toThrow("pilot_rate_basis_expired");
 expect(sends).toBe(0);guard.close();
});
