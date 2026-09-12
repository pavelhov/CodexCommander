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
  if (result.exitCode !== 0) {
    // Only this fixed diagnostic grammar may cross the subprocess boundary.
    // Compiler messages and native errors can contain paths or account details.
    const diagnostic = new TextDecoder().decode(result.stderr).match(
      /^CCX_IDENTITY_FAILURE:(compile|token-environment|registered-folder):([A-Za-z0-9_.]{1,80}):([0-9A-F]{8})\r?$/m,
    );
    refuse(diagnostic
      ? `Windows effective-account lookup failed (${diagnostic[1]}, ${diagnostic[2]}, HRESULT 0x${diagnostic[3]}).`
      : "Windows effective-account lookup failed.");
  }
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
  // Shell folder expansion can retain the launcher's ambient USERPROFILE.
  // Expand the raw registered location against the OS token's environment,
  // without consulting or mutating this process's environment.
  const localAppData = powershellValue(String.raw`
$stage = 'compile'
try {
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text.RegularExpressions;
using Microsoft.Win32;
public static class CodexCommanderKnownFolders {
  public static string Stage = "token-environment";
  [DllImport("userenv.dll", SetLastError = true, ExactSpelling = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool CreateEnvironmentBlock(out IntPtr block, IntPtr token, [MarshalAs(UnmanagedType.Bool)] bool inherit);
  [DllImport("userenv.dll", ExactSpelling = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool DestroyEnvironmentBlock(IntPtr block);
  public static string LocalAppData(string expectedSid) {
    using (WindowsIdentity identity = WindowsIdentity.GetCurrent()) {
      if (!String.Equals(identity.User.Value, expectedSid, StringComparison.OrdinalIgnoreCase))
        throw new InvalidOperationException("Effective account changed during environment resolution.");
      IntPtr block = IntPtr.Zero;
      try {
        if (!CreateEnvironmentBlock(out block, identity.Token, false))
          throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        IntPtr cursor = block;
        while (Marshal.ReadInt16(cursor) != 0) {
          string entry = Marshal.PtrToStringUni(cursor);
          int separator = entry.IndexOf('=');
          if (separator > 0) values[entry.Substring(0, separator)] = entry.Substring(separator + 1);
          cursor = IntPtr.Add(cursor, checked((entry.Length + 1) * 2));
        }
        Stage = "registered-folder";
        string path;
        bool expand;
        using (RegistryKey users = RegistryKey.OpenBaseKey(RegistryHive.Users, RegistryView.Registry64))
        using (RegistryKey key = users.OpenSubKey(identity.User.Value + @"\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders")) {
          if (key == null) throw new InvalidOperationException("Registered folder key is unavailable.");
          var kind = key.GetValueKind("Local AppData");
          if (kind != RegistryValueKind.String && kind != RegistryValueKind.ExpandString)
            throw new InvalidOperationException("Registered folder value is not a string.");
          expand = kind == RegistryValueKind.ExpandString;
          path = key.GetValue("Local AppData", null, RegistryValueOptions.DoNotExpandEnvironmentNames) as string;
        }
        if (String.IsNullOrWhiteSpace(path)) throw new InvalidOperationException("Registered folder is empty.");
        var seen = new HashSet<string>(StringComparer.Ordinal);
        for (int depth = 0; expand && path.IndexOf('%') >= 0; depth++) {
          if (depth >= 16 || path.Length > 32767 || !seen.Add(path))
            throw new InvalidOperationException("Registered folder expansion did not converge.");
          bool replaced = false;
          path = Regex.Replace(path, @"%([^%]+)%", match => {
            string value;
            if (!values.TryGetValue(match.Groups[1].Value, out value))
              throw new InvalidOperationException("Registered folder references an unavailable variable.");
            replaced = true;
            return value;
          });
          if (!replaced) throw new InvalidOperationException("Registered folder has an unresolved variable.");
        }
        string root = Path.GetPathRoot(path);
        if (path.Length > 32767 || path.IndexOf('\0') >= 0 || String.IsNullOrEmpty(root) || root.Length < 3 || root.EndsWith(":"))
          throw new InvalidOperationException("Registered folder is not an absolute path.");
        return Path.GetFullPath(path);
      } finally {
        if (block != IntPtr.Zero) DestroyEnvironmentBlock(block);
      }
    }
  }
}
'@
$stage = 'token-environment'
[CodexCommanderKnownFolders]::LocalAppData('${identity.sid}')
} catch {
  if ($stage -ne 'compile') { $stage = [CodexCommanderKnownFolders]::Stage }
  $failure = $_.Exception.GetBaseException()
  [Console]::Error.WriteLine('CCX_IDENTITY_FAILURE:' + $stage + ':' + $failure.GetType().FullName + ':' + $failure.HResult.ToString('X8'))
  exit 1
}
`);
  if (!isAbsolute(localAppData)) refuse("Windows LocalAppData resolution returned a relative path.");

  // The SID and registered folder values come from the effective token/registry,
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
