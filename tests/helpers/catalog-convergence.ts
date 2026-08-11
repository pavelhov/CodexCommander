import { saveConfig } from "../../src/config";
import { captureCatalogAdmissionSnapshot } from "../../src/codex/catalog-admission";
import { convergeCodexCatalog } from "../../src/codex/convergence";
import { projectCatalogOnlyOutcome } from "../../src/codex/management-convergence";
import type { ConvergeCodex } from "../../src/codex/convergence-types";
import type { CodexCommanderConfig } from "../../src/types";

export function catalogConvergenceFactory(
  run: () => Promise<void> | void = () => {},
): (config: Readonly<CodexCommanderConfig>) => ConvergeCodex {
  return () => async () => {
    await run();
    return projectCatalogOnlyOutcome({
      changed: false,
      catalogRefresh: { status: "committed", changed: false, degraded: false, notices: [] },
    });
  };
}

/** Persist, admit, and run the production catalog convergence path in focused tests. */
export async function convergeCatalogForTest(config: Readonly<CodexCommanderConfig>) {
  saveConfig(config);
  const result = await convergeCodexCatalog(captureCatalogAdmissionSnapshot(config), {
    action: "converge",
    scope: "catalog",
    reason: "api-sync",
    mode: "explicit",
    deadlineMs: 1_000,
  });
  if (result.catalogRefresh.status !== "committed") {
    throw new Error(`Catalog convergence did not commit: ${JSON.stringify(result.catalogRefresh)}`);
  }
  return result.projection;
}
