import type { DataSurfaceKind } from "../../data-surface";
import { binProviderStatus } from "../../provider-workspace/catalog";
import type { ClientAppsProvider, ResourceReadState } from "./ClientAppsWorkspace";

export function resourceReadState(kind: DataSurfaceKind): ResourceReadState {
  if (kind === "cold" || kind === "retrying-cold") return "checking";
  if (kind === "failed-cold" || kind === "failed-with-stale") return "unavailable";
  return "available";
}

export function deriveProviderReadiness(
  kind: DataSurfaceKind,
  providers: ClientAppsProvider[],
): { state: ResourceReadState; readyProviders: ClientAppsProvider[] } {
  const readyProviders = providers.filter(provider => binProviderStatus(provider) === "ready");
  const readState = resourceReadState(kind);
  return {
    readyProviders,
    state: readState === "available" && readyProviders.length === 0 ? "unavailable" : readState,
  };
}

export function deriveModelReadiness(kind: DataSurfaceKind, visibleModelCount: number | null): ResourceReadState {
  const readState = resourceReadState(kind);
  return readState === "available" && visibleModelCount === 0 ? "unavailable" : readState;
}
