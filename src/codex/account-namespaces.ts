import type { CodexAccount, CodexCommanderConfig } from "../types";
import { COMBO_NAMESPACE } from "../combos/types";
import { OPENAI_CODEX_PROVIDER_ID } from "../providers/openai-tiers";
import {
  CODEX_ACCOUNT_LOG_LABEL_RE,
} from "./account-label";
import { isValidCodexAccountId, MAIN_CODEX_ACCOUNT_ID } from "./account-id";
import {
  codexAccountIdNamespaceCollisionError,
  codexProviderNamespaceKey,
  MAIN_CODEX_ACCOUNT_NAMESPACE_TARGET,
} from "./account-namespace-match";

export { isValidCodexAccountNamespaceTarget } from "./account-namespace-match";

const RESERVED_NAMESPACE_KEYS = new Set([
  "__proto__",
  "prototype",
  "constructor",
  COMBO_NAMESPACE,
  OPENAI_CODEX_PROVIDER_ID,
].map(codexProviderNamespaceKey));
function comboAliasNamespaces(config: Pick<CodexCommanderConfig, "combos">): string[] {
  return Object.values(config.combos ?? {}).flatMap((combo) => {
    const alias = typeof combo?.alias === "string" ? combo.alias.trim() : "";
    const slash = alias.indexOf("/");
    return slash > 0 ? [alias.slice(0, slash)] : [];
  });
}

function privateAccountSelectorCandidates(accountIds: Iterable<string>): Set<string> {
  return new Set(accountIds);
}

function defaultPublicAccountSelector(
  account: Pick<CodexAccount, "id" | "logLabel">,
  allPrivateCandidates: ReadonlySet<string>,
): string | null {
  const privateCandidates = new Set(allPrivateCandidates);
  privateCandidates.add(account.id);
  if (CODEX_ACCOUNT_LOG_LABEL_RE.test(account.logLabel)
    && !privateCandidates.has(account.logLabel)) return account.logLabel;
  return null;
}

function claimNamespace(requested: string, used: Set<string>): string {
  let namespace = requested;
  let suffix = 2;
  while (used.has(namespace)) namespace = `${requested}-${suffix++}`;
  used.add(namespace);
  return namespace;
}

function occupiedNamespaces(config: Pick<CodexCommanderConfig, "combos" | "providers">): Set<string> {
  return new Set([
    ...Object.keys(config.providers).map(codexProviderNamespaceKey),
    ...comboAliasNamespaces(config),
    ...RESERVED_NAMESPACE_KEYS,
  ]);
}

/** Build an initial account-selector map without deriving public selectors from aliases or ids. */
export function defaultCodexAccountNamespaces(
  config: Pick<CodexCommanderConfig, "codexAccounts" | "combos" | "providers">,
): Record<string, string> {
  const namespaces: Record<string, string> = {};
  const used = occupiedNamespaces(config);
  const accounts = config.codexAccounts ?? [];
  const privateCandidates = privateAccountSelectorCandidates(
    accounts
      .filter(account => account.id !== MAIN_CODEX_ACCOUNT_ID)
      .map(account => account.id),
  );
  for (const candidate of privateCandidates) used.add(candidate);

  namespaces[claimNamespace("main", used)] = MAIN_CODEX_ACCOUNT_NAMESPACE_TARGET;
  for (const account of accounts) {
    if (account.isMain || !isValidCodexAccountId(account.id)) continue;
    const selector = defaultPublicAccountSelector(account, privateCandidates);
    if (selector === null) continue;
    const namespace = claimNamespace(selector, used);
    namespaces[namespace] = account.id;
  }
  return namespaces;
}

/**
 * Add one account to a generated map without renaming or replacing explicit existing entries.
 * The account-creation layer must reject a new id that already equals an existing selector key.
 * A true result means the map was mutated in place; callers must persist the updated config.
 */
export function appendDefaultCodexAccountNamespace(
  config: Pick<CodexCommanderConfig, "codexAccountNamespaces" | "codexAccounts" | "combos" | "providers">,
  account: Pick<CodexAccount, "id" | "isMain" | "logLabel">,
): boolean {
  const namespaces = config.codexAccountNamespaces;
  if (account.isMain
    || !isValidCodexAccountId(account.id)
    || !namespaces
    || Object.keys(namespaces).length === 0
    || codexAccountIdNamespaceCollisionError(namespaces, account.id)
    || Object.values(namespaces).includes(account.id)) return false;

  const used = occupiedNamespaces(config);
  for (const namespace of Object.keys(namespaces)) used.add(namespace);
  const privateCandidates = privateAccountSelectorCandidates([
    ...(config.codexAccounts ?? [])
      .filter(existing => existing.id !== MAIN_CODEX_ACCOUNT_ID)
      .map(existing => existing.id),
    ...Object.values(namespaces),
    account.id,
  ]);
  for (const candidate of privateCandidates) used.add(candidate);
  const selector = defaultPublicAccountSelector(account, privateCandidates);
  if (selector === null) return false;
  const namespace = claimNamespace(selector, used);
  namespaces[namespace] = account.id;
  return true;
}

export function isMainCodexAccountTarget(accountId: string): boolean {
  return accountId === MAIN_CODEX_ACCOUNT_NAMESPACE_TARGET || accountId === MAIN_CODEX_ACCOUNT_ID;
}

function normalizeCodexAccountNamespaceTarget(accountId: string): string {
  return isMainCodexAccountTarget(accountId)
    ? MAIN_CODEX_ACCOUNT_ID
    : accountId;
}

export function codexAccountNamespaceEntries(
  config: Pick<CodexCommanderConfig, "codexAccountNamespaces">,
): Array<[string, string]> {
  return Object.entries(config.codexAccountNamespaces ?? {})
    .map(([namespace, accountId]) => [namespace, normalizeCodexAccountNamespaceTarget(accountId)]);
}
