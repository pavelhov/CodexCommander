import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess, spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  buildConfirmedGuiLaunchUrl,
  createGuiLaunchHandoff,
  mintConfirmedGuiLaunch,
  openConfirmedGuiUrl,
  type GuiLaunchTicketResponse,
} from "../src/cli/gui-launch";
import {
  resetHardenedStateForTests,
  setIcaclsRunnerForTests,
  setPlatformForTests,
} from "../src/lib/windows-secret-acl";

const ticket: GuiLaunchTicketResponse = {
  ticket: `ccx_launch_${"A".repeat(43)}`,
  origin: "http://127.0.0.1:10100",
  route: "subagents",
  expiresAt: 60_000,
};

let temporaryRoot = "";
const previousUsername = process.env.USERNAME;

beforeEach(() => {
  temporaryRoot = mkdtempSync(join(tmpdir(), "ccx-gui-launch-test-"));
  resetHardenedStateForTests();
  setPlatformForTests(null);
  setIcaclsRunnerForTests(null);
});

afterEach(() => {
  setIcaclsRunnerForTests(null);
  setPlatformForTests(null);
  resetHardenedStateForTests();
  if (previousUsername === undefined) delete process.env.USERNAME;
  else process.env.USERNAME = previousUsername;
  rmSync(temporaryRoot, { recursive: true, force: true });
  temporaryRoot = "";
});

class FakeChild extends EventEmitter {
  unrefCalls = 0;
  unref(): this {
    this.unrefCalls += 1;
    return this;
  }
}

describe("confirmed GUI launch", () => {
  test("mints against the exact live origin and rejects localhost aliases", async () => {
    const seen: Array<{ path: string; baseUrl?: string; body?: BodyInit | null }> = [];
    const request = (async (path: string, init?: RequestInit, options?: { baseUrl?: string }) => {
      seen.push({ path, baseUrl: options?.baseUrl, body: init?.body });
      return ticket;
    }) as never;
    const launch = await mintConfirmedGuiLaunch("http://127.0.0.1:10100", 10100, "subagents", {
      runtimeRequest: request,
      now: () => 30_000,
    });
    expect(seen).toEqual([{
      path: "/api/gui-launch-ticket",
      baseUrl: "http://127.0.0.1:10100",
      body: JSON.stringify({ route: "subagents" }),
    }]);
    expect(launch.origin).toBe("http://127.0.0.1:10100");
    expect(new URL(launch.url).search).toBe("");
    expect(new URL(launch.url).hash).toContain(ticket.ticket);

    await expect(mintConfirmedGuiLaunch("http://127.0.0.1:10100", 10100, "subagents", {
      runtimeRequest: (async () => ({ ...ticket, origin: "http://localhost:10100" })) as never,
      now: () => 30_000,
    })).rejects.toThrow("invalid dashboard launch confirmation");
  });

  test("POSIX handoff is private and never places the bearer in launcher argv", () => {
    const url = buildConfirmedGuiLaunchUrl(ticket);
    const handoff = createGuiLaunchHandoff(url, { platform: "linux", temporaryRoot });
    try {
      expect(statSync(handoff.directory).mode & 0o777).toBe(0o700);
      expect(statSync(handoff.file).mode & 0o777).toBe(0o600);
      expect(readFileSync(handoff.file, "utf8")).toContain(ticket.ticket);
      expect([handoff.command, ...handoff.args].join(" ")).not.toContain(ticket.ticket);
      expect([handoff.command, ...handoff.args].join(" ")).not.toContain(url);
    } finally {
      handoff.cleanup();
    }
    expect(existsSync(handoff.directory)).toBe(false);
  });

  test("launcher close retains the handoff until the delayed post-TTL cleanup", () => {
    const url = buildConfirmedGuiLaunchUrl(ticket);
    const children: FakeChild[] = [];
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const spawnImpl = ((command: string, args: readonly string[]) => {
      calls.push({ command, args });
      const child = new FakeChild();
      children.push(child);
      return child as unknown as ChildProcess;
    }) as unknown as typeof spawn;
    let cleanupTimer: (() => void) | null = null;
    let cleanupDelay = 0;
    const setTimeoutImpl = ((callback: () => void, delay?: number) => {
      cleanupTimer = callback;
      cleanupDelay = delay ?? 0;
      return { unref() {} } as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;

    openConfirmedGuiUrl(url, { platform: "linux", temporaryRoot, spawnImpl, setTimeoutImpl });
    const handoffFile = calls[0]?.args[0];
    expect(handoffFile).toBeTruthy();
    expect(existsSync(String(handoffFile))).toBe(true);
    children[0]?.emit("close", 0);
    expect(existsSync(String(handoffFile))).toBe(true);
    expect(cleanupDelay).toBe(65_000);
    expect(calls.flatMap(call => [call.command, ...call.args]).join(" ")).not.toContain(ticket.ticket);
    expect(calls.flatMap(call => [call.command, ...call.args]).join(" ")).not.toContain(url);
    expect(cleanupTimer).not.toBeNull();
    (cleanupTimer as unknown as () => void)();
    expect(existsSync(String(handoffFile))).toBe(false);
  });

  test("launcher spawn errors remove the private handoff immediately", () => {
    const url = buildConfirmedGuiLaunchUrl(ticket);
    const child = new FakeChild();
    const spawnImpl = (() => child as unknown as ChildProcess) as unknown as typeof spawn;
    const setTimeoutImpl = (() => ({ unref() {} }) as unknown as ReturnType<typeof setTimeout>) as typeof setTimeout;
    openConfirmedGuiUrl(url, { platform: "linux", temporaryRoot, spawnImpl, setTimeoutImpl });
    const directory = readdirSync(temporaryRoot).map(name => join(temporaryRoot, name))[0];
    expect(directory && existsSync(directory)).toBe(true);
    child.emit("error", new Error("injected launcher failure"));
    expect(directory && existsSync(directory)).toBe(false);
  });

  test("Windows ACL failures for either directory or file fail closed", () => {
    process.env.USERNAME = "ccx-test-user";
    setPlatformForTests("win32");
    const url = buildConfirmedGuiLaunchUrl(ticket);

    setIcaclsRunnerForTests(() => ({ success: false, exitCode: 5, timedOut: false, stdout: "" }));
    expect(() => createGuiLaunchHandoff(url, { platform: "win32", temporaryRoot }))
      .toThrow("private dashboard launch handoff");
    expect(readdirSync(temporaryRoot)).toEqual([]);

    resetHardenedStateForTests();
    setIcaclsRunnerForTests(args => ({
      success: !String(args[0]).endsWith("dashboard.url"),
      exitCode: String(args[0]).endsWith("dashboard.url") ? 5 : 0,
      timedOut: false,
      stdout: "",
    }));
    expect(() => createGuiLaunchHandoff(url, { platform: "win32", temporaryRoot }))
      .toThrow("private dashboard launch handoff");
    expect(readdirSync(temporaryRoot)).toEqual([]);
  });

  test("CLI GUI output is pinned to the base origin, never the ticket URL", async () => {
    const source = await Bun.file(new URL("../src/cli/index.ts", import.meta.url)).text();
    expect(source).toContain("console.log(`Opening ${launch.origin}`)");
    expect(source).not.toContain("console.log(`Opening ${launch.url}`)");
  });
});
