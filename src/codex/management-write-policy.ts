import type { CodexCommanderConfig } from "../types";
import { codexIntegrationEnabled } from "./desired-state";
import { getCodexRoutingKind } from "./inject";
import type { CodexRoutingKind } from "./routing-document";
import type { ConvergeRequest } from "./convergence-types";

export type NonDisruptiveCodexManagementWritePolicy =
  | { readonly allowed: true; readonly routingKind: "codexcommander-local" }
  | {
      readonly allowed: false;
      readonly reason: "integration-disabled" | "routing-not-owned";
      readonly routingKind: CodexRoutingKind;
    };

/**
 * Automatic management Saves may maintain only an integration they already
 * own. Adoption of native routing is reserved for the separately confirmed
 * full Apply path, and external/custom routing is never adopted here.
 */
export function nonDisruptiveCodexManagementWritePolicy(
  config: Pick<CodexCommanderConfig, "clientIntegrations">,
  routingKind: CodexRoutingKind = getCodexRoutingKind(),
): NonDisruptiveCodexManagementWritePolicy {
  if (!codexIntegrationEnabled(config)) {
    return { allowed: false, reason: "integration-disabled", routingKind };
  }
  if (routingKind !== "codexcommander-local") {
    return { allowed: false, reason: "routing-not-owned", routingKind };
  }
  return { allowed: true, routingKind };
}

export function isNonDisruptiveManagementCatalogRequest(
  request: ConvergeRequest,
): boolean {
  return request.action === "converge"
    && request.scope === "catalog"
    && request.reason === "management-mutation"
    && request.mode === "automatic";
}

/** A single policy projection shared by preflight and the commit-time fence. */
export function codexCatalogWritePolicy(
  config: Pick<CodexCommanderConfig, "clientIntegrations">,
  request: ConvergeRequest,
  routingKind: CodexRoutingKind = getCodexRoutingKind(),
): { readonly allowed: true; readonly requiresManagedRouting: boolean }
  | (Extract<NonDisruptiveCodexManagementWritePolicy, { allowed: false }>
    & { readonly requiresManagedRouting: true }) {
  if (!isNonDisruptiveManagementCatalogRequest(request)) {
    return { allowed: true, requiresManagedRouting: false };
  }
  const policy = nonDisruptiveCodexManagementWritePolicy(config, routingKind);
  return policy.allowed
    ? { allowed: true, requiresManagedRouting: true }
    : { ...policy, requiresManagedRouting: true };
}
