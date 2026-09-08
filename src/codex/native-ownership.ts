import { createHash } from "node:crypto";
import { lstatSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile, getConfigDir } from "../config";

export type NativeOwner = { account: string; generation: string };
type RecordEntry = { kind: "task" | "artifact"; key: string; account: string; generation: string; at: number };
const MAX_ENTRIES = 4096;
const TTL = 24 * 60 * 60_000;
const digestPattern = /^[a-f0-9]{64}$/;
let loadedPath = "";
let entries = new Map<string, RecordEntry>();
export function ownershipFingerprint(domain: string, value: string): string {
  return createHash("sha256").update(domain).update("\0").update(value).digest("hex");
}
/** Inputs are never retained: logical account survives refresh, generation does not. */
export function nativeOwner(accountId: string, credentialGeneration: string | number): NativeOwner {
  return { account: ownershipFingerprint("account", accountId), generation: ownershipFingerprint("generation", String(credentialGeneration)) };
}
function validOwner(owner: NativeOwner): boolean {
  return typeof owner.account === "string" && typeof owner.generation === "string"
    && digestPattern.test(owner.account) && digestPattern.test(owner.generation);
}
function load(): string {
  const path = join(getConfigDir(), "native-ownership.json");
  if (loadedPath === path) return path;
  loadedPath = path; entries = new Map();
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024 || (process.platform !== "win32" && (stat.mode & 0o077))) return path;
    const data = JSON.parse(readFileSync(path, "utf8"));
    if (data.version !== 1 || !Array.isArray(data.entries) || data.entries.length > MAX_ENTRIES) return path;
    for (const item of data.entries) {
      if (!item || !["task", "artifact"].includes(item.kind) || !digestPattern.test(item.key) || !validOwner(item) || !Number.isFinite(item.at)
        || item.at > Date.now() + 60_000 || Date.now() - item.at > TTL) continue;
      entries.set(item.key, { kind: item.kind, key: item.key, account: item.account, generation: item.generation, at: item.at });
    }
  } catch { /* Untrusted or unavailable cache fails closed. */ }
  return path;
}
function persist(path: string): void {
  try {
    try { if (!lstatSync(path).isFile()) return; } catch { /* New cache. */ }
    mkdirSync(getConfigDir(), { recursive: true, mode: 0o700 });
    atomicWriteFile(path, JSON.stringify({ version: 1, entries: [...entries.values()] }));
  } catch { /* Persistence failure loses qualification on restart, never invents provenance. */ }
}
export function readNativeOwnership(key: string): RecordEntry | undefined {
  load(); const entry = entries.get(key);
  return entry && Date.now() - entry.at <= TTL ? entry : undefined;
}
export function writeNativeOwnership(key: string, owner: NativeOwner, kind: "task" | "artifact" = "artifact"): void {
  const path = load();
  if (!digestPattern.test(key) || !validOwner(owner)) return;
  entries.delete(key); entries.set(key, { kind, key, ...owner, at: Date.now() });
  for (const [id, entry] of entries) if (Date.now() - entry.at > TTL) entries.delete(id);
  while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value!);
  persist(path);
}
export function deleteNativeOwnership(key: string): void {
  const path = load(); if (entries.delete(key)) persist(path);
}
export function clearNativeTaskOwnership(account?: string): void {
  const path = load();
  for (const [key, entry] of entries) if (entry.kind === "task" && (!account || entry.account === account)) entries.delete(key);
  persist(path);
}
export function clearNativeOwnershipMemoryForTests(): void { loadedPath = ""; entries.clear(); }

class NativeArtifactBoundsError extends Error {}
const ARTIFACT_FIELDS = new Set(["encrypted_content"]);
const ARTIFACT_HEADERS = ["x-codex-turn-state"];
export type NativeArtifactKind = "encrypted" | "reference" | "turnState";
function artifactKeys(body: unknown, headers?: Headers, response = false): Array<{ key: string; kind: NativeArtifactKind }> {
  const keys: Array<{ key: string; kind: NativeArtifactKind }> = [];
  let visited = 0;
  const add = (field: string, value: unknown) => {
    if (value === undefined || value === null || value === "") return;
    if (typeof value !== "string" || value.length > 1024 * 1024) throw new NativeArtifactBoundsError();
    keys.push({ key: ownershipFingerprint(`artifact:${field}`, value), kind: field === "encrypted_content" ? "encrypted" : field === "response_id" ? "reference" : "turnState" });
    if (keys.length > 1024) throw new NativeArtifactBoundsError();
  };
  const walk = (value: unknown, depth: number): void => {
    if (++visited > 50_000 || depth > 40) throw new NativeArtifactBoundsError();
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const child of value) walk(child, depth + 1); return; }
    for (const [field, child] of Object.entries(value)) {
      if (ARTIFACT_FIELDS.has(field)) {
        if (Array.isArray(child)) { for (const item of child) add(field, item); }
        else add(field, child);
      } else if (field === "previous_response_id") add("response_id", child);
      else walk(child, depth + 1);
    }
  };
  walk(body, 0);
  if (response && body && typeof body === "object" && !Array.isArray(body)) {
    const record = body as Record<string, unknown>;
    if (record.type === undefined || record.object === "response" || record.type === "response") add("response_id", record.id);
  }
  for (const field of ARTIFACT_HEADERS) add(field, headers?.get(field));
  return keys;
}
export type NativeArtifactProvenance = "none" | "same" | "different-account" | "different-generation" | "unknown";
/** Origin evidence by kind, never a compatibility verdict. Encrypted replay and connection state differ. */
export function classifyNativeArtifactProvenance(body: unknown, headers: Headers | undefined, owner: NativeOwner | undefined): Record<NativeArtifactKind, NativeArtifactProvenance> {
  const result: Record<NativeArtifactKind, NativeArtifactProvenance> = { encrypted: "none", reference: "none", turnState: "none" };
  let keys: ReturnType<typeof artifactKeys>;
  try { keys = artifactKeys(body, headers); } catch { return { encrypted: "unknown", reference: "unknown", turnState: "unknown" }; }
  const rank: Record<NativeArtifactProvenance, number> = { none: 0, same: 1, unknown: 2, "different-generation": 3, "different-account": 4 };
  for (const { key, kind } of keys) {
    const entry = readNativeOwnership(key);
    const status: NativeArtifactProvenance = !owner || !entry ? "unknown"
      : entry.account !== owner.account ? "different-account"
      : entry.generation !== owner.generation ? "different-generation" : "same";
    if (rank[status] > rank[result[kind]]) result[kind] = status;
  }
  return result;
}
/** Call only with artifacts actually received from upstream (terminal response or output item). */
export function rememberNativeArtifacts(response: unknown, headers: Headers | undefined, owner: NativeOwner): void {
  if (!validOwner(owner)) return;
  let keys: ReturnType<typeof artifactKeys>;
  try { keys = artifactKeys(response, headers, true); } catch { return; }
  const path = load();
  for (const { key } of keys) {
    entries.delete(key); entries.set(key, { kind: "artifact", key, ...owner, at: Date.now() });
  }
  while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value!);
  if (keys.length) persist(path);
}
