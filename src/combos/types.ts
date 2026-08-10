import { isCodexReasoningEffort } from "../reasoning-effort";
import type {
  CodexCommanderComboConfig,
  CodexCommanderComboDefaultEffort,
  CodexCommanderComboStrategy,
  CodexCommanderComboTarget,
  CodexCommanderConfig,
  CodexCommanderProviderConfig,
} from "../types";

export const COMBO_NAMESPACE = "combo";

export function preservesPhysicalComboProvider(
  config: Pick<CodexCommanderConfig, "providers" | "combos">,
): boolean {
  return Object.hasOwn(config.providers, COMBO_NAMESPACE)
    && Object.keys(config.combos ?? {}).length === 0;
}

const COMBO_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/**
 * Public alias shape: one optional "/" segment, each segment id-shaped. Bare aliases
 * (no "/") are the masquerade case — the combo answers to a mandated model id with no
 * `combo/` prefix. Codex-facing slugs tolerate at most one "/", so deeper paths reject.
 */
const COMBO_ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,63})?$/;
/**
 * Bare aliases in the OpenAI native family (gpt-*, o1-*, o3-*, o4-*, codex-*) are
 * rejected: they collide with native catalog rows and the canonical-OpenAI routing
 * branch, which cannot be shadowed honestly.
 */
const NATIVE_OPENAI_FAMILY_PATTERN = /^(?:gpt-|o1-|o3-|o4-|codex-)/;

export interface ComboValidationIssue {
  path: Array<string | number>;
  message: string;
}

export interface NormalizedComboConfig {
  strategy: CodexCommanderComboStrategy;
  stickyLimit: number;
  defaultEffort: CodexCommanderComboDefaultEffort | null;
  /** Trimmed public alias, or null when the combo keeps the default `combo/<id>` slug. */
  alias: string | null;
  targets: Array<Required<CodexCommanderComboTarget>>;
}

export function targetKey(target: Pick<CodexCommanderComboTarget, "provider" | "model">): string {
  return `${target.provider}/${target.model}`;
}

export function parseComboModelId(modelId: string): string | null {
  const slash = modelId.indexOf("/");
  if (slash <= 0 || modelId.slice(0, slash) !== COMBO_NAMESPACE) return null;
  const id = modelId.slice(slash + 1);
  return id.length > 0 ? id : null;
}

export function comboModelId(id: string): string {
  return `${COMBO_NAMESPACE}/${id}`;
}

/** Public model id clients request: the alias when set, else the default `combo/<id>`. */
export function comboPublicModelId(id: string, combo: { alias?: string | null }): string {
  const alias = typeof combo.alias === "string" ? combo.alias.trim() : "";
  return alias || comboModelId(id);
}

/**
 * Resolve a client-requested public model id to a combo config key. A configured alias
 * is exclusive; `combo/<id>` is public only while that combo has no alias.
 */
export function resolveComboId(
  config: { combos?: Record<string, CodexCommanderComboConfig> },
  modelId: string,
): string | null {
  const combos = config.combos;
  const direct = parseComboModelId(modelId);
  if (direct) {
    const raw = combos && Object.hasOwn(combos, direct) ? combos[direct] : undefined;
    const alias = typeof raw?.alias === "string" ? raw.alias.trim() : "";
    return alias ? null : direct;
  }
  if (!combos) return null;
  for (const [id, raw] of Object.entries(combos)) {
    if (!raw || typeof raw !== "object") continue;
    const alias = typeof raw.alias === "string" ? raw.alias.trim() : "";
    if (alias && alias === modelId) return id;
  }
  return null;
}

/**
 * Cross-combo alias checks that need the full combos map (uniqueness). Kept separate
 * from `comboConfigIssues` so config-file validation and the management API share it.
 */
export function comboAliasIssues(
  id: string,
  alias: string,
  combos: Record<string, CodexCommanderComboConfig> | undefined,
  options: { excludeComboId?: string } = {},
): ComboValidationIssue[] {
  const issues: ComboValidationIssue[] = [];
  if (!COMBO_ALIAS_PATTERN.test(alias)) {
    issues.push({
      path: ["alias"],
      message: "alias must use letters, numbers, dot, underscore, or hyphen, with at most one \"/\" segment",
    });
    return issues;
  }
  if (alias === COMBO_NAMESPACE || alias.startsWith(`${COMBO_NAMESPACE}/`)) {
    issues.push({
      path: ["alias"],
      message: `alias must not use the reserved "${COMBO_NAMESPACE}/" namespace`,
    });
  }
  if (!alias.includes("/") && NATIVE_OPENAI_FAMILY_PATTERN.test(alias)) {
    issues.push({
      path: ["alias"],
      message: "bare aliases in the OpenAI native family (gpt-*, o1-*, o3-*, o4-*, codex-*) are not allowed",
    });
  }
  for (const [otherId, other] of Object.entries(combos ?? {})) {
    if (otherId === id || otherId === options.excludeComboId) continue;
    const otherAlias = typeof other?.alias === "string" ? other.alias.trim() : "";
    if (otherAlias && otherAlias === alias) {
      issues.push({
        path: ["alias"],
        message: `alias "${alias}" is already used by combo "${otherId}"`,
      });
    }
  }
  return issues;
}

export interface ComboValidationOptions {
  requireEnabledTarget?: boolean;
  /** Full combos map for alias uniqueness checks; omitted during early config load. */
  combos?: Record<string, CodexCommanderComboConfig>;
  /** Combo being renamed — its stored alias is excluded from uniqueness checks. */
  excludeComboId?: string;
}

export function comboConfigIssues(
  id: string,
  raw: unknown,
  providers: Record<string, CodexCommanderProviderConfig>,
  options: ComboValidationOptions = {},
): ComboValidationIssue[] {
  const issues: ComboValidationIssue[] = [];
  if (!isValidComboId(id)) {
    issues.push({
      path: [],
      message: "combo id must start with a letter/number and use letters, numbers, dot, underscore, or hyphen (max 64)",
    });
  }
  if (Object.hasOwn(providers, COMBO_NAMESPACE)) {
    issues.push({
      path: [],
      message: 'provider name "combo" collides with the reserved "combo/" namespace while combos are configured',
    });
  }
  if (Object.hasOwn(providers, id)) {
    issues.push({
      path: [],
      message: `combo id "${id}" collides with configured provider name "${id}"`,
    });
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    issues.push({ path: [], message: "combo must be an object" });
    return issues;
  }

  const body = raw as Record<string, unknown>;
  if (body.strategy !== undefined
    && body.strategy !== "failover"
    && body.strategy !== "round-robin") {
    issues.push({ path: ["strategy"], message: 'strategy must be "failover" or "round-robin"' });
  }
  if (body.stickyLimit !== undefined
    && (typeof body.stickyLimit !== "number" || !Number.isInteger(body.stickyLimit)
      || body.stickyLimit < 1
      || body.stickyLimit > 100)) {
    issues.push({ path: ["stickyLimit"], message: "stickyLimit must be an integer from 1 to 100" });
  }
  if (body.defaultEffort !== undefined
    && body.defaultEffort !== null
    && (typeof body.defaultEffort !== "string" || !isCodexReasoningEffort(body.defaultEffort))) {
    issues.push({
      path: ["defaultEffort"],
      message: "defaultEffort must be one of: low, medium, high, xhigh, max, ultra",
    });
  }

  if (body.alias !== undefined) {
    if (typeof body.alias !== "string") {
      issues.push({ path: ["alias"], message: "alias must be a string" });
    } else {
      const alias = body.alias.trim();
      if (alias) issues.push(...comboAliasIssues(id, alias, options.combos, options));
    }
  }

  if (!Array.isArray(body.targets) || body.targets.length === 0) {
    issues.push({ path: ["targets"], message: "targets must be a non-empty array" });
    return issues;
  }

  const seen = new Set<string>();
  let configuredProviderCount = 0;
  let enabledProviderCount = 0;
  for (let i = 0; i < body.targets.length; i++) {
    const rawTarget = body.targets[i];
    if (!rawTarget || typeof rawTarget !== "object" || Array.isArray(rawTarget)) {
      issues.push({ path: ["targets", i], message: `targets[${i}] must be an object` });
      continue;
    }
    const target = rawTarget as Record<string, unknown>;
    const provider = typeof target.provider === "string" ? target.provider.trim() : "";
    const model = typeof target.model === "string" ? target.model.trim() : "";

    if (!provider) {
      issues.push({ path: ["targets", i, "provider"], message: `targets[${i}].provider is required` });
    } else if (!Object.hasOwn(providers, provider)) {
      issues.push({
        path: ["targets", i, "provider"],
        message: `targets[${i}].provider "${provider}" is not configured`,
      });
    } else {
      configuredProviderCount += 1;
      if (providers[provider]?.disabled !== true) enabledProviderCount += 1;
    }

    if (!model) {
      issues.push({ path: ["targets", i, "model"], message: `targets[${i}].model is required` });
    }
    if (target.weight !== undefined
      && (typeof target.weight !== "number" || !Number.isInteger(target.weight)
        || target.weight < 1
        || target.weight > 10_000)) {
      issues.push({
        path: ["targets", i, "weight"],
        message: `targets[${i}].weight must be an integer from 1 to 10000`,
      });
    }

    if (provider && model) {
      const key = targetKey({ provider, model });
      if (seen.has(key)) {
        issues.push({ path: ["targets", i], message: `duplicate combo target "${key}"` });
      } else {
        seen.add(key);
      }
    }
  }
  if (options.requireEnabledTarget
    && configuredProviderCount === body.targets.length
    && enabledProviderCount === 0) {
    issues.push({
      path: ["targets"],
      message: "targets must include at least one enabled provider",
    });
  }
  return issues;
}

export function comboConfigError(
  id: string,
  raw: unknown,
  providers: Record<string, CodexCommanderProviderConfig>,
  options: ComboValidationOptions = {},
): string | null {
  return comboConfigIssues(id, raw, providers, options)[0]?.message ?? null;
}

export function normalizeComboConfig(raw: CodexCommanderComboConfig): NormalizedComboConfig {
  const alias = typeof raw.alias === "string" ? raw.alias.trim() : "";
  return {
    strategy: raw.strategy ?? "failover",
    stickyLimit: raw.stickyLimit ?? 1,
    defaultEffort: raw.defaultEffort ?? null,
    alias: alias || null,
    targets: raw.targets.map(target => ({
      provider: target.provider.trim(),
      model: target.model.trim(),
      weight: target.weight ?? 1,
    })),
  };
}

export function comboDefaultEffort(
  config: { combos?: Record<string, CodexCommanderComboConfig> },
  id: string,
): CodexCommanderComboDefaultEffort | null {
  const combos = config.combos;
  if (!combos || !Object.hasOwn(combos, id)) return null;
  const value: unknown = combos[id]!.defaultEffort ?? null;
  return typeof value === "string" && isCodexReasoningEffort(value)
    ? value as CodexCommanderComboDefaultEffort
    : null;
}

export function isValidComboId(id: string): boolean {
  return COMBO_ID_PATTERN.test(id);
}

export function listComboIds(config: { combos?: Record<string, CodexCommanderComboConfig> }): string[] {
  return Object.keys(config.combos ?? {}).sort((a, b) => a.localeCompare(b));
}

export function listLiveComboTargetKeys(
  config: { combos?: Record<string, CodexCommanderComboConfig> },
): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const id of listComboIds(config)) {
    const combo = getCombo(config, id);
    if (!combo) continue;
    for (const target of combo.targets) keys.add(`${id}::${targetKey(target)}`);
  }
  return keys;
}

export function getCombo(
  config: { combos?: Record<string, CodexCommanderComboConfig> },
  id: string,
): NormalizedComboConfig | undefined {
  const combos = config.combos;
  if (!combos || !Object.hasOwn(combos, id)) return undefined;
  return normalizeComboConfig(combos[id]!);
}
