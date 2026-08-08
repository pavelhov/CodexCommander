/**
 * Bun runtime stream-capability gate for eager SSE passthrough (#314).
 *
 * Generic JS streams with an async `pull()` remain exposed to Bun#32111 (fixed
 * upstream by Bun PR #32120, merged 2026-06-21). No RELEASED Bun version is
 * proven to carry that fix yet, so `MIN_FIXED_BUN_VERSION` is null: generic
 * eager selection remains "known-bad" until a bundle-bump commit sets it.
 *
 * The plaintext-V2 Darwin relay is a narrower, product-owned exception: its
 * exact single-reader implementation has a synchronous `pull()` and was
 * positive-control tested against the bundled Bun below. `auto` may use that
 * exact shape only for an activated plaintext collaboration rewrite; every
 * other Darwin rewrite remains explicit-only, and `legacy-tee` is the kill
 * switch. A Bun bump must update the validated version in the same reviewed
 * commit after re-running the abort/backpressure diagnostic.
 *
 * Prerelease conservatism: a version carrying a prerelease suffix (e.g.
 * `1.4.0-canary.3`) is NEVER treated as fixed even when its numeric triple
 * reaches the threshold — canaries are exactly the OPENCODEX_BUN_PATH audience
 * and may predate the fix commit.
 */

/**
 * Bump in the SAME commit that bumps package.json's bundled Bun to a version
 * verified to include Bun PR #32120. null = no released version is known-fixed.
 */
export const MIN_FIXED_BUN_VERSION: string | null = null;

/** Exact bundled runtime used for the Darwin plaintext-V2 relay validation. */
export const DARWIN_PLAINTEXT_EAGER_VALIDATED_BUN_VERSION = "1.3.14";

export type StreamMode = "auto" | "legacy-tee" | "eager-relay";

export const STREAM_MODES: readonly StreamMode[] = ["auto", "legacy-tee", "eager-relay"];

export function isStreamMode(value: unknown): value is StreamMode {
  return typeof value === "string" && (STREAM_MODES as readonly string[]).includes(value);
}

/** Numeric [major, minor, patch] triple, or null for unparseable input. */
export function parseBunVersion(version: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Compare two version strings numerically; null when either is unparseable. */
export function compareBunVersions(a: string, b: string): number | null {
  const pa = parseBunVersion(a);
  const pb = parseBunVersion(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    if (pa[i]! !== pb[i]!) return pa[i]! - pb[i]!;
  }
  return 0;
}

function hasPrereleaseSuffix(version: string): boolean {
  return /^\d+\.\d+\.\d+-/.test(version.trim());
}

/**
 * True only when `version` is proven to carry the Bun#32120 async-pull cancel
 * fix. Conservative: unknown, unparseable, prerelease, or no threshold → false.
 */
export function bunHasAsyncPullCancelFix(
  version: string,
  minFixed: string | null = MIN_FIXED_BUN_VERSION,
): boolean {
  if (!minFixed) return false;
  if (hasPrereleaseSuffix(version)) return false;
  const cmp = compareBunVersions(version, minFixed);
  return cmp !== null && cmp >= 0;
}

export type EagerRelayDecision = {
  useEagerRelay: boolean;
  reason:
    | "config-legacy"
    | "config-eager"
    | "auto-fixed-runtime"
    | "auto-known-bad"
    | "auto-darwin-plaintext-v2";
};

export type EagerRelayRequestShape = {
  needsClientRewrite: boolean;
  /** The exact, fully recognized native V2 collaboration namespace was aliased. */
  plaintextCollaborationRewrite: boolean;
};

/**
 * Decide the runtime/config SSE client-path capability. `version`/`minFixed`
 * are injectable for tests; `selectEagerPath` applies platform policy.
 */
export function decideEagerRelay(
  mode: StreamMode,
  version: string = Bun.version,
  minFixed: string | null = MIN_FIXED_BUN_VERSION,
): EagerRelayDecision {
  if (mode === "legacy-tee") return { useEagerRelay: false, reason: "config-legacy" };
  if (mode === "eager-relay") return { useEagerRelay: true, reason: "config-eager" };
  return bunHasAsyncPullCancelFix(version, minFixed)
    ? { useEagerRelay: true, reason: "auto-fixed-runtime" }
    : { useEagerRelay: false, reason: "auto-known-bad" };
}

/**
 * Apply the two-platform eager-relay policy to the runtime/config capability.
 * Windows preserves the decision for no-rewrite traffic. Darwin permits
 * explicit config opt-in for every shape and admits `auto` only for the exact
 * validated plaintext-V2 collaboration rewrite. Returns the normalized
 * effective decision, or null when platform/shape policy selects tee.
 */
export function selectEagerPath(
  platform: NodeJS.Platform,
  shape: EagerRelayRequestShape,
  mode: StreamMode,
  version: string = Bun.version,
  minFixed: string | null = MIN_FIXED_BUN_VERSION,
): EagerRelayDecision | null {
  if (platform !== "win32" && platform !== "darwin") {
    return null;
  }

  const decision = decideEagerRelay(mode, version, minFixed);
  if (platform === "win32") return shape.needsClientRewrite ? null : decision;
  if (decision.reason === "config-eager") return decision;
  if (
    mode === "auto"
    && shape.needsClientRewrite
    && shape.plaintextCollaborationRewrite
    && version.trim() === DARWIN_PLAINTEXT_EAGER_VALIDATED_BUN_VERSION
  ) {
    return { useEagerRelay: true, reason: "auto-darwin-plaintext-v2" };
  }
  return null;
}

/**
 * Privacy-safe startup diagnostic for custom/unvalidated Bun runtimes. The
 * selector already fails closed to tee; this merely explains why.
 */
export function darwinPlaintextEagerRuntimeWarning(
  platform: NodeJS.Platform,
  mode: StreamMode,
  delivery: "encrypted" | "plaintext",
  version: string = Bun.version,
): string | null {
  if (
    platform !== "darwin"
    || mode !== "auto"
    || delivery !== "plaintext"
    || version.trim() === DARWIN_PLAINTEXT_EAGER_VALIDATED_BUN_VERSION
  ) return null;
  return `macOS plaintext V2 auto relay was validated on Bun ${DARWIN_PLAINTEXT_EAGER_VALIDATED_BUN_VERSION}; running Bun ${version} stays on legacy tee. Set streamMode to \"eager-relay\" only after validating this runtime.`;
}

/**
 * #864 transport gate: win32 traffic that needs a client payload rewrite must
 * use the eager single reader with the rewrite applied inline, because the
 * alternative tee()+JS-pull chain is the Bun#32111-unsafe path that loses the
 * terminal SSE block on Windows. Independent of the version-based eager
 * policy: the pull chain is unsafe on the AFFECTED runtimes by definition.
 */
export function isWin32EagerRewrite(
  platform: NodeJS.Platform,
  needsClientRewrite: boolean,
): boolean {
  return platform === "win32" && needsClientRewrite;
}
