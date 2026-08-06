/** Read-only OpenCode client detection and fixed-shape launch helpers. */
import { spawn, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { commandInvocation } from "../lib/win-exec";

export const OPENCODE_DESKTOP_BUNDLE_ID = "ai.opencode.desktop";
export const OPENCODE_DOWNLOAD_URL = "https://opencode.ai/download";
export const OPENCODE_CONSOLE_URL = "https://opencode.ai/console";

export interface OpencodeInstallationStatus {
  desktopInstalled: boolean;
  cliInstalled: boolean;
  preferred: "desktop" | "cli" | null;
}

function standardDesktopCandidates(home = homedir()): string[] {
  return [
    "/Applications/OpenCode.app",
    join(home, "Applications", "OpenCode.app"),
  ];
}

function spotlightFindDesktop(): boolean {
  if (process.platform !== "darwin") return false;
  try {
    const output = execFileSync(
      "/usr/bin/mdfind",
      [`kMDItemCFBundleIdentifier == '${OPENCODE_DESKTOP_BUNDLE_ID}'`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2_000, maxBuffer: 64 * 1024 },
    );
    return output.split(/\r?\n/).some(path => path.trim().endsWith(".app") && existsSync(path.trim()));
  } catch {
    return false;
  }
}

export function detectOpencodeInstallation(home = homedir()): OpencodeInstallationStatus {
  const desktopInstalled = process.platform === "darwin"
    && (standardDesktopCandidates(home).some(existsSync) || spotlightFindDesktop());
  const cliInstalled = Bun.which("opencode") != null;
  return {
    desktopInstalled,
    cliInstalled,
    preferred: desktopInstalled ? "desktop" : cliInstalled ? "cli" : null,
  };
}

export async function launchInstalledOpencode(
  env: NodeJS.ProcessEnv = process.env,
): Promise<"desktop" | "cli"> {
  const installation = detectOpencodeInstallation();
  if (!installation.preferred) throw new Error("OpenCode is not installed");
  if (installation.preferred === "desktop") {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        "/usr/bin/open",
        ["-b", OPENCODE_DESKTOP_BUNDLE_ID, "opencode://"],
        { detached: true, stdio: "ignore", env },
      );
      child.once("error", reject);
      child.once("spawn", () => { child.unref(); resolve(); });
    });
    return "desktop";
  }

  await new Promise<void>((resolve, reject) => {
    const invocation = commandInvocation("opencode", []);
    const child = spawn(invocation.file, invocation.args, {
      detached: true,
      stdio: "ignore",
      env,
      windowsHide: true,
      ...invocation.options,
    });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
  return "cli";
}
