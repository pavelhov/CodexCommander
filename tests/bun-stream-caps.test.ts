import { describe, expect, test } from "bun:test";
import {
  bunHasAsyncPullCancelFix,
  compareBunVersions,
  DARWIN_PLAINTEXT_EAGER_VALIDATED_BUN_VERSION,
  darwinPlaintextEagerRuntimeWarning,
  decideEagerRelay,
  isStreamMode,
  isWin32EagerRewrite,
  MIN_FIXED_BUN_VERSION,
  parseBunVersion,
  selectEagerPath,
} from "../src/lib/bun-stream-caps";

describe("isWin32EagerRewrite (#864 transport gate)", () => {
  test("win32 + rewrite → eager inline rewrite; everything else stays out", () => {
    expect(isWin32EagerRewrite("win32", true)).toBe(true);
    expect(isWin32EagerRewrite("win32", false)).toBe(false);
    expect(isWin32EagerRewrite("darwin", true)).toBe(false);
    expect(isWin32EagerRewrite("linux", true)).toBe(false);
  });
});

describe("parseBunVersion", () => {
  test("parses plain and prerelease versions to the numeric triple", () => {
    expect(parseBunVersion("1.3.14")).toEqual([1, 3, 14]);
    expect(parseBunVersion("1.3.14-canary.1")).toEqual([1, 3, 14]);
    expect(parseBunVersion(" 2.0.0 ")).toEqual([2, 0, 0]);
  });

  test("returns null for garbage", () => {
    expect(parseBunVersion("")).toBeNull();
    expect(parseBunVersion("bun")).toBeNull();
    expect(parseBunVersion("1.3")).toBeNull();
  });
});

describe("compareBunVersions", () => {
  test("orders numerically per segment", () => {
    expect(compareBunVersions("1.3.14", "1.3.14")).toBe(0);
    expect(compareBunVersions("1.4.0", "1.3.14")!).toBeGreaterThan(0);
    expect(compareBunVersions("1.3.9", "1.3.14")!).toBeLessThan(0);
    expect(compareBunVersions("2.0.0", "1.99.99")!).toBeGreaterThan(0);
  });

  test("null on unparseable input", () => {
    expect(compareBunVersions("nope", "1.0.0")).toBeNull();
  });
});

describe("bunHasAsyncPullCancelFix", () => {
  test("no min-fixed threshold → never fixed (today's shipped state)", () => {
    expect(MIN_FIXED_BUN_VERSION).toBeNull();
    expect(bunHasAsyncPullCancelFix("99.0.0", null)).toBe(false);
  });

  test("at/above threshold → fixed; below → not", () => {
    expect(bunHasAsyncPullCancelFix("1.4.0", "1.4.0")).toBe(true);
    expect(bunHasAsyncPullCancelFix("1.4.1", "1.4.0")).toBe(true);
    expect(bunHasAsyncPullCancelFix("1.3.14", "1.4.0")).toBe(false);
  });

  test("prerelease conservatism: canary of the fixed version is NOT fixed", () => {
    expect(bunHasAsyncPullCancelFix("1.4.0-canary.1", "1.4.0")).toBe(false);
  });

  test("unparseable version → not fixed", () => {
    expect(bunHasAsyncPullCancelFix("garbage", "1.4.0")).toBe(false);
  });
});

describe("decideEagerRelay (activation scenarios)", () => {
  test("auto on today's bundled runtime → legacy tee (auto-known-bad)", () => {
    expect(decideEagerRelay("auto", "1.3.14", null)).toEqual({
      useEagerRelay: false,
      reason: "auto-known-bad",
    });
  });

  test("auto on a future fixed runtime → eager relay", () => {
    expect(decideEagerRelay("auto", "1.4.0", "1.4.0")).toEqual({
      useEagerRelay: true,
      reason: "auto-fixed-runtime",
    });
  });

  test("explicit eager-relay opt-in wins even on known-bad runtimes", () => {
    expect(decideEagerRelay("eager-relay", "1.3.14", null)).toEqual({
      useEagerRelay: true,
      reason: "config-eager",
    });
  });

  test("explicit legacy-tee pin wins even on fixed runtimes", () => {
    expect(decideEagerRelay("legacy-tee", "9.9.9", "1.4.0")).toEqual({
      useEagerRelay: false,
      reason: "config-legacy",
    });
  });
});

describe("selectEagerPath (platform policy matrix)", () => {
  const configLegacy = { useEagerRelay: false, reason: "config-legacy" } as const;
  const configEager = { useEagerRelay: true, reason: "config-eager" } as const;
  const autoFixed = { useEagerRelay: true, reason: "auto-fixed-runtime" } as const;
  const autoDarwinPlaintext = { useEagerRelay: true, reason: "auto-darwin-plaintext-v2" } as const;
  const none = { needsClientRewrite: false, plaintextCollaborationRewrite: false } as const;
  const otherRewrite = { needsClientRewrite: true, plaintextCollaborationRewrite: false } as const;
  const plaintextRewrite = { needsClientRewrite: true, plaintextCollaborationRewrite: true } as const;
  const cases: Array<{
    platform: NodeJS.Platform;
    mode: "auto" | "legacy-tee" | "eager-relay";
    shape: typeof none | typeof otherRewrite | typeof plaintextRewrite;
    version: string;
    minFixed: string | null;
    expected: typeof configLegacy | typeof configEager | typeof autoFixed | typeof autoDarwinPlaintext | null;
  }> = [
    { platform: "win32", mode: "legacy-tee", shape: none, version: "9.9.9", minFixed: "1.4.0", expected: configLegacy },
    { platform: "win32", mode: "eager-relay", shape: none, version: "1.3.14", minFixed: null, expected: configEager },
    { platform: "win32", mode: "auto", shape: none, version: "1.4.0", minFixed: "1.4.0", expected: autoFixed },
    { platform: "win32", mode: "auto", shape: otherRewrite, version: "1.4.0", minFixed: "1.4.0", expected: null },
    { platform: "win32", mode: "auto", shape: plaintextRewrite, version: "1.3.14", minFixed: null, expected: null },
    { platform: "darwin", mode: "legacy-tee", shape: plaintextRewrite, version: "1.3.14", minFixed: null, expected: null },
    { platform: "darwin", mode: "eager-relay", shape: none, version: "1.3.14", minFixed: null, expected: configEager },
    { platform: "darwin", mode: "eager-relay", shape: otherRewrite, version: "1.3.14", minFixed: null, expected: configEager },
    { platform: "darwin", mode: "auto", shape: none, version: "1.3.14", minFixed: null, expected: null },
    { platform: "darwin", mode: "auto", shape: otherRewrite, version: "1.3.14", minFixed: null, expected: null },
    { platform: "darwin", mode: "auto", shape: plaintextRewrite, version: "1.3.14", minFixed: null, expected: autoDarwinPlaintext },
    { platform: "darwin", mode: "auto", shape: plaintextRewrite, version: "1.3.15", minFixed: null, expected: null },
    { platform: "linux", mode: "eager-relay", shape: none, version: "1.3.14", minFixed: null, expected: null },
    { platform: "linux", mode: "auto", shape: plaintextRewrite, version: "1.3.14", minFixed: null, expected: null },
  ];

  for (const { platform, mode, shape, version, minFixed, expected } of cases) {
    test(`${platform} + ${mode} + ${shape.plaintextCollaborationRewrite ? "plaintext-v2" : shape.needsClientRewrite ? "other-rewrite" : "no-rewrite"} + Bun ${version}`, () => {
      expect(selectEagerPath(platform, shape, mode, version, minFixed)).toEqual(expected);
    });
  }
});

describe("Darwin plaintext-V2 runtime validation", () => {
  test("the validated relay runtime stays pinned to the bundled Bun dependency", async () => {
    const pkg = await Bun.file(new URL("../package.json", import.meta.url)).json() as {
      dependencies?: { bun?: string };
    };
    expect(DARWIN_PLAINTEXT_EAGER_VALIDATED_BUN_VERSION).toBe("1.3.14");
    expect(pkg.dependencies?.bun).toBe(DARWIN_PLAINTEXT_EAGER_VALIDATED_BUN_VERSION);
  });

  test("warns only when plaintext auto would fall back on an unvalidated Darwin runtime", () => {
    expect(darwinPlaintextEagerRuntimeWarning("darwin", "auto", "plaintext", "1.3.15"))
      .toContain("stays on legacy tee");
    expect(darwinPlaintextEagerRuntimeWarning("darwin", "auto", "plaintext", "1.3.14")).toBeNull();
    expect(darwinPlaintextEagerRuntimeWarning("darwin", "legacy-tee", "plaintext", "1.3.15")).toBeNull();
    expect(darwinPlaintextEagerRuntimeWarning("darwin", "auto", "encrypted", "1.3.15")).toBeNull();
    expect(darwinPlaintextEagerRuntimeWarning("linux", "auto", "plaintext", "1.3.15")).toBeNull();
  });
});

describe("isStreamMode", () => {
  test("accepts the three modes, rejects everything else", () => {
    expect(isStreamMode("auto")).toBe(true);
    expect(isStreamMode("legacy-tee")).toBe(true);
    expect(isStreamMode("eager-relay")).toBe(true);
    expect(isStreamMode("legacy_tee")).toBe(false);
    expect(isStreamMode(1)).toBe(false);
    expect(isStreamMode(undefined)).toBe(false);
  });
});
