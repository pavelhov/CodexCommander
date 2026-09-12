/**
 * Environment-independent identity and namespace resolution for Codex writes.
 *
 * Bun 1.3.14 made the obvious implementation unsafe: both `os.homedir()` and
 * `os.userInfo().homedir` follow HOME. A service and CLI for the same account
 * could therefore coordinate through different databases. The namespace is
 * keyed only by the effective uid/SID and the canonical CODEX_HOME.
 */
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import type {
  ResolveCodexCoordinatorDatabasePath,
  ResolveCodexCatalogSerializationDatabasePath,
  ResolveEffectiveUserIdentity,
  UserIdentity,
} from "./convergence-types";

const POSIX_PRIVATE_MODE = 0o700;
const POSIX_TMP_REQUIRED_MODE = 0o1003;
const POSIX_TMP_PATH = "/tmp";
const SID_PATTERN = /^S-1-(?:\d+-)+\d+$/i;

export class CodexUserIdentityRefusal extends Error {
  readonly code = "CODEX_USER_IDENTITY_REFUSED";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CodexUserIdentityRefusal";
  }
}

function refuse(message: string, cause?: unknown): never {
  throw new CodexUserIdentityRefusal(message, cause === undefined ? undefined : { cause });
}

function powershellValue(expression: string): string {
  let result: ReturnType<typeof Bun.spawnSync>;
  try {
    result = Bun.spawnSync([
      "powershell.exe",
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(
        "$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8;\n" + expression,
        "utf16le",
      ).toString("base64"),
    ], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    });
  } catch (cause) {
    refuse("Windows effective-account lookup could not start.", cause);
  }
  if (result.exitCode !== 0) refuse("Windows effective-account lookup failed.");
  const value = new TextDecoder().decode(result.stdout).trim();
  if (!value) refuse("Windows effective-account lookup returned an empty value.");
  return value;
}

function resolveWindowsSid(): string {
  const sid = powershellValue(
    "[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
  );
  if (!SID_PATTERN.test(sid)) refuse("Windows effective-account lookup returned an invalid SID.");
  return sid.toUpperCase();
}

export const resolveEffectiveUserIdentity: ResolveEffectiveUserIdentity = () => {
  if (process.platform === "win32") {
    return { platform: "win32", sid: resolveWindowsSid() };
  }

  const getuid = process.getuid;
  if (typeof getuid !== "function") {
    refuse("The runtime does not expose the effective POSIX uid.");
  }
  let uid: number;
  try {
    uid = getuid.call(process);
  } catch (cause) {
    refuse("The effective POSIX uid lookup failed.", cause);
  }
  if (!Number.isSafeInteger(uid) || uid < 0) {
    refuse("The runtime returned an invalid effective POSIX uid.");
  }
  return { platform: "posix", uid };
};

function assertPrivatePosixDirectory(path: string, uid: number): void {
  let entry;
  try {
    entry = lstatSync(path);
  } catch (cause) {
    refuse("The Codex coordinator namespace cannot be inspected.", cause);
  }
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    refuse("The Codex coordinator namespace is not a real directory.");
  }
  if (entry.uid !== uid || (entry.mode & 0o777) !== POSIX_PRIVATE_MODE) {
    refuse("The Codex coordinator namespace has unsafe ownership or permissions.");
  }
}

function ensurePrivatePosixDirectory(path: string, uid: number): void {
  try {
    mkdirSync(path, { mode: POSIX_PRIVATE_MODE });
  } catch (cause) {
    const code = cause && typeof cause === "object" && "code" in cause
      ? String((cause as { code?: unknown }).code)
      : "";
    if (code !== "EEXIST") refuse("The Codex coordinator namespace cannot be created.", cause);
  }
  assertPrivatePosixDirectory(path, uid);
}

function resolvePosixRuntimeRoot(uid: number): string {
  let realTmp: string;
  try {
    realTmp = realpathSync.native(POSIX_TMP_PATH);
    const entry = statSync(realTmp);
    if (!entry.isDirectory() || entry.uid !== 0) {
      refuse("The system temporary directory has unsafe ownership.");
    }
    if ((entry.mode & POSIX_TMP_REQUIRED_MODE) !== POSIX_TMP_REQUIRED_MODE) {
      refuse("The system temporary directory lacks sticky world write/search permissions.");
    }
  } catch (cause) {
    if (cause instanceof CodexUserIdentityRefusal) throw cause;
    refuse("The system temporary directory cannot be trusted.", cause);
  }

  const root = join(realTmp, `codexcommander-runtime-v1-${uid}`);
  ensurePrivatePosixDirectory(root, uid);
  return root;
}

function resolveWindowsRuntimeRoot(identity: Extract<UserIdentity, { platform: "win32" }>): string {
  if (!SID_PATTERN.test(identity.sid)) refuse("The coordinator identity contains an invalid SID.");
  // An implicit-current-user folder lookup expands the caller's USERPROFILE.
  // Pass the effective token explicitly so every launcher uses the OS account's
  // registered (possibly redirected) LocalAppData, including under isolated HOME.
  const localAppData = powershellValue(`
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Security.Principal;
public static class CodexCommanderKnownFolders {
  [DllImport("shell32.dll", ExactSpelling = true)]
  private static extern int SHGetKnownFolderPath(ref Guid folder, uint flags, IntPtr token, out IntPtr path);
  public static string LocalAppData(string expectedSid) {
    using (WindowsIdentity identity = WindowsIdentity.GetCurrent()) {
      if (!String.Equals(identity.User.Value, expectedSid, StringComparison.OrdinalIgnoreCase))
        throw new InvalidOperationException("Effective account changed during folder resolution.");
      Guid folder = new Guid("F1B32785-6FBA-4FCF-9D55-7B8E7F157091");
      IntPtr path = IntPtr.Zero;
      try {
        Marshal.ThrowExceptionForHR(SHGetKnownFolderPath(ref folder, 0, identity.Token, out path));
        return Marshal.PtrToStringUni(path);
      } finally {
        if (path != IntPtr.Zero) Marshal.FreeCoTaskMem(path);
      }
    }
  }
}
'@
[CodexCommanderKnownFolders]::LocalAppData('${identity.sid}')
`);
  if (!isAbsolute(localAppData)) refuse("Windows LocalAppData resolution returned a relative path.");

  // The SID and known-folder values come from the effective token/Windows APIs,
  // never USERPROFILE or LOCALAPPDATA. WP11 adds descriptor/reparse/ACL checks at
  // the stable-database open boundary where those checks can cover SQLite too.
  const root = resolve(localAppData, "CodexCommander", "Runtime", "v1", identity.sid.toUpperCase());
  try {
    mkdirSync(root, { recursive: true });
  } catch (cause) {
    refuse("The Windows coordinator namespace cannot be created.", cause);
  }
  return root;
}

export const resolveCodexCoordinatorDatabasePath: ResolveCodexCoordinatorDatabasePath = (
  identity,
  canonicalCodexHome,
) => {
  if (!isAbsolute(canonicalCodexHome)) {
    refuse("The canonical CODEX_HOME must be an absolute path.");
  }
  const root = identity.platform === "posix"
    ? resolvePosixRuntimeRoot(identity.uid)
    : resolveWindowsRuntimeRoot(identity);
  const locks = join(root, "native-write-locks");
  if (identity.platform === "posix") ensurePrivatePosixDirectory(locks, identity.uid);
  else {
    try {
      mkdirSync(locks, { recursive: true });
    } catch (cause) {
      refuse("The Windows coordinator lock directory cannot be created.", cause);
    }
  }

  const homeDigest = createHash("sha256").update(canonicalCodexHome).digest("hex");
  return join(locks, `${homeDigest}.sqlite`);
};

/**
 * K's FINAL database path. Never the native coordinator path.
 *
 * Catalog serialization is a different ownership surface from the native
 * coordinator N: `K -> C` is a legal order and `N -> K` nests, so sharing one
 * database would make the required nesting self-contend. The two live in
 * sibling directories under the same per-user runtime root — same identity
 * namespace, same environment-independent parent, distinct exclusion.
 *
 * Consumers use the returned path verbatim and append nothing.
 */
export const resolveCodexCatalogSerializationDatabasePath:
  ResolveCodexCatalogSerializationDatabasePath = (identity, canonicalCodexHome) => {
    if (!isAbsolute(canonicalCodexHome)) {
      refuse("The canonical CODEX_HOME must be an absolute path.");
    }
    const root = identity.platform === "posix"
      ? resolvePosixRuntimeRoot(identity.uid)
      : resolveWindowsRuntimeRoot(identity);
    const locks = join(root, "catalog-write-locks");
    if (identity.platform === "posix") ensurePrivatePosixDirectory(locks, identity.uid);
    else {
      try {
        mkdirSync(locks, { recursive: true });
      } catch (cause) {
        refuse("The Windows catalog serialization directory cannot be created.", cause);
      }
    }

    const homeDigest = createHash("sha256").update(canonicalCodexHome).digest("hex");
    return join(locks, `${homeDigest}.sqlite`);
  };
