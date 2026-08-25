/**
 * HTTP protocol shared by lifecycle clients and the proxy. Filesystem lock
 * ownership deliberately lives in proxy-start-lock.ts instead.
 */

export const PROXY_START_LEASE_HEADER = "x-codexcommander-proxy-start-lock";
export const PROXY_ENSURE_LEASE_HEADER = "x-codexcommander-proxy-ensure-lock";
export const PROXY_LIFECYCLE_LEASE_CAPABILITY_HEADER = "x-codexcommander-lifecycle-lock-lease";
export const PROXY_LIFECYCLE_LEASE_CAPABILITY_VALUE = "1";
/** Authenticated /healthz metadata used only for bounded stale-runtime replacement. */
export const PROXY_RUNTIME_VERSION_HEADER = "x-codexcommander-runtime-version";
export const PROXY_LIFECYCLE_COMPATIBILITY_GENERATION_HEADER = "x-codexcommander-lifecycle-generation";
/** Increment only when a newer lifecycle helper must retire older runtime behavior. */
export const PROXY_LIFECYCLE_COMPATIBILITY_GENERATION = 1;

/**
 * One-shot foreground child whose parent already owns E. This deliberately
 * does not claim that a supervisor will restart the child after a later exit.
 */
export const PROXY_DELEGATED_START_ENV = "CCX_DELEGATED_START";

/** Existing lock tokens forwarded only to the proxy being stopped. */
export interface ProxyLifecycleLockLease {
  readonly ensureToken: string;
  readonly startToken: string;
}

interface HeaderReader {
  get(name: string): string | null;
}

interface HeaderWriter {
  set(name: string, value: string): void;
}

export type ProxyLifecycleLockLeaseHeaderState =
  | { readonly kind: "none" }
  | { readonly kind: "invalid" }
  | { readonly kind: "lease"; readonly lease: ProxyLifecycleLockLease };

/** Build the complete, all-or-nothing delegated-stop request header pair. */
export function proxyLifecycleLockLeaseHeaders(
  lease: ProxyLifecycleLockLease,
): Record<string, string> {
  return {
    [PROXY_ENSURE_LEASE_HEADER]: lease.ensureToken,
    [PROXY_START_LEASE_HEADER]: lease.startToken,
  };
}

/** Distinguish an ordinary stop from a complete or malformed delegated stop. */
export function readProxyLifecycleLockLeaseHeaders(
  headers: HeaderReader,
): ProxyLifecycleLockLeaseHeaderState {
  const ensureToken = headers.get(PROXY_ENSURE_LEASE_HEADER);
  const startToken = headers.get(PROXY_START_LEASE_HEADER);
  if (ensureToken === null && startToken === null) return { kind: "none" };
  if (!ensureToken || !startToken) return { kind: "invalid" };
  return { kind: "lease", lease: { ensureToken, startToken } };
}

export function proxySupportsLifecycleLockLease(headers: HeaderReader): boolean {
  return headers.get(PROXY_LIFECYCLE_LEASE_CAPABILITY_HEADER)
    === PROXY_LIFECYCLE_LEASE_CAPABILITY_VALUE;
}

export function advertiseProxyLifecycleLockLease(headers: HeaderWriter): void {
  headers.set(
    PROXY_LIFECYCLE_LEASE_CAPABILITY_HEADER,
    PROXY_LIFECYCLE_LEASE_CAPABILITY_VALUE,
  );
}

export function advertiseProxyRuntimeMetadata(headers: HeaderWriter, version: string): void {
  headers.set(PROXY_RUNTIME_VERSION_HEADER, version);
  headers.set(
    PROXY_LIFECYCLE_COMPATIBILITY_GENERATION_HEADER,
    String(PROXY_LIFECYCLE_COMPATIBILITY_GENERATION),
  );
}
