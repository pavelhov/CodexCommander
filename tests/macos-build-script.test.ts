import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// The macOS build script deletes whatever sits at its destination, so its containment
// check is a safety boundary rather than a convenience. These run the real script.
//
// Every case here shipped as a defect at some point:
//   - the original check compared two values derived from the same variable, so any
//     OUTPUT_DIR passed;
//   - resolving logical paths let a repository-local symlink point outside;
//   - re-appending an unresolved tail let `.nope/../../outside` escape entirely;
//   - resolving physically BEFORE normalising let `..` reveal a symlink that was then
//     never followed.

const repoRoot = resolve(import.meta.dir, "..");
const script = join(repoRoot, "scripts", "build-macos-app.sh");
const scriptSource = readFileSync(script, "utf8");
const releaseScriptSource = readFileSync(join(repoRoot, "scripts", "package-macos-release.sh"), "utf8");
const isMacOS = process.platform === "darwin";

describe("macOS build script bundle contract", () => {
  test("stages the exact canonical app and launcher names", () => {
    expect(scriptSource).toContain('app_bundle="$output_root/CodexCommander.app"');
    expect(scriptSource).toContain('staged_app="$staging_root/CodexCommander.app"');
    expect(scriptSource).toContain('! -f "$runtime_root/bin/ccx.mjs"');
    expect(scriptSource).toContain('source_revision="${CCX_BUILD_REVISION:-}"');
    expect(scriptSource).toContain("git ls-files -z --");
    expect(scriptSource).toContain("assert_tracked_tree \"src\"");
    expect(scriptSource).toContain("assert_tracked_tree \"bin\"");
    expect(scriptSource).toContain("stage_tracked_tree \"src\"");
    expect(scriptSource).toContain("stage_tracked_tree \"bin\"");
    expect(scriptSource).toContain("bun run build");
    expect(scriptSource).toContain("privacy-scan.ts");
    expect(scriptSource).toContain("--check-symlinks");
    expect(scriptSource).not.toContain('copy_verified_tree "$repo_root/src"');
    expect(scriptSource).not.toContain('copy_verified_tree "$repo_root/bin"');
    expect(scriptSource).toContain('copy_verified_tree "$repo_root/gui/dist" "$runtime_root/gui/dist"');
    expect(scriptSource).toContain('find -P "$path" -print0');
    expect(releaseScriptSource).toContain("status --porcelain");
    expect(releaseScriptSource).toContain("package:macos requires a clean git working tree");
  });

  test("requires the canonical delegation skill in staged and archived runtimes", () => {
    expect(scriptSource).toContain(
      'assert_safe_file "$runtime_root/src/skills/codexcommander-delegation/SKILL.md"',
    );
    expect(releaseScriptSource).toContain(
      '"$runtime_root/src/skills/codexcommander-delegation/SKILL.md"',
    );
    expect(releaseScriptSource).toContain(
      "'CodexCommander.app/Contents/Resources/runtime/src/skills/codexcommander-delegation/SKILL.md'",
    );
  });
});

async function runScript(outputDir: string, cwd: string = repoRoot) {
  const proc = Bun.spawn(["bash", script], {
    cwd,
    env: { ...process.env, OUTPUT_DIR: outputDir },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stderr, exitCode };
}

/// Runs `body` with a uniquely named sandbox that this test owns and always removes.
///
/// An earlier version deleted FIXED paths such as `<repo-parent>/ccx-escaped-probe`,
/// which would have destroyed unrelated data if anything already lived there. A test
/// for a safety boundary must not itself be destructive.
async function withSandbox<T>(body: (sandbox: string) => Promise<T>): Promise<T> {
  const sandbox = mkdtempSync(join(tmpdir(), "ccx-containment-"));
  try {
    return await body(sandbox);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

describe.skipIf(!isMacOS)("macOS build script containment", () => {
  test("fails closed on a tracked source path that became a symlink", async () => {
    await withSandbox(async sandbox => {
      const tracked = join(repoRoot, "src", "identity.ts");
      const original = readFileSync(tracked);
      const external = join(sandbox, "external.txt");
      writeFileSync(external, "external content must not be copied or chmodded");
      chmodSync(external, 0o600);
      rmSync(tracked);
      symlinkSync(external, tracked);
      try {
        const { stderr, exitCode } = await runScript(join(sandbox, "output"));
        expect(exitCode).not.toBe(0);
        expect(stderr).toContain("Refusing unsafe packaging source");
        expect(stderr).toContain("symbolic link");
        expect(readFileSync(external, "utf8")).toBe("external content must not be copied or chmodded");
      } finally {
        rmSync(tracked, { force: true });
        writeFileSync(tracked, original);
      }
    });
  }, 120_000);

  test("rejects a multiply-linked tracked source file without modifying the external inode", async () => {
    await withSandbox(async sandbox => {
      const tracked = join(repoRoot, "src", "identity.ts");
      const original = readFileSync(tracked, "utf8");
      const extraLink = join(sandbox, "identity-hardlink.ts");
      linkSync(tracked, extraLink);
      try {
        const result = await runScript(join(sandbox, "hardlink-output"));
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("multiply linked");
        expect(readFileSync(tracked, "utf8")).toBe(original);
        expect(readFileSync(extraLink, "utf8")).toBe(original);
      } finally {
        rmSync(extraLink, { force: true });
      }
    });
  }, 120_000);

  test("refuses a destination outside the repository and creates nothing", async () => {
    // Deliberately NOT derived from process.env.HOME: other suites replace HOME with a
    // temp directory, and temp is a permitted root — so this test built successfully and
    // failed during a full-suite run. A sibling of the repository is stable and is
    // outside every permitted root.
    const target = resolve(repoRoot, "..", `.ccx-outside-${process.pid}-${Date.now()}`);

    const { stderr, exitCode } = await runScript(target);

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Refusing to build");
    expect(existsSync(target)).toBe(false);
  }, 120_000);

  test("refuses an unresolved .. traversal before creating any directory", async () => {
    const intermediate = join(repoRoot, `.ccx-traversal-${process.pid}`);
    const escapedName = `.ccx-escaped-${process.pid}-${Date.now()}`;
    const escaped = resolve(repoRoot, "..", escapedName);

    // String concatenation, NOT path.join: join() normalises `..` itself, so the script
    // would never receive the traversal that was the actual bypass. Written with join()
    // this test passed against the broken resolver.
    const traversal = `${intermediate}/../../${escapedName}`;

    const { stderr, exitCode } = await runScript(traversal);

    expect(exitCode).not.toBe(0);
    // The message names the RESOLVED path, which is the proof normalisation happened.
    expect(stderr).toContain(escapedName);
    expect(stderr).toContain("Refusing to build into");
    expect(existsSync(escaped)).toBe(false);
    expect(existsSync(intermediate)).toBe(false);
  }, 120_000);

  test("follows a symlink revealed by a .. traversal instead of trusting the link path", async () => {
    const link = join(repoRoot, `.ccx-link-${process.pid}`);
    const missing = join(repoRoot, `.ccx-missing-${process.pid}`);

    const { stderr, exitCode } = await withSandbox(async (sandbox) => {
      const outside = join(sandbox, "outside-target");
      rmSync(link, { recursive: true, force: true });
      symlinkSync(outside, link);
      try {
        // Nothing exists at the missing component, so `..` has to be applied lexically
        // before the symlink can be resolved.
        return await runScript(`${missing}/../${link.split("/").pop()}`);
      } finally {
        rmSync(link, { recursive: true, force: true });
        rmSync(missing, { recursive: true, force: true });
      }
    });

    // The link points at a directory that does not exist, so the script refuses to
    // build THROUGH it rather than guessing where it leads. What must never happen is
    // treating the unresolved link path as a destination inside the repository.
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Refusing to build");
    expect(stderr).not.toContain(`${missing}/`);
    expect(existsSync(link)).toBe(false);
    expect(existsSync(missing)).toBe(false);
  }, 300_000);

  test("refuses a symlink that points outside the permitted roots", async () => {
    const link = join(repoRoot, `.ccx-outward-${process.pid}`);
    const outside = join(
      process.env.HOME ?? "/Users/shared",
      `.ccx-symtarget-${process.pid}-${Date.now()}`,
    );

    rmSync(link, { recursive: true, force: true });
    symlinkSync(outside, link);
    try {
      const { stderr, exitCode } = await runScript(link);

      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("Refusing to build");
      expect(existsSync(outside)).toBe(false);
    } finally {
      rmSync(link, { recursive: true, force: true });
    }
  }, 120_000);

  // The third bypass: a RELATIVE dangling target was joined onto the resolved prefix
  // without normalising, so `link -> ../../outside` became `<repo>/../../outside`,
  // satisfied the `<repo>/*` prefix check, and escaped during mkdir -p.
  test("refuses a symlink whose relative target escapes the repository", async () => {
    const link = join(repoRoot, `.ccx-rel-${process.pid}`);
    const escaped = resolve(repoRoot, "..", "..", `ccx-rel-target-${process.pid}`);

    rmSync(link, { recursive: true, force: true });
    symlinkSync(`../../ccx-rel-target-${process.pid}`, link);
    try {
      const { stderr, exitCode } = await runScript(link);

      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("Refusing to build");
      expect(existsSync(escaped)).toBe(false);
    } finally {
      rmSync(link, { recursive: true, force: true });
    }
  }, 120_000);

  // Runs the child in a directory that CONTAINS a matching entry, so the old unquoted
  // loop would have expanded the star. With cwd=repoRoot and the glob under dist/, the
  // pattern matched nothing and the test passed against the broken implementation too.
  test("treats glob characters as literal path components", async () => {
    await withSandbox(async (sandbox) => {
      const decoy = join(sandbox, "ccx-glob-decoy-probe");
      mkdirSync(decoy, { recursive: true });

      const { stderr } = await runScript(join(sandbox, "ccx-glob-*-probe"), sandbox);

      expect(stderr).not.toContain("Refusing to build");
      // The literal-star path is the one that was used, not the decoy it could match.
      expect(existsSync(join(sandbox, "ccx-glob-*-probe"))).toBe(true);
      expect(existsSync(join(decoy, "CodexCommander.app"))).toBe(false);
    });
  }, 300_000);

  test("allows a destination inside the repository", async () => {
    const inside = join(repoRoot, "dist", `ccx-inside-${process.pid}`);
    const probeCwd = mkdtempSync(join(tmpdir(), "ccx-bundled-probe-"));
    const untrackedName = `.ccx-untracked-secret-${process.pid}.ts`;
    const untracked = join(repoRoot, "src", untrackedName);
    writeFileSync(untracked, "export const shouldNotShip = true;\n");
    try {
      const { stderr, exitCode } = await runScript(inside);
      expect(exitCode).toBe(0);
      expect(stderr).not.toContain("Refusing to build into");
      const resources = join(inside, "CodexCommander.app", "Contents", "Resources");
      const runtime = join(resources, "runtime");
      expect(existsSync(join(resources, "CodexCommander.png"))).toBe(true);
      expect(existsSync(join(resources, "LICENSE.txt"))).toBe(true);
      expect(existsSync(join(resources, "THIRD_PARTY_NOTICES.md"))).toBe(true);
      expect(existsSync(join(resources, "provider-icons", "openai.svg"))).toBe(true);
      expect(existsSync(join(resources, "provider-icons", "kimi-color.svg"))).toBe(true);
      expect(existsSync(join(resources, "provider-icons", "grok.svg"))).toBe(true);
      expect(existsSync(join(resources, "provider-icons", "claude-color.svg"))).toBe(true);
      expect(existsSync(join(resources, "provider-icons", "cursor-color.svg"))).toBe(true);
      expect(existsSync(join(resources, "provider-icons", "gemini-color.svg"))).toBe(true);
      expect(existsSync(join(runtime, "package.json"))).toBe(true);
      expect(existsSync(join(runtime, "bin", "ccx.mjs"))).toBe(true);
      expect(existsSync(join(runtime, "src", "cli", "index.ts"))).toBe(true);
      expect(existsSync(join(runtime, "src", untrackedName))).toBe(false);
      const bundledBun = existsSync(join(runtime, "node_modules", "bun", "bin", "bun.exe"))
        ? join(runtime, "node_modules", "bun", "bin", "bun.exe")
        : join(runtime, "node_modules", "bun", "bin", "bun");
      expect(existsSync(bundledBun)).toBe(true);
      expect(existsSync(join(runtime, "gui", "dist", "index.html"))).toBe(true);
      const versionProbe = Bun.spawn(
        [bundledBun, join(runtime, "src", "cli", "index.ts"), "--version"],
        {
          cwd: probeCwd,
          env: {
            HOME: probeCwd,
            PATH: "/usr/bin:/bin",
            CODEXCOMMANDER_HOME: join(probeCwd, "state"),
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [versionOutput, versionExit] = await Promise.all([
        new Response(versionProbe.stdout).text(),
        versionProbe.exited,
      ]);
      expect(versionExit).toBe(0);
      expect(versionOutput).toMatch(/codexcommander/i);
      const info = readFileSync(join(inside, "CodexCommander.app", "Contents", "Info.plist"), "utf8");
      expect(info).toContain("<key>CodexCommanderSourceRevision</key>");
      expect(info).toMatch(/[0-9a-f]{40}(?:-dirty)?/);
    } finally {
      rmSync(untracked, { force: true });
      rmSync(inside, { recursive: true, force: true });
      rmSync(probeCwd, { recursive: true, force: true });
    }
  }, 300_000);

  test("allows a temp destination", async () => {
    await withSandbox(async (sandbox) => {
      const { stderr } = await runScript(join(sandbox, "build"));
      expect(stderr).not.toContain("Refusing to build into");
    });
  }, 300_000);
});
