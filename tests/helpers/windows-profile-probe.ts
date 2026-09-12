/** Read-only metadata comparisons for a failed Windows namespace regression. */
export function windowsProfileProbe(): Record<string, boolean | number | string> {
  if (process.platform !== "win32") return { stage: "not-windows" };
  const script = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$stage = 'compile'
$identity = $null
$block = [IntPtr]::Zero
$folderPointer = [IntPtr]::Zero
try {
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class CCXProfileProbe {
  [DllImport("userenv.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool GetUserProfileDirectoryW(IntPtr token, StringBuilder path, ref uint size);
  [DllImport("userenv.dll", ExactSpelling = true, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool CreateEnvironmentBlock(out IntPtr block, IntPtr token, [MarshalAs(UnmanagedType.Bool)] bool inherit);
  [DllImport("userenv.dll", ExactSpelling = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool DestroyEnvironmentBlock(IntPtr block);
  [DllImport("shell32.dll", ExactSpelling = true)]
  public static extern int SHGetKnownFolderPath(ref Guid folder, uint flags, IntPtr token, out IntPtr path);
}
'@
function Same($left, $right) {
  return ![String]::IsNullOrEmpty($left) -and ![String]::IsNullOrEmpty($right) -and [String]::Equals($left, $right, [StringComparison]::OrdinalIgnoreCase)
}
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$stage = 'registry-profile'
$machine = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryView]::Registry64)
try {
  $key = $machine.OpenSubKey('SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\' + $identity.User.Value)
  try { $rawProfile = [string]$key.GetValue('ProfileImagePath', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }
  finally { if ($key) { $key.Dispose() } }
} finally { $machine.Dispose() }
$stage = 'native-profile'
$size = [uint32]0
[void][CCXProfileProbe]::GetUserProfileDirectoryW($identity.Token, $null, [ref]$size)
if ($size -lt 1 -or $size -gt 32768) { throw [InvalidOperationException]::new() }
$profileBuffer = [System.Text.StringBuilder]::new([int]$size)
if (![CCXProfileProbe]::GetUserProfileDirectoryW($identity.Token, $profileBuffer, [ref]$size)) { throw [System.ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error()) }
$nativeProfile = $profileBuffer.ToString()
$stage = 'token-environment'
if (![CCXProfileProbe]::CreateEnvironmentBlock([ref]$block, $identity.Token, $false)) { throw [System.ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error()) }
$cursor = $block
$tokenProfile = $null
while ([Runtime.InteropServices.Marshal]::ReadInt16($cursor) -ne 0) {
  $entry = [Runtime.InteropServices.Marshal]::PtrToStringUni($cursor)
  if ($entry.StartsWith('USERPROFILE=', [StringComparison]::OrdinalIgnoreCase)) { $tokenProfile = $entry.Substring(12) }
  $cursor = [IntPtr]::Add($cursor, ($entry.Length + 1) * 2)
}
$stage = 'registry-local'
$users = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::Users, [Microsoft.Win32.RegistryView]::Registry64)
try {
  $key = $users.OpenSubKey($identity.User.Value + '\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders')
  try { $rawLocal = [string]$key.GetValue('Local AppData', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }
  finally { if ($key) { $key.Dispose() } }
} finally { $users.Dispose() }
$stage = 'known-folder'
$folder = [Guid]'F1B32785-6FBA-4FCF-9D55-7B8E7F157091'
[Runtime.InteropServices.Marshal]::ThrowExceptionForHR([CCXProfileProbe]::SHGetKnownFolderPath([ref]$folder, 0x4000, $identity.Token, [ref]$folderPointer))
$knownFolder = [Runtime.InteropServices.Marshal]::PtrToStringUni($folderPointer)
@{
  stage = 'complete'
  registryProfileAbsolute = [IO.Path]::IsPathRooted($rawProfile)
  registryProfileHasVariables = $rawProfile.Contains('%')
  nativeProfileAbsolute = [IO.Path]::IsPathRooted($nativeProfile)
  tokenProfileAbsolute = [IO.Path]::IsPathRooted($tokenProfile)
  nativeMatchesRegistry = (Same $nativeProfile $rawProfile)
  nativeMatchesAmbient = (Same $nativeProfile $env:USERPROFILE)
  tokenMatchesRegistry = (Same $tokenProfile $rawProfile)
  tokenMatchesNative = (Same $tokenProfile $nativeProfile)
  tokenMatchesAmbient = (Same $tokenProfile $env:USERPROFILE)
  localRegistrationAbsolute = [IO.Path]::IsPathRooted($rawLocal)
  localRegistrationHasVariables = $rawLocal.Contains('%')
  localRegistrationUsesProfile = $rawLocal.IndexOf('%USERPROFILE%', [StringComparison]::OrdinalIgnoreCase) -ge 0
  knownFolderAbsolute = [IO.Path]::IsPathRooted($knownFolder)
  knownMatchesRawLocal = (Same $knownFolder $rawLocal)
  knownMatchesNativeDefault = (Same $knownFolder ([IO.Path]::Combine($nativeProfile, 'AppData\Local')))
  knownMatchesAmbientDefault = (Same $knownFolder ([IO.Path]::Combine($env:USERPROFILE, 'AppData\Local')))
} | ConvertTo-Json -Compress
} catch {
  @{ stage = $stage; errorCode = $_.Exception.GetBaseException().HResult } | ConvertTo-Json -Compress
} finally {
  if ($block -ne [IntPtr]::Zero) { [void][CCXProfileProbe]::DestroyEnvironmentBlock($block) }
  if ($folderPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::FreeCoTaskMem($folderPointer) }
  if ($identity) { $identity.Dispose() }
}
`;
  try {
    const result = Bun.spawnSync([
      "powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 8_000 });
    if (result.exitCode !== 0) return { stage: "probe-process", errorCode: result.exitCode };
    const parsed = JSON.parse(new TextDecoder().decode(result.stdout)) as Record<string, unknown>;
    const safe: Record<string, boolean | number | string> = {};
    for (const [name, value] of Object.entries(parsed)) {
      if (/^[A-Za-z]{1,40}$/.test(name) && typeof value === "boolean") safe[name] = value;
      else if (name === "errorCode" && Number.isSafeInteger(value)) safe[name] = value as number;
      else if (name === "stage" && typeof value === "string"
        && /^(compile|registry-profile|native-profile|token-environment|registry-local|known-folder|complete)$/.test(value)) safe.stage = value;
    }
    return safe;
  } catch {
    return { stage: "probe-unavailable" };
  }
}
