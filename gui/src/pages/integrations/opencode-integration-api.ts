import { readJsonOrThrow } from "../../fetch-json";

export type OpenCodeIntegrationState =
  | "not_applied"
  | "applied"
  | "modified"
  | "needs_attention";

export interface OpenCodeIntegrationEnvelope {
  integration: {
    state: OpenCodeIntegrationState;
    targetPath: string;
    autoConnect: boolean;
    canRestore: boolean;
    tokenReady: boolean;
    detail?: string;
  };
  installation: {
    desktopInstalled: boolean;
    cliInstalled: boolean;
    preferred: "desktop" | "cli" | null;
  };
  canOpen: boolean;
  downloadUrl: string;
  consoleUrl: string;
  provider: {
    configured: boolean;
    credentialVerification: "not_configured" | "unverified" | "verified" | null;
  };
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isOpenCodeIntegrationEnvelope(value: unknown): value is OpenCodeIntegrationEnvelope {
  if (!isRecord(value) || !isRecord(value.integration) || !isRecord(value.installation) || !isRecord(value.provider)) {
    return false;
  }
  const integration = value.integration;
  const installation = value.installation;
  const provider = value.provider;
  const states = new Set<OpenCodeIntegrationState>([
    "not_applied",
    "applied",
    "modified",
    "needs_attention",
  ]);
  const preferred = installation.preferred;
  const verification = provider.credentialVerification;
  return typeof integration.state === "string"
    && states.has(integration.state as OpenCodeIntegrationState)
    && typeof integration.targetPath === "string"
    && typeof integration.autoConnect === "boolean"
    && typeof integration.canRestore === "boolean"
    && typeof integration.tokenReady === "boolean"
    && (integration.detail === undefined || typeof integration.detail === "string")
    && typeof installation.desktopInstalled === "boolean"
    && typeof installation.cliInstalled === "boolean"
    && (preferred === null || preferred === "desktop" || preferred === "cli")
    && typeof value.canOpen === "boolean"
    && typeof value.downloadUrl === "string"
    && typeof value.consoleUrl === "string"
    && typeof provider.configured === "boolean"
    && (verification === null
      || verification === "not_configured"
      || verification === "unverified"
      || verification === "verified")
    && (value.error === undefined || typeof value.error === "string");
}

export async function loadOpenCodeIntegration(
  apiBase: string,
  signal: AbortSignal | undefined,
  fallbackMessage: string,
): Promise<OpenCodeIntegrationEnvelope> {
  const response = await fetch(`${apiBase}/api/integrations/opencode`, { signal });
  const data = await readJsonOrThrow<unknown>(response, fallbackMessage);
  if (!isOpenCodeIntegrationEnvelope(data)) throw new Error(fallbackMessage);
  return data;
}
