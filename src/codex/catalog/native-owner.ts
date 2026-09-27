import { createHash, randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../../config";
import { readCodexTokensResult, type CodexTokenReadResult } from "../auth-collision";
import { canonicalCodexHomeDir } from "../home";
import { currentNativeLiveIdentity, nativeLiveCatalogSnapshotPath } from "./native-live";

export type NativeCatalogOwnerDecision = "match" | "mismatch" | "unknown";
const OWNER_VERSION = 1;
const HEX = /^[0-9a-f]{64}$/;
let sidecarMemo: { stamp: string | null; value: Record<string, unknown> | null } | null = null;
let legacySnapshotMemo: { stamp: string | null; identity: string | null } | null = null;

export function nativeCatalogOwnerPath(configDir = getConfigDir()): string {
  return join(configDir, "native-catalog-owner.json");
}

/** Credential-file epoch only; never reads or exposes its bytes. */
export function nativeAuthFileStamp(codexHome = canonicalCodexHomeDir()): string {
  const path = join(canonicalCodexHomeDir(codexHome), "auth.json");
  try {
    const stat = lstatSync(path, { bigint: true });
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`;
  } catch { return "missing-or-unreadable"; }
}

/** Hash only a current ChatGPT account id and the physical Codex home. */
export function currentNativeCatalogOwner(
  codexHome = canonicalCodexHomeDir(),
  tokenRead = readCodexTokensResult(codexHome),
): string | null {
  if (tokenRead.status !== "ok" || !tokenRead.tokens.account_id) return null;
  return createHash("sha256")
    .update(JSON.stringify(["ccx-native-owner-v1", tokenRead.tokens.account_id, canonicalCodexHomeDir(codexHome)]))
    .digest("hex");
}

function readBoundedObject(path: string, maxBytes: number): Record<string, unknown> | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown> : null;
  } catch { return null; }
}

function fileStamp(path: string): string | null {
  try {
    const stat = lstatSync(path, { bigint: true });
    return `${path}\0${stat.dev}\0${stat.ino}\0${stat.size}\0${stat.mtimeNs}\0${stat.ctimeNs}`;
  } catch { return null; }
}

function readSidecar(): Record<string, unknown> | null {
  const path = nativeCatalogOwnerPath();
  const stamp = fileStamp(path);
  if (sidecarMemo?.stamp === stamp) return sidecarMemo.value;
  const value = stamp === null ? null : readBoundedObject(path, 512);
  sidecarMemo = { stamp, value };
  return value;
}

function retainedSnapshotIdentity(): { exists: boolean; identity: string | null } {
  const path = nativeLiveCatalogSnapshotPath();
  const stamp = fileStamp(path);
  if (stamp === null) return { exists: false, identity: null };
  if (legacySnapshotMemo?.stamp !== stamp) {
    const value = readBoundedObject(path, 4 * 1024 * 1024);
    legacySnapshotMemo = { stamp, identity: typeof value?.identity === "string" ? value.identity : null };
  }
  return { exists: true, identity: legacySnapshotMemo.identity };
}

export function resetNativeCatalogOwnerMemoForTests(): void {
  sidecarMemo = null;
  legacySnapshotMemo = null;
}

/** One decision shared by carry and published-native consumers. */
export function nativeCatalogOwnerDecision(
  codexHome = canonicalCodexHomeDir(),
  tokenRead: CodexTokenReadResult = readCodexTokensResult(codexHome),
): NativeCatalogOwnerDecision {
  const home = canonicalCodexHomeDir(codexHome);
  const currentOwner = currentNativeCatalogOwner(home, tokenRead);
  if (currentOwner === null) return "unknown";
  const sidecar = readSidecar();
  if (sidecar?.version === OWNER_VERSION && typeof sidecar.owner === "string" && HEX.test(sidecar.owner)) {
    return sidecar.owner === currentOwner ? "match" : "mismatch";
  }
  // Upgrade from a release without the owner sidecar: the retained native-live
  // snapshot is account/runtime bound. An existing but nonmatching snapshot is
  // negative evidence; absence leaves the previous catalog usable.
  const snapshot = retainedSnapshotIdentity();
  if (!snapshot.exists) return "unknown";
  const identity = currentNativeLiveIdentity({ codexHome: home });
  return identity !== null && snapshot.identity === identity ? "match" : "mismatch";
}

/** Commit the opaque owner without putting account data in Codex's catalog. */
export function writeNativeCatalogOwner(owner: string): void {
  if (!HEX.test(owner)) throw new TypeError("Invalid native catalog owner hash.");
  const path = nativeCatalogOwnerPath();
  const dir = getConfigDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify({ version: OWNER_VERSION, owner })}\n`, { mode: 0o600, flag: "wx" });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch { /* rename consumed it */ }
  }
}

export function forgetNativeCatalogOwnerAfterWriteFailure(): void {
  try { unlinkSync(nativeCatalogOwnerPath()); } catch { /* no stale sidecar */ }
}
