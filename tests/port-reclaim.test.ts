import { describe, expect, test } from "bun:test";
import { reclaimListenPort } from "../src/server/port-reclaim";
import {
  isBareIpv6Address,
  parseTcpQuadsForLocalPort,
  dropWindowsTcpRowsForLocalPort,
} from "../src/server/windows-tcp-drop";
import { parseListenPidsFromNetstat } from "../src/server/port-reclaim";

describe("parseListenPidsFromNetstat", () => {
  test("extracts Windows LISTENING owners for the local port", () => {
    const output = [
      "  Proto  Local Address          Foreign Address        State           PID",
      "  TCP    127.0.0.1:10100        0.0.0.0:0              LISTENING       18268",
      "  TCP    127.0.0.1:10100        127.0.0.1:60001        CLOSE_WAIT      18268",
      "  TCP    0.0.0.0:54321          0.0.0.0:0              LISTENING       99",
    ].join("\n");
    expect(parseListenPidsFromNetstat(output, 10100)).toEqual([18268]);
  });

  test("extracts unix netstat -anlp listen PIDs", () => {
    const output = [
      "tcp        0      0 127.0.0.1:10100         0.0.0.0:*               LISTEN      4242/bun",
      "tcp        0      0 127.0.0.1:22            0.0.0.0:*               LISTEN      1/sshd",
    ].join("\n");
    expect(parseListenPidsFromNetstat(output, 10100)).toEqual([4242]);
  });
});

describe("parseTcpQuadsForLocalPort / IPv6", () => {
  test("collects every TCP row on the local port including non-LISTEN states", () => {
    const output = [
      "  TCP    127.0.0.1:10100        0.0.0.0:0              LISTENING       18268",
      "  TCP    127.0.0.1:10100        127.0.0.1:60001        CLOSE_WAIT      18268",
      "  TCP    127.0.0.1:10100        127.0.0.1:62066        ESTABLISHED     18268",
      "  TCP    127.0.0.1:62066        127.0.0.1:10100        ESTABLISHED     14492",
    ].join("\n");
    expect(parseTcpQuadsForLocalPort(output, 10100)).toEqual([
      { localAddr: "127.0.0.1", localPort: 10100, remoteAddr: "0.0.0.0", remotePort: 0, state: "LISTENING" },
      { localAddr: "127.0.0.1", localPort: 10100, remoteAddr: "127.0.0.1", remotePort: 60001, state: "CLOSE_WAIT" },
      { localAddr: "127.0.0.1", localPort: 10100, remoteAddr: "127.0.0.1", remotePort: 62066, state: "ESTABLISHED" },
    ]);
  });

  test("keeps IPv6 local rows parseable without coercing them into IPv4 wildcards", () => {
    const output = [
      "  TCP    [::1]:10100            [::]:0                 LISTENING       18268",
      "  TCP    [::]:10100             [::]:0                 LISTENING       18268",
      "  TCP    127.0.0.1:10100        0.0.0.0:0              LISTENING       18268",
    ].join("\n");
    const rows = parseTcpQuadsForLocalPort(output, 10100);
    expect(rows.some(r => r.localAddr === "::1")).toBe(true);
    expect(rows.some(r => r.localAddr === "::")).toBe(true);
    expect(rows.some(r => r.localAddr === "127.0.0.1")).toBe(true);
    expect(isBareIpv6Address("::1")).toBe(true);
    expect(isBareIpv6Address("::")).toBe(true);
    expect(isBareIpv6Address("127.0.0.1")).toBe(false);
    expect(isBareIpv6Address("::ffff:127.0.0.1")).toBe(false);
  });

  test("dropWindowsTcpRowsForLocalPort never claims IPv6 rows as dropped on non-Windows", () => {
    // On non-win32 the function is a no-op; on win32 without matching rows it still
    // reports skippedIpv6 for parsed IPv6 quads when netstat is readable. Assert the
    // return shape never coerces IPv6 into a positive dropped count from IPv4 APIs alone.
    if (process.platform !== "win32") {
      expect(dropWindowsTcpRowsForLocalPort(10100)).toEqual({ dropped: 0, skippedIpv6: 0, accessDenied: 0 });
    }
  });
});

describe("reclaimListenPort", () => {
  test("does not kill any ccx listener by default (healthy proxy / stale pid files)", async () => {
    const killed: number[] = [];
    await expect(reclaimListenPort(10100, "127.0.0.1", {
      timeoutMs: 80,
      intervalMs: 20,
      scanIntervalMs: 20,
      dropTcpRows: false,
      isAvailableFn: async () => false,
      listListenPidsFn: () => [4242],
      isAliveFn: () => true,
      verifyCodexCommanderFn: pid => pid,
      killFn: pid => {
        killed.push(pid);
      },
      sleepMs: async () => {},
    })).resolves.toBe(false);
    expect(killed).toEqual([]);
  });

  test("does not kill when killCodexCommanderHolders is true but allowlist is empty", async () => {
    const killed: number[] = [];
    await expect(reclaimListenPort(10100, "127.0.0.1", {
      timeoutMs: 80,
      intervalMs: 20,
      scanIntervalMs: 20,
      dropTcpRows: false,
      killCodexCommanderHolders: true,
      onlyKillPids: [],
      isAvailableFn: async () => false,
      listListenPidsFn: () => [4242],
      isAliveFn: () => true,
      verifyCodexCommanderFn: pid => pid,
      killFn: pid => {
        killed.push(pid);
      },
      sleepMs: async () => {},
    })).resolves.toBe(false);
    expect(killed).toEqual([]);
  });

  test("concurrent pinned-start shape: second start never kills the first ccx listener", async () => {
    const killed: number[] = [];
    await expect(reclaimListenPort(10100, "127.0.0.1", {
      timeoutMs: 80,
      intervalMs: 20,
      scanIntervalMs: 20,
      dropTcpRows: false,
      killCodexCommanderHolders: false,
      isAvailableFn: async () => false,
      listListenPidsFn: () => [1111],
      isAliveFn: () => true,
      verifyCodexCommanderFn: pid => pid,
      killFn: pid => {
        killed.push(pid);
      },
      sleepMs: async () => {},
    })).resolves.toBe(false);
    expect(killed).toEqual([]);
  });

  test("kills only the allowlisted ccx pid after revalidation", async () => {
    const killed: number[] = [];
    const verified: number[] = [];
    await expect(reclaimListenPort(10100, "127.0.0.1", {
      timeoutMs: 80,
      intervalMs: 20,
      scanIntervalMs: 20,
      dropTcpRows: false,
      killCodexCommanderHolders: true,
      onlyKillPids: [100],
      isAvailableFn: async () => false,
      listListenPidsFn: () => [100, 200],
      isAliveFn: () => true,
      verifyCodexCommanderFn: pid => {
        verified.push(pid);
        return pid;
      },
      killFn: pid => {
        killed.push(pid);
      },
      sleepMs: async () => {},
    })).resolves.toBe(false);
    expect(killed).toEqual([100]);
    expect(verified.filter(pid => pid === 100).length).toBeGreaterThanOrEqual(2);
  });

  test("unknown old PID: update-style reclaim kills no ccx listener", async () => {
    const killed: number[] = [];
    await expect(reclaimListenPort(10100, "127.0.0.1", {
      timeoutMs: 80,
      intervalMs: 20,
      scanIntervalMs: 20,
      dropTcpRows: false,
      killCodexCommanderHolders: false,
      onlyKillPids: [],
      isAvailableFn: async () => false,
      listListenPidsFn: () => [777],
      isAliveFn: () => true,
      verifyCodexCommanderFn: pid => pid,
      killFn: pid => {
        killed.push(pid);
      },
      sleepMs: async () => {},
    })).resolves.toBe(false);
    expect(killed).toEqual([]);
  });

  test("does not kill foreign (non-ccx) listeners and does not drop their TCP rows", async () => {
    const killed: number[] = [];
    const dropped: number[] = [];
    await expect(reclaimListenPort(10100, "127.0.0.1", {
      timeoutMs: 80,
      intervalMs: 20,
      scanIntervalMs: 20,
      dropTcpRows: true,
      killCodexCommanderHolders: true,
      onlyKillPids: [999],
      isAvailableFn: async () => false,
      listListenPidsFn: () => [555],
      isAliveFn: () => true,
      verifyCodexCommanderFn: () => null,
      killFn: pid => {
        killed.push(pid);
      },
      dropTcpFn: port => {
        dropped.push(port);
        return { dropped: 1, skippedIpv6: 0, accessDenied: 0 };
      },
      sleepMs: async () => {},
    })).resolves.toBe(false);
    expect(killed).toEqual([]);
    expect(dropped).toEqual([]);
  });

  test("listener-scan failure does not kill or reset TCP rows", async () => {
    const killed: number[] = [];
    const dropped: number[] = [];
    await expect(reclaimListenPort(10100, "127.0.0.1", {
      timeoutMs: 80,
      intervalMs: 20,
      scanIntervalMs: 20,
      dropTcpRows: true,
      killCodexCommanderHolders: true,
      onlyKillPids: [100],
      isAvailableFn: async () => false,
      listListenPidsFn: () => ({ ok: false, error: "lsof/netstat unavailable" }),
      isAliveFn: () => true,
      verifyCodexCommanderFn: pid => pid,
      killFn: pid => {
        killed.push(pid);
      },
      dropTcpFn: port => {
        dropped.push(port);
        return { dropped: 1, skippedIpv6: 0, accessDenied: 0 };
      },
      sleepMs: async () => {},
    })).resolves.toBe(false);
    expect(killed).toEqual([]);
    expect(dropped).toEqual([]);
  });

  test("ignores dead owner PIDs still listed by the OS", async () => {
    const killed: number[] = [];
    let ticks = 0;
    await expect(reclaimListenPort(10100, "127.0.0.1", {
      timeoutMs: 80,
      intervalMs: 20,
      scanIntervalMs: 20,
      dropTcpRows: false,
      killCodexCommanderHolders: true,
      onlyKillPids: [18268],
      isAvailableFn: async () => {
        ticks += 1;
        return ticks > 2;
      },
      listListenPidsFn: () => [18268],
      isAliveFn: () => false,
      verifyCodexCommanderFn: pid => pid,
      killFn: pid => {
        killed.push(pid);
      },
      sleepMs: async () => {},
    })).resolves.toBe(true);
    expect(killed).toEqual([]);
  });

  test("resets TCP rows only when no live foreign/protected listener remains", async () => {
    let available = false;
    const dropped: number[] = [];
    await expect(reclaimListenPort(10100, "127.0.0.1", {
      timeoutMs: 200,
      intervalMs: 20,
      scanIntervalMs: 20,
      dropTcpRows: true,
      isAvailableFn: async () => available,
      listListenPidsFn: () => [],
      dropTcpFn: port => {
        dropped.push(port);
        available = true;
        return { dropped: 3, skippedIpv6: 1, accessDenied: 0 };
      },
      sleepMs: async () => {},
    })).resolves.toBe(true);
    expect(dropped).toEqual([10100]);
  });

  test("returns true once the port becomes available after allowlisted cleanup", async () => {
    let available = false;
    const killed: number[] = [];
    const pending = reclaimListenPort(10100, "127.0.0.1", {
      timeoutMs: 500,
      intervalMs: 20,
      scanIntervalMs: 20,
      dropTcpRows: false,
      killCodexCommanderHolders: true,
      onlyKillPids: [4242],
      isAvailableFn: async () => available,
      listListenPidsFn: () => (available ? [] : [4242]),
      isAliveFn: () => true,
      verifyCodexCommanderFn: pid => pid,
      killFn: pid => {
        killed.push(pid);
        available = true;
      },
      sleepMs: async () => {},
    });
    await expect(pending).resolves.toBe(true);
    expect(killed).toEqual([4242]);
  });

  test("allowlisted pid with failing ccx revalidation is still killed (trusted teardown PID)", async () => {
    const killed: number[] = [];
    let available = false;
    let checks = 0;
    await expect(reclaimListenPort(10100, "127.0.0.1", {
      timeoutMs: 200,
      intervalMs: 20,
      scanIntervalMs: 20,
      dropTcpRows: false,
      killCodexCommanderHolders: true,
      onlyKillPids: [100],
      isAvailableFn: async () => available,
      listListenPidsFn: () => (available ? [] : [100]),
      isAliveFn: () => !available,
      verifyCodexCommanderFn: pid => {
        checks += 1;
        // First pass (scan identity) succeeds; later scans reclassify as non-ccx.
        // Allowlisted teardown PIDs still take the best-effort kill path.
        return checks === 1 ? pid : null;
      },
      killFn: pid => {
        killed.push(pid);
        available = true;
      },
      sleepMs: async () => {},
    })).resolves.toBe(true);
    expect(killed).toEqual([100]);
  });

  test("allowlisted revalidation failure still permits TCP drop after kill", async () => {
    const killed: number[] = [];
    const dropped: number[] = [];
    let alive = true;
    let available = false;
    let checks = 0;
    await expect(reclaimListenPort(10100, "127.0.0.1", {
      timeoutMs: 200,
      intervalMs: 20,
      scanIntervalMs: 20,
      dropTcpRows: true,
      killCodexCommanderHolders: true,
      onlyKillPids: [100],
      isAvailableFn: async () => available,
      listListenPidsFn: () => (alive ? [100] : []),
      isAliveFn: () => alive,
      verifyCodexCommanderFn: pid => {
        checks += 1;
        return checks === 1 ? pid : null;
      },
      killFn: pid => {
        killed.push(pid);
        alive = false;
      },
      dropTcpFn: port => {
        dropped.push(port);
        available = true;
        return { dropped: 1, skippedIpv6: 0, accessDenied: 0 };
      },
      sleepMs: async () => {},
    })).resolves.toBe(true);
    expect(killed).toEqual([100]);
    expect(dropped).toEqual([10100]);
  });

  test("does not drop TCP rows while allowlisted non-ccx survives kill", async () => {
    const killed: number[] = [];
    const dropped: number[] = [];
    await expect(reclaimListenPort(10100, "127.0.0.1", {
      timeoutMs: 80,
      intervalMs: 20,
      scanIntervalMs: 20,
      dropTcpRows: true,
      killCodexCommanderHolders: true,
      onlyKillPids: [100],
      isAvailableFn: async () => false,
      listListenPidsFn: () => [100],
      isAliveFn: () => true,
      verifyCodexCommanderFn: () => null,
      killFn: pid => {
        killed.push(pid);
      },
      dropTcpFn: port => {
        dropped.push(port);
        return { dropped: 1, skippedIpv6: 0, accessDenied: 0 };
      },
      sleepMs: async () => {},
    })).resolves.toBe(false);
    expect(killed).toEqual([100]);
    expect(dropped).toEqual([]);
  });

  test("does not drop TCP rows when allowlisted kill throws", async () => {
    const dropped: number[] = [];
    await expect(reclaimListenPort(10100, "127.0.0.1", {
      timeoutMs: 80,
      intervalMs: 20,
      scanIntervalMs: 20,
      dropTcpRows: true,
      killCodexCommanderHolders: true,
      onlyKillPids: [100],
      isAvailableFn: async () => false,
      listListenPidsFn: () => [100],
      isAliveFn: () => true,
      verifyCodexCommanderFn: pid => pid,
      killFn: () => {
        throw new Error("kill failed");
      },
      dropTcpFn: port => {
        dropped.push(port);
        return { dropped: 1, skippedIpv6: 0, accessDenied: 0 };
      },
      sleepMs: async () => {},
    })).resolves.toBe(false);
    expect(dropped).toEqual([]);
  });

  test("does not drop TCP rows while allowlisted ccx survives kill", async () => {
    const killed: number[] = [];
    const dropped: number[] = [];
    await expect(reclaimListenPort(10100, "127.0.0.1", {
      timeoutMs: 80,
      intervalMs: 20,
      scanIntervalMs: 20,
      dropTcpRows: true,
      killCodexCommanderHolders: true,
      onlyKillPids: [100],
      isAvailableFn: async () => false,
      listListenPidsFn: () => [100],
      isAliveFn: () => true,
      verifyCodexCommanderFn: pid => pid,
      killFn: pid => {
        killed.push(pid);
      },
      dropTcpFn: port => {
        dropped.push(port);
        return { dropped: 1, skippedIpv6: 0, accessDenied: 0 };
      },
      sleepMs: async () => {},
    })).resolves.toBe(false);
    expect(killed).toEqual([100]);
    expect(dropped).toEqual([]);
  });

  test("drops TCP rows only after allowlisted ccx is confirmed dead", async () => {
    let alive = true;
    let available = false;
    const dropped: number[] = [];
    await expect(reclaimListenPort(10100, "127.0.0.1", {
      timeoutMs: 200,
      intervalMs: 20,
      scanIntervalMs: 20,
      dropTcpRows: true,
      killCodexCommanderHolders: true,
      onlyKillPids: [4242],
      isAvailableFn: async () => available,
      listListenPidsFn: () => (alive ? [4242] : []),
      isAliveFn: () => alive,
      verifyCodexCommanderFn: pid => pid,
      killFn: () => {
        alive = false;
      },
      dropTcpFn: port => {
        dropped.push(port);
        available = true;
        return { dropped: 2, skippedIpv6: 0, accessDenied: 0 };
      },
      sleepMs: async () => {},
    })).resolves.toBe(true);
    expect(dropped).toEqual([10100]);
  });

  test("killAllCodexCommanderOnPort kills ccx listeners absent from the allowlist snapshot", async () => {
    const killed: number[] = [];
    let holder = 9001;
    let available = false;
    await expect(reclaimListenPort(10100, "127.0.0.1", {
      timeoutMs: 200,
      intervalMs: 20,
      scanIntervalMs: 20,
      dropTcpRows: false,
      killCodexCommanderHolders: true,
      killAllCodexCommanderOnPort: true,
      onlyKillPids: [100], // pre-update PID — respawned child is 9001
      isAvailableFn: async () => available,
      listListenPidsFn: () => (holder > 0 ? [holder] : []),
      isAliveFn: pid => pid === holder,
      verifyCodexCommanderFn: pid => pid,
      killFn: pid => {
        killed.push(pid);
        if (pid === holder) holder = 0;
      },
      sleepMs: async () => {
        if (holder === 0) available = true;
      },
    })).resolves.toBe(true);
    expect(killed).toEqual([9001]);
  });

  test("foreign non-ccx claimant survives reclaim without allowlist or ccx identity", async () => {
    const killed: number[] = [];
    const dropped: number[] = [];
    await expect(reclaimListenPort(10100, "127.0.0.1", {
      timeoutMs: 80,
      intervalMs: 20,
      scanIntervalMs: 20,
      dropTcpRows: true,
      killCodexCommanderHolders: true,
      killAllCodexCommanderOnPort: true,
      onlyKillPids: [4242], // trusted old PID — different from the foreign holder
      isAvailableFn: async () => false,
      listListenPidsFn: () => [777],
      isAliveFn: () => true,
      verifyCodexCommanderFn: () => null,
      killFn: pid => {
        killed.push(pid);
      },
      dropTcpFn: port => {
        dropped.push(port);
        return { dropped: 1, skippedIpv6: 0, accessDenied: 0 };
      },
      sleepMs: async () => {},
    })).resolves.toBe(false);
    expect(killed).toEqual([]);
    expect(dropped).toEqual([]);
  });

  test("allowlisted PID that fails ccx verify still gets killed and does not block TCP drop", async () => {
    const killed: number[] = [];
    const dropped: number[] = [];
    let alive = true;
    let available = false;
    await expect(reclaimListenPort(10100, "127.0.0.1", {
      timeoutMs: 200,
      intervalMs: 20,
      scanIntervalMs: 20,
      dropTcpRows: true,
      killCodexCommanderHolders: true,
      onlyKillPids: [14772],
      isAvailableFn: async () => available,
      // Windows often keeps a dead pre-update owner listed; cmdline probe already failed.
      listListenPidsFn: () => (alive ? [14772] : []),
      isAliveFn: () => alive,
      verifyCodexCommanderFn: () => null,
      killFn: pid => {
        killed.push(pid);
        alive = false;
      },
      dropTcpFn: port => {
        dropped.push(port);
        available = true;
        return { dropped: 1, skippedIpv6: 0, accessDenied: 0 };
      },
      sleepMs: async () => {},
    })).resolves.toBe(true);
    expect(killed).toEqual([14772]);
    expect(dropped).toEqual([10100]);
  });

  test("dead ghost then same PID reused is killed again under killAllCodexCommanderOnPort", async () => {
    const killed: number[] = [];
    let phase: "first-live" | "ghost" | "reuse" = "first-live";
    let available = false;
    await expect(reclaimListenPort(10100, "127.0.0.1", {
      timeoutMs: 200,
      intervalMs: 20,
      scanIntervalMs: 20,
      dropTcpRows: false,
      killCodexCommanderHolders: true,
      killAllCodexCommanderOnPort: true,
      onlyKillPids: [],
      isAvailableFn: async () => available,
      listListenPidsFn: () => [4242],
      isAliveFn: () => phase !== "ghost",
      verifyCodexCommanderFn: pid => pid,
      killFn: pid => {
        killed.push(pid);
        if (phase === "first-live") phase = "ghost";
        else if (phase === "reuse") available = true;
      },
      sleepMs: async () => {
        if (phase === "ghost") phase = "reuse";
      },
    })).resolves.toBe(true);
    expect(killed).toEqual([4242, 4242]);
  });
});
