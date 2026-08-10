import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Windows CI runners spawn Node/Bun child processes slowly ("Slow filesystem detected");
// the package-main import test measured 9.4s there vs bun's 5s default.
setDefaultTimeout(30_000);

const root = new URL("../", import.meta.url);
const repoRoot = fileURLToPath(root);

async function readText(path: string): Promise<string> {
  return await Bun.file(new URL(path, root)).text();
}

describe("package launcher", () => {
  test("npm package main is a Node-safe wrapper while Bun keeps the TypeScript API", async () => {
    const pkg = JSON.parse(await readText("package.json")) as {
      private?: boolean;
      main?: string;
      exports?: { "."?: { bun?: string; default?: string } };
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      scripts?: Record<string, string>;
      files?: string[];
    };

    expect(pkg.private).toBe(true);
    expect(pkg.main).toBe("./bin/package-main.mjs");
    expect(pkg.exports?.["."]?.bun).toBe("./src/index.ts");
    expect(pkg.exports?.["."]?.default).toBe("./bin/package-main.mjs");
    expect(pkg.dependencies?.zod).toBe("4.4.3");
    expect(pkg.devDependencies?.typescript).toBe("5.9.3");
    expect(pkg.devDependencies?.["@types/bun"]).toBe("1.3.14");
    expect(pkg.scripts?.dev).toBe("bun run src/cli/index.ts start");
    expect(pkg.scripts?.["dev:proxy"]).toBe("bun run src/cli/index.ts start");
    expect(pkg.scripts?.["dev:gui"]).toBe("cd gui && bun run dev");
    expect(pkg.scripts?.["prepare:package"]).toBe("bun scripts/prepare-package.ts");
    expect(pkg.scripts?.prepack).toBe("bun run prepare:package");
    expect(pkg.files).toContain("assets/banner.png");
    expect(pkg.files).toContain("assets/architecture.png");
    expect(pkg.files).toContain("assets/codex-app-picker.png");
  });

  test("Node can import the package main without executing the CLI", () => {
    const result = spawnSync("node", [
      "-e",
      "import('./bin/package-main.mjs').then(m => { if (m.cliCommand !== 'ccx' || m.packageName !== 'codexcommander') process.exit(2); })",
    ], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
  });

  test("npmignore keeps GUI development docs out of the package", async () => {
    const npmignore = await readText(".npmignore");
    const guiNpmignore = await readText("gui/.npmignore");
    const guiReadme = await readText("gui/README.md");

    expect(npmignore).toContain("gui/README.md");
    expect(guiNpmignore).toContain("README.md");
    expect(guiReadme).toContain("CodexCommander dashboard");
    expect(guiReadme).toContain("bun run dev:proxy");
    expect(guiReadme).toContain("bun run dev:gui");
    expect(guiReadme).not.toContain("This template provides a minimal setup");
  });

  test("Node launcher has no package-registry self-update boundary", async () => {
    const launcher = await readText("bin/ccx.mjs");

    expect(launcher).not.toContain("npmInvocation");
    expect(launcher).not.toContain("runNpmSelfUpdate");
    expect(launcher).not.toContain('process.argv[2] === "update"');
    expect(launcher).not.toContain('["view",');
    expect(launcher).not.toContain('["install", "-g",');
    expect(launcher).not.toContain("src/update/");
    expect(launcher).not.toContain("codex-history-backup-");
    expect(launcher).not.toContain("resume history");
    expect(launcher.match(/spawnSync\(process\.execPath/g)).toHaveLength(1);
  });

  test("an update argv is forwarded as an unknown CLI command without touching runtime state", () => {
    const home = mkdtempSync(join(tmpdir(), "ccx-no-updater-"));
    const stateDir = join(home, "state");
    const sentinel = join(stateDir, "codexcommander.pid");
    try {
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(sentinel, "do-not-stop\n", { encoding: "utf8", flag: "wx" });
      for (const argv of [["update"], ["update", "--help"]]) {
        const result = spawnSync("node", [fileURLToPath(new URL("bin/ccx.mjs", root)), ...argv], {
          cwd: repoRoot,
          encoding: "utf8",
          timeout: 30_000,
          env: {
            ...process.env,
            HOME: home,
            USERPROFILE: home,
            CODEXCOMMANDER_HOME: stateDir,
            CCX_BUN_PATH: process.execPath,
          },
        });

        expect(result.status).toBe(1);
        expect(result.stderr).toContain("Unknown command: update");
        expect(result.stdout).not.toContain("Updating");
        expect(result.stderr).not.toContain("npm");
        expect(existsSync(sentinel)).toBe(true);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
