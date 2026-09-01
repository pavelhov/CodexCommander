import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface OwnedServiceHome {
  /**
   * Add this to child-process `env` so Linux never reaches the host bus.
   * In-process `PATH` mutation is not enough: Bun's `execSync` keeps the
   * original lookup path, which is why these stubs are spawn-env only.
   */
  readonly env: Record<string, string>;
}

function linuxSystemctlStubEnv(home: string, lines: readonly string[]): Record<string, string> {
  const binDir = join(home, ".ccx-test-bin");
  mkdirSync(binDir, { recursive: true, mode: 0o700 });
  const systemctl = join(binDir, "systemctl");
  writeFileSync(systemctl, ["#!/bin/sh", ...lines].join("\n"));
  chmodSync(systemctl, 0o700);
  return { PATH: [binDir, process.env.PATH ?? ""].filter(Boolean).join(delimiter) };
}

/**
 * Linux CI (and container runners) have `systemctl` on PATH but no user bus.
 * The production probe correctly treats that as unproven ownership, and
 * `diagnoseService` treats a failed query as an installed service that needs
 * repair — which then blocks unmanaged `ensure`/`start`.
 *
 * Tests that need a fresh machine (no unit) put this on PATH so
 * `systemctl --user show` answers not-found without touching the host bus.
 */
export function claimAbsentLinuxServiceBus(home: string): OwnedServiceHome {
  if (process.platform !== "linux") return { env: {} };
  return {
    env: linuxSystemctlStubEnv(home, [
      'if [ "$1" = "--version" ]; then echo "systemd 255"; exit 0; fi',
      'if [ "$1" = "--user" ] && [ "$2" = "show-environment" ]; then exit 0; fi',
      'if [ "$1" = "--user" ] && [ "$2" = "show" ]; then',
      "  printf '%s\\n' 'LoadState=not-found' 'ActiveState=inactive' 'UnitFileState=' 'FragmentPath=' 'NeedDaemonReload=no'",
      "  exit 0",
      "fi",
      "exit 64",
    ]),
  };
}

/**
 * Seed the same state and service-manager definition that an installed proxy
 * records, scoped entirely to a test home.
 *
 * Linux CI has no user systemd bus. The production probe correctly treats that
 * as unproven ownership, so the fixture supplies a read-only `systemctl show`
 * response on its own PATH together with the unit that response describes.
 */
export function claimOwnedServiceHome(
  codexHome: string,
  codexCommanderHome: string,
  home: string,
): OwnedServiceHome {
  writeFileSync(join(codexCommanderHome, "service-state.json"), JSON.stringify({
    version: 3,
    codexHome,
    codexCommanderHome: codexCommanderHome,
    bunPath: process.execPath,
    cliPath: fileURLToPath(new URL("../../src/cli/index.ts", import.meta.url)),
    backend: "scheduler",
  }), { mode: 0o600 });

  if (process.platform === "darwin") {
    const launchAgents = join(home, "Library", "LaunchAgents");
    mkdirSync(launchAgents, { recursive: true, mode: 0o700 });
    writeFileSync(join(launchAgents, "com.codexcommander.proxy.plist"), [
      "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
      "<plist version=\"1.0\"><dict><key>EnvironmentVariables</key><dict>",
      `<key>CODEX_HOME</key><string>${codexHome}</string>`,
      `<key>CODEXCOMMANDER_HOME</key><string>${codexCommanderHome}</string>`,
      "</dict></dict></plist>",
    ].join("\n"));
  }

  if (process.platform !== "linux") return { env: {} };

  const unitDir = join(home, ".config", "systemd", "user");
  mkdirSync(unitDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(unitDir, "codexcommander-proxy.service"), [
    "[Service]",
    `Environment=\"CODEX_HOME=${codexHome}\"`,
    `Environment=\"CODEXCOMMANDER_HOME=${codexCommanderHome}\"`,
  ].join("\n"));

  return {
    env: linuxSystemctlStubEnv(home, [
      'if [ "$1" != "--user" ] || [ "$2" != "show" ] || [ "$3" != "codexcommander-proxy" ]; then exit 64; fi',
      "printf '%s\\n' 'LoadState=loaded' 'ActiveState=inactive' 'FragmentPath=fixture' 'NeedDaemonReload=no'",
    ]),
  };
}
