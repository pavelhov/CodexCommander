export interface ExternalModelRow {
  id: string;
  displayName: string;
  provider: string;
  disabled?: boolean;
  native?: boolean;
  custom?: boolean;
}

/** The inbound wires a client can speak to this proxy. */
export type GatewayInboundProtocol = "responses" | "chat" | "messages";

/** Inbound gateway protocols — not inferred from provider type. */
export function gatewayInboundProtocols(claudeCodeEnabled: boolean): GatewayInboundProtocol[] {
  return claudeCodeEnabled
    ? ["responses", "chat", "messages"]
    : ["responses", "chat"];
}

/**
 * Classify a `/v1/models` row. Bare IDs keep their callable id; `owned_by`
 * decides native/combo/custom so combo aliases are not labeled OpenAI.
 */
export function classifyExternalModel(row: {
  id: string;
  owned_by?: string;
}): ExternalModelRow {
  const slashIndex = row.id.indexOf("/");
  const ownedBy = typeof row.owned_by === "string" && row.owned_by.trim()
    ? row.owned_by.trim()
    : undefined;
  const provider = slashIndex > 0
    ? row.id.slice(0, slashIndex)
    : (ownedBy ?? "openai");
  const native = slashIndex < 0 && provider === "openai";
  const custom = provider !== "openai" && provider !== "combo";
  return {
    id: row.id,
    displayName: row.id,
    provider,
    native,
    custom,
  };
}

/**
 * Classify a management `/api/models` row for the API-keys catalog.
 * Disabled rows are omitted: they are not callable on the data plane.
 */
export function classifyManagementModel(row: unknown): ExternalModelRow | null {
  if (row === null || typeof row !== "object" || Array.isArray(row)) return null;
  const data = row as Record<string, unknown>;
  if (data.disabled === true) return null;
  if (typeof data.id !== "string" || data.id.length === 0) return null;
  const namespaced = typeof data.namespaced === "string" && data.namespaced.length > 0
    ? data.namespaced
    : data.id;
  const provider = typeof data.provider === "string" && data.provider.length > 0
    ? data.provider
    : (namespaced.includes("/") ? namespaced.slice(0, namespaced.indexOf("/")) : "openai");
  return {
    id: namespaced,
    displayName: typeof data.displayName === "string" && data.displayName.length > 0
      ? data.displayName
      : namespaced,
    provider,
    native: data.native === true,
    custom: data.custom === true,
  };
}

export function externalModelId(model: ExternalModelRow): string {
  return model.id;
}
