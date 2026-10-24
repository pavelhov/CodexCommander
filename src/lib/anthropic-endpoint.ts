const NATIVE_ANTHROPIC_ORIGIN = "https://api.anthropic.com";

/** Canonical API root for supported native Anthropic base URLs; never rewrites custom destinations. */
export function canonicalAnthropicApiRoot(baseUrl: string): string | undefined {
  try {
    const url = new URL(baseUrl);
    if (url.origin !== NATIVE_ANTHROPIC_ORIGIN
      || url.username
      || url.password
      || /[?#]/.test(url.href)
      || !/^(?:\/v1(?:\/messages)?)?$/i.test(url.pathname.replace(/\/+$/, ""))) {
      return undefined;
    }
    return NATIVE_ANTHROPIC_ORIGIN;
  } catch {
    return undefined;
  }
}

/** Shared native endpoint boundary for model budgets and catalog metadata. */
export function isCanonicalAnthropicEndpoint(baseUrl: string): boolean {
  return canonicalAnthropicApiRoot(baseUrl) !== undefined;
}
