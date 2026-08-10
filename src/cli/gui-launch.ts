import { spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GUI_LAUNCH_TICKET_PATH } from "../identity";
import {
  forgetEphemeralSecretPath,
  hardenSecretDir,
  hardenSecretPath,
} from "../lib/windows-secret-acl";
import { isLoopbackHostname } from "../server/auth-cors";
import { runtimeRequest } from "./runtime-api";

export interface GuiLaunchTicketResponse {
  ticket: string;
  origin: string;
  route: string;
  expiresAt: number;
}

interface GuiLaunchDeps {
  runtimeRequest?: typeof runtimeRequest;
  now?: () => number;
}

export interface GuiLaunchHandoff {
  directory: string;
  file: string;
  command: string;
  args: string[];
  cleanup: () => void;
}

function validRoute(route: string): boolean {
  return route.length > 0
    && route.length <= 512
    && !route.startsWith("/")
    && !route.includes("#")
    && !/[\u0000-\u001f\u007f]/.test(route);
}

function validateTicketResponse(
  value: GuiLaunchTicketResponse,
  route: string,
  expectedBaseUrl: string,
  now: number,
): GuiLaunchTicketResponse {
  let origin: URL;
  try {
    origin = new URL(value.origin);
  } catch {
    throw new Error("CodexCommander returned an invalid dashboard launch confirmation.");
  }
  if (!/^ccx_launch_[A-Za-z0-9_-]{43}$/.test(value.ticket)
    || value.route !== route
    || !Number.isFinite(value.expiresAt)
    || value.expiresAt <= now
    || value.expiresAt > now + 60_000
    || origin.protocol !== "http:"
    || !isLoopbackHostname(origin.hostname)
    || origin.origin !== new URL(expectedBaseUrl).origin
    || origin.pathname !== "/"
    || origin.search !== ""
    || origin.hash !== "") {
    throw new Error("CodexCommander returned an invalid dashboard launch confirmation.");
  }
  return value;
}

export function buildConfirmedGuiLaunchUrl(ticket: GuiLaunchTicketResponse): string {
  const url = new URL(ticket.origin);
  url.hash = new URLSearchParams({
    "ccx-launch-ticket": ticket.ticket,
    "ccx-route": ticket.route,
  }).toString();
  return url.toString();
}

export async function mintConfirmedGuiLaunch(
  baseUrl: string,
  port: number,
  route: string,
  deps: GuiLaunchDeps = {},
): Promise<{ url: string; origin: string }> {
  if (!validRoute(route)) throw new Error("Invalid dashboard route.");
  if (Number(new URL(baseUrl).port || "80") !== port) {
    throw new Error("Invalid dashboard endpoint.");
  }
  const request = deps.runtimeRequest ?? runtimeRequest;
  const value = await request<GuiLaunchTicketResponse>(GUI_LAUNCH_TICKET_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ route }),
  }, { baseUrl });
  const ticket = validateTicketResponse(value, route, baseUrl, (deps.now ?? Date.now)());
  return { url: buildConfirmedGuiLaunchUrl(ticket), origin: ticket.origin };
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function windowsRundll32(): string {
  const windowsRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
  const candidate = join(windowsRoot, "System32", "rundll32.exe");
  return existsSync(candidate) ? candidate : "rundll32";
}

/**
 * Put the fragment bearer in a user-private handoff file, never a launcher argv,
 * environment value, console line, or durable browser store. The OS launcher sees
 * only the random file path; cleanup is idempotent and outlives launcher delegation.
 */
export function createGuiLaunchHandoff(
  url: string,
  options: { platform?: NodeJS.Platform; temporaryRoot?: string } = {},
): GuiLaunchHandoff {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:"
    || !isLoopbackHostname(parsed.hostname)
    || !parsed.hash.includes("ccx-launch-ticket=")) {
    throw new Error("Invalid confirmed dashboard URL.");
  }
  const platform = options.platform ?? process.platform;
  const directory = mkdtempSync(join(options.temporaryRoot ?? tmpdir(), "ccx-gui-launch-"));
  const cleanup = () => {
    rmSync(directory, { recursive: true, force: true });
    forgetEphemeralSecretPath(join(directory, "dashboard.webloc"));
    forgetEphemeralSecretPath(join(directory, "dashboard.url"));
    forgetEphemeralSecretPath(join(directory, "dashboard.html"));
    forgetEphemeralSecretPath(directory);
  };
  const extension = platform === "darwin" ? "webloc" : platform === "win32" ? "url" : "html";
  const file = join(directory, `dashboard.${extension}`);
  const contents = platform === "darwin"
    ? `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>URL</key><string>${escapeXml(url)}</string></dict></plist>`
    : platform === "win32"
      ? `[InternetShortcut]\r\nURL=${url}\r\n`
      : `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${escapeXml(url)}"><title>CodexCommander</title>`;
  try {
    chmodSync(directory, 0o700);
    if (platform === "win32" && !hardenSecretDir(directory, { required: true }).ok) {
      throw new Error("directory ACL hardening failed");
    }
    writeFileSync(file, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
    chmodSync(file, 0o600);
    if (platform === "win32" && !hardenSecretPath(file, { required: true }).ok) {
      throw new Error("file ACL hardening failed");
    }
  } catch {
    cleanup();
    throw new Error("Could not create a private dashboard launch handoff.");
  }
  const command = platform === "darwin"
    ? "/usr/bin/open"
    : platform === "win32"
      ? windowsRundll32()
      : "xdg-open";
  const args = platform === "win32"
    ? ["url.dll,FileProtocolHandler", file]
    : [file];
  let cleaned = false;
  return {
    directory,
    file,
    command,
    args,
    cleanup: () => {
      if (cleaned) return;
      cleaned = true;
      cleanup();
    },
  };
}

function scheduleGuiLaunchCleanup(
  handoff: GuiLaunchHandoff,
  platform: NodeJS.Platform,
  spawnImpl: typeof spawn,
): void {
  const seconds = "65";
  const cleanup = platform === "win32"
    ? {
        command: join(
          process.env.SystemRoot || process.env.WINDIR || "C:\\Windows",
          "System32",
          "WindowsPowerShell",
          "v1.0",
          "powershell.exe",
        ),
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Start-Sleep -Seconds 65; Remove-Item -LiteralPath $args[0] -Recurse -Force -ErrorAction SilentlyContinue",
          handoff.directory,
        ],
      }
    : {
        command: "/bin/sh",
        args: ["-c", `sleep ${seconds}; rm -rf -- "$1"`, "ccx-gui-cleanup", handoff.directory],
      };
  try {
    const child = spawnImpl(cleanup.command, cleanup.args, {
      detached: true,
      stdio: "ignore",
      shell: false,
    });
    child.on("error", () => {});
    child.unref();
  } catch {
    // The in-process fallback below still cleans up when the CLI stays alive;
    // otherwise the private temp file contains only an already-expiring ticket.
  }
}

export function openConfirmedGuiUrl(
  url: string,
  options: {
    platform?: NodeJS.Platform;
    temporaryRoot?: string;
    spawnImpl?: typeof spawn;
    setTimeoutImpl?: typeof setTimeout;
  } = {},
): void {
  const handoff = createGuiLaunchHandoff(url, options);
  let child: ChildProcess;
  try {
    child = (options.spawnImpl ?? spawn)(handoff.command, handoff.args, {
      detached: false,
      stdio: "ignore",
      shell: false,
    });
  } catch {
    handoff.cleanup();
    throw new Error("Could not open the CodexCommander dashboard.");
  }
  child.once("error", handoff.cleanup);
  // A launcher can exit immediately after delegating to the browser. Retain the
  // private file through the 30-second ticket TTL, then remove it with margin.
  scheduleGuiLaunchCleanup(handoff, options.platform ?? process.platform, options.spawnImpl ?? spawn);
  const fallback = (options.setTimeoutImpl ?? setTimeout)(handoff.cleanup, 65_000);
  fallback.unref?.();
  child.unref();
}
