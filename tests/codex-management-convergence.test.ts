import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createCatalogConvergeRequest } from "../src/codex/catalog-admission";
import {
  createManagementConvergeCodex,
  projectCatalogOnlyOutcome,
} from "../src/codex/management-convergence";
import {
  codexCatalogWritePolicy,
  nonDisruptiveCodexManagementWritePolicy,
} from "../src/codex/management-write-policy";
import type { CatalogDisposition } from "../src/codex/convergence-types";
import type { CodexCommanderConfig } from "../src/types";

function config(): CodexCommanderConfig {
  return {
    port: 10100,
    multiAgentGuidanceEnabled: true,
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
      },
    },
    defaultProvider: "openai",
  };
}

const repoRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

function runUnownedRosterSave(
  codexHome: string,
  commanderHome: string,
  mode: "off" | "native" | "external",
): { status: number; stdout: string; stderr: string } {
  const script = `
    const { readFileSync } = require("node:fs");
    const { join } = require("node:path");
    const { getDefaultConfig, saveConfigPreservingClaudeCode } = require("./src/config");
    const { handleManagementAPI } = require("./src/server/management-api");
    const { ManagementRequest } = require("./tests/helpers/management-auth");
    const config = {
      ...getDefaultConfig(),
      ...(process.env.TEST_MODE === "off" ? { clientIntegrations: { codex: false } } : {}),
    };
    saveConfigPreservingClaudeCode(config);
    const catalogPath = join(process.env.CODEX_HOME, "codexcommander-catalog.json");
    const cachePath = join(process.env.CODEX_HOME, "models_cache.json");
    const before = { catalog: readFileSync(catalogPath, "utf8"), cache: readFileSync(cachePath, "utf8") };
    const req = new ManagementRequest("http://localhost/api/subagent-models", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ models: ["gpt-5.6-terra"] }),
    });
    const response = await handleManagementAPI(req, new URL(req.url), config, {
      syncClaudeAgentDefsBestEffort: () => {},
      collectCodexAppServerCatalogState: () => ({ state: "not_running", catalogMtimeMs: null, processes: [] }),
    });
    console.log(JSON.stringify({
      status: response.status,
      body: await response.json(),
      before,
      after: { catalog: readFileSync(catalogPath, "utf8"), cache: readFileSync(cachePath, "utf8") },
    }));
  `;
  const result = spawnSync(process.execPath, ["--eval", script], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      CODEXCOMMANDER_HOME: commanderHome,
      TEST_MODE: mode,
    },
    encoding: "utf8",
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? "",
  };
}

test("ownership refusal precedes catalog generation admission", async () => {
  const convergeCodex = createManagementConvergeCodex(config());

  const outcome = await convergeCodex(createCatalogConvergeRequest({ deadlineMs: 1_000 }));

  expect(outcome).toEqual({
    kind: "catalog-only",
    changed: false,
    catalogRefresh: { status: "skipped", reason: "refused", retryable: false },
    observed: {
      aggregate: "not-evaluated",
      isApplied: null,
      desired: "unknown",
      converged: null,
      authority: { service: "unknown", externalProvider: null },
      surfaces: {
        config: "not-evaluated",
        profile: "not-evaluated",
        catalog: "not-evaluated",
        cache: "not-evaluated",
        journal: "not-evaluated",
        provenance: {
          state: "not-evaluated",
          nativeGeneration: null,
          currentTxId: null,
        },
      },
    },
  });
});

test("refuses a non-catalog request through the total projection", async () => {
  const convergeCodex = createManagementConvergeCodex(config());

  const outcome = await convergeCodex({
    action: "observe",
    scope: "full",
    reason: "cli",
    mode: "explicit",
    deadlineMs: 1_000,
  });
  expect(outcome.kind).toBe("catalog-only");
  expect(outcome.catalogRefresh).toEqual({
    status: "failed",
    reason: "disk",
    phase: "gather",
    retryable: false,
    partialWrite: false,
  });
});

test("constructs the fixed catalog request and ignores caller attempts to choose direction", () => {
  const malformedInput = {
    action: "remove",
    scope: "full",
    reason: "cli",
    mode: "explicit",
    deadlineMs: 1_000,
  } as unknown as Parameters<typeof createCatalogConvergeRequest>[0];
  const request = createCatalogConvergeRequest(malformedInput);

  expect(request).toEqual({
    action: "converge",
    scope: "catalog",
    reason: "management-mutation",
    mode: "automatic",
    deadlineMs: 1_000,
  });
});

test("automatic management catalog writes require enabled, already-owned routing", () => {
  const automatic = createCatalogConvergeRequest({ deadlineMs: 1_000 });
  expect(codexCatalogWritePolicy(config(), automatic, "codexcommander-local"))
    .toEqual({ allowed: true, requiresManagedRouting: true });
  expect(codexCatalogWritePolicy({ ...config(), clientIntegrations: { codex: false } }, automatic, "codexcommander-local"))
    .toMatchObject({ allowed: false, reason: "integration-disabled", requiresManagedRouting: true });

  for (const routingKind of ["native", "custom-local", "custom-remote", "unknown"] as const) {
    expect(nonDisruptiveCodexManagementWritePolicy(config(), routingKind))
      .toEqual({ allowed: false, reason: "routing-not-owned", routingKind });
    expect(codexCatalogWritePolicy(config(), automatic, routingKind))
      .toMatchObject({ allowed: false, reason: "routing-not-owned", requiresManagedRouting: true });
  }
});

test("explicit full Apply retains authority to adopt native routing", () => {
  const explicitApply = {
    action: "converge",
    scope: "full",
    reason: "api-sync",
    mode: "explicit",
    deadlineMs: 1_000,
  } as const;
  expect(codexCatalogWritePolicy(config(), explicitApply, "native"))
    .toEqual({ allowed: true, requiresManagedRouting: false });
});

test.each([
  ["off", [
    "# Auto-injected by CodexCommander",
    'openai_base_url = "http://127.0.0.1:10100/v1"',
    'model_catalog_json = "codexcommander-catalog.json"',
    "",
  ].join("\n")],
  ["native", 'model = "gpt-5.6-terra"\n'],
  ["external", 'model_provider = "external"\n\n[model_providers.external]\nbase_url = "https://example.test/v1"\n'],
] as const)("%s roster Save leaves catalog and cache byte-for-byte unchanged", (mode, nativeConfig) => {
  const codexHome = mkdtempSync(join(tmpdir(), `ccx-roster-${mode}-codex-`));
  const commanderHome = mkdtempSync(join(tmpdir(), `ccx-roster-${mode}-home-`));
  try {
    writeFileSync(join(codexHome, "config.toml"), nativeConfig, "utf8");
    writeFileSync(join(codexHome, "codexcommander-catalog.json"), "catalog-sentinel\n", "utf8");
    writeFileSync(join(codexHome, "models_cache.json"), "cache-sentinel\n", "utf8");
    const result = runUnownedRosterSave(codexHome, commanderHome, mode);
    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout) as {
      status: number;
      body: { catalogRefresh: unknown };
      before: { catalog: string; cache: string };
      after: { catalog: string; cache: string };
    };
    expect(output.status).toBe(200);
    expect(output.body.catalogRefresh).toEqual({ status: "skipped", reason: "refused", retryable: false });
    expect(output.after).toEqual(output.before);
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
    rmSync(commanderHome, { recursive: true, force: true });
  }
}, 30_000);

test("rejects malformed catalog request deadlines", () => {
  for (const deadlineMs of [
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    expect(() => createCatalogConvergeRequest({ deadlineMs })).toThrow(
      "Catalog convergence deadlineMs must be a positive safe integer.",
    );
  }
});

const booleans = [false, true] as const;
const catalogRefreshVariants: readonly CatalogDisposition[] = [
  ...booleans.flatMap(changed => booleans.map(degraded => ({
    status: "committed" as const,
    changed,
    degraded,
    notices: ["provider-auth", "provider-network", "fallback"] as const,
  }))),
  ...(["not-requested", "catalog-unavailable", "busy", "stale", "refused"] as const)
    .flatMap(reason => booleans.map(retryable => ({
      status: "skipped" as const,
      reason,
      retryable,
    }))),
  ...(["provider-auth", "provider-network", "disk"] as const).flatMap(reason =>
    (["gather", "commit"] as const).flatMap(phase =>
      booleans.flatMap(retryable => booleans.map(partialWrite => ({
        status: "failed" as const,
        reason,
        phase,
        retryable,
        partialWrite,
      }))),
    ),
  ),
];

for (const changed of booleans) {
  for (const [variantIndex, catalogRefresh] of catalogRefreshVariants.entries()) {
    test(`projects changed=${changed} with catalog variant ${variantIndex} exactly`, () => {
      expect(projectCatalogOnlyOutcome({ changed, catalogRefresh })).toEqual({
        kind: "catalog-only",
        changed,
        catalogRefresh,
        observed: {
          aggregate: "not-evaluated",
          isApplied: null,
          desired: "unknown",
          converged: null,
          authority: { service: "unknown", externalProvider: null },
          surfaces: {
            config: "not-evaluated",
            profile: "not-evaluated",
            catalog: "not-evaluated",
            cache: "not-evaluated",
            journal: "not-evaluated",
            provenance: {
              state: "not-evaluated",
              nativeGeneration: null,
              currentTxId: null,
            },
          },
        },
      });
    });
  }
}
