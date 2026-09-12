import { expect, test } from "bun:test";
import { parseMacOSUpdateArguments, encodeMacOSUpdateResult, recoveryDisposition } from "../src/cli/macos-update";
test("update helper refuses paths, nondecimal builds, malformed IDs and surplus arguments", () => {
  const id = "c94b8309-5c96-41f1-8dd1-fd57aeab8913";
  expect(parseMacOSUpdateArguments(["prepare", id, "102"])).toEqual({action:"prepare",transactionId:id,targetBuild:"102",updateAnyway:false});
  for (const args of [["prepare",id,"1.2"],["prepare","/tmp/a.app","102"],["status","extra"],["arm",id,"extra"]]) expect(() => parseMacOSUpdateArguments(args)).toThrow();
});
test("replacement recovery requires exact bundle/build and changed physical source", () => {
  const source = {bundlePath:"/Applications/Test.app",build:"100",fingerprint:"old"};
  expect(recoveryDisposition(source, "101", {...source,build:"101",fingerprint:"new"})).toBe("replacement-completed");
  expect(recoveryDisposition(source, "101", {...source,build:"101"})).toBe("finish-required");
  expect(recoveryDisposition(source, "101", {...source,build:"102",fingerprint:"new"})).toBe("finish-required");
  expect(recoveryDisposition(source, "101", {...source,bundlePath:"/tmp/Test.app",build:"101",fingerprint:"new"})).toBe("finish-required");
});

import { afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, cpSync, copyFileSync, symlinkSync, constants, realpathSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performMacOSUpdateCommand, trustedMacOSUpdateSource, type MacOSUpdateHelperIo } from "../src/cli/macos-update";
import { MacosUpdateTransactionStore, type MacosUpdateSemanticSnapshot } from "../src/server/macos-update-transaction";
import { acquireProxyLifecycleAuthority } from "../src/server/proxy-lifecycle-authority";
const temporary: string[] = [];
afterEach(() => { for (const root of temporary.splice(0)) rmSync(root,{recursive:true,force:true}); });
const id = "c94b8309-5c96-41f1-8dd1-fd57aeab8913";
function fixture(snapshot: Partial<MacosUpdateSemanticSnapshot> = {}) {
  const root = mkdtempSync(join(tmpdir(),"ccx-update-bridge-")); temporary.push(root);
  const store = new MacosUpdateTransactionStore(join(root,"transaction.json"));
  let source = {bundlePath:"/Applications/Test.app",build:"100",fingerprint:"source"};
  let fingerprint = "before", active = 0, verified = true, resumeSucceeds = true;
  const resumed: boolean[] = []; let stopped = 0;
  const io: MacOSUpdateHelperIo = {store,source:()=>source,intentFingerprint:()=>fingerprint,
    authority: options => acquireProxyLifecycleAuthority({...options,acquireEnsureLock:async()=>({token:"E",release(){}}),acquireStartLock:async()=>({token:"S",release(){}})}),
    preparation:()=>({capture:async()=>({running:true,routing:"owned",supervision:"none",process:null,supervisorFingerprint:null,sourceFingerprint:"source",intentFingerprint:"before",...snapshot}),fence:async()=>({active,release(){}}),stop:async()=>{stopped++;fingerprint="after";},verify:async()=>verified}),
    resume:async(transaction,authority,restoreOwned)=>{expect(store.read()?.phase).toBe("recovering");expect(authority.delegatedLease()).toBeDefined();resumed.push(restoreOwned);return resumeSucceeds;}
  };
  return {io,store,resumed,get stopped(){return stopped;},replace(){source={...source,build:"101",fingerprint:"replacement"};},setIntent(){fingerprint="external-edit";},setActive(n:number){active=n;},failVerify(){verified=false;},failResume(){resumeSucceeds=false;},allowResume(){resumeSucceeds=true;}};
}
const prepare = {action:"prepare" as const,transactionId:id,targetBuild:"101"};
test("active prepare immediately returns confirmation; cancel preserves the live runtime",async()=>{
  const f=fixture();f.setActive(2);
  expect((await performMacOSUpdateCommand(prepare,f.io)).status).toBe("confirmation-required");
  expect(f.stopped).toBe(0);
  expect((await performMacOSUpdateCommand({action:"cancel",transactionId:id},f.io)).status).toBe("recovered");
  expect(f.stopped).toBe(0);expect(f.resumed).toEqual([]);expect(f.store.read()).toBeNull();
});
test("arming reverifies exit and uncertain/armed cancellation cannot clear exclusion",async()=>{
  const f=fixture();await performMacOSUpdateCommand(prepare,f.io);f.failVerify();
  expect((await performMacOSUpdateCommand({action:"arm",transactionId:id},f.io)).status).toBe("blocked");
  expect(f.store.read()).not.toBeNull();
  const g=fixture();await performMacOSUpdateCommand(prepare,g.io);await performMacOSUpdateCommand({action:"arm",transactionId:id},g.io);
  expect((await performMacOSUpdateCommand({action:"cancel",transactionId:id},g.io)).status).toBe("finish-required");
  expect((await performMacOSUpdateCommand({action:"reconcile"},g.io)).status).toBe("finish-required");
  expect(g.resumed).toEqual([]);
});
test("successful replacement restores owned intent unless newer file edits or native intent superseded it",async()=>{
  for (const changed of [false,true]) {
    const f=fixture();await performMacOSUpdateCommand(prepare,f.io);await performMacOSUpdateCommand({action:"arm",transactionId:id},f.io);f.replace();if(changed)f.setIntent();
    expect((await performMacOSUpdateCommand({action:"reconcile"},f.io)).status).toBe("recovered");expect(f.resumed).toEqual([!changed]);expect(f.store.read()).toBeNull();
  }
  const f=fixture();await performMacOSUpdateCommand(prepare,f.io);
  const a=await f.io.authority!({includeStart:true});f.store.recordNative(a);a.releaseAll();f.replace();
  await performMacOSUpdateCommand({action:"reconcile"},f.io);expect(f.resumed).toEqual([false]);
});
test("running-native never enables routing, and failed resume retains a retryable recovery record",async()=>{
  const f=fixture({routing:"native"});await performMacOSUpdateCommand(prepare,f.io);f.replace();f.failResume();
  expect((await performMacOSUpdateCommand({action:"reconcile"},f.io)).status).toBe("blocked");expect(f.store.read()?.phase).toBe("recovering");
  f.allowResume();expect((await performMacOSUpdateCommand({action:"reconcile"},f.io)).status).toBe("recovered");expect(f.resumed).toEqual([false,false]);
  expect((await performMacOSUpdateCommand({action:"reconcile"},f.io)).status).toBe("idle");
});
test("prearm cancellation recovery survives helper failure and cold-launch retry",async()=>{
  const f=fixture();await performMacOSUpdateCommand(prepare,f.io);f.failResume();
  expect((await performMacOSUpdateCommand({action:"cancel",transactionId:id},f.io)).status).toBe("blocked");f.allowResume();
  expect((await performMacOSUpdateCommand({action:"reconcile"},f.io)).status).toBe("recovered");
});
test.skipIf(process.platform !== "darwin")("real bundled CLI helper derives source from bundle and refuses injected bundle arguments",async()=>{
  const root=mkdtempSync(join(tmpdir(),"ccx-bundled-update-"));temporary.push(root);
  const bundle=join(root,"Renamed.app"),runtime=join(bundle,"Contents/Resources/runtime");
  mkdirSync(runtime,{recursive:true});mkdirSync(join(bundle,"Contents/MacOS"),{recursive:true});
  writeFileSync(join(bundle,"Contents/Info.plist"),'<plist><dict><key>CFBundleVersion</key><string>100</string><key>CFBundleExecutable</key><string>Fixture</string></dict></plist>');writeFileSync(join(bundle,"Contents/MacOS/Fixture"),"fixture");
  cpSync(resolve("src"),join(runtime,"src"),{recursive:true});copyFileSync(resolve("package.json"),join(runtime,"package.json"));symlinkSync(resolve("node_modules"),join(runtime,"node_modules"),"dir");
  const bun=join(runtime,"bun");copyFileSync(process.execPath,bun,constants.COPYFILE_FICLONE);
  mkdirSync(join(root,"home"));mkdirSync(join(root,"codex"));mkdirSync(join(root,"state"));
  const env={...process.env,HOME:join(root,"home"),CODEX_HOME:join(root,"codex"),CODEXCOMMANDER_HOME:join(root,"state"),TMPDIR:root,BUN_OPTIONS:"",NODE_OPTIONS:""};
  const run=async(args:string[])=>{const child=Bun.spawn([bun,"--no-install","--no-env-file","--config=/dev/null",join(runtime,"src/cli/index.ts"),"__macos-update",...args],{env,stdout:"pipe",stderr:"pipe",cwd:runtime});return {code:await child.exited,text:await new Response(child.stdout).text()};};
  const good=await run(["status"]);expect(good.code).toBe(0);expect(JSON.parse(good.text).status).toBe("idle");
  expect(trustedMacOSUpdateSource(join(runtime,"src/cli/macos-update.ts"),bun).bundlePath).toBe(realpathSync(bundle));
  const bad=await run(["prepare",id,"101","/tmp/Other.app"]);expect(bad.code).toBe(2);expect(bad.text).not.toContain("Other.app");expect(Buffer.byteLength(bad.text)).toBeLessThan(2048);
},15000);

import { macOSUpdateResumeIntent } from "../src/cli/macos-update";
test("semantic matrix preserves stopped/native/supervised and newer OFF without copying settings",async()=>{
  for (const running of [true,false]) for (const routing of ["owned","native","external"] as const) for (const supervision of ["none","launchd"] as const) {
    const f=fixture({running,routing,supervision});await performMacOSUpdateCommand(prepare,f.io);
    expect(macOSUpdateResumeIntent(f.store.read()!,"after")).toEqual({running,restoreOwned:routing==="owned",supervised:supervision==="launchd"});
    await performMacOSUpdateCommand({action:"record-off"},f.io);
    expect(macOSUpdateResumeIntent(f.store.read()!,"after")).toEqual({running:false,restoreOwned:false,supervised:supervision==="launchd"});
  }
});
test("partial preparation stays excluded and Finish Update retries the same captured target",async()=>{
  const f=fixture();let stopAttempt=0;
  const base=f.io.preparation!;f.io.preparation=(source,authority)=>{const original=base(source,authority);return {...original,stop:async(t,a)=>{if(++stopAttempt===1)throw Error("partial stop");await original.stop(t,a);}};};
  expect((await performMacOSUpdateCommand(prepare,f.io)).status).toBe("blocked");expect(f.store.read()?.phase).toBe("uncertain");
  expect((await performMacOSUpdateCommand(prepare,f.io)).status).toBe("prepared");expect(stopAttempt).toBe(2);
  await performMacOSUpdateCommand({action:"arm",transactionId:id},f.io);
  expect((await performMacOSUpdateCommand(prepare,f.io)).status).toBe("prepared");expect(f.store.read()?.installerMayBeArmed).toBe(true);
  expect((await performMacOSUpdateCommand({action:"cancel",transactionId:id},f.io)).status).toBe("finish-required");
});

import { resumeProduction } from "../src/cli/macos-update";
test("newer OFF stops a recovery child or active bundle supervisor before clearing exclusion",async()=>{
  const f=fixture();await performMacOSUpdateCommand(prepare,f.io);await performMacOSUpdateCommand({action:"record-off"},f.io);
  const authority=await f.io.authority!({includeStart:true});let stops=0;
  const stop=async()=>{stops++;return {schemaVersion:1 as const,action:"stop" as const,ok:true,state:"stopped" as const,changed:true,pid:null,port:null,message:"stopped"};};
  expect(await resumeProduction(f.store.read()!,authority,false,{service:()=>({kind:"absent",fingerprint:null,active:false}),live:async()=>({pid:123,port:1234,source:"runtime"}),inspect:async()=>({pid:123,bundlePath:"/Applications/Test.app",fingerprint:"child"}),stop})).toBe(true);
  expect(stops).toBe(1);
  expect(await resumeProduction(f.store.read()!,authority,false,{service:()=>({kind:"bundle",fingerprint:null,active:true}),live:async()=>null,stop})).toBe(true);
  expect(stops).toBe(2);authority.releaseAll();
});

import { macOSUpdateIntentFingerprint } from "../src/cli/macos-update";
test("permission hardening reads do not supersede routing intent but user writes do",async()=>{
  const root=mkdtempSync(join(tmpdir(),"ccx-update-intent-"));temporary.push(root);
  const config=join(root,"config.json");writeFileSync(config,'{"enabled":true}');
  const before=macOSUpdateIntentFingerprint([config]);
  await Bun.sleep(2);chmodSync(config,0o600);
  expect(macOSUpdateIntentFingerprint([config])).toBe(before);
  await Bun.sleep(2);writeFileSync(config,'{"enabled":false}');
  expect(macOSUpdateIntentFingerprint([config])).not.toBe(before);
});
