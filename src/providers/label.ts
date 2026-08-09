import { CODEX_ACCOUNT_LOG_LABEL_RE } from "../codex/account-label";

function canonicalUsageProviderLabel(provider: string): string {
  return provider === "chatgpt" ? "openai" : provider;
}

export function baseProviderLabel(provider: string): string {
  const canonical = canonicalUsageProviderLabel(provider);
  if (canonical !== provider) return canonical;
  const cut = provider.lastIndexOf("-");
  if (cut <= 0) return canonicalUsageProviderLabel(provider);
  const suffix = provider.slice(cut + 1);
  // ChatGPT auth-pool and OpenAI passthrough are the same Codex/OpenAI usage surface, so display
  // summaries normalize them to one `openai` row after recognized main/pool suffixes are removed.
  return CODEX_ACCOUNT_LOG_LABEL_RE.test(suffix) ? canonicalUsageProviderLabel(provider.slice(0, cut)) : provider;
}
