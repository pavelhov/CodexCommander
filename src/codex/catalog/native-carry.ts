import type { CodexCommanderConfig } from "../../types";
import { readCodexTokensResult } from "../auth-collision";
import { canonicalCodexHomeDir } from "../home";
import { nativeCatalogOwnerDecision } from "./native-owner";
import { desktopAllowlistSuppressedNativeSlugs, disabledNativeSlugs, isBareBundledNativeCatalogEntry, shouldIncludeNativeOpenAi } from "./metadata";
import { trustedAccountBoundNativeCatalogSlug } from "./account-models";
import type { NativeLiveCatalogStatus } from "./native-live";
import type { RawCatalog, RawEntry } from "./parsing";

/** Prior bare native rows authorized while this gather's live peek is empty. */
export function carriedNativeDiscoveryRows(
  config: Readonly<CodexCommanderConfig>,
  nativeLive: NativeLiveCatalogStatus,
  prior: RawCatalog | null,
  codexHome = canonicalCodexHomeDir(),
): RawEntry[] {
  if (nativeLive.catalog !== null || !shouldIncludeNativeOpenAi(config)) return [];
  // Only a confirmed missing or signed-out credential file is a logout.
  const tokenRead = readCodexTokensResult(codexHome);
  if (tokenRead.status === "missing" || tokenRead.status === "signed-out") return [];
  if (nativeCatalogOwnerDecision(codexHome, tokenRead) === "mismatch") return [];
  const priorSlugs = new Set((prior?.models ?? []).flatMap(entry => {
    const slug = typeof entry.slug === "string" ? entry.slug : "";
    return isBareBundledNativeCatalogEntry(entry) && /^(?:gpt|codex)-/.test(slug) ? [slug] : [];
  }));
  const intentional = new Set([
    ...disabledNativeSlugs(config),
    ...desktopAllowlistSuppressedNativeSlugs(config, {}, priorSlugs),
  ]);
  const visibleAccountNative = new Set((prior?.models ?? []).flatMap(entry => {
    const slug = trustedAccountBoundNativeCatalogSlug(entry);
    return slug && entry.visibility === "list" ? [slug] : [];
  }));
  return (prior?.models ?? []).filter(entry => {
    const slug = typeof entry.slug === "string" ? entry.slug : "";
    return priorSlugs.has(slug) && isBareBundledNativeCatalogEntry(entry)
      && !intentional.has(slug)
      && (config.nativeCatalogMode !== "bundled-listed" || entry.visibility === "list" || visibleAccountNative.has(slug));
  });
}
