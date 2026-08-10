// Google Antigravity (Cloud Code Assist) bundled model list.
//
// Single source of truth: the Antigravity `:fetchAvailableModels` backend, the same one the `agy`
// CLI resolves labels against. The ids below separate CCA wire ids and collapsed picker entries.
// The CCA envelope's `model` field must
// receive the wire id (for example "Gemini 3.1 Pro (High)" => gemini-pro-agent), while the
// picker exposes collapsed base models with reasoning-effort routing.

// ── Wire IDs (what CCA :fetchAvailableModels returns) ──
const ANTIGRAVITY_WIRE_MODELS = [
  "gemini-3.6-flash-low",
  "gemini-3.6-flash-medium",
  "gemini-3.6-flash-high",
  "gemini-3.1-pro-low",
  "gemini-pro-agent",
  "gemini-3.1-flash-image",
  "claude-sonnet-4-6",
  "claude-opus-4-6-thinking",
  "gpt-oss-120b-medium",
];

// ── Effort ladders per collapsed base model ──
// Gemini models: effort → wire model suffix (official agy UI pattern).
// Claude Opus: effort → thinkingConfig.thinkingLevel (CLIProxyAPI proven pattern).
export const ANTIGRAVITY_MODEL_EFFORTS: Record<string, string[]> = {
  "gemini-3.6-flash": ["low", "medium", "high"],
  "gemini-3.1-pro": ["low", "high"],
  "claude-sonnet-4-6": ["low", "medium", "high", "max"],
  "claude-opus-4-6-thinking": ["low", "medium", "high", "max"],
};

// ── Effort → wire model map for Gemini base models ──
const ANTIGRAVITY_EFFORT_WIRE_MAP: Record<string, Record<string, string>> = {
  "gemini-3.6-flash": {
    low: "gemini-3.6-flash-low",
    medium: "gemini-3.6-flash-medium",
    high: "gemini-3.6-flash-high",
  },
  "gemini-3.1-pro": {
    low: "gemini-3.1-pro-low",
    high: "gemini-pro-agent",
  },
};

// ── Default effort per Gemini base model ──
const ANTIGRAVITY_DEFAULT_EFFORT: Record<string, string> = {
  "gemini-3.6-flash": "medium",
  "gemini-3.1-pro": "high",
};

const ANTIGRAVITY_THINKING_LEVELS = new Set(["minimal", "low", "medium", "high"]);

function resolveAntigravityThinkingLevel(effort: string): string | undefined {
  if (effort === "xhigh" || effort === "max" || effort === "ultra") return "high";
  return ANTIGRAVITY_THINKING_LEVELS.has(effort) ? effort : undefined;
}

// Picker-visible: collapsed base models only.
export const ANTIGRAVITY_MODELS = [
  "gemini-3.6-flash",
  "gemini-3.1-pro",
  "gemini-3.1-flash-image",
  "claude-sonnet-4-6",
  "claude-opus-4-6-thinking",
  "gpt-oss-120b-medium",
];

// Context windows from the upstream `:fetchAvailableModels` maxTokens per model.
const ANTIGRAVITY_WIRE_MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "gemini-3.6-flash-low": 1_048_576,
  "gemini-3.6-flash-medium": 1_048_576,
  "gemini-3.6-flash-high": 1_048_576,
  "gemini-3.1-pro-low": 1_048_576,
  "gemini-pro-agent": 1_048_576,
  "gemini-3.1-flash-image": 1_048_576,
  "claude-sonnet-4-6": 200_000,
  "claude-opus-4-6-thinking": 1_000_000,
  "gpt-oss-120b-medium": 131_072,
};

export const ANTIGRAVITY_MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // Collapsed base IDs — explicit entries for the picker.
  "gemini-3.6-flash": 1_048_576,
  "gemini-3.1-pro": 1_048_576,
  // Current CCA wire IDs.
  ...ANTIGRAVITY_WIRE_MODEL_CONTEXT_WINDOWS,
};

/**
 * Whether the given model ID is a CCA wire ID that already encodes
 * an effort level. For these IDs, the caller must NOT send thinkingConfig — the suffix
 * IS the effort, and sending both creates a contradictory request.
 */
export function isAntigravitySuffixModelId(modelId: string): boolean {
  return !(ANTIGRAVITY_MODELS as string[]).includes(modelId);
}

/**
 * Resolve a picker-visible base model + optional reasoning effort to the CCA wire model ID.
 *
 * Precedence (evaluated in order):
 * 1. Wire ID → preserve it without a thinkingConfig.
 * 2. Mapped Gemini base with effort → return mapped wire ID + thinkingLevel.
 * 3. Mapped Gemini base without effort → return default-effort wire ID, no thinkingConfig.
 * 4. Claude Opus with effort → return identity + thinkingLevel (no suffix variants exist).
 * 5. All other IDs → preserve the supplied wire model, no thinkingConfig.
 */
export function resolveAntigravityEffortWireModel(
  modelId: string,
  effort?: string,
): { wireModelId: string; thinkingLevel?: string } {
  // Rule 1: wire ID — its suffix IS the effort.
  if (isAntigravitySuffixModelId(modelId)) {
    return { wireModelId: modelId };
  }

  // Rule 2/3: mapped Gemini base model.
  const effortMap = ANTIGRAVITY_EFFORT_WIRE_MAP[modelId];
  if (effortMap) {
    if (effort && effort in effortMap) {
      return { wireModelId: effortMap[effort]!, thinkingLevel: effort };
    }
    const defaultEffort = ANTIGRAVITY_DEFAULT_EFFORT[modelId]!;
    return { wireModelId: effortMap[defaultEffort]! };
  }

  // Rule 4: Claude models — effort via thinkingConfig only (no suffix variants).
  // CCA validates this field as Google's ThinkingLevel enum, whose highest value is `high`.
  if (/^claude-/.test(modelId) && effort) {
    return { wireModelId: modelId, thinkingLevel: resolveAntigravityThinkingLevel(effort) };
  }

  // Rule 5: everything else.
  return { wireModelId: modelId };
}


// ── Usage aggregation reverse map (picker/call base identity) ──
// Effort wire IDs collapse to the picker-visible base model that users invoke after effort
// routing, so one current call model produces one usage row.
const ANTIGRAVITY_USAGE_BASE_BY_ID: Record<string, string> = (() => {
  const rev: Record<string, string> = {};
  for (const base of ANTIGRAVITY_MODELS) rev[base] = base;
  for (const [base, effortMap] of Object.entries(ANTIGRAVITY_EFFORT_WIRE_MAP)) {
    rev[base] = base;
    for (const wire of Object.values(effortMap)) rev[wire] = base;
  }
  return rev;
})();

/**
 * Canonical picker/call model id for usage aggregation.
 * Unknown ids stay identity so future CCA models do not invent mappings.
 */
export function canonicalAntigravityUsageModel(modelId: string): string {
  const id = modelId.trim();
  if (!id) return modelId;
  return ANTIGRAVITY_USAGE_BASE_BY_ID[id] ?? id;
}
