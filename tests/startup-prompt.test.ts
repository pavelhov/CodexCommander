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

    const notify = await readText("src/update/notify.ts");
    expect(notify).not.toContain("hasStarPromptRun");
    expect(notify).not.toContain("star-prompt");
  });

  test("service install no longer surfaces a star prompt", async () => {
    const service = await readText("src/service.ts");
    expect(service).not.toContain("maybeShowStarPrompt");
    expect(service).not.toContain("star-prompt");
  });

  test("management sidebar no longer exposes a star API", async () => {
    const routes = await readText("src/server/management/sidebar-routes.ts");
    expect(routes).toContain("/api/update/badge");
    expect(routes).not.toContain("/api/github/star");
    expect(routes).not.toContain("agent_consent_required");
    expect(routes).not.toContain("starRepository");
  });

  test("docs and agent guidance no longer require relaying a star prompt", async () => {
    const agents = await readText("AGENTS.md");
    const readme = await readText("README.md");
    expect(agents).not.toContain("Star lidge-jun/opencodex? Yes / No");
    expect(agents).not.toContain("src/cli/star-prompt.ts");
    expect(readme).not.toContain("Star lidge-jun/opencodex? Yes / No");
    expect(readme).not.toContain("agent_consent_required");
  });

  test("update prompt eligibility no longer waits on a star marker", async () => {
    const notify = await readText("src/update/notify.ts");
    expect(notify).toContain("export function shouldConsider()");
    expect(notify).toContain("interactiveGuardOk()");
    expect(notify).not.toContain("hasStarPromptRun()");
  });

  test("ocx init still offers the Codex autostart shim by default", async () => {
    const init = await readText("src/cli/init.ts");
    expect(init).toContain("Install Codex autostart shim? [Y/n]");
    expect(init).toContain("installCodexShim");
  });
});
