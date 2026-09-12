/**
 * Opt-in installed-bundle Sparkle qualification. The fixture entry driver must only
 * drive the production AppDelegate's actions and real Sparkle UI, never replace
 * lifecycle or installer callbacks. See the rollout qualification report for the
 * exact fixture source revision, signing and service-identity isolation changes.
 *
 * CCX_MACOS_UPDATE_FIXTURE points at a prepared, disposable fixture directory.
 * The reusable runner lives in tests/helpers/macos-update; signing material and
 * installed apps must stay in ignored scratch space. Ordinary CI skips this host/GUI-dependent test.
 */
import { test, expect } from "bun:test";
import { readFileSync, realpathSync, lstatSync } from "node:fs";
import { join, isAbsolute } from "node:path";

const fixture = process.env.CCX_MACOS_UPDATE_FIXTURE;
const enabled = process.platform === "darwin" && Boolean(fixture);

test.skipIf(!enabled)("real installed Sparkle update preserves the selected semantic state", async () => {
  if (!fixture || !isAbsolute(fixture)) throw new Error("An absolute isolated fixture directory is required");
  expect(lstatSync(fixture).isSymbolicLink()).toBe(false);
  const root = realpathSync(fixture);
  const metadata = JSON.parse(readFileSync(join(root, "fixture.json"), "utf8"));
  expect(metadata.root).toBe(root);
  expect(metadata.bundleId.startsWith("org.ccx.u6.")).toBe(true);
  expect(metadata.serviceLabel).toBe(`${metadata.bundleId}.proxy`);
  expect(["arm64", "x86_64"]).toContain(metadata.arch);
  expect(["stopped", "native", "owned"]).toContain(metadata.mode);
  const identity = readFileSync(join(root, "installed/CodexCommander.app/Contents/Resources/runtime/src/identity.mjs"), "utf8");
  expect(identity).not.toContain('"com.codexcommander.proxy"');
  expect(identity).toContain(metadata.serviceLabel);
  const child = Bun.spawn(["python3", join(import.meta.dir, "../helpers/macos-update/run.py"), root], {
    stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  expect({ code, stdout, stderr }).toMatchObject({ code: 0 });
  const steps = JSON.parse(readFileSync(join(root, "steps.json"), "utf8")) as Array<{kind: string; build?: number; semantic?: string; survivors?: number[]; serviceAbsent?: boolean}>;
  expect(steps.some(step => step.kind === "PASS" && step.build === metadata.targetBuild && step.semantic === metadata.mode)).toBe(true);
  expect(steps.at(-1)?.kind).toBe("cleanup");
  expect(steps.at(-1)?.survivors).toEqual([]);
  expect(steps.at(-1)?.serviceAbsent).toBe(true);
}, 360_000);
