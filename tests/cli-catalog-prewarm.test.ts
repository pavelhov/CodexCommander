import { describe, expect, mock, spyOn, test } from "bun:test";
import type { CodexCommanderConfig } from "../src/types";
import { scheduleCatalogPrewarm } from "../src/cli/catalog-prewarm";
import {
  runForegroundProxyStart,
  type ForegroundProxyStartIo,
} from "../src/cli/foreground-proxy";
import { foregroundProxyStartIo } from "./helpers/foreground-proxy-start";

describe("catalog prewarm on handleStart bind", () => {
  test("scheduleCatalogPrewarm calls gatherRoutedModels(loadConfig()) once", async () => {
    const config = { port: 9_001, providers: {}, defaultProvider: "fixture" } as CodexCommanderConfig;
    const gatherRoutedModels = mock(async (_config: CodexCommanderConfig) => []);
    const load = mock(() => config);
    const importCatalog = mock(async () => ({ gatherRoutedModels }));

    scheduleCatalogPrewarm({ loadConfig: load, importCatalog });

    await Bun.sleep(0);
    expect(importCatalog).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(1);
    expect(gatherRoutedModels).toHaveBeenCalledTimes(1);
    expect(gatherRoutedModels.mock.calls[0]?.[0]).toBe(config);
  });

  test("scheduleCatalogPrewarm swallows gather failures", async () => {
    const gatherRoutedModels = mock(async () => {
      throw new Error("discovery failed");
    });
    scheduleCatalogPrewarm({
      loadConfig: () => ({ port: 9_002, providers: {}, defaultProvider: "fixture" }) as CodexCommanderConfig,
      importCatalog: async () => ({ gatherRoutedModels }),
    });
    await Bun.sleep(0);
    expect(gatherRoutedModels).toHaveBeenCalledTimes(1);
  });

  test("catalog busy maps startup prewarm to warn-skip", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      scheduleCatalogPrewarm({
        loadConfig: () => ({ port: 9_003, providers: {}, defaultProvider: "fixture" }) as CodexCommanderConfig,
        importCatalog: async () => ({ gatherRoutedModels: async () => { throw Object.assign(new Error("busy"), { code: "catalog_busy" }); } }),
      });
      await Bun.sleep(0);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain("skipped");
    } finally {
      warn.mockRestore();
    }
  });

  test("handleStart schedules catalog prewarm immediately after a successful bind", async () => {
    const events: string[] = [];
    const io = foregroundProxyStartIo({
      startServer: (() => {
        events.push("bind");
        return {};
      }) as NonNullable<ForegroundProxyStartIo["startServer"]>,
      scheduleCatalogPrewarm: () => events.push("prewarm"),
      installCrashGuards: () => events.push("next-startup-step"),
    });

    expect(await runForegroundProxyStart([], { block: false, io })).toBe(0);
    expect(events).toEqual(["bind", "prewarm", "next-startup-step"]);
  });
});
