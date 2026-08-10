import { describe, expect, test } from "bun:test";

const root = new URL("../", import.meta.url);

async function readText(path: string): Promise<string> {
  return await Bun.file(new URL(path, root)).text();
}

describe("startup prompts without GitHub star prompt", () => {
  test("does not ship a package-manager postinstall lifecycle prompt", async () => {
    const pkg = JSON.parse(await readText("package.json")) as {
      scripts?: Record<string, string>;
      files?: string[];
    };

    expect(pkg.scripts?.postinstall).toBeUndefined();
    expect(pkg.files ?? []).not.toContain("scripts/postinstall.mjs");
  });

  test("the star-prompt module and marker are gone", async () => {
    expect(await Bun.file(new URL("src/cli/star-prompt.ts", root)).exists()).toBe(false);
    expect(await Bun.file(new URL("src/github/star-state.ts", root)).exists()).toBe(false);
    expect(await Bun.file(new URL("src/cli/agent-driven.ts", root)).exists()).toBe(false);
    expect(await Bun.file(new URL("tests/agent-driven.test.ts", root)).exists()).toBe(false);

    const ownership = await readText("src/lib/config-ownership.ts");
    expect(ownership).not.toContain(".star-prompted");

  });

  test("service install no longer surfaces a star prompt", async () => {
    const service = await readText("src/service.ts");
    expect(service).not.toContain("maybeShowStarPrompt");
    expect(service).not.toContain("star-prompt");
  });

  test("management sidebar no longer exposes a star API", async () => {
    const managementApi = await readText("src/server/management-api.ts");
    expect(managementApi).not.toContain("handleSidebarRoutes");
    expect(managementApi).not.toContain("/api/github/star");
    expect(managementApi).not.toContain("agent_consent_required");
    expect(managementApi).not.toContain("starRepository");
  });

  test("docs and agent guidance no longer require relaying a star prompt", async () => {
    const agents = await readText("AGENTS.md");
    const readme = await readText("README.md");
    expect(agents).not.toContain("src/cli/star-prompt.ts");
    expect(readme).not.toContain("agent_consent_required");
  });

  test("startup has no updater prompt, refresh helper, or worker", async () => {
    for (const path of [
      "src/update/index.ts",
      "src/update/job.ts",
      "src/update/notify.ts",
      "src/update/badge.ts",
    ]) {
      expect(await Bun.file(new URL(path, root)).exists()).toBe(false);
    }

    const cli = await readText("src/cli/index.ts");
    const help = await readText("src/cli/help.ts");
    expect(cli).not.toContain("maybeShowUpdatePrompt");
    expect(cli).not.toContain("__refresh-version");
    expect(cli).not.toContain("__gui-update-worker");
    expect(cli).not.toContain('case "update"');
    expect(cli).not.toContain('../update');
    expect(help).not.toContain("ccx update");
    expect(help).not.toContain("latest|preview");
  });

  test("ccx init still offers the Codex autostart shim by default", async () => {
    const init = await readText("src/cli/init.ts");
    expect(init).toContain("Install Codex autostart shim? [Y/n]");
    expect(init).toContain("installCodexShim");
  });
});
