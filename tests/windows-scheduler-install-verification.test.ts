import { afterEach, describe, expect, test } from "bun:test";
import {
  buildWindowsTaskXml,
  decodeSchtasksOutput,
  diagnoseService,
  evaluateWindowsSchedulerInstallVerification,
  formatWindowsSchedulerServiceStatus,
  inspectWindowsSchedulerServiceStatus,
  probeWindowsSchedulerTask,
  schedulerVerificationMaySettle,
  setQuerySchtasksForTests,
  stopServiceIfInstalled,
  stopWindows,
  windowsSchedulerCsvIncludesTask,
  windowsSchedulerTaskInstalled,
  windowsTaskRegistrationHealthy,
} from "../src/service";

afterEach(() => {
  setQuerySchtasksForTests(null);
});

describe("decodeSchtasksOutput", () => {
  test("decodes UTF-16LE BOM XML that would fail as UTF-8", () => {
    // Pin <Command> the way the sibling describe block below does: buildWindowsTaskXml()
    // resolves it through windowsWscript(), which falls back to a bare "wscript.exe" off
    // Windows because the System32 path does not exist. Without this the fixture only
    // matches on a Windows host and the decoder assertion fails everywhere else.
    const wscript = "C:\\WINDOWS\\System32\\wscript.exe";
    const xml = buildWindowsTaskXml(
      "C:\\Users\\x\\.codexcommander\\codexcommander-service.cmd",
      "C:\\Users\\x\\.codexcommander\\codexcommander-service-launcher.vbs",
    ).replace(/<Command>.*?<\/Command>/, `<Command>${wscript}</Command>`);
    const utf16 = Buffer.from(`\uFEFF${xml}`, "utf16le");
    const decoded = decodeSchtasksOutput(utf16);
    expect(decoded.startsWith("<?xml")).toBe(true);
    expect(windowsTaskRegistrationHealthy(
      decoded,
      wscript,
      "C:\\Users\\x\\.codexcommander\\codexcommander-service-launcher.vbs",
    )).toBe(true);
    // Sanity: the historical utf8 mis-decode is unhealthy.
    expect(windowsTaskRegistrationHealthy(utf16.toString("utf8"))).toBe(false);
  });

  test("keeps plain UTF-8 schtasks text listings intact", () => {
    const text = "Folder: \\\nTaskName: codexcommander-proxy";
    expect(decodeSchtasksOutput(Buffer.from(text, "utf8"))).toBe(text);
  });
});

describe("windowsSchedulerCsvIncludesTask", () => {
  test("matches quoted Task Scheduler CSV task names", () => {
    const csv = [
      `"TaskName","Next Run Time","Status"`,
      `"\\codexcommander-proxy","N/A","Ready"`,
      `"\\Other Task","N/A","Ready"`,
    ].join("\n");
    expect(windowsSchedulerCsvIncludesTask(csv, "codexcommander-proxy")).toBe(true);
    expect(windowsSchedulerCsvIncludesTask(csv, "missing-task")).toBe(false);
    expect(windowsSchedulerCsvIncludesTask(csv, "codexcommander")).toBe(false);
  });
});

describe("probeWindowsSchedulerTask", () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
    setQuerySchtasksForTests(null);
  });

  test("returns present when the specific /tn query includes the task", () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    setQuerySchtasksForTests((args) => {
      if (args[0] === "/query" && args[1] === "/tn") return "Folder: \\\nTaskName: codexcommander-proxy";
      throw new Error("unexpected query");
    });
    expect(probeWindowsSchedulerTask("codexcommander-proxy")).toEqual({ status: "present" });
    expect(windowsSchedulerTaskInstalled("codexcommander-proxy")).toBe(true);
  });

  test("recognizes the task without exposing mojibake from localized table output", () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    const localizedTable = [
      "����: \\",
      "�۾� �̸�                                ���� ���� �ð�         ����",
      "======================================== ====================== ===============",
      "codexcommander-proxy                          N/A                    �غ�",
    ].join("\n");
    setQuerySchtasksForTests(() => localizedTable);

    const result = formatWindowsSchedulerServiceStatus(
      probeWindowsSchedulerTask("codexcommander-proxy"),
      { status: "running", port: 10100 },
    );

    expect(result).toBe("✅ service installed (Task Scheduler); CodexCommander proxy running on port 10100.");
    expect(result).not.toContain("����");
    expect(result).not.toContain("�۾�");
  });

  test("falls back to CSV listing when the specific query fails", () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    setQuerySchtasksForTests((args) => {
      if (args.includes("/tn")) throw new Error("Access is denied.");
      if (args.includes("CSV")) {
        return `"TaskName"\n"\\codexcommander-proxy"\n`;
      }
      throw new Error("unexpected query");
    });
    expect(probeWindowsSchedulerTask("codexcommander-proxy")).toEqual({ status: "present" });
  });

  test("returns absent when specific query fails and CSV succeeds without the task", () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    setQuerySchtasksForTests((args) => {
      if (args.includes("/tn")) throw new Error("ERROR: The system cannot find the file specified.");
      if (args.includes("CSV")) return `"TaskName"\n"\\other-task"\n`;
      throw new Error("unexpected query");
    });
    expect(probeWindowsSchedulerTask("codexcommander-proxy")).toEqual({ status: "absent" });
    expect(windowsSchedulerTaskInstalled("codexcommander-proxy")).toBe(false);
  });

  test("returns unknown with both details when specific query and CSV listing fail", () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    setQuerySchtasksForTests((args) => {
      if (args.includes("/tn")) throw new Error("Access is denied.");
      if (args.includes("CSV")) throw new Error("RPC server is unavailable.");
      throw new Error("unexpected query");
    });
    const probe = probeWindowsSchedulerTask("codexcommander-proxy");
    expect(probe.status).toBe("unknown");
    if (probe.status !== "unknown") throw new Error("expected unknown");
    expect(probe.detail).toContain("Access is denied.");
    expect(probe.detail).toContain("RPC server is unavailable.");
    expect(windowsSchedulerTaskInstalled("codexcommander-proxy")).toBe(false);
  });
});

describe("Windows scheduler stop admission", () => {
  const originalPlatform = process.platform;
  const originalCodexCommanderHome = process.env.CODEXCOMMANDER_HOME;
  const originalCodexHome = process.env.CODEX_HOME;

  afterEach(() => {
    Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
    if (originalCodexCommanderHome === undefined) delete process.env.CODEXCOMMANDER_HOME;
    else process.env.CODEXCOMMANDER_HOME = originalCodexCommanderHome;
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
    setQuerySchtasksForTests(null);
  });

  function useIsolatedWindowsHomes(): void {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    process.env.CODEXCOMMANDER_HOME = `${import.meta.dir}/.tmp-windows-scheduler-stop`;
    process.env.CODEX_HOME = `${import.meta.dir}/.tmp-windows-scheduler-codex`;
  }

  test("an unknown scheduler query blocks service stop before any task end", () => {
    useIsolatedWindowsHomes();
    let endCalls = 0;
    setQuerySchtasksForTests((args) => {
      if (args[0] === "/end") {
        endCalls += 1;
        return "";
      }
      if (args.includes("/tn")) throw new Error("Access is denied.");
      if (args.includes("CSV")) throw new Error("RPC server is unavailable.");
      throw new Error("unexpected scheduler command");
    });

    expect(() => stopServiceIfInstalled()).toThrow(/presence could not be verified/i);
    expect(endCalls).toBe(0);
  });

  test("a non-benign task end failure is propagated", () => {
    useIsolatedWindowsHomes();
    const xml = buildWindowsTaskXml();
    let endCalls = 0;
    setQuerySchtasksForTests((args) => {
      if (args[0] === "/end") {
        endCalls += 1;
        throw new Error("Access is denied.");
      }
      if (args.includes("/xml")) return xml;
      if (args[0] === "/query" && args.includes("/tn")) {
        return "TaskName: codexcommander-proxy";
      }
      throw new Error("unexpected scheduler command");
    });

    expect(() => stopWindows()).toThrow();
    expect(endCalls).toBe(1);
  });

  test("only an already-stopped task end failure is benign", () => {
    useIsolatedWindowsHomes();
    const xml = buildWindowsTaskXml();
    let endCalls = 0;
    setQuerySchtasksForTests((args) => {
      if (args[0] === "/end") {
        endCalls += 1;
        throw new Error("ERROR: No running instance of the task.");
      }
      if (args.includes("/xml")) return xml;
      if (args[0] === "/query" && args.includes("/tn")) {
        return "TaskName: codexcommander-proxy";
      }
      throw new Error("unexpected scheduler command");
    });

    expect(() => stopWindows()).not.toThrow();
    expect(endCalls).toBe(1);
  });

  test("an unreadable scheduler XML remains installed with indeterminate runtime truth", () => {
    useIsolatedWindowsHomes();
    setQuerySchtasksForTests((args) => {
      if (args.includes("/xml")) throw new Error("Access is denied.");
      if (args[0] === "/query" && args.includes("/tn")) {
        return "TaskName: codexcommander-proxy";
      }
      throw new Error("unexpected scheduler command");
    });

    expect(diagnoseService()).toMatchObject({
      registrationState: "present",
      supervisorState: "indeterminate",
      installed: true,
      running: false,
      viable: false,
      startable: false,
    });
  });
});

describe("formatWindowsSchedulerServiceStatus", () => {
  test("reports task and identity-checked proxy state independently", () => {
    expect(formatWindowsSchedulerServiceStatus({ status: "present" }, { status: "not-running" }))
      .toBe("⚠️  service installed (Task Scheduler); CodexCommander proxy not running.");
    expect(formatWindowsSchedulerServiceStatus({ status: "present" }, { status: "unknown" }))
      .toBe("⚠️  service installed (Task Scheduler); CodexCommander proxy status unknown.");
    expect(formatWindowsSchedulerServiceStatus({ status: "absent" }, { status: "running", port: 3593 }))
      .toBe("❌ service not installed (Task Scheduler); CodexCommander proxy is running independently on port 3593.");
    expect(formatWindowsSchedulerServiceStatus({ status: "absent" }, { status: "not-running" }))
      .toBe("❌ service not installed (Task Scheduler).");
    expect(formatWindowsSchedulerServiceStatus({ status: "unknown", detail: "����" }, { status: "running", port: 10100 }))
      .toBe("⚠️  Task Scheduler registration unknown; CodexCommander proxy running on port 10100.");
    expect(formatWindowsSchedulerServiceStatus({ status: "unknown", detail: "����" }, { status: "not-running" }))
      .toBe("⚠️  service status unknown (Task Scheduler query failed); CodexCommander proxy not running.");
  });

  test("keeps scheduler and runtime probe failures locale-independent", async () => {
    const status = await inspectWindowsSchedulerServiceStatus({
      probeTask: () => { throw new Error("���� ����"); },
      findProxy: async () => { throw new Error("connection failure"); },
    });

    expect(status).toBe("⚠️  service status unknown (Task Scheduler and proxy checks failed).");
    expect(status).not.toContain("����");
    expect(status).not.toContain("connection failure");
  });
});

describe("evaluateWindowsSchedulerInstallVerification", () => {
  const wscript = "C:\\Windows\\System32\\wscript.exe";
  const launcher = "C:\\Users\\Test\\.codexcommander\\codexcommander-service-launcher.vbs";
  const healthyXml = buildWindowsTaskXml("ignored.cmd", launcher)
    .replace(/<Command>.*?<\/Command>/, `<Command>${wscript}</Command>`);

  test("succeeds when task, registration, assets, and absent WinSW all hold", () => {
    expect(windowsTaskRegistrationHealthy(healthyXml, wscript, launcher)).toBe(true);
    const result = evaluateWindowsSchedulerInstallVerification({
      taskInstalled: true,
      xml: healthyXml,
      assetsExist: true,
      nativeStatus: "nonexistent",
      wscript,
      launcher,
    });
    expect(result).toMatchObject({
      ok: true,
      conflict: false,
      nativeServiceAbsent: true,
      registrationHealthy: true,
      assetsHealthy: true,
      detail: "ok",
    });
  });

  test("fails with conflict when WinSW remains installed", () => {
    const result = evaluateWindowsSchedulerInstallVerification({
      taskInstalled: true,
      xml: healthyXml,
      assetsExist: true,
      nativeStatus: "stopped",
      wscript,
      launcher,
    });
    expect(result.ok).toBe(false);
    expect(result.conflict).toBe(true);
    expect(result.nativeServiceAbsent).toBe(false);
    expect(result.detail).toContain("CONFLICT");
  });

  test("fails when both scheduler and WinSW report present", () => {
    const result = evaluateWindowsSchedulerInstallVerification({
      taskInstalled: true,
      xml: healthyXml,
      assetsExist: true,
      nativeStatus: "started",
      wscript,
      launcher,
    });
    expect(result.ok).toBe(false);
    expect(result.conflict).toBe(true);
  });

  test("treats unknown WinSW status as unverified, not as a conflict", () => {
    const result = evaluateWindowsSchedulerInstallVerification({
      taskInstalled: true,
      xml: healthyXml,
      assetsExist: true,
      nativeStatus: "unknown",
      wscript,
      launcher,
    });
    expect(result.ok).toBe(false);
    expect(result.conflict).toBe(false);
    expect(result.nativeStatusUnknown).toBe(true);
    expect(result.nativeServiceAbsent).toBe(false);
    expect(result.detail).toContain("could not verify");
    expect(result.detail).not.toContain("CONFLICT");
  });

  test("fails when registration health is invalid", () => {
    const badXml = healthyXml.replace("<LogonTrigger>", "<BootTrigger>");
    const result = evaluateWindowsSchedulerInstallVerification({
      taskInstalled: true,
      xml: badXml,
      assetsExist: true,
      nativeStatus: "nonexistent",
      wscript,
      launcher,
    });
    expect(result.ok).toBe(false);
    expect(result.registrationHealthy).toBe(false);
    expect(result.detail).toContain("unhealthy");
  });

  test("a published-but-invalid registration never enters the settle loop", () => {
    const badXml = healthyXml.replace("<LogonTrigger>", "<BootTrigger>");
    const invalid = evaluateWindowsSchedulerInstallVerification({
      taskInstalled: true,
      xml: badXml,
      assetsExist: true,
      nativeStatus: "nonexistent",
      wscript,
      launcher,
    });
    expect(invalid.registrationHealthy).toBe(false);
    expect(invalid.registrationInvalid).toBe(true);
    // Permanent: rollback must fire immediately, with zero settle delays.
    expect(schedulerVerificationMaySettle(invalid)).toBe(false);

    // An empty/unreadable view is publication lag: still transient.
    const pending = evaluateWindowsSchedulerInstallVerification({
      taskInstalled: false,
      xml: "",
      assetsExist: true,
      nativeStatus: "nonexistent",
      wscript,
      launcher,
    });
    expect(pending.registrationInvalid).toBe(false);
    expect(schedulerVerificationMaySettle(pending)).toBe(true);

    // A <Data> block is an explicit permanent violation too.
    const dataXml = healthyXml.replace("<Triggers>", "<Data>x</Data><Triggers>");
    const withData = evaluateWindowsSchedulerInstallVerification({
      taskInstalled: true,
      xml: dataXml,
      assetsExist: true,
      nativeStatus: "nonexistent",
      wscript,
      launcher,
    });
    expect(withData.registrationInvalid).toBe(true);
    expect(schedulerVerificationMaySettle(withData)).toBe(false);
  });

  test("fails when required assets are missing", () => {
    const result = evaluateWindowsSchedulerInstallVerification({
      taskInstalled: true,
      xml: healthyXml,
      assetsExist: false,
      nativeStatus: "nonexistent",
      wscript,
      launcher,
    });
    expect(result.ok).toBe(false);
    expect(result.assetsHealthy).toBe(false);
    expect(result.detail).toContain("assets are missing");
  });

  test("fails when scheduler task is absent", () => {
    const result = evaluateWindowsSchedulerInstallVerification({
      taskInstalled: false,
      xml: "",
      assetsExist: true,
      nativeStatus: "nonexistent",
      wscript,
      launcher,
    });
    expect(result.ok).toBe(false);
    expect(result.taskInstalled).toBe(false);
    expect(result.detail).toContain("not installed");
  });
});
