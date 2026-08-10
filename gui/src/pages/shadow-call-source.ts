export interface ShadowCallData {
  enabled: boolean;
  model: string;
  sourceModels: string[];
}

/** Accept only the current management response; malformed successful reads are failures. */
export function parseShadowCallData(value: unknown): ShadowCallData {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid shadow-call response");
  }
  const row = value as Record<string, unknown>;
  if (typeof row.enabled !== "boolean" || typeof row.model !== "string" || !Array.isArray(row.sourceModels)) {
    throw new Error("invalid shadow-call response");
  }
  const sourceModels = row.sourceModels.map(model => {
    if (typeof model !== "string" || model.trim() === "") throw new Error("invalid shadow-call response");
    return model.trim();
  });
  if (sourceModels.length === 0) throw new Error("invalid shadow-call response");
  return { enabled: row.enabled, model: row.model, sourceModels };
}

export function shadowSourceModelList(sourceModels?: readonly string[]): string[] {
  if (!sourceModels) return [];
  return sourceModels.map(model => model.trim()).filter(Boolean);
}

/** Comma-joined source models for inline badges and warning text. */
export function shadowSourceModelLabel(sourceModels?: readonly string[]): string {
  return shadowSourceModelList(sourceModels).join(", ");
}

/** Short badge form: drops the shared `gpt-` prefix to keep the row compact. */
export function shadowSourceModelBadge(sourceModels?: readonly string[]): string {
  return shadowSourceModelList(sourceModels)
    .map(id => id.replace(/^gpt-/, ""))
    .join(", ");
}
