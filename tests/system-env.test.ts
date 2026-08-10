import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import type { CodexCommanderConfig } from "../src/types";
import {
  cleanStaleSystemEnv,
  injectSystemEnv,
  revertSystemEnv,
} from "../src/server/system-env";

const originalFetch = globalThis.fetch;
const originalPlatform = process.platform;

const baseConfig = {
  port: 4096,
  multiAgentGuidanceEnabled: true,
  providers: {},
  defaultProvider: "test",
  claudeCode: { systemEnv: true },
} satisfies CodexCommanderConfig;

let execSpy: ReturnType<typeof spyOn>;
let execFileSpy: ReturnType<typeof spyOn>;
let readSpy: ReturnType<typeof spyOn>;
let writeSpy: ReturnType<typeof spyOn>;
let unlinkSpy: ReturnType<typeof spyOn>;
let mkdirSpy: ReturnType<typeof spyOn>;
let trackingFile: string | undefined;
let launchctlBaseUrl: string | undefined;
let launchctlEnvValues: Record<string, string | undefined>;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
}

function tracking(
  port = 4567,
  injectedKeys: string[] = ["ANTHROPIC_BASE_URL", "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY", "ANTHROPIC_AUTH_TOKEN"],
): string {
  return JSON.stringify({
    schemaVersion: 1,
    pid: 123,
    port,
    injectedAt: "2026-07-11T00:00:00.000Z",
    injectedKeys,
  });
}

function launchctlCommands(): string[] {
  return execFileSpy.mock.calls
    .filter(call => call[0] === "/bin/launchctl")
    .map(call => `launchctl ${(call[1] as string[]).join(" ")}`);
}

beforeEach(() => {
  setPlatform("darwin");
  trackingFile = undefined;
  launchctlBaseUrl = undefined;
  launchctlEnvValues = {};
  globalThis.fetch = mock(async () => new Response("ok")) as unknown as typeof fetch;

  execSpy = spyOn(childProcess, "execSync").mockImplementation((() => Buffer.alloc(0)) as typeof childProcess.execSync);
  execFileSpy = spyOn(childProcess, "execFileSync").mockImplementation(((file: string, args?: readonly string[]) => {
    if (file === "/bin/launchctl" && args?.[0] === "getenv") {
      const name = args[1];
      if (name === "ANTHROPIC_BASE_URL") return launchctlBaseUrl ?? "";
      return launchctlEnvValues[name] ?? "";
    }
    return Buffer.alloc(0);
  }) as typeof childProcess.execFileSync);
  readSpy = spyOn(fs, "readFileSync").mockImplementation((() => {
    if (trackingFile === undefined) throw new Error("ENOENT");
    return trackingFile;
  }) as typeof fs.readFileSync);
  writeSpy = spyOn(fs, "writeFileSync").mockImplementation(((...args: unknown[]) => {
    trackingFile = String(args[1]);
  }) as typeof fs.writeFileSync);
  unlinkSpy = spyOn(fs, "unlinkSync").mockImplementation((() => {
    trackingFile = undefined;
  }) as typeof fs.unlinkSync);
  mkdirSpy = spyOn(fs, "mkdirSync").mockImplementation((() => undefined) as typeof fs.mkdirSync);
});

afterEach(() => {
  execSpy.mockRestore();
  execFileSpy.mockRestore();
  readSpy.mockRestore();
  writeSpy.mockRestore();
  unlinkSpy.mockRestore();
  mkdirSpy.mockRestore();
  globalThis.fetch = originalFetch;
  setPlatform(originalPlatform);
});

describe("system environment injection", () => {
  test("injectSystemEnv sets the Claude launchctl variables on macOS", async () => {
    expect(await injectSystemEnv(4567, baseConfig)).toEqual({ injected: true });

    const commands = launchctlCommands();
    expect(commands).toContain("launchctl setenv ANTHROPIC_BASE_URL http://127.0.0.1:4567");
    expect(commands).toContain("launchctl setenv CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY 1");
    // Writes include the shell env file and the tracking file (agent-def syncing
    // may add owned ccx-*.md writes — implementation contract; count is no longer fixed).
    const writePaths = writeSpy.mock.calls.map(call => String(call[0]));
    expect(writePaths.some(p => p.includes("claude-env.sh"))).toBe(true);
    expect(writePaths.some(p => p.endsWith("/.zshrc"))).toBe(true);
    expect(writePaths.some(p => p.includes("system-env-port"))).toBe(true);
    const persisted = JSON.parse(trackingFile!);
    expect(persisted).toMatchObject({ schemaVersion: 1, pid: process.pid, port: 4567 });
    expect(Object.keys(persisted).sort()).toEqual([
      "injectedAt", "injectedKeys", "pid", "port", "schemaVersion",
    ]);
  });

  test("injectSystemEnv invokes launchctl without a command shell", async () => {
    expect(await injectSystemEnv(4567, baseConfig)).toEqual({ injected: true });

    expect(execFileSpy).toHaveBeenCalledWith(
      "/bin/launchctl",
      ["getenv", "ANTHROPIC_BASE_URL"],
      { encoding: "utf8" },
    );
    expect(execFileSpy).toHaveBeenCalledWith(
      "/bin/launchctl",
      ["setenv", "ANTHROPIC_BASE_URL", "http://127.0.0.1:4567"],
    );
    expect(execSpy).not.toHaveBeenCalled();
  });

  test("injectSystemEnv is a no-op outside macOS", async () => {
    setPlatform("linux");

    expect(await injectSystemEnv(4567, baseConfig)).toEqual({ injected: false, reason: "not macOS" });
    expect(execFileSpy).not.toHaveBeenCalled();
  });

  test("injectSystemEnv skips disabled Claude and system environment integration", async () => {
    expect(await injectSystemEnv(4567, { ...baseConfig, claudeCode: { enabled: false } })).toEqual({
      injected: false,
      reason: "claude disabled",
    });
    expect(await injectSystemEnv(4567, {
      ...baseConfig,
      claudeCode: { systemEnv: false },
    })).toEqual({ injected: false, reason: "systemEnv disabled" });
    expect(writeSpy.mock.calls.some(call => String(call[0]).endsWith("/.zshrc"))).toBe(false);
  });

  test("injectSystemEnv preserves a custom ANTHROPIC_BASE_URL", async () => {
    launchctlBaseUrl = "https://anthropic.example.com";

    expect(await injectSystemEnv(4567, baseConfig)).toEqual({
      injected: false,
      reason: "user has custom ANTHROPIC_BASE_URL",
    });
    expect(launchctlCommands().some(command => command.includes("setenv"))).toBe(false);
  });

  test("injectSystemEnv includes the first configured API key", async () => {
    const config: CodexCommanderConfig = {
      ...baseConfig,
      apiKeys: [{ id: "key-1", name: "Primary", key: "secret-token", createdAt: "2026-07-11T00:00:00.000Z" }],
    };

    expect(await injectSystemEnv(4567, config)).toEqual({ injected: true });
    expect(launchctlCommands()).toContain("launchctl setenv ANTHROPIC_AUTH_TOKEN secret-token");
  });

  test("injectSystemEnv passes API keys with special characters as one argument", async () => {
    const config: CodexCommanderConfig = {
      ...baseConfig,
      apiKeys: [{ id: "key-1", name: "Primary", key: "secret token'quoted", createdAt: "2026-07-11T00:00:00.000Z" }],
    };

    expect(await injectSystemEnv(4567, config)).toEqual({ injected: true });
    expect(execFileSpy).toHaveBeenCalledWith(
      "/bin/launchctl",
      ["setenv", "ANTHROPIC_AUTH_TOKEN", "secret token'quoted"],
    );
  });

  // Subscription switch-back cleanup (implementation contract, audit R1 #1):
  // re-injecting without proxy mode must unset ONLY the codexcommander-owned dummy token.
  function trackingWithToken(port = 4567, keys: string[] = ["ANTHROPIC_BASE_URL", "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY", "ANTHROPIC_AUTH_TOKEN"]): string {
    return tracking(port, keys);
  }

  function mockAuthTokenGetenv(value: string | undefined): void {
    launchctlEnvValues.ANTHROPIC_AUTH_TOKEN = value;
  }

  test("re-inject after switching back to subscription unsets the owned dummy token", async () => {
    trackingFile = trackingWithToken();
    launchctlBaseUrl = "http://127.0.0.1:4567";
    mockAuthTokenGetenv("codexcommander-proxy");

    // EXPLICIT subscription, not auto: this asserts the switch-back strip, and under
    // auto the resolver would read the real machine's Claude auth and could legitimately
    // decide proxy (implementation contract).
    const subscription = {
      ...baseConfig,
      claudeCode: { systemEnv: true, authMode: "subscription" },
    } as unknown as CodexCommanderConfig;
    expect(await injectSystemEnv(4567, subscription)).toEqual({ injected: true });
    expect(execFileSpy).toHaveBeenCalledWith("/bin/launchctl", ["unsetenv", "ANTHROPIC_AUTH_TOKEN"]);
    expect(JSON.parse(trackingFile!).injectedKeys).not.toContain("ANTHROPIC_AUTH_TOKEN");
  });

  test("re-inject preserves a tracked token whose value is not the codexcommander dummy", async () => {
    trackingFile = trackingWithToken();
    launchctlBaseUrl = "http://127.0.0.1:4567";
    mockAuthTokenGetenv("sk-user-real-token");

    expect(await injectSystemEnv(4567, baseConfig)).toEqual({ injected: true });
    expect(launchctlCommands()).not.toContain("launchctl unsetenv ANTHROPIC_AUTH_TOKEN");
  });

  test("re-inject preserves an untracked dummy-valued token it does not own", async () => {
    // Ownership guard independent of the value guard (audit R2 #1): the launchd domain
    // carries "codexcommander-proxy" but WE never injected it (not in injectedKeys).
    trackingFile = trackingWithToken(4567, ["ANTHROPIC_BASE_URL", "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY"]);
    launchctlBaseUrl = "http://127.0.0.1:4567";
    mockAuthTokenGetenv("codexcommander-proxy");

    expect(await injectSystemEnv(4567, baseConfig)).toEqual({ injected: true });
    expect(launchctlCommands()).not.toContain("launchctl unsetenv ANTHROPIC_AUTH_TOKEN");
  });
});

describe("system environment cleanup", () => {
  test("revertSystemEnv unsets owned variables and deletes the tracking file", () => {
    trackingFile = tracking();
    launchctlBaseUrl = "http://127.0.0.1:4567";

    expect(revertSystemEnv()).toEqual({ reverted: true });
    for (const name of [
      "ANTHROPIC_BASE_URL",
      "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY",
      "ANTHROPIC_AUTH_TOKEN",
    ]) {
      expect(execFileSpy).toHaveBeenCalledWith("/bin/launchctl", ["unsetenv", name]);
    }
    // Two deletes: shell env file + tracking file
    expect(unlinkSpy).toHaveBeenCalledTimes(2);
  });

  test("revertSystemEnv skips variables it does not own", () => {
    trackingFile = tracking();
    launchctlBaseUrl = "http://127.0.0.1:9999";

    expect(revertSystemEnv()).toEqual({ reverted: false, reason: "ownership mismatch" });
    expect(unlinkSpy).not.toHaveBeenCalled();
  });

  test("revertSystemEnv rejects a tampered tracking file instead of salvaging recognized names", () => {
    trackingFile = JSON.stringify({
      schemaVersion: 1,
      pid: 123,
      port: 4567,
      injectedAt: "2026-07-11T00:00:00.000Z",
      injectedKeys: [
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        "UNRELATED_USER_SETTING",
      ],
    });
    launchctlBaseUrl = "http://127.0.0.1:4567";

    expect(revertSystemEnv()).toEqual({ reverted: false, reason: "no tracking file" });
    const unsetNames = execFileSpy.mock.calls
      .filter(call => call[0] === "/bin/launchctl" && (call[1] as string[])[0] === "unsetenv")
      .map(call => (call[1] as string[])[1]);
    expect(unsetNames).toEqual([]);
  });

  test("revertSystemEnv rejects unversioned, incomplete, and extended tracking records", () => {
    const current = JSON.parse(tracking()) as Record<string, unknown>;
    for (const invalid of [
      { ...current, schemaVersion: undefined },
      { ...current, injectedKeys: undefined },
      { ...current, removedField: true },
    ]) {
      trackingFile = JSON.stringify(invalid);
      expect(revertSystemEnv()).toEqual({ reverted: false, reason: "no tracking file" });
    }
    const unsetNames = execFileSpy.mock.calls
      .filter(call => call[0] === "/bin/launchctl" && (call[1] as string[])[0] === "unsetenv");
    expect(unsetNames).toEqual([]);
  });

  test("revertSystemEnv unsets only the exact keys recorded by the current schema", () => {
    trackingFile = tracking(4567, ["ANTHROPIC_BASE_URL"]);
    launchctlBaseUrl = "http://127.0.0.1:4567";

    expect(revertSystemEnv()).toEqual({ reverted: true });
    const unsetNames = execFileSpy.mock.calls
      .filter(call => call[0] === "/bin/launchctl" && (call[1] as string[])[0] === "unsetenv")
      .map(call => (call[1] as string[])[1]);
    expect(unsetNames).toEqual(["ANTHROPIC_BASE_URL"]);
  });

  test("revertSystemEnv invokes launchctl without a command shell", () => {
    trackingFile = tracking();
    launchctlBaseUrl = "http://127.0.0.1:4567";

    expect(revertSystemEnv()).toEqual({ reverted: true });
    expect(execFileSpy).toHaveBeenCalledWith(
      "/bin/launchctl",
      ["unsetenv", "ANTHROPIC_BASE_URL"],
    );
  });

  test("cleanStaleSystemEnv reverts a dead tracked proxy", async () => {
    trackingFile = tracking();
    launchctlBaseUrl = "http://127.0.0.1:4567";
    globalThis.fetch = mock(async () => { throw new Error("connection refused"); }) as unknown as typeof fetch;

    expect(await cleanStaleSystemEnv()).toEqual({ cleaned: true });
    // Two deletes: shell env file + tracking file
    expect(unlinkSpy).toHaveBeenCalledTimes(2);
  });
});

describe("systemEnv helper-model and auto-context keys", () => {
  function capturedWrites(): Array<{ path: string; data: string }> {
    const writes: Array<{ path: string; data: string }> = [];
    writeSpy.mockImplementation(((...args: unknown[]) => {
      writes.push({ path: String(args[0]), data: String(args[1]) });
      trackingFile = String(args[1]);
    }) as typeof fs.writeFileSync);
    return writes;
  }

  test("auto-context default lever: AUTO_COMPACT_WINDOW 350000 injected, tracked, conditionally exported (implementation contract)", async () => {
    const writes = capturedWrites();
    expect(await injectSystemEnv(4096, baseConfig)).toEqual({ injected: true });
    const setCalls = launchctlCommands();
    expect(setCalls).toContain("launchctl setenv CLAUDE_CODE_AUTO_COMPACT_WINDOW 350000");
    const trackingWrite = writes.filter(w => w.path.includes("system-env-port")).at(-1);
    expect(JSON.parse(trackingWrite!.data).injectedKeys).toContain("CLAUDE_CODE_AUTO_COMPACT_WINDOW");
    const shellWrite = writes.find(w => w.path.includes("claude-env.sh"));
    expect(shellWrite!.data).toContain(`[ -z "\${CLAUDE_CODE_AUTO_COMPACT_WINDOW+x}" ] && export CLAUDE_CODE_AUTO_COMPACT_WINDOW='350000'`);
  });

  test("auto-context: user-preset launchctl value is respected and untracked (audit 021 #2)", async () => {
    const writes = capturedWrites();
    launchctlEnvValues.CLAUDE_CODE_AUTO_COMPACT_WINDOW = "500000";
    expect(await injectSystemEnv(4096, baseConfig)).toEqual({ injected: true });
    const setCalls = launchctlCommands();
    expect(setCalls.some(c => c.startsWith("launchctl setenv CLAUDE_CODE_AUTO_COMPACT_WINDOW"))).toBe(false);
    const trackingWrite = writes.filter(w => w.path.includes("system-env-port")).at(-1);
    expect(JSON.parse(trackingWrite!.data).injectedKeys).not.toContain("CLAUDE_CODE_AUTO_COMPACT_WINDOW");
  });

  test("the helper selector injects both current Haiku variables", async () => {
    const writes = capturedWrites();
    const helperConfig = {
      ...baseConfig,
      claudeCode: { systemEnv: true, smallFastModel: "mock/small" },
    } satisfies CodexCommanderConfig;
    expect(await injectSystemEnv(4096, helperConfig)).toEqual({ injected: true });
    const setCalls = launchctlCommands();
    expect(setCalls).toContain("launchctl setenv ANTHROPIC_DEFAULT_HAIKU_MODEL mock/small");
    expect(setCalls).toContain("launchctl setenv ANTHROPIC_SMALL_FAST_MODEL mock/small");
    const trackingWrite = writes.filter(w => w.path.includes("system-env-port")).at(-1);
    expect(JSON.parse(trackingWrite!.data).injectedKeys).toEqual(expect.arrayContaining([
      "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_SMALL_FAST_MODEL",
    ]));
    const shellWrite = writes.find(w => w.path.includes("claude-env.sh"));
    expect(shellWrite!.data).toContain('[ -z "${ANTHROPIC_DEFAULT_HAIKU_MODEL+x}" ] && export ANTHROPIC_DEFAULT_HAIKU_MODEL=');
    expect(shellWrite!.data).toContain('[ -z "${ANTHROPIC_SMALL_FAST_MODEL+x}" ] && export ANTHROPIC_SMALL_FAST_MODEL=');
  });
});
