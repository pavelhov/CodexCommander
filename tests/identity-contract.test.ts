import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as plainIdentity from "../src/identity.mjs";
import {
  ADMIN_KEY_PATTERN,
  isOwnedHealthService,
  isOwnedProviderId,
} from "../src/identity";

describe("CodexCommander identity contract", () => {
  test("the plain-JavaScript source exports one canonical identity surface", () => {
    expect(Object.keys(plainIdentity).sort()).toEqual([
      "ADMIN_AUTH_REQUIRED_MESSAGE",
      "ADMIN_KEY_PREFIX",
      "API_KEY_HEADER",
      "ARTIFACT_HTTP_PREFIX",
      "ATTESTATION_CHALLENGE_HEADER",
      "ATTESTATION_PROOF_HEADER",
      "AUTH_REQUIRED_MESSAGE",
      "BRAND_DISPLAY",
      "CLI_LONG",
      "CLI_SHORT",
      "CSRF_HEADER",
      "DATA_KEY_PREFIX",
      "GUI_ORIGIN_HEADER",
      "GUI_SESSION_PREFIX",
      "HEALTH_SERVICE_ID",
      "HOME_ENV",
      "NPM_PACKAGE",
      "OWNER_FILE",
      "PACKAGE_SLUG",
      "PROVIDER_ID",
      "REPOSITORY_URL",
      "SERVICE_LABEL",
      "SERVICE_TASK",
      "SESSION_PATH",
      "STATE_DIR_NAME",
      "UNINSTALL_MANIFEST",
      "WINSW_SERVICE_ID",
      "readEnv",
    ].sort());
  });

  test("environment reads use only the requested canonical key", () => {
    expect(plainIdentity.readEnv(plainIdentity.HOME_ENV, {
      UNSUPPORTED_HOME: "/tmp/unsupported",
    })).toBeUndefined();
    expect(plainIdentity.readEnv(plainIdentity.HOME_ENV, {
      [plainIdentity.HOME_ENV]: "  /tmp/canonical  ",
    })).toBe("/tmp/canonical");
  });

  test("typed predicates accept only CodexCommander identities", () => {
    expect(isOwnedProviderId("codexcommander")).toBe(true);
    expect(isOwnedHealthService("codexcommander")).toBe(true);
    expect(isOwnedProviderId("foreign-provider")).toBe(false);
    expect(isOwnedHealthService("foreign-service")).toBe(false);
    expect(ADMIN_KEY_PATTERN.test(`ccx_admin_${"A".repeat(43)}`)).toBe(true);
    expect(ADMIN_KEY_PATTERN.test(`xx_admin_${"A".repeat(43)}`)).toBe(false);
  });

  test("tracked product files contain no retired identity", () => {
    const root = join(import.meta.dir, "..");
    const license = readFileSync(join(root, "LICENSE"), "utf8");
    const legalName = license.match(/^Copyright \(c\) \d{4} ([a-z]+) contributors$/m)?.[1];
    expect(legalName).toBeDefined();
    const suffixAt = legalName!.indexOf("codex");
    expect(suffixAt).toBeGreaterThan(0);
    const shortName = `${legalName![0]}${legalName![suffixAt]}${legalName!.at(-1)}`;
    const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const textPattern = new RegExp(
      `${escaped(legalName!)}|(^|[^A-Za-z0-9])${escaped(shortName)}([^A-Za-z0-9]|$)`,
      "i",
    );
    const filenamePattern = new RegExp(
      `${escaped(legalName!)}|(^|[^A-Za-z0-9])${escaped(shortName)}([^A-Za-z0-9]|$)`,
      "i",
    );
    const excluded = new Set([
      "LICENSE",
      "docs-site/bun.lock",
      "src/adapters/cursor/gen/agent_pb.ts",
    ]);
    const listing = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: root });
    expect(listing.exitCode).toBe(0);
    const files = listing.stdout.toString().split("\0").filter(Boolean);
    const offenders: string[] = [];
    for (const relative of files) {
      if (filenamePattern.test(relative)) offenders.push(`${relative}: filename`);
      if (excluded.has(relative)) continue;
      const path = join(root, relative);
      if (!existsSync(path)) continue;
      const bytes = readFileSync(path);
      const text = bytes.toString("utf8");
      const binary = bytes.subarray(0, 8_192).includes(0);
      if (binary ? text.toLowerCase().includes(legalName!) : textPattern.test(text)) {
        offenders.push(`${relative}: content`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
