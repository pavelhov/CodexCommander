import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCodexTaskIdentity } from "../src/codex/task-identity";
import { classifyNativeArtifactProvenance, rememberNativeArtifacts, nativeOwner, clearNativeOwnershipMemoryForTests } from "../src/codex/native-ownership";
let home: string;
let previous: string | undefined;
beforeEach(() => { previous = process.env.CODEXCOMMANDER_HOME; home = mkdtempSync(join(tmpdir(), "ccx-owner-")); process.env.CODEXCOMMANDER_HOME = home; clearNativeOwnershipMemoryForTests(); });
afterEach(() => { clearNativeOwnershipMemoryForTests(); if (previous === undefined) delete process.env.CODEXCOMMANDER_HOME; else process.env.CODEXCOMMANDER_HOME = previous; rmSync(home, { recursive: true, force: true }); });
test("own tasks stay distinct across siblings and session fallback excludes parent", () => {
  expect(resolveCodexTaskIdentity(new Headers({"thread-id":"child-a", "session_id":"shared", "x-codex-parent-thread-id":"parent"})).taskId).toBe("child-a");
  expect(resolveCodexTaskIdentity(new Headers({"thread-id":"child-b", "session_id":"shared", "x-codex-parent-thread-id":"parent"})).taskId).toBe("child-b");
  expect(resolveCodexTaskIdentity(new Headers({"session-id":"session", "x-codex-parent-thread-id":"parent"})).taskId).toBe("session");
  expect(resolveCodexTaskIdentity(new Headers({"x-codex-parent-thread-id":"parent"})).taskId).toBeUndefined();
});
test("conflicting or oversized task aliases cannot acquire session ownership", () => {
  expect(resolveCodexTaskIdentity(new Headers({"thread-id":"a", "x-codex-thread-id":"b", "session_id":"session"})).source).toBe("conflict");
  expect(resolveCodexTaskIdentity(new Headers({"thread-id":"x".repeat(513), "session_id":"session"})).taskId).toBeUndefined();
});
test("native artifact provenance survives restart without raw content and classifies forged labels and refreshed generation", () => {
  const owner = nativeOwner("synthetic-account-a", "generation-a");
  rememberNativeArtifacts({ id: "response-private", output: [{ type: "reasoning", encrypted_content: "ciphertext-private" }] }, undefined, owner);
  const body = { previous_response_id: "response-private", input: [{type:"reasoning",encrypted_content:"ciphertext-private"}] };
  expect(classifyNativeArtifactProvenance(body, new Headers({"thread-id":"forged-owner"}), owner).encrypted).toBe("same");
  expect(classifyNativeArtifactProvenance(body, undefined, nativeOwner("synthetic-account-b", "generation-a")).encrypted).toBe("different-account");
  expect(classifyNativeArtifactProvenance(body, undefined, nativeOwner("synthetic-account-a", "generation-b")).encrypted).toBe("different-generation");
  const path = join(home,"native-ownership.json");
  const bytes = readFileSync(path,"utf8");
  for (const secret of ["response-private","ciphertext-private","synthetic-account-a","generation-a"]) expect(bytes).not.toContain(secret);
  if (process.platform !== "win32") expect(statSync(path).mode & 0o077).toBe(0);
  clearNativeOwnershipMemoryForTests();
  expect(classifyNativeArtifactProvenance(body, undefined, owner).encrypted).toBe("same");
  writeFileSync(path, "{}"); clearNativeOwnershipMemoryForTests();
  expect(classifyNativeArtifactProvenance(body, undefined, owner).encrypted).toBe("unknown");
});
test("ordinary messages and tool results need no ownership; unknown encrypted artifacts remain explicit", () => {
  expect(classifyNativeArtifactProvenance({input:[{role:"user",content:"hello"},{type:"function_call",arguments:"{}"},{type:"function_call_output",output:"ok"}]},undefined,undefined).encrypted).toBe("none");
  expect(classifyNativeArtifactProvenance({input:[{encrypted_content:"unknown"}]},undefined,nativeOwner("a",1)).encrypted).toBe("unknown");
});

test("reference, encrypted history and per-turn state have independent origin evidence", () => {
  const owner = nativeOwner("owner-a", 1);
  rememberNativeArtifacts({ id: "known-response", output: [] }, new Headers({"x-codex-turn-state":"known-turn"}), owner);
  expect(classifyNativeArtifactProvenance({previous_response_id:"known-response",input:[{encrypted_content:"unobserved-cipher"}]}, new Headers({"x-codex-turn-state":"known-turn"}), owner)).toEqual({reference:"same",encrypted:"unknown",turnState:"same"});
  expect(classifyNativeArtifactProvenance({}, new Headers({"x-codex-routing-hint":"model=gpt-5;tier=default"}), undefined)).toEqual({reference:"none",encrypted:"none",turnState:"none"});
});

test("bounded canonical turn metadata participates in own-task conflict checks", () => {
  expect(resolveCodexTaskIdentity(new Headers({"x-codex-turn-metadata":JSON.stringify({thread_id:"own",parent_thread_id:"parent"}),session_id:"session"})).taskId).toBe("own");
  expect(resolveCodexTaskIdentity(new Headers({"thread-id":"header"}), {thread_id:"body"}).source).toBe("conflict");
  expect(resolveCodexTaskIdentity(new Headers(), {thread_id:null,parent_thread_id:"parent"}).source).toBe("conflict");
});
