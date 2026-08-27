import { describe, expect, test } from "bun:test";
import { failedFilesFromJunit, partitionBunTestCliArgs, resolveRetryCount, resolveWorkerCount, retryTestArgs } from "../scripts/test";

describe("GUI test runner", () => {
  test("defaults to a bounded worker count and validates overrides", () => {
    expect(resolveWorkerCount(undefined, 10)).toBe(4);
    expect(resolveWorkerCount(undefined, 2)).toBe(2);
    expect(resolveWorkerCount("8", 10)).toBe(8);
    expect(() => resolveWorkerCount("0", 10)).toThrow("positive integer");
    expect(() => resolveWorkerCount("1.5", 10)).toThrow("positive integer");
    expect(() => resolveWorkerCount("x", 10)).toThrow("positive integer");
  });

  test("retries failed files once by default and validates overrides", () => {
    expect(resolveRetryCount(undefined)).toBe(1);
    expect(resolveRetryCount("0")).toBe(0);
    expect(resolveRetryCount("2")).toBe(2);
    expect(() => resolveRetryCount("-1")).toThrow("non-negative integer");
    expect(() => resolveRetryCount("1.5")).toThrow("non-negative integer");
  });

  test("happy-dom Window exposes event for React 19 update priority", async () => {
    const { Window } = await import("happy-dom");
    const win = new Window({ url: "http://localhost/" });
    expect("event" in win).toBe(true);
    expect((win as { event?: unknown }).event).toBeUndefined();
    win.close();
  });

  test("retries forward caller flags including --timeout", () => {
    expect(partitionBunTestCliArgs(["--timeout", "1", "tests/foo.test.tsx"])).toEqual({
      flags: ["--timeout", "1"],
      targets: ["tests/foo.test.tsx"],
    });
    expect(retryTestArgs(["--timeout", "1"], "tests/foo.test.tsx")).toEqual([
      "--timeout",
      "1",
      "--isolate",
      "tests/foo.test.tsx",
    ]);
    expect(retryTestArgs(["--timeout=1", "--bail"], "tests/bar.test.ts")).toEqual([
      "--timeout=1",
      "--bail",
      "--isolate",
      "tests/bar.test.ts",
    ]);
  });

  test("junit parser names only files that actually failed", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="3" failures="2" errors="0">
  <testsuite name="tests/ok.test.ts" file="tests/ok.test.ts" tests="1" failures="0" errors="0">
    <testcase name="passes" classname="ok" time="0.001" file="tests/ok.test.ts" />
  </testsuite>
  <testsuite name="tests/fail.test.tsx" file="tests/fail.test.tsx" tests="1" failures="1" errors="0">
    <testcase name="breaks" classname="fail" time="0.01" file="tests/fail.test.tsx">
      <failure message="Expected true">Expected true</failure>
    </testcase>
  </testsuite>
  <testsuite name="tests/load.test.ts" file="tests/load.test.ts" tests="0" failures="0" errors="1" />
</testsuites>`;
    expect(failedFilesFromJunit(xml)).toEqual(["tests/fail.test.tsx", "tests/load.test.ts"]);
  });
});
