import { describe, expect, test } from "bun:test";
import {
  isProcessAlive,
  stopProxy,
  waitForExit,
  type ProxySignalIdentity,
  type StopProxyIo,
} from "../src/lib/process-control";

const PID = 4242;
const SECRET_A = "a".repeat(43);
const SECRET_B = "b".repeat(43);

function runtime(secret = SECRET_A) {
  return { pid: PID, port: 10100, hostname: "127.0.0.1", attestationSecret: secret };
}

function identity(overrides: Partial<ProxySignalIdentity> = {}): ProxySignalIdentity {
  return {
    pid: PID,
    argvSha256: "argv-a",
    birthIdentity: "birth-a",
    ownerIdentity: "uid:501",
    ...overrides,
  };
}

function fallbackIo(overrides: StopProxyIo = {}): StopProxyIo {
  return {
    platform: "linux",
    isAlive: () => true,
    readRuntime: () => runtime(),
    readProcessIdentity: () => identity(),
    gracefulStop: async () => false,
    waitExit: () => true,
    waitStoppedPort: async () => {},
    ...overrides,
  };
}

describe("process control helpers", () => {
  test("reports the current process as alive", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  test("reports a clearly invalid pid as exited", () => {
    const invalidPid = 999_999_999;

    expect(isProcessAlive(invalidPid)).toBe(false);
    expect(waitForExit(invalidPid, 1)).toBe(true);
  });
});

describe("stopProxy forced fallback identity fence", () => {
  test("stable runtime, current-user argv and birth authorize SIGTERM", async () => {
    const signals: NodeJS.Signals[] = [];
    await stopProxy(PID, fallbackIo({
      signal: (_pid, signal) => { signals.push(signal); },
    }));
    expect(signals).toEqual(["SIGTERM"]);
  });

  test("runtime rotation during graceful stop refuses before SIGTERM", async () => {
    let currentRuntime = runtime();
    const signals: NodeJS.Signals[] = [];
    await expect(stopProxy(PID, fallbackIo({
      readRuntime: () => currentRuntime,
      gracefulStop: async () => {
        currentRuntime = runtime(SECRET_B);
        return false;
      },
      signal: (_pid, signal) => { signals.push(signal); },
    }))).rejects.toThrow("identity changed");
    expect(signals).toEqual([]);
  });

  for (const [name, replacement] of [
    ["argv", identity({ argvSha256: "argv-b" })],
    ["birth", identity({ birthIdentity: "birth-b" })],
    ["owner", identity({ ownerIdentity: "uid:777" })],
  ] as const) {
    test(`${name} replacement during graceful stop refuses before SIGTERM`, async () => {
      let currentIdentity = identity();
      const signals: NodeJS.Signals[] = [];
      await expect(stopProxy(PID, fallbackIo({
        readProcessIdentity: () => currentIdentity,
        gracefulStop: async () => {
          currentIdentity = replacement;
          return false;
        },
        signal: (_pid, signal) => { signals.push(signal); },
      }))).rejects.toThrow("identity changed");
      expect(signals).toEqual([]);
    });
  }

  test("unknown birth or owner evidence fails closed", async () => {
    const signals: NodeJS.Signals[] = [];
    await expect(stopProxy(PID, fallbackIo({
      readProcessIdentity: () => null,
      signal: (_pid, signal) => { signals.push(signal); },
    }))).rejects.toThrow("identity changed");
    expect(signals).toEqual([]);
  });

  test("SIGKILL revalidates again after the SIGTERM grace window", async () => {
    const signals: NodeJS.Signals[] = [];
    let waits = 0;
    await stopProxy(PID, fallbackIo({
      signal: (_pid, signal) => { signals.push(signal); },
      waitExit: () => ++waits > 1,
    }));
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test("PID reuse during the SIGTERM wait blocks SIGKILL", async () => {
    const signals: NodeJS.Signals[] = [];
    let currentIdentity = identity();
    let waits = 0;
    await expect(stopProxy(PID, fallbackIo({
      readProcessIdentity: () => currentIdentity,
      signal: (_pid, signal) => { signals.push(signal); },
      waitExit: () => {
        waits += 1;
        if (waits === 1) currentIdentity = identity({ birthIdentity: "reused-birth" });
        return false;
      },
    }))).rejects.toThrow("identity changed");
    expect(signals).toEqual(["SIGTERM"]);
  });

  test("Windows taskkill runs only after the same exact fallback fence", async () => {
    const killed: number[] = [];
    await stopProxy(PID, fallbackIo({
      platform: "win32",
      taskkill: pid => { killed.push(pid); },
    }));
    expect(killed).toEqual([PID]);

    let currentIdentity = identity();
    await expect(stopProxy(PID, fallbackIo({
      platform: "win32",
      readProcessIdentity: () => currentIdentity,
      gracefulStop: async () => {
        currentIdentity = identity({ argvSha256: "replacement" });
        return false;
      },
      taskkill: pid => { killed.push(pid); },
    }))).rejects.toThrow("identity changed");
    expect(killed).toEqual([PID]);
  });
});
