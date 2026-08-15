import type { TKey } from "./i18n/shared";

/**
 * Map a quota-unavailable reason code to its localized copy, matching the Mac app's
 * ProviderListView summary. Any unknown or missing reason falls back to the generic
 * "Temporarily unavailable" line (raw reason strings never reach the DOM).
 */
export function quotaUnavailableReasonKey(reason: string | undefined): TKey {
  if (reason === "reauth_required") return "pws.quota.signInRequired";
  if (reason === "local_cli_refresh_required") return "pws.quota.loginNeedsRefresh";
  return "pws.quota.upstreamUnavailable";
}
