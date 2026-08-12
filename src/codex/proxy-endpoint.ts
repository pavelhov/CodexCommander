/** True only for hostnames that bind loopback exclusively. */
export function isLoopbackHostname(hostname: string | undefined): boolean {
  const normalized = (hostname ?? "127.0.0.1").trim().toLowerCase();
  return normalized === ""
    || normalized === "localhost"
    || normalized === "127.0.0.1"
    || normalized === "::1"
    || normalized === "[::1]";
}

/** Convert the configured bind host into the exact authority clients should dial. */
export function providerBaseHost(hostname: string | undefined): string {
  const trimmed = (hostname ?? "127.0.0.1").trim();
  const lower = trimmed.toLowerCase();
  if (lower === "::1" || lower === "[::1]") return "[::1]";
  if (isLoopbackHostname(trimmed)
    || trimmed === "0.0.0.0"
    || trimmed === "::"
    || trimmed === "[::]") return "127.0.0.1";
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) return trimmed;
  return trimmed.includes(":") ? `[${trimmed}]` : trimmed;
}

export function proxyProviderBaseUrl(port: number, hostname?: string): string {
  return `http://${providerBaseHost(hostname)}:${port}/v1`;
}

/** Exact grammar emitted by proxyProviderBaseUrl for a valid TCP port. */
export function isProxyProviderBaseUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^http:\/\/(\[[^\]\s]+\]|[^/\s:@?#]+):([1-9]\d{0,4})\/v1$/u.exec(value);
  if (!match || Number(match[2]) > 65_535) return false;
  const authority = match[1];
  if (authority.startsWith("[") && authority.includes("%")) {
    const scopedHost = authority.slice(1, -1);
    const separator = scopedHost.indexOf("%");
    const address = scopedHost.slice(0, separator);
    const zone = scopedHost.slice(separator + 1);
    // WHATWG URL rejects an IPv6 zone identifier even though Bun.serve accepts
    // the same configured bind host. Validate the address without its zone,
    // then accept only the exact, delimiter-safe zone grammar our emitter can
    // round-trip. This keeps Start and Restore Native symmetric.
    if (!zone || !/^[A-Za-z0-9._~-]+$/u.test(zone)) return false;
    try {
      const parsed = new URL(`http://[${address}]:${match[2]}/v1`);
      return parsed.hostname.startsWith("[") && parsed.hostname.endsWith("]");
    } catch {
      return false;
    }
  }
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:"
      && parsed.username === ""
      && parsed.password === ""
      && parsed.pathname === "/v1"
      && parsed.search === ""
      && parsed.hash === "";
  } catch {
    return false;
  }
}
