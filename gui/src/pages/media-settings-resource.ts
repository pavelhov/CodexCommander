import { requireJson } from "./dashboard-shared";

export type MediaSource = "subscription_oauth" | "api_key";

export interface DashboardMediaJob {
  id: string;
  revision: number;
  state: string;
  phase: "progress" | "human_action_required" | "completed" | "terminal";
  action: "wait" | "recover_auth" | "acknowledge" | "open" | "none";
  reason: string;
  createdAt: number;
  updatedAt: number;
}

export interface DashboardMediaResource {
  revision: number;
  settings: { imagesEnabled: boolean; videosEnabled: boolean; authSource: MediaSource | null };
  readiness: {
    credential: { state: "disabled" | "ready" | "blocked"; reason: string | null };
    image: { enabled: boolean; state: "disabled" | "ready" | "blocked"; reason: string | null };
    video: { enabled: boolean; state: "disabled" | "ready" | "blocked"; reason: string | null };
  };
  experimental: true;
  sourceFallback: "disabled";
  acceptedJobsKeepOriginalBinding: true;
  jobs: DashboardMediaJob[];
  probe: null | {
    id: string;
    revision: number;
    steps: { image: { state: string }; video: { state: string } };
  };
  recovery: null | {
    id: string;
    revision: number;
    cause: string;
    readOnly: boolean;
    action: "upgrade" | "manual_recovery" | "quarantine_reset" | "acknowledge";
    acknowledgementRequired: boolean;
    restartRequired: boolean;
  };
}

export function mediaResourceKey(apiBase: string): string {
  return `dashboard-media:${apiBase}`;
}

export async function fetchDashboardMedia(apiBase: string, signal?: AbortSignal): Promise<DashboardMediaResource> {
  const response = await fetch(`${apiBase}/api/media?limit=25`, { signal, cache: "no-store" });
  return requireJson<DashboardMediaResource>(response, "media load failed");
}
