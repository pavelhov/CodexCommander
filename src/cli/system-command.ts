import {
  CliUsageError,
  printData,
  rejectArgs,
  runCliAction,
  runtimeRequest,
  summaryLines,
  takeBooleanOption,
  takeFlag,
  takeOption,
  type RuntimeApiDeps,
} from "./runtime-api";

const USAGE = `Usage:
  ccx system [status] [--json]
  ccx system settings [--auto-start <on|off>] [--stream-mode <auto|safe-tee|eager-relay>] [--json]
  ccx system startup <health|install-service|install-shim> [--json]
  ccx system diagnostics [--json]
  ccx system sync [--json]`;

async function status(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  rejectArgs(args, USAGE);
  const [settings, startup, memory] = await Promise.all([
    runtimeRequest("/api/settings", {}, deps),
    runtimeRequest("/api/startup-health", {}, deps),
    runtimeRequest("/api/system/memory", {}, deps),
  ]);
  const result = { settings, startup, memory };
  printData(result, wantsJson, summaryLines(result));
}

async function settings(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const autoStart = takeBooleanOption(args, "--auto-start");
  const streamMode = takeOption(args, "--stream-mode");
  rejectArgs(args, USAGE);
  if (autoStart === undefined && streamMode === undefined) {
    const result = await runtimeRequest("/api/settings", {}, deps);
    printData(result, wantsJson, summaryLines(result));
    return;
  }
  const body = { ...(autoStart !== undefined ? { codexAutoStart: autoStart } : {}), ...(streamMode !== undefined ? { streamMode } : {}) };
  const result = await runtimeRequest("/api/settings", { method: "PUT", body: JSON.stringify(body) }, deps);
  printData(result, wantsJson, ["System settings updated."]);
}

async function startup(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const action = (args.shift() ?? "health").toLowerCase();
  const wantsJson = takeFlag(args, "--json");
  rejectArgs(args, USAGE);
  if (action === "health" || action === "status") {
    const result = await runtimeRequest("/api/startup-health", {}, deps);
    printData(result, wantsJson, summaryLines(result));
    return;
  }
  if (action !== "install-service" && action !== "install-shim") throw new CliUsageError("startup action must be health, install-service, or install-shim", USAGE);
  const result = await runtimeRequest("/api/startup-action", { method: "POST", body: JSON.stringify({ action }) }, deps);
  printData(result, wantsJson, [String((result as Record<string, unknown>).message ?? `${action} complete.`)]);
}

export async function handleSystemCommand(argv: string[], deps: RuntimeApiDeps = {}): Promise<number> {
  return runCliAction(async () => {
    const [sub = "status", ...rest] = argv;
    if (sub === "status") await status(rest, deps);
    else if (sub === "settings") await settings(rest, deps);
    else if (sub === "startup") await startup(rest, deps);
    else if (sub === "diagnostics") {
      const args = [...rest]; const wantsJson = takeFlag(args, "--json"); rejectArgs(args, USAGE);
      printData(await runtimeRequest("/api/diagnostics/project-config", {}, deps), wantsJson);
    } else if (sub === "sync") {
      const args = [...rest]; const wantsJson = takeFlag(args, "--json"); rejectArgs(args, USAGE);
      printData(await runtimeRequest("/api/sync", { method: "POST" }, deps), wantsJson);
    } else throw new CliUsageError(`unknown system command ${sub}`, USAGE);
  });
}

export const SYSTEM_USAGE = USAGE;
