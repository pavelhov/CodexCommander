import type { CodexCommanderConfig } from "../types";
import type { CatalogConfigAuthoritySnapshot } from "./catalog-admission";
import { injectCodexConfig } from "./inject";
import { nonDisruptiveCodexManagementWritePolicy } from "./management-write-policy";

export type ManagementNativeDefaultsReconcileResult =
  | {
      readonly status: "reconciled";
      readonly warning?: string;
    }
  | {
      readonly status: "skipped";
      readonly reason: "integration-disabled" | "routing-not-owned";
    }
  | {
      readonly status: "failed";
      readonly retryable: boolean;
      readonly message: string;
    };

/**
 * Re-run the canonical native injector only for an already-owned integration.
 * This updates marker-owned config/profile bytes without catalog discovery and
 * deliberately performs no worker signaling.
 */
export async function reconcileManagementNativeSubagentDefaults(
  config: CodexCommanderConfig,
  authority?: CatalogConfigAuthoritySnapshot,
): Promise<ManagementNativeDefaultsReconcileResult> {
  const policy = nonDisruptiveCodexManagementWritePolicy(config);
  if (!policy.allowed) return { status: "skipped", reason: policy.reason };

  const result = await injectCodexConfig(config.port ?? 10100, config, {
    expectedRoutingKind: "codexcommander-local",
    ...(authority ? { expectedConfigAuthority: authority } : {}),
  });
  if (result.success && result.status !== "skipped") {
    return {
      status: "reconciled",
      ...(result.nativeSubagentDefaultsWarning
        ? { warning: result.nativeSubagentDefaultsWarning }
        : {}),
    };
  }
  if (result.success && result.status === "skipped") {
    return {
      status: "skipped",
      reason: result.skippedReason === "desired_disabled"
        ? "integration-disabled"
        : "routing-not-owned",
    };
  }
  return {
    status: "failed",
    retryable: "retryable" in result && result.retryable === true,
    message: result.message,
  };
}
