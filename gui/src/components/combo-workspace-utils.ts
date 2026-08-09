import type { ModelOption, ProviderOption } from "./combo-workspace-types";

export function enabledProviders(providers: ProviderOption[]): ProviderOption[] {
  return providers
    .filter((p) => !p.disabled && !p.hiddenFromPicker)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Parse a number input and clamp to [min, max]. Empty / non-finite values return
 * `undefined` so callers can ignore the keystroke without writing NaN.
 */
export function clampedNumberInput(raw: string, min: number, max: number): number | undefined {
  if (raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(max, Math.max(min, n));
}

/** OpenAI forward auth has no /models catalog; GPT slugs use the OpenAI catalog. */
export function isOpenAiForwardOption(p: ProviderOption | undefined): boolean {
  if (!p) return false;
  const id = p.name.toLowerCase();
  if (id !== "openai") return false;
  if ((p.authMode ?? "").toLowerCase() !== "forward") return false;
  if ((p.adapter ?? "").toLowerCase() !== "openai-responses") return false;
  const base = (p.baseUrl ?? "").replace(/\/+$/, "");
  return !base || base.includes("chatgpt.com/backend-api/codex");
}

export function modelsForProvider(
  models: ModelOption[],
  provider: string,
  providers: ProviderOption[],
): string[] {
  const keys = new Set<string>([provider]);
  const meta = providers.find((p) => p.name === provider);
  // Forward providers do not publish a separate catalog.
  if (isOpenAiForwardOption(meta)) {
    keys.add("openai");
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const m of models) {
    if (!keys.has(m.provider) || !m.id) continue;
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    ids.push(m.id);
  }
  return ids.toSorted((a, b) => a.localeCompare(b));
}
