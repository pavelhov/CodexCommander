/**
 * The service-manager probe, and the ownership it feeds.
 *
 * Three ways this could pass while broken, each named by an audit and each
 * answered here rather than by care:
 *   - inspect only the disk definition and miss a stale LOADED one
 *   - report `present` for a definition whose homes could not be parsed
 *   - mutation-test the fixture's argv instead of the argv production emits
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  inspectServiceManagerInstallation,
  type ProbeRunner,
} from "../src/service-manager-probe";
import { inspectNativeCodexOwnership } from "../src/integrations/native/ownership-preflight";

let home = "";
const cleanup: string[] = [];
let previousCodexHome: string | undefined;
let previousCodexCommanderHome: string | undefined;

/** Records exactly what production asked for, so the allowlist is observed. */
function recorder(reply: (file: string, args: readonly string[]) => Partial<ReturnType<ProbeRunner>>) {
  const calls: { file: string; args: readonly string[] }[] = [];
  const run: ProbeRunner = (file, args) => {
    calls.push({ file, args });
    return { status: 0, stdout: "", stderr: "", timedOut: false, spawnFailed: false, ...reply(file, args) };
  };
  return { run, calls };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ccx-probe-"));
  cleanup.push(home);
  previousCodexHome = process.env.CODEX_HOME;
  previousCodexCommanderHome = process.env.CODEXCOMMANDER_HOME;
});
afterEach(() => {
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  if (previousCodexCommanderHome === undefined) delete process.env.CODEXCOMMANDER_HOME;
  else process.env.CODEXCOMMANDER_HOME = previousCodexCommanderHome;
  while (cleanup.length) rmSync(cleanup.pop()!, { recursive: true, force: true });
});

function writePlist(codexHome: string | null, codexCommanderHome: string | null): string {
  const dir = join(home, "Library", "LaunchAgents");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "com.codexcommander.proxy.plist");
  writeFileSync(path, [
    "<plist><dict><key>EnvironmentVariables</key><dict>",
    codexHome ? `<key>CODEX_HOME</key><string>${codexHome}</string>` : "",
    codexCommanderHome ? `<key>CODEXCOMMANDER_HOME</key><string>${codexCommanderHome}</string>` : "",
    "</dict></dict></plist>",
  ].join("\n"));
  return path;
}

function writeUnit(codexHome: string, codexCommanderHome: string): string {
  const dir = join(home, ".config", "systemd", "user");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "codexcommander-proxy.service");
  writeFileSync(path, [
    "[Service]",
    `Environment="CODEX_HOME=${codexHome}"`,
    `Environment="CODEXCOMMANDER_HOME=${codexCommanderHome}"`,
  ].join("\n"));
  return path;
}

describe("the probe only ever asks", () => {
  /**
   * The user's proxy is live under a service manager while this runs. A probe
   * that could start, stop or reload anything is not a probe — and asserting
   * that from the source text is not enough, because this unit has already
   * shipped a fix that was only a comment.
   */
  /** Both domains are independent; every call must only ask. */
  test("macOS asks launchctl only with print, in both domains", () => {
    const { run, calls } = recorder(() => ({ status: 113 }));
    inspectServiceManagerInstallation({ run, platform: "darwin", uid: 501, home });

    expect(calls).toHaveLength(2);
    expect(calls.map(c => c.args[1])).toEqual([
      "gui/501/com.codexcommander.proxy",
      "user/501/com.codexcommander.proxy",
    ]);
    for (const call of calls) {
      expect(call.file).toBe("/bin/launchctl");
      expect(call.args[0]).toBe("print");
      for (const verb of ["load", "unload", "bootstrap", "bootout", "kickstart", "start", "stop", "enable", "disable"]) {
        expect(call.args).not.toContain(verb);
      }
    }
  });

  test("a live job in the user domain is found even though gui answered first", () => {
    const { run } = recorder((_file, args) => (
      String(args[1]).startsWith("user/") ? { status: 0 } : { status: 113 }
    ));
    const result = inspectServiceManagerInstallation({ run, platform: "darwin", uid: 501, home });
    // The plist is absent in this fixture, so a loaded job with no file is the
    // interrupted-uninstall case rather than a clean absence.
    expect(result.kind).toBe("unknown");
  });

  test("Linux asks systemctl once for the canonical unit, with show", () => {
    const { run, calls } = recorder(() => ({
      stdout: "LoadState=not-found\nActiveState=inactive\nFragmentPath=\nNeedDaemonReload=no\n",
    }));
    inspectServiceManagerInstallation({ run, platform: "linux", home });

    expect(calls).toHaveLength(1);
    expect(calls.map(call => call.args[2])).toEqual(["codexcommander-proxy"]);
    for (const call of calls) {
      expect(call.file).toBe("systemctl");
      expect(call.args).toContain("show");
      expect(call.args).toContain("--user");
      for (const verb of ["start", "stop", "restart", "reload", "daemon-reload", "enable", "disable", "kill"]) {
        expect(call.args).not.toContain(verb);
      }
    }
  });

  test("and it asks systemd for the stale-definition signal, not just the load state", () => {
    const { run, calls } = recorder(() => ({
      stdout: "LoadState=not-found\nActiveState=inactive\nFragmentPath=\nNeedDaemonReload=no\n",
    }));
    inspectServiceManagerInstallation({ run, platform: "linux", home });
    // LoadState alone cannot say whether the LOADED bytes match the file.
    expect(calls[0].args).toContain("NeedDaemonReload");
  });
});

describe("absence has to be proven twice", () => {
  test("no registration and no definition is absent", () => {
    const { run } = recorder(() => ({ status: 113 }));
    expect(inspectServiceManagerInstallation({ run, platform: "darwin", uid: 501, home }))
      .toEqual({ kind: "absent" });
  });

  /**
   * The case a registration-only probe gets wrong: a logged-out macOS user has
   * the plist on disk with no GUI domain, so nothing is loaded while a foreign
   * definition sits right there.
   */
  test("no registration but a definition on disk is NOT absent", () => {
    const path = writePlist("/somewhere/.codex", "/somewhere/.codexcommander");
    const { run } = recorder(() => ({ status: 113 }));
    const result = inspectServiceManagerInstallation({ run, platform: "darwin", uid: 501, home });

    expect(result.kind).toBe("present");
    if (result.kind !== "present") return;
    expect(result.claims[0].registration).toBe("absent");
    expect(result.claims[0].definitionPath).toBe(path);
    expect(result.claims[0].homes).toEqual({ codexHome: "/somewhere/.codex", codexCommanderHome: "/somewhere/.codexcommander" });
  });

  test("a registration with no definition file is unknown, not present", () => {
    const { run } = recorder(() => ({ status: 0, stdout: "state = running" }));
    const result = inspectServiceManagerInstallation({ run, platform: "darwin", uid: 501, home });
    expect(result.kind).toBe("unknown");
  });
});

describe("could not ask is not an answer", () => {
  /**
   * Measured against real nonexistent targets: 113 is "no such service", 112 is
   * "no such domain". Only the first is an answer.
   */
  /**
   * 112 with nothing staged on disk is ABSENT, and this test asserted the
   * opposite until a review round showed what that costs: a fresh headless Mac
   * has no GUI domain and no installation either, so treating 112 as "could not
   * ask" refused every Codex write on it.
   *
   * The measurement that settles it (macOS 27.0): 112 is an answer about the
   * DOMAIN and is label-independent — `launchctl print gui/999999` with no
   * service name at all returns it — so an unreachable domain cannot be hiding a
   * job of ours. 113 stays service-scoped within a domain that answered.
   */
  test("exit 112 with no plist is absent — an unreachable domain holds nothing", () => {
    const { run } = recorder(() => ({ status: 112, stderr: "Could not find domain for user" }));
    const result = inspectServiceManagerInstallation({ run, platform: "darwin", uid: 501, home });
    expect(result.kind).toBe("absent");
  });

  test("exit 112 WITH a plist staged is unknown", () => {
    mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(join(home, "Library", "LaunchAgents", "com.codexcommander.proxy.plist"), "<plist/>");
    const { run } = recorder(() => ({ status: 112, stderr: "Could not find domain for user" }));
    const result = inspectServiceManagerInstallation({ run, platform: "darwin", uid: 501, home });
    // Something is staged to load and we could not see whether it did.
    expect(result.kind).not.toBe("absent");
  });

  /**
   * A dangling symlink at the plist path must not read as a clean machine.
   *
   * Worth stating plainly: this test does NOT distinguish `lstat` from
   * `existsSync`, and a mutation check proved it. Either way the probe ends at
   * `unknown` — with `lstat` because the entry exists and cannot be read, with
   * `existsSync` because the later `readFileSync` throws. The refusal is what
   * the caller depends on and the refusal is what is pinned here; which of the
   * two produced it is not observable from outside, so claiming to test it
   * would be claiming more than this proves.
   */
  test("a dangling plist symlink does not read as a clean machine", () => {
    const agents = join(home, "Library", "LaunchAgents");
    mkdirSync(agents, { recursive: true });
    symlinkSync(join(home, "nothing-here.plist"), join(agents, "com.codexcommander.proxy.plist"));
    expect(existsSync(join(agents, "com.codexcommander.proxy.plist"))).toBeFalse();

    const { run } = recorder(() => ({ status: 113 }));
    const result = inspectServiceManagerInstallation({ run, platform: "darwin", uid: 501, home });
    expect(result.kind).toBe("unknown");
  });

  test("a launchctl timeout is unknown", () => {
    const { run } = recorder(() => ({ status: null, timedOut: true }));
    expect(inspectServiceManagerInstallation({ run, platform: "darwin", uid: 501, home }).kind).toBe("unknown");
  });

  /**
   * systemd does NOT signal absence through the exit code — a missing unit
   * prints not-found and exits ZERO. A non-zero status means the question never
   * reached the bus, which is the opposite conclusion.
   */
  test("a non-zero systemctl status is unknown even though a missing unit exits zero", () => {
    const { run } = recorder(() => ({ status: 1, stderr: "Failed to connect to bus" }));
    expect(inspectServiceManagerInstallation({ run, platform: "linux", home }).kind).toBe("unknown");
  });

  test("NeedDaemonReload=yes is unknown — systemd is running something else", () => {
    writeUnit("/x/.codex", "/x/.codexcommander");
    const { run } = recorder(() => ({
      stdout: "LoadState=loaded\nActiveState=active\nFragmentPath=/x/unit\nNeedDaemonReload=yes\n",
    }));
    const result = inspectServiceManagerInstallation({ run, platform: "linux", home });
    expect(result.kind).toBe("unknown");
    expect(result.kind === "unknown" && result.reason).toContain("daemon-reload");
  });

  test("Windows refuses rather than guessing at a chain it does not walk", () => {
    // The task XML names only the launcher; the homes are in the batch wrapper.
    // Parsing the XML and stopping would find no homes and read that as
    // agreement, so until the chain walk exists the honest answer is unknown.
    expect(inspectServiceManagerInstallation({ platform: "win32", home }).kind).toBe("unknown");
  });
});

describe("a definition that cannot supply homes is not present", () => {
  test("an unreadable plist is unknown", () => {
    const dir = join(home, "Library", "LaunchAgents");
    mkdirSync(dir, { recursive: true });
    // A directory where the plist should be: exists, cannot be read as a file.
    mkdirSync(join(dir, "com.codexcommander.proxy.plist"));
    const { run } = recorder(() => ({ status: 113 }));
    expect(inspectServiceManagerInstallation({ run, platform: "darwin", uid: 501, home }).kind).toBe("unknown");
  });

  /**
   * An omitted key is not a disagreement: an install run without CODEX_HOME set
   * writes no such key at all, and `null` has to survive to the caller so the
   * comparison can skip it rather than compare against "".
   */
  test("an omitted home is null, not an empty string", () => {
    writePlist(null, "/somewhere/.codexcommander");
    const { run } = recorder(() => ({ status: 113 }));
    const result = inspectServiceManagerInstallation({ run, platform: "darwin", uid: 501, home });
    expect(result.kind).toBe("present");
    if (result.kind !== "present") return;
    expect(result.claims[0].homes.codexHome).toBeNull();
    expect(result.claims[0].homes.codexCommanderHome).toBe("/somewhere/.codexcommander");
  });
});

describe("ownership refuses what it cannot prove", () => {
  function own(extra: { run: ProbeRunner }) {
    const codexHome = join(home, ".codex");
    const codexCommanderHome = join(home, ".codexcommander");
    return {
      ...extra,
      platform: "darwin" as const,
      uid: 501,
      home,
      statePaths: [join(codexCommanderHome, "service-state.json")],
      currentHomes: { codexHome, codexCommanderHome },
    };
  }

  function useHomes(): { codexHome: string; codexCommanderHome: string } {
    const codexHome = join(home, ".codex");
    const codexCommanderHome = join(home, ".codexcommander");
    mkdirSync(codexHome, { recursive: true });
    mkdirSync(codexCommanderHome, { recursive: true });
    process.env.CODEX_HOME = codexHome;
    process.env.CODEXCOMMANDER_HOME = codexCommanderHome;
    return { codexHome, codexCommanderHome };
  }

  function writeState(dir: string, codexHome: string, codexCommanderHome: string): void {
    const path = join(dir, "service-state.json");
    writeFileSync(path, JSON.stringify({
      version: 3,
      codexHome,
      codexCommanderHome,
      bunPath: process.execPath,
      cliPath: import.meta.path,
      backend: "scheduler",
    }), { mode: 0o600 });
    chmodSync(path, 0o600);
  }

  test("a fresh home with no state and no service is owned", () => {
    useHomes();
    const { run } = recorder(() => ({ status: 113 }));
    expect(inspectNativeCodexOwnership(own({ run })).ownership).toBe("owned");
  });

  test("state naming another home is foreign", () => {
    const { codexCommanderHome } = useHomes();
    writeState(codexCommanderHome, "/elsewhere/.codex", "/elsewhere/.codexcommander");
    const { run } = recorder(() => ({ status: 113 }));
    expect(inspectNativeCodexOwnership(own({ run })).ownership).toBe("foreign");
  });

  /*
   * THE interrupted reinstall. Installation writes the definition BEFORE the
   * state file, so a valid state for this home can sit beside a plist naming
   * another. Picking a winner unattended means guessing which half of a
   * half-finished operation to believe.
   */
  test("state says here, definition says elsewhere — unknown, not owned", () => {
    const { codexHome, codexCommanderHome } = useHomes();
    writeState(codexCommanderHome, codexHome, codexCommanderHome);
    writePlist("/elsewhere/.codex", "/elsewhere/.codexcommander");
    const { run } = recorder(() => ({ status: 113 }));

    const result = inspectNativeCodexOwnership(own({ run }));
    expect(result.ownership).toBe("unknown");
    expect(result.reason).toContain("different homes");
  });

  test("state and definition agreeing is owned", () => {
    const { codexHome, codexCommanderHome } = useHomes();
    writeState(codexCommanderHome, codexHome, codexCommanderHome);
    writePlist(codexHome, codexCommanderHome);
    const { run } = recorder(() => ({ status: 113 }));
    expect(inspectNativeCodexOwnership(own({ run })).ownership).toBe("owned");
  });

  test("an installed definition that no state file accounts for is unknown", () => {
    const { codexHome, codexCommanderHome } = useHomes();
    writePlist(codexHome, codexCommanderHome);
    const { run } = recorder(() => ({ status: 0, stdout: "state = running" }));
    expect(inspectNativeCodexOwnership(own({ run })).ownership).toBe("unknown");
  });

  /*
   * The fail-open helper this replaces returns {ok:true} here, which is right
   * for a teardown route a human just invoked and wrong as authority for an
   * unattended write.
   */
  test("a malformed state file is unknown, where the teardown helper says fine", () => {
    const { codexCommanderHome } = useHomes();
    const path = join(codexCommanderHome, "service-state.json");
    writeFileSync(path, "{ not json", { mode: 0o600 });
    chmodSync(path, 0o600);
    const { run } = recorder(() => ({ status: 113 }));
    const result = inspectNativeCodexOwnership(own({ run }));
    expect(result.ownership).toBe("unknown");
    expect(result.reason).toContain("malformed");
  });

  /**
   * The property is "silence is not absence", and it needs a case that is
   * genuinely silent. Exit 112 no longer qualifies: it is an answer about the
   * domain, and with nothing staged on disk it proves absence — that is what
   * keeps a fresh headless Mac usable. A launchctl that will not run at all is
   * the real unaskable case, and it still refuses.
   */
  test("an unaskable service manager is unknown even with clean state", () => {
    const { codexHome, codexCommanderHome } = useHomes();
    writeState(codexCommanderHome, codexHome, codexCommanderHome);
    const { run } = recorder(() => ({ status: null, spawnFailed: true, stderr: "spawn EACCES" }));
    expect(inspectNativeCodexOwnership(own({ run })).ownership).toBe("unknown");
  });

  /**
   * The counterpart, and the one a refuse-everything design gets wrong: no state
   * file, no plist, and a domain that does not exist is a FRESH MACHINE. It has
   * to be usable.
   */
  test("a fresh headless machine is owned, not refused", () => {
    useHomes();
    const { run } = recorder(() => ({ status: 112, stderr: "Could not find domain for user" }));
    expect(inspectNativeCodexOwnership(own({ run })).ownership).toBe("owned");
  });
});
